/**
 * Layer 1 runtime error catching and auto-diagnosis.
 *
 * Call initErrorHandler() once at startup. It registers uncaughtException and
 * unhandledRejection handlers, logs errors to ~/.clawbridge/errors.log,
 * sends Telegram alerts, requests Claude diagnosis, and optionally watches for
 * a "fix it" reply.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { readEnvFile } from './env.js';
import { log } from './log.js';

// ── Config ──────────────────────────────────────────────────────────────────

const envCfg = readEnvFile([
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'TELEGRAM_ALERT_CHAT_ID',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ERROR_AUTO_FIX',
]);

function cfg(key: string): string {
  return process.env[key] || envCfg[key] || '';
}

const LOG_DIR = path.join(os.homedir(), '.clawbridge');
const LOG_FILE = path.join(LOG_DIR, 'errors.log');
const CONTEXT_LINES = 50; // lines of source to include either side of error line

// ── Types ───────────────────────────────────────────────────────────────────

interface ErrorLogEntry {
  ts: string;
  error: string;
  stack: string;
  file: string;
  uptime: number;
  context?: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function ensureLogDir(): void {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch {
    // ignore
  }
}

function appendLog(entry: ErrorLogEntry): void {
  try {
    ensureLogDir();
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n', 'utf-8');
  } catch (metaErr) {
    console.error('[error-handler] Failed to write error log:', metaErr);
  }
}

/** Extract "src/some-file.ts:47" from a stack trace string. */
function extractFileFromStack(stack: string): { file: string; line: number } | null {
  // Match patterns like: at ... (src/foo.ts:47:12) or at src/foo.ts:47:12
  const patterns = [
    /\(([^)]*\.ts):(\d+):\d+\)/,
    /at ([^\s]*\.ts):(\d+):\d+/,
    /\(([^)]*\.js):(\d+):\d+\)/,
    /at ([^\s]*\.js):(\d+):\d+/,
  ];
  for (const re of patterns) {
    const m = stack.match(re);
    if (m) {
      // Skip node internals
      if (m[1].startsWith('node:') || m[1].includes('node_modules')) continue;
      return { file: m[1], line: parseInt(m[2], 10) };
    }
  }
  return null;
}

/** Read ~CONTEXT_LINES lines around errorLine from a file. */
function readFileContext(file: string, errorLine: number): string {
  try {
    // Try absolute path first, then relative to cwd
    let content: string;
    let resolvedPath = file;
    if (!path.isAbsolute(file)) {
      resolvedPath = path.join(process.cwd(), file);
    }
    content = fs.readFileSync(resolvedPath, 'utf-8');
    const lines = content.split('\n');
    const start = Math.max(0, errorLine - Math.floor(CONTEXT_LINES / 2) - 1);
    const end = Math.min(lines.length, errorLine + Math.floor(CONTEXT_LINES / 2));
    return lines
      .slice(start, end)
      .map((l, i) => `${start + i + 1}${start + i + 1 === errorLine ? ' >>>' : '    '} ${l}`)
      .join('\n');
  } catch {
    return '(could not read source file)';
  }
}

// ── Telegram ─────────────────────────────────────────────────────────────────

async function sendTelegram(text: string): Promise<number | null> {
  const token = cfg('TELEGRAM_BOT_TOKEN');
  const chatId = cfg('TELEGRAM_ALERT_CHAT_ID') || cfg('TELEGRAM_CHAT_ID');
  if (!token || !chatId) return null;

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
    const data = (await res.json()) as { ok: boolean; result?: { message_id: number } };
    if (data.ok && data.result) return data.result.message_id;
  } catch (metaErr) {
    console.error('[error-handler] Failed to send Telegram alert:', metaErr);
  }
  return null;
}

/**
 * Poll Telegram for a "fix it" reply for up to 5 minutes.
 * Returns true if the reply was received.
 */
async function pollForFixIt(afterMessageId: number): Promise<boolean> {
  const token = cfg('TELEGRAM_BOT_TOKEN');
  const chatId = cfg('TELEGRAM_ALERT_CHAT_ID') || cfg('TELEGRAM_CHAT_ID');
  if (!token || !chatId) return false;

  const deadline = Date.now() + 5 * 60 * 1000;
  let offset: number | undefined;

  while (Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, 10_000));
    try {
      const url = new URL(`https://api.telegram.org/bot${token}/getUpdates`);
      url.searchParams.set('timeout', '9');
      if (offset !== undefined) url.searchParams.set('offset', String(offset));

      const res = await fetch(url.toString());
      const data = (await res.json()) as {
        ok: boolean;
        result: Array<{
          update_id: number;
          message?: {
            message_id: number;
            chat: { id: number };
            text?: string;
            reply_to_message?: { message_id: number };
          };
        }>;
      };

      if (!data.ok) continue;
      for (const update of data.result) {
        offset = update.update_id + 1;
        const msg = update.message;
        if (!msg) continue;
        if (String(msg.chat.id) !== String(chatId)) continue;
        const isReply = msg.reply_to_message?.message_id === afterMessageId;
        const isDirectFix = !msg.reply_to_message && msg.message_id > afterMessageId;
        if (isReply || isDirectFix) {
          const text = (msg.text || '').toLowerCase().trim();
          if (text === 'fix it' || text === 'fix') return true;
        }
      }
    } catch (metaErr) {
      console.error('[error-handler] Telegram poll error:', metaErr);
    }
  }
  return false;
}

// ── Claude diagnosis ─────────────────────────────────────────────────────────

async function getDiagnosis(error: Error, fileContext: string): Promise<string> {
  const apiKey = cfg('ANTHROPIC_API_KEY');
  const oauthToken = cfg('CLAUDE_CODE_OAUTH_TOKEN');
  const authHeader = oauthToken ? `Bearer ${oauthToken}` : apiKey ? undefined : null;

  if (authHeader === null && !apiKey) return '(no Anthropic credentials configured)';

  const prompt =
    `Error: ${error.message}\n` +
    `Stack: ${error.stack || '(no stack)'}\n\n` +
    `File content:\n${fileContext}\n\n` +
    `Diagnose this error in 2-3 sentences. Suggest the specific fix.`;

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    };
    if (oauthToken) {
      headers['Authorization'] = `Bearer ${oauthToken}`;
    } else {
      headers['x-api-key'] = apiKey;
    }

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'claude-opus-4-5-20251001',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = (await res.json()) as {
      content?: Array<{ type: string; text: string }>;
      error?: { message: string };
    };

    if (data.error) return `(Claude API error: ${data.error.message})`;
    const text = data.content?.find((b) => b.type === 'text')?.text;
    return text || '(empty diagnosis)';
  } catch (metaErr) {
    console.error('[error-handler] Failed to call Claude API:', metaErr);
    return '(diagnosis unavailable)';
  }
}

// ── Apply fix via Claude Code SDK ────────────────────────────────────────────

async function applyFix(error: Error, fileContext: string): Promise<void> {
  try {
    // Dynamically import to avoid hard dep if package not present
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);

    const prompt =
      `Fix this runtime error:\n\n` +
      `Error: ${error.message}\n` +
      `Stack: ${error.stack || '(no stack)'}\n\n` +
      `File content:\n${fileContext}\n\n` +
      `Apply the minimal fix needed to resolve this error. Edit the file in place.`;

    log.info('[error-handler] Applying auto-fix via Claude Code SDK');
    await execFileAsync('claude', ['--print', prompt], { timeout: 120_000, cwd: process.cwd() });
    log.info('[error-handler] Auto-fix applied, restarting...');

    // Restart: re-exec current process
    const { spawn } = await import('child_process');
    const child = spawn(process.execPath, process.argv.slice(1), {
      detached: true,
      stdio: 'inherit',
      env: process.env,
    });
    child.unref();
    process.exit(0);
  } catch (metaErr) {
    console.error('[error-handler] Auto-fix failed:', metaErr);
    await sendTelegram('⚠️ Auto-fix attempted but failed. Manual intervention required.');
  }
}

// ── Core handler ─────────────────────────────────────────────────────────────

async function handleError(error: Error, context?: string): Promise<void> {
  const ts = new Date().toISOString();
  const fileInfo = extractFileFromStack(error.stack || '');
  const fileLabel = fileInfo ? `${fileInfo.file}:${fileInfo.line}` : 'unknown';

  // 1. Log to file
  const entry: ErrorLogEntry = {
    ts,
    error: error.message,
    stack: error.stack || '',
    file: fileLabel,
    uptime: process.uptime(),
    ...(context ? { context } : {}),
  };
  appendLog(entry);

  // 2. Send initial Telegram alert
  const alertText =
    `🚨 ClawBridge Error\n\n` +
    `<b>File:</b> ${fileLabel}\n` +
    `<b>Error:</b> ${error.message}\n\n` +
    `Investigating...`;

  const alertMsgId = await sendTelegram(alertText);

  // 4. Get file context
  const fileContext = fileInfo ? readFileContext(fileInfo.file, fileInfo.line) : '(no source context)';

  // 5. Call Claude for diagnosis
  const diagnosis = await getDiagnosis(error, fileContext);

  // 6. Send diagnosis follow-up
  const diagText =
    `🔍 Diagnosis:\n\n` +
    diagnosis +
    `\n\n` +
    (cfg('ERROR_AUTO_FIX') === 'true' ? `Auto-fix available — reply "fix it" to apply.` : '');

  const diagMsgId = await sendTelegram(diagText);

  // 7. Watch for "fix it" reply if auto-fix enabled
  if (cfg('ERROR_AUTO_FIX') === 'true' && diagMsgId !== null) {
    log.info('[error-handler] Watching for "fix it" reply for 5 minutes');
    const shouldFix = await pollForFixIt(diagMsgId);
    if (shouldFix) {
      await applyFix(error, fileContext);
    } else {
      log.info('[error-handler] No fix-it reply received within 5 minutes');
      appendLog({ ...entry, context: 'fix-it timeout — no reply' });
    }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

let initialized = false;

/**
 * Call once at startup. Registers process-level error handlers.
 * Safe to call multiple times — only registers once.
 */
export function initErrorHandler(): void {
  if (initialized) return;
  initialized = true;

  // Remove any existing handlers registered by log.ts so we can add ours
  // (we still call log.fatal/log.error before our async work)
  process.removeAllListeners('uncaughtException');
  process.removeAllListeners('unhandledRejection');

  process.on('uncaughtException', (err: Error) => {
    log.fatal('Uncaught exception', { err });
    handleError(err, 'uncaughtException').finally(() => {
      process.exit(1);
    });
  });

  process.on('unhandledRejection', (reason: unknown) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    log.error('Unhandled rejection', { err });
    handleError(err, 'unhandledRejection').catch((metaErr) => {
      console.error('[error-handler] meta-error in unhandledRejection handler:', metaErr);
    });
  });

  log.info('[error-handler] Initialized');
}

/**
 * Manually log an error without crashing the process.
 */
export function logError(error: Error, context?: string): void {
  const ts = new Date().toISOString();
  const fileInfo = extractFileFromStack(error.stack || '');
  const fileLabel = fileInfo ? `${fileInfo.file}:${fileInfo.line}` : 'unknown';

  const entry: ErrorLogEntry = {
    ts,
    error: error.message,
    stack: error.stack || '',
    file: fileLabel,
    uptime: process.uptime(),
    ...(context ? { context } : {}),
  };
  appendLog(entry);
  log.error(`[error-handler] ${error.message}`, { file: fileLabel, context: context || '' });
}

/**
 * Read the last N errors from the log file.
 */
export function getRecentErrors(limit = 10): ErrorLogEntry[] {
  try {
    const content = fs.readFileSync(LOG_FILE, 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim());
    return lines
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line) as ErrorLogEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is ErrorLogEntry => e !== null);
  } catch {
    return [];
  }
}
