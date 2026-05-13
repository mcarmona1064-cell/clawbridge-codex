/**
 * Slack channel adapter — Events API webhook for inbound, Web API for outbound.
 * Reads SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET from ~/.clawbridge/.env.
 *
 * In your Slack app (api.slack.com/apps):
 *   Event Subscriptions → Request URL: http(s)://<host>:3000/webhook/slack
 *   Subscribe to bot events: message.channels, message.im, message.mpim, message.groups
 */
import crypto from 'crypto';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { namespacedPlatformId } from '../platform-id.js';
import { registerRawWebhookHandler } from '../webhook-server.js';
import type { ChannelAdapter, ChannelSetup, InboundFile, InboundMessage, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';
import { isAudioLike, transcribeAudio } from '../transcription.js';

const CHANNEL_TYPE = 'slack';
const SLACK_API = 'https://slack.com/api';
const INBOUND_FILE_SIZE_CAP = 50 * 1024 * 1024; // 50 MB — matches Telegram / WhatsApp / Discord

interface SlackFile {
  id: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  size?: number;
  url_private?: string;
  url_private_download?: string;
}

function createAdapter(): ChannelAdapter | null {
  const env = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET']);
  const token = env['SLACK_BOT_TOKEN'];
  const signingSecret = env['SLACK_SIGNING_SECRET'];
  if (!token || !signingSecret) return null;

  let cfg: ChannelSetup | null = null;
  let botUserId: string | null = null;
  let connected = false;

  async function verifySignature(req: Request, body: string): Promise<boolean> {
    const ts = req.headers.get('x-slack-request-timestamp');
    const sig = req.headers.get('x-slack-signature');
    if (!ts || !sig) return false;
    if (Math.abs(Date.now() / 1000 - parseInt(ts, 10)) > 300) return false;
    const hmac = crypto.createHmac('sha256', signingSecret).update(`v0:${ts}:${body}`).digest('hex');
    try {
      return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(`v0=${hmac}`));
    } catch {
      return false;
    }
  }

  async function apiCall(method: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await fetch(`${SLACK_API}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    return (await res.json()) as Record<string, unknown>;
  }

  return {
    name: 'slack',
    channelType: CHANNEL_TYPE,
    supportsThreads: true,

    async setup(config: ChannelSetup) {
      cfg = config;

      try {
        const auth = await apiCall('auth.test', {});
        botUserId = (auth['user_id'] as string) ?? null;
        log.info('[slack] Authenticated', { user: auth['user'], team: auth['team'] });
      } catch {
        log.warn('[slack] Could not verify bot token');
      }

      registerRawWebhookHandler('slack', async (req) => {
        const body = await req.text();

        if (!(await verifySignature(req, body))) {
          log.warn('[slack] Webhook signature verification failed');
          return new Response('Unauthorized', { status: 401 });
        }

        const payload = JSON.parse(body) as Record<string, unknown>;

        // Slack app installation URL verification challenge
        if (payload['type'] === 'url_verification') {
          return new Response(JSON.stringify({ challenge: payload['challenge'] }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }

        if (payload['type'] === 'event_callback') {
          const event = payload['event'] as Record<string, unknown> | undefined;
          // Slack delivers file uploads as `message` events with subtype
          // `file_share` rather than a plain message. Allow that subtype
          // through; reject all others (message_changed, message_deleted,
          // channel_join, etc.).
          if (!event || event['type'] !== 'message') {
            return new Response('OK');
          }
          const subtype = event['subtype'] as string | undefined;
          if (subtype && subtype !== 'file_share') {
            return new Response('OK');
          }
          // Ignore own messages and bot messages
          if (event['bot_id'] || event['user'] === botUserId) return new Response('OK');

          const channelId = event['channel'] as string;
          let text = (event['text'] as string) ?? '';
          const ts = event['ts'] as string;
          const threadTs = (event['thread_ts'] as string | undefined) ?? null;
          const isGroup = (event['channel_type'] as string) !== 'im';
          const platformId = namespacedPlatformId(CHANNEL_TYPE, channelId);

          // Slack file uploads arrive as `event.files: SlackFile[]`. Each file
          // exposes a `url_private` / `url_private_download` URL that requires
          // an Authorization: Bearer <bot-token> header to fetch. Mirrors the
          // pattern used by Telegram / WhatsApp / Discord adapters: every
          // successful download adds a one-line text hint AND a buffer to
          // the `files` array; failures still emit a hint so the agent
          // acknowledges the message rather than silently ignoring it.
          const files: InboundFile[] = [];
          const eventFiles = (event['files'] as SlackFile[] | undefined) ?? [];
          for (const file of eventFiles) {
            const filename = file.name || file.title || `file.${file.filetype ?? 'bin'}`;
            const mimeType = file.mimetype ?? 'application/octet-stream';
            const size = file.size ?? 0;
            if (size > INBOUND_FILE_SIZE_CAP) {
              const mb = Math.round(size / 1024 / 1024);
              text = (text ? text + '\n' : '') + `[file] ${filename} (${mb}MB — exceeds inbound limit, not downloaded)`;
              continue;
            }
            const downloadUrl = file.url_private_download ?? file.url_private;
            if (!downloadUrl) {
              text = (text ? text + '\n' : '') + `[file] ${filename} mime=${mimeType} (no url)`;
              continue;
            }
            try {
              const res = await fetch(downloadUrl, {
                headers: { Authorization: `Bearer ${token}` },
              });
              if (!res.ok) {
                log.warn('[slack] file fetch failed', { filename, status: res.status });
                text = (text ? text + '\n' : '') + `[file] ${filename} mime=${mimeType} (download failed)`;
                continue;
              }
              const buf = Buffer.from(await res.arrayBuffer());
              if (isAudioLike(mimeType)) {
                const transcript = await transcribeAudio(buf, filename, mimeType);
                if (transcript) {
                  text = (text ? text + '\n' : '') + `[voice] ${transcript}`;
                  files.push({ filename, mimeType, data: buf });
                  continue;
                }
              }
              const sizeStr = ` size=${size || buf.length}`;
              const mimeStr = ` mime=${mimeType}`;
              text = (text ? text + '\n' : '') + `[file] ${filename}${mimeStr}${sizeStr}`;
              files.push({ filename, mimeType, data: buf });
            } catch (err) {
              log.warn('[slack] file download threw', { filename, err: (err as Error).message });
              text = (text ? text + '\n' : '') + `[file] ${filename} mime=${mimeType} (download failed)`;
            }
          }

          // Drop entirely empty messages (no text, no files).
          if (!text && files.length === 0) return new Response('OK');

          const inbound: InboundMessage = {
            id: ts,
            kind: 'chat',
            content: { text },
            timestamp: new Date(parseFloat(ts) * 1000).toISOString(),
            isMention: !isGroup || (botUserId ? text.includes(`<@${botUserId}>`) : false),
            isGroup,
            ...(files.length > 0 ? { files } : {}),
          };

          if (cfg) {
            cfg.onMetadata(platformId, channelId, isGroup);
            void cfg.onInbound(platformId, threadTs, inbound);
          }
        }

        return new Response('OK');
      });

      connected = true;
      log.info('[slack] Webhook handler ready — set Slack Event URL to /webhook/slack');
    },

    async teardown() {
      connected = false;
    },

    isConnected: () => connected,

    async deliver(platformId: string, threadId: string | null, message: OutboundMessage) {
      const channelId = platformId.startsWith(`${CHANNEL_TYPE}:`)
        ? platformId.slice(`${CHANNEL_TYPE}:`.length)
        : platformId;

      const content = message.content as { text?: string };
      const text = content?.text ?? '';

      const body: Record<string, unknown> = { channel: channelId, text };
      if (threadId) body['thread_ts'] = threadId;

      const result = await apiCall('chat.postMessage', body);
      return result['ts'] as string | undefined;
    },
  };
}

registerChannelAdapter(CHANNEL_TYPE, { factory: createAdapter });
