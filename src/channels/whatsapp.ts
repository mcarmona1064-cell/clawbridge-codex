/**
 * WhatsApp channel adapter — Meta Cloud API (official Business API).
 * Reads WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_ACCESS_TOKEN, WHATSAPP_WEBHOOK_VERIFY_TOKEN.
 *
 * In your Meta app (developers.facebook.com):
 *   WhatsApp → Configuration → Webhook URL: http(s)://<host>:3000/webhook/whatsapp
 *   Webhook fields: messages
 */
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { namespacedPlatformId } from '../platform-id.js';
import { registerRawWebhookHandler } from '../webhook-server.js';
import type { ChannelAdapter, ChannelSetup, InboundMessage, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

const CHANNEL_TYPE = 'whatsapp';
const GRAPH_API = 'https://graph.facebook.com/v18.0';

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
              if (msg['type'] !== 'text') continue;
              const from = msg['from'] as string;
              const msgId = msg['id'] as string;
              const textObj = msg['text'] as Record<string, string> | undefined;
              const text = textObj?.['body'] ?? '';
              const platformId = namespacedPlatformId(CHANNEL_TYPE, from);

              const inbound: InboundMessage = {
                id: msgId,
                kind: 'chat',
                content: { text },
                timestamp: new Date().toISOString(),
                isGroup: false,
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
      const to = platformId.startsWith(`${CHANNEL_TYPE}:`)
        ? platformId.slice(`${CHANNEL_TYPE}:`.length)
        : platformId;

      const content = message.content as { text?: string };
      const text = content?.text ?? '';
      return sendText(to, text);
    },
  };
}

registerChannelAdapter(CHANNEL_TYPE, { factory: createAdapter });
