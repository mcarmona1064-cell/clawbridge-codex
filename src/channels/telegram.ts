/**
 * Telegram channel — native Bot API long-poll adapter.
 *
 * Reads TELEGRAM_BOT_TOKEN from ~/.clawbridge/.env via readEnvFile (the host
 * doesn't load it into process.env). Speaks the Telegram Bot HTTP API
 * directly via fetch — no SDK dependency.
 *
 * Inbound: a single long-poll loop calls getUpdates with timeout=25 and
 * forwards each message into onInbound. The router uses (channelType,
 * platformId) to look up the messaging_groups row, so platformId here must
 * match what setup/register.ts wrote — `telegram:<chat_id>` per the
 * namespacedPlatformId convention in src/platform-id.ts.
 *
 * Outbound: deliver() POSTs to sendMessage. setTyping uses sendChatAction.
 */
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import type {
  ChannelAdapter,
  ChannelSetup,
  InboundFile,
  InboundMessage,
  OutboundFile,
  OutboundMessage,
} from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';
import { interceptPairingMessage } from './telegram-pairing.js';

const API_BASE = 'https://api.telegram.org';
const LONG_POLL_TIMEOUT_S = 25;
const INBOUND_FILE_SIZE_CAP = 50 * 1024 * 1024; // 50 MB

interface TgUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  is_bot?: boolean;
}

interface TgChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

interface TgMessageEntity {
  type: string;
  offset: number;
  length: number;
}

interface TgVoice {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

interface TgAudio extends TgVoice {
  performer?: string;
  title?: string;
  file_name?: string;
}

interface TgVideoNote {
  file_id: string;
  file_unique_id: string;
  duration: number;
  length: number;
  file_size?: number;
}

interface TgDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

interface TgPhotoSize {
  file_id: string;
  width: number;
  height: number;
  file_size?: number;
}

interface TgVideo {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  duration: number;
  file_size?: number;
}

interface TgSticker {
  file_id: string;
  width: number;
  height: number;
  is_animated: boolean;
  is_video: boolean;
  emoji?: string;
}

interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  date: number;
  text?: string;
  caption?: string;
  entities?: TgMessageEntity[];
  caption_entities?: TgMessageEntity[];
  voice?: TgVoice;
  audio?: TgAudio;
  video_note?: TgVideoNote;
  document?: TgDocument;
  photo?: TgPhotoSize[]; // array of sizes — largest is last
  video?: TgVideo;
  animation?: TgDocument; // Telegram sends GIFs as MP4 animations (same shape as document)
  sticker?: TgSticker;
}

interface TgFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
}

interface TgResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  parameters?: { retry_after?: number };
}

class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

function platformIdFor(chatId: number): string {
  // Match the form setup/register.ts writes via namespacedPlatformId('telegram', ...).
  // Router does no normalization on inbound, so we MUST emit the prefixed shape.
  return `telegram:${chatId}`;
}

function senderName(user: TgUser | undefined): string {
  if (!user) return 'telegram';
  if (user.first_name && user.last_name) return `${user.first_name} ${user.last_name}`;
  if (user.first_name) return user.first_name;
  if (user.username) return user.username;
  return `telegram:${user.id}`;
}

function detectMention(msg: TgMessage, botUsername: string | null): boolean {
  if (!botUsername) return false;
  const text = msg.text ?? msg.caption ?? '';
  const entities = msg.entities ?? msg.caption_entities ?? [];
  const needle = `@${botUsername.toLowerCase()}`;
  for (const e of entities) {
    if (e.type !== 'mention' && e.type !== 'bot_command') continue;
    const slice = text.substring(e.offset, e.offset + e.length).toLowerCase();
    if (slice.includes(needle)) return true;
  }
  return false;
}

function extractText(message: OutboundMessage): string | null {
  const content = message.content as Record<string, unknown> | string | undefined;
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object' && typeof content.text === 'string') {
    return content.text;
  }
  return null;
}

async function tgGet<T>(token: string, method: string, params: Record<string, string | number>): Promise<T> {
  const url = new URL(`${API_BASE}/bot${token}/${method}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new NetworkError(`fetch failed for ${method}: ${(err as Error).message}`);
  }
  const body = (await res.json().catch(() => ({}))) as TgResponse<T>;
  if (!res.ok || !body.ok) {
    if (res.status === 429 && body.parameters?.retry_after) {
      await new Promise((r) => setTimeout(r, body.parameters!.retry_after! * 1000));
      return tgGet<T>(token, method, params);
    }
    throw new Error(`Telegram ${method} failed: ${res.status} ${body.description ?? ''}`);
  }
  return body.result as T;
}

async function tgPost<T>(token: string, method: string, body: Record<string, unknown>): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new NetworkError(`fetch failed for ${method}: ${(err as Error).message}`);
  }
  const json = (await res.json().catch(() => ({}))) as TgResponse<T>;
  if (!res.ok || !json.ok) {
    if (res.status === 429 && json.parameters?.retry_after) {
      await new Promise((r) => setTimeout(r, json.parameters!.retry_after! * 1000));
      return tgPost<T>(token, method, body);
    }
    throw new Error(`Telegram ${method} failed: ${res.status} ${json.description ?? ''}`);
  }
  return json.result as T;
}

async function tgDownloadFile(token: string, fileId: string): Promise<{ data: Buffer; filename: string } | null> {
  const info = await tgGet<TgFile>(token, 'getFile', { file_id: fileId });
  if (!info.file_path) return null;
  const url = `${API_BASE}/file/bot${token}/${info.file_path}`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new NetworkError(`fetch failed for file download: ${(err as Error).message}`);
  }
  if (!res.ok) throw new Error(`Telegram file download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const filename = (info.file_path.split('/').pop() ?? `${fileId}.bin`).replace(/\.oga$/, '.ogg');
  return { data: buf, filename };
}

const GROQ_TRANSCRIBE_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_MODEL = 'whisper-large-v3-turbo';

async function transcribeWithGroq(
  apiKey: string,
  audio: { data: Buffer; filename: string },
  mimeType: string,
): Promise<string> {
  const form = new FormData();
  const blob = new Blob([new Uint8Array(audio.data)], { type: mimeType });
  form.append('file', blob, audio.filename);
  form.append('model', GROQ_MODEL);
  form.append('response_format', 'text');

  let res: Response;
  try {
    res = await fetch(GROQ_TRANSCRIBE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
  } catch (err) {
    throw new NetworkError(`Groq transcription network error: ${(err as Error).message}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Groq transcription failed: ${res.status} ${body.slice(0, 200)}`);
  }
  return (await res.text()).trim();
}

async function tgPostMultipart<T>(
  token: string,
  method: string,
  fields: Record<string, string | number>,
  file: { field: string; filename: string; data: Buffer },
): Promise<T> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
  // Buffer → Uint8Array (BlobPart) avoids a copy and works under Node 20's fetch.
  const blob = new Blob([new Uint8Array(file.data)]);
  form.append(file.field, blob, file.filename);
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/bot${token}/${method}`, { method: 'POST', body: form });
  } catch (err) {
    throw new NetworkError(`fetch failed for ${method}: ${(err as Error).message}`);
  }
  const json = (await res.json().catch(() => ({}))) as TgResponse<T>;
  if (!res.ok || !json.ok) {
    throw new Error(`Telegram ${method} failed: ${res.status} ${json.description ?? ''}`);
  }
  return json.result as T;
}

function createAdapter(): ChannelAdapter | null {
  const { TELEGRAM_BOT_TOKEN: token, GROQ_API_KEY: groqKey } = readEnvFile(['TELEGRAM_BOT_TOKEN', 'GROQ_API_KEY']);
  if (!token) return null;

  let running = false;
  let botUsername: string | null = null;
  let lastUpdateId = 0;
  let pollPromise: Promise<void> | null = null;

  async function pollLoop(config: ChannelSetup): Promise<void> {
    while (running) {
      try {
        const updates = await tgGet<TgUpdate[]>(token, 'getUpdates', {
          offset: lastUpdateId + 1,
          timeout: LONG_POLL_TIMEOUT_S,
          allowed_updates: '["message","edited_message"]',
        });
        for (const upd of updates) {
          lastUpdateId = Math.max(lastUpdateId, upd.update_id);
          const msg = upd.message;
          if (!msg) continue;
          await handleMessage(msg, config);
        }
      } catch (err) {
        if (!running) break;
        if (err instanceof NetworkError) {
          log.warn('Telegram poll network error, backing off', { err: err.message });
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
        const e = err as Error & { status?: number };
        const message = e.message || '';
        // 409 Conflict means another getUpdates session is active. Pause longer
        // — likely a stale poller from a previous launch — but don't spin.
        if (message.includes('409')) {
          log.warn('Telegram getUpdates conflict (another instance polling); waiting', { err: message });
          await new Promise((r) => setTimeout(r, 10000));
          continue;
        }
        log.error('Telegram poll error', { err: message });
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  async function transcribeVoice(msg: TgMessage): Promise<string | null> {
    const media = msg.voice ?? msg.audio ?? msg.video_note;
    if (!media) return null;
    if (!groqKey) {
      log.warn('Telegram: voice/audio received but GROQ_API_KEY not set — dropping', {
        chatId: msg.chat.id,
        duration: media.duration,
      });
      return null;
    }
    try {
      const file = await tgDownloadFile(token, media.file_id);
      if (!file) return null;
      const mime =
        ('mime_type' in media && media.mime_type) ||
        (msg.voice ? 'audio/ogg' : msg.video_note ? 'video/mp4' : 'audio/mpeg');
      const transcript = await transcribeWithGroq(groqKey, file, mime);
      return transcript;
    } catch (err) {
      log.error('Telegram: voice transcription failed', { err: (err as Error).message });
      return null;
    }
  }

  async function handleMessage(msg: TgMessage, config: ChannelSetup): Promise<void> {
    let text = msg.text ?? msg.caption ?? '';
    if (!text && (msg.voice || msg.audio || msg.video_note)) {
      const transcript = await transcribeVoice(msg);
      if (transcript) text = `[voice] ${transcript}`;
    }

    // Collect file attachments: document, photo (largest size), video, animation, sticker.
    // For every file: append a synthetic text hint for backward compat with containers that
    // don't yet parse the `files` field, and to give the agent a one-line preview.
    // Files exceeding INBOUND_FILE_SIZE_CAP are hinted but not downloaded.
    const files: InboundFile[] = [];

    async function tgCollectFile(opts: {
      fileId: string;
      fileSize?: number;
      filename: string;
      mimeType?: string;
      hintType?: string;
    }): Promise<void> {
      const { fileId, fileSize, filename, mimeType, hintType = 'document' } = opts;
      if (fileSize && fileSize > INBOUND_FILE_SIZE_CAP) {
        const mb = Math.round(fileSize / 1024 / 1024);
        text = (text ? text + '\n' : '') + `[${hintType}] ${filename} (${mb}MB — exceeds 50MB inbound limit, not downloaded)`;
        return;
      }
      const f = await tgDownloadFile(token, fileId);
      if (!f) return;
      const sizeStr = fileSize ? ` size=${fileSize}` : '';
      const mimeStr = mimeType ? ` mime=${mimeType}` : '';
      text = (text ? text + '\n' : '') + `[${hintType}] ${filename}${mimeStr}${sizeStr}`;
      files.push({ filename, mimeType, data: f.data });
    }

    if (msg.document) {
      await tgCollectFile({
        fileId: msg.document.file_id,
        fileSize: msg.document.file_size,
        filename: msg.document.file_name ?? 'file.bin',
        mimeType: msg.document.mime_type,
      });
    }
    if (msg.photo?.length) {
      const largest = msg.photo[msg.photo.length - 1];
      await tgCollectFile({
        fileId: largest.file_id,
        fileSize: largest.file_size,
        filename: 'photo.jpg',
        mimeType: 'image/jpeg',
        hintType: 'photo',
      });
    }
    if (msg.video) {
      await tgCollectFile({
        fileId: msg.video.file_id,
        fileSize: msg.video.file_size,
        filename: msg.video.file_name ?? 'video.mp4',
        mimeType: msg.video.mime_type ?? 'video/mp4',
        hintType: 'video',
      });
    }
    if (msg.animation) {
      await tgCollectFile({
        fileId: msg.animation.file_id,
        fileSize: msg.animation.file_size,
        filename: msg.animation.file_name ?? 'animation.mp4',
        mimeType: msg.animation.mime_type ?? 'video/mp4',
        hintType: 'animation',
      });
    }
    if (msg.sticker) {
      const f = await tgDownloadFile(token, msg.sticker.file_id);
      if (f) {
        const filename = f.filename || 'sticker.webp';
        text = (text ? text + '\n' : '') + `[sticker] ${filename} mime=image/webp`;
        files.push({ filename, mimeType: 'image/webp', data: f.data });
      }
    }

    // Drop messages with no text and no files (e.g. unsupported sticker types)
    if (!text && files.length === 0) return;

    const platformId = platformIdFor(msg.chat.id);
    const isGroup = msg.chat.type !== 'private';
    // Intercept pairing codes during setup — swallow the message if consumed.
    const adminUserId = msg.from ? String(msg.from.id) : undefined;
    if (interceptPairingMessage(text, platformId, isGroup, adminUserId)) return;
    const isMention = detectMention(msg, botUsername) || msg.chat.type === 'private';

    const inbound: InboundMessage = {
      id: `tg-${msg.message_id}`,
      kind: 'chat',
      timestamp: new Date(msg.date * 1000).toISOString(),
      isMention,
      isGroup,
      content: {
        text,
        sender: senderName(msg.from),
        senderId: msg.from ? `telegram:${msg.from.id}` : `telegram:${msg.chat.id}`,
      },
      ...(files.length > 0 ? { files } : {}),
    };

    // Best-effort: surface the chat name so the host can fill in
    // messaging_groups.name on auto-create. No-op on the host side beyond a log
    // line today, but harmless and future-proof.
    const name = msg.chat.title ?? msg.chat.username ?? msg.chat.first_name;
    if (name) config.onMetadata(platformId, name, isGroup);

    try {
      await config.onInbound(platformId, null, inbound);
    } catch (err) {
      log.error('Telegram: onInbound threw', { err });
    }
  }

  const adapter: ChannelAdapter = {
    name: 'telegram',
    channelType: 'telegram',
    supportsThreads: false,

    async setup(config: ChannelSetup): Promise<void> {
      // getMe doubles as a credentials check. Wrap network errors so the
      // registry's retry-on-NetworkError path engages (channel-registry.ts).
      const me = await tgGet<TgUser>(token, 'getMe', {});
      botUsername = me.username ?? null;
      // If a webhook was previously set, getUpdates returns 409. Clearing is
      // idempotent; keep_pending_updates default behavior preserves backlog.
      try {
        await tgPost(token, 'deleteWebhook', { drop_pending_updates: false });
      } catch (err) {
        log.warn('Telegram deleteWebhook failed (continuing)', { err: (err as Error).message });
      }
      log.info('Telegram bot online', { username: botUsername, id: me.id });
      running = true;
      pollPromise = pollLoop(config);
    },

    async teardown(): Promise<void> {
      running = false;
      if (pollPromise) {
        try {
          await pollPromise;
        } catch {
          // swallow — teardown is best-effort
        }
        pollPromise = null;
      }
    },

    isConnected(): boolean {
      return running && botUsername !== null;
    },

    async deliver(platformId, _threadId, message: OutboundMessage): Promise<string | undefined> {
      const chatId = platformId.startsWith('telegram:') ? platformId.slice('telegram:'.length) : platformId;
      const text = extractText(message);
      const files = message.files ?? [];

      let lastMessageId: string | undefined;
      if (text) {
        const sent = await tgPost<{ message_id: number }>(token, 'sendMessage', {
          chat_id: chatId,
          text,
        });
        lastMessageId = String(sent.message_id);
      }
      for (const f of files as OutboundFile[]) {
        const sent = await tgPostMultipart<{ message_id: number }>(
          token,
          'sendDocument',
          { chat_id: chatId },
          { field: 'document', filename: f.filename, data: f.data },
        );
        lastMessageId = String(sent.message_id);
      }
      return lastMessageId;
    },

    async setTyping(platformId): Promise<void> {
      const chatId = platformId.startsWith('telegram:') ? platformId.slice('telegram:'.length) : platformId;
      try {
        await tgPost(token, 'sendChatAction', { chat_id: chatId, action: 'typing' });
      } catch (err) {
        // Typing indicators are nice-to-have — never fail the request over them.
        // Logged at INFO so silent API failures (rate limits, network blips) are visible.
        log.info('Telegram setTyping failed', { err: (err as Error).message, chatId });
      }
    },
  };

  return adapter;
}

registerChannelAdapter('telegram', { factory: createAdapter });
