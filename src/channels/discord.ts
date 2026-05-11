/**
 * Discord channel adapter — connects a Discord bot via Gateway WebSocket.
 * Reads DISCORD_BOT_TOKEN from ~/.clawbridge/.env.
 *
 * Requires Message Content Intent enabled in the Discord Developer Portal
 * (Application → Bot → Privileged Gateway Intents → Message Content Intent).
 *
 * The bot responds to:
 *   - Direct messages (any message)
 *   - Guild channel messages that @mention the bot
 */
import type { DMChannel, Message as DjsMessage, TextChannel } from 'discord.js';
import { Client, Events, GatewayIntentBits, Partials } from 'discord.js';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { namespacedPlatformId } from '../platform-id.js';
import type { ChannelAdapter, ChannelSetup, InboundMessage, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

const CHANNEL_TYPE = 'discord';
const MAX_LEN = 2000;

function splitText(text: string): string[] {
  if (text.length <= MAX_LEN) return [text];
  const chunks: string[] = [];
  let rem = text;
  while (rem.length > 0) {
    if (rem.length <= MAX_LEN) {
      chunks.push(rem);
      break;
    }
    const slice = rem.slice(0, MAX_LEN);
    const cut = slice.lastIndexOf('\n') > 100 ? slice.lastIndexOf('\n') : MAX_LEN;
    chunks.push(rem.slice(0, cut));
    rem = rem.slice(cut).trimStart();
  }
  return chunks;
}

function createAdapter(): ChannelAdapter | null {
  const env = readEnvFile(['DISCORD_BOT_TOKEN']);
  const token = env['DISCORD_BOT_TOKEN'];
  if (!token) return null;

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel],
  });

  let cfg: ChannelSetup | null = null;
  let connected = false;

  client.on(Events.MessageCreate, (msg: DjsMessage) => {
    if (!cfg || msg.author.bot) return;
    // In guilds: only respond when the bot is @mentioned; always respond in DMs.
    if (msg.guild && !msg.mentions.users.has(client.user!.id)) return;

    const platformId = namespacedPlatformId(CHANNEL_TYPE, msg.channelId);
    const threadId = msg.guildId ? msg.id : null;
    const isGroup = !!msg.guild;

    const inbound: InboundMessage = {
      id: msg.id,
      kind: 'chat',
      content: { text: msg.cleanContent || msg.content },
      timestamp: new Date(msg.createdTimestamp).toISOString(),
      isMention: true,
      isGroup,
    };

    const channelName = isGroup ? `#${(msg.channel as TextChannel).name}` : `DM:${msg.author.username}`;
    cfg.onMetadata(platformId, channelName, isGroup);
    void cfg.onInbound(platformId, threadId, inbound);
  });

  client.on(Events.Error, (err) => log.error('[discord] client error', { err }));

  return {
    name: 'discord',
    channelType: CHANNEL_TYPE,
    supportsThreads: true,

    async setup(config: ChannelSetup) {
      cfg = config;
      await client.login(token);
      connected = true;
      log.info('[discord] Bot connected', { tag: client.user?.tag });
    },

    async teardown() {
      connected = false;
      client.destroy();
    },

    isConnected: () => connected,

    async deliver(platformId: string, _threadId: string | null, message: OutboundMessage) {
      const channelId = platformId.startsWith(`${CHANNEL_TYPE}:`)
        ? platformId.slice(`${CHANNEL_TYPE}:`.length)
        : platformId;

      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel?.isTextBased()) throw new Error(`[discord] channel ${channelId} not found`);

      const content = message.content as { text?: string };
      const text = content?.text ?? '';
      let lastId: string | undefined;
      for (const chunk of splitText(text)) {
        const sent = await (channel as TextChannel | DMChannel).send(chunk);
        lastId = sent.id;
      }
      return lastId;
    },
  };
}

registerChannelAdapter(CHANNEL_TYPE, { factory: createAdapter });
