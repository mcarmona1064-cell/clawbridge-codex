/**
 * WhatsApp channel adapter — Meta Cloud API (official Business API).
 * Reads WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_ACCESS_TOKEN, WHATSAPP_WEBHOOK_VERIFY_TOKEN.
 *
 * In your Meta app (developers.facebook.com):
 *   WhatsApp → Configuration → Webhook URL: http(s)://<host>:3000/webhook/whatsapp
 *   Webhook fields: messages
 *
 * Media handling: when the user sends image/video/audio/voice/document/sticker,
 * Meta's webhook delivers a media descriptor `{id, mime_type, sha256, caption?,
 * filename?}` (no inline data). To fetch the bytes we do two requests:
 *   1. GET /{media-id}                → {url, mime_type, file_size, ...}
 *   2. GET <url>  (Authorization: Bearer <token>)  → binary
 * Both require the bot's access token. URLs from step 1 expire after ~5 min,
 * so we fetch eagerly on receipt rather than passing the id downstream.
 */
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { namespacedPlatformId } from '../platform-id.js';
import { registerRawWebhookHandler } from '../webhook-server.js';
import type {
  ChannelAdapter,
  ChannelSetup,
  InboundFile,
  InboundMessage,
  OutboundMessage,
} from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

const CHANNEL_TYPE = 'whatsapp';
const GRAPH_API = 'https://graph.facebook.com/v18.0';
const INBOUND_FILE_SIZE_CAP = 50 * 1024 * 1024; // 50 MB — matches Telegram

/** WhatsApp message types that carry an attached media descriptor. */
const MEDIA_TYPES = ['image', 'video', 'audio', 'voice', 'document', 'sticker'] as const;
type MediaType = (typeof MEDIA_TYPES)[number];

interface WaMediaDescriptor {
  id: string;
  mime_type?: string;
  sha256?: string;
  caption?: string;
  filename?: string;
}

function createAdapter(): ChannelAdapter | null {
  const env = readEnvFile(['WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_WEBHOOK_VERIFY_TOKEN']);
  const phoneNumberId = env['WHATSAPP_PHONE_NUMBER_ID'];
  const accessToken = env['WHATSAPP_ACCESS_TOKEN'];
  const verifyToken = env['WHATSAPP_WEBHOOK_VERIFY_TOKEN'];
  if (!phoneNumberId || !accessToken) return null;

  let cfg: ChannelSetup | null = null;
  let connected = false;

  async function sendText(to: string, text: string): Promise<string | undefined> {
    const res = await fetch(`${GRAPH_API}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } }),
    });
    const data = (await res.json()) as { messages?: Array<{ id: string }> };
    return data.messages?.[0]?.id;
  }

  /**
   * Fetch media bytes via Meta's two-step flow. Returns null on any failure —
   * caller should still produce a textual hint so the agent knows a media
   * message arrived even if download failed.
   */
  async function waDownloadMedia(
    mediaId: string,
  ): Promise<{ data: Buffer; mimeType: string; size: number } | null> {
    try {
      const metaRes = await fetch(`${GRAPH_API}/${mediaId}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!metaRes.ok) {
        log.warn('[whatsapp] media metadata fetch failed', { mediaId, status: metaRes.status });
        return null;
      }
      const meta = (await metaRes.json()) as { url?: string; mime_type?: string; file_size?: number };
      if (!meta.url) {
        log.warn('[whatsapp] media metadata missing url', { mediaId });
        return null;
      }
      const size = typeof meta.file_size === 'number' ? meta.file_size : 0;
      if (size > INBOUND_FILE_SIZE_CAP) {
        log.warn('[whatsapp] media exceeds size cap, skipping download', { mediaId, size });
        return null;
      }
      const binRes = await fetch(meta.url, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!binRes.ok) {
        log.warn('[whatsapp] media bytes fetch failed', { mediaId, status: binRes.status });
        return null;
      }
      const arrayBuffer = await binRes.arrayBuffer();
      return {
        data: Buffer.from(arrayBuffer),
        mimeType: meta.mime_type ?? 'application/octet-stream',
        size: size || arrayBuffer.byteLength,
      };
    } catch (err) {
      log.warn('[whatsapp] media download threw', { mediaId, err: (err as Error).message });
      return null;
    }
  }

  /** Pick a sensible filename for a WhatsApp media descriptor. */
  function fileNameFor(type: MediaType, desc: WaMediaDescriptor): string {
    if (desc.filename) return desc.filename;
    const ext =
      type === 'image' ? '.jpg' :
      type === 'video' ? '.mp4' :
      type === 'audio' ? '.ogg' :
      type === 'voice' ? '.ogg' :
      type === 'sticker' ? '.webp' :
      ''; // 'document' usually carries .filename; bare fallback otherwise
    return `${type}${ext}`;
  }

  return {
    name: 'whatsapp',
    channelType: CHANNEL_TYPE,
    supportsThreads: false,

    async setup(config: ChannelSetup) {
      cfg = config;

      registerRawWebhookHandler('whatsapp', async (req) => {
        const url = new URL(req.url);

        // Meta webhook verification (GET request)
        if (req.method === 'GET') {
          if (verifyToken && url.searchParams.get('hub.verify_token') !== verifyToken) {
            return new Response('Forbidden', { status: 403 });
          }
          return new Response(url.searchParams.get('hub.challenge') ?? 'OK');
        }

        // Inbound messages (POST)
        let body: Record<string, unknown>;
        try {
          body = (await req.json()) as Record<string, unknown>;
        } catch {
          return new Response('Bad Request', { status: 400 });
        }

        const entries = (body['entry'] as Array<Record<string, unknown>>) ?? [];
        for (const entry of entries) {
          const changes = (entry['changes'] as Array<Record<string, unknown>>) ?? [];
          for (const change of changes) {
            const value = change['value'] as Record<string, unknown> | undefined;
            if (!value) continue;
            const messages = (value['messages'] as Array<Record<string, unknown>>) ?? [];
            for (const msg of messages) {
              const msgType = msg['type'] as string;
              const from = msg['from'] as string;
              const msgId = msg['id'] as string;
              const platformId = namespacedPlatformId(CHANNEL_TYPE, from);

              // Start with plain text (text message body OR media caption).
              let text = '';
              if (msgType === 'text') {
                const textObj = msg['text'] as Record<string, string> | undefined;
                text = textObj?.['body'] ?? '';
              }

              // Collect file attachments. Mirrors the Telegram adapter's
              // pattern: each successful download adds a one-line text hint
              // *and* pushes a buffer to `files`. Failures still emit a hint
              // so the agent knows media arrived.
              const files: InboundFile[] = [];
              if (MEDIA_TYPES.includes(msgType as MediaType)) {
                const type = msgType as MediaType;
                const desc = msg[type] as WaMediaDescriptor | undefined;
                if (desc?.id) {
                  // Captions live on the media payload, not on the message.
                  if (desc.caption) text = text ? `${text}\n${desc.caption}` : desc.caption;
                  const filename = fileNameFor(type, desc);
                  const downloaded = await waDownloadMedia(desc.id);
                  if (downloaded) {
                    const sizeStr = ` size=${downloaded.size}`;
                    const mimeStr = ` mime=${downloaded.mimeType}`;
                    text =
                      (text ? text + '\n' : '') +
                      `[${type}] ${filename}${mimeStr}${sizeStr}`;
                    files.push({
                      filename,
                      mimeType: downloaded.mimeType,
                      data: downloaded.data,
                    });
                  } else {
                    // Hint without download — agent should still acknowledge.
                    const mimeStr = desc.mime_type ? ` mime=${desc.mime_type}` : '';
                    text =
                      (text ? text + '\n' : '') +
                      `[${type}] ${filename}${mimeStr} (download failed)`;
                  }
                }
              }

              // Drop messages we don't handle (reactions, location, contacts,
              // interactive button responses, etc.) when they carry no usable
              // text or files. Matches the Telegram adapter's behavior.
              if (!text && files.length === 0) continue;

              const inbound: InboundMessage = {
                id: msgId,
                kind: 'chat',
                content: { text },
                timestamp: new Date().toISOString(),
                isGroup: false,
                ...(files.length > 0 ? { files } : {}),
              };

              if (cfg) {
                cfg.onMetadata(platformId, from, false);
                void cfg.onInbound(platformId, null, inbound);
              }
            }
          }
        }

        return new Response(JSON.stringify({ status: 'ok' }), {
          headers: { 'Content-Type': 'application/json' },
        });
      });

      connected = true;
      log.info('[whatsapp] Webhook registered — set Meta Webhook URL to /webhook/whatsapp');
    },

    async teardown() {
      connected = false;
    },

    isConnected: () => connected,

    async deliver(platformId: string, _threadId: string | null, message: OutboundMessage) {
      const to = platformId.startsWith(`${CHANNEL_TYPE}:`) ? platformId.slice(`${CHANNEL_TYPE}:`.length) : platformId;

      const content = message.content as { text?: string };
      const text = content?.text ?? '';
      return sendText(to, text);
    },
  };
}

registerChannelAdapter(CHANNEL_TYPE, { factory: createAdapter });
