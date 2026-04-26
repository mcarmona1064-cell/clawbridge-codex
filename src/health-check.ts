/**
 * Health monitoring for ClawBridge.
 *
 * Call startHealthCheck() once at startup. Every intervalMs it verifies:
 *   1. Docker daemon is accessible
 *   2. Database is readable
 *   3. At least one channel adapter is registered
 *   4. Memory usage is under 80% of available
 *
 * Failures are logged and sent as Telegram alerts.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import { log } from './log.js';
import { getDb } from './db/connection.js';
import { getActiveAdapters } from './channels/channel-registry.js';

const execFileAsync = promisify(execFile);

const MEMORY_THRESHOLD = 0.8; // 80%

// ── Telegram helper (duplicated here to keep health-check self-contained) ────

import { readEnvFile } from './env.js';

const envCfg = readEnvFile(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'TELEGRAM_ALERT_CHAT_ID']);

function cfg(key: string): string {
  return process.env[key] || envCfg[key] || '';
}

async function sendTelegramAlert(text: string): Promise<void> {
  const token = cfg('TELEGRAM_BOT_TOKEN');
  const chatId = cfg('TELEGRAM_ALERT_CHAT_ID') || cfg('TELEGRAM_CHAT_ID');
  if (!token || !chatId) return;

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
  } catch (err) {
    console.error('[health-check] Failed to send Telegram alert:', err);
  }
}

// ── Individual checks ─────────────────────────────────────────────────────────

interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

async function checkDocker(): Promise<CheckResult> {
  try {
    await execFileAsync('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 10_000 });
    return { name: 'Docker', ok: true };
  } catch (err) {
    return { name: 'Docker', ok: false, detail: String(err) };
  }
}

function checkDatabase(): CheckResult {
  try {
    const db = getDb();
    // Simple read to verify accessibility
    db.prepare('SELECT 1').get();
    return { name: 'Database', ok: true };
  } catch (err) {
    return { name: 'Database', ok: false, detail: String(err) };
  }
}

function checkChannels(): CheckResult {
  try {
    const adapters = getActiveAdapters();
    if (adapters.length === 0) {
      return { name: 'Channels', ok: false, detail: 'No active channel adapters registered' };
    }
    return { name: 'Channels', ok: true, detail: `${adapters.length} active` };
  } catch (err) {
    return { name: 'Channels', ok: false, detail: String(err) };
  }
}

function checkMemory(): CheckResult {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedRatio = (totalMem - freeMem) / totalMem;
  const usedPct = Math.round(usedRatio * 100);

  if (usedRatio >= MEMORY_THRESHOLD) {
    return {
      name: 'Memory',
      ok: false,
      detail: `${usedPct}% used (threshold: ${MEMORY_THRESHOLD * 100}%)`,
    };
  }
  return { name: 'Memory', ok: true, detail: `${usedPct}% used` };
}

// ── Status icon ───────────────────────────────────────────────────────────────

function icon(ok: boolean): string {
  return ok ? '✅' : '❌';
}

// ── Main health check loop ────────────────────────────────────────────────────

let healthCheckTimer: NodeJS.Timeout | null = null;

export function startHealthCheck(intervalMs = 60_000): void {
  if (healthCheckTimer) return; // already running

  const run = async () => {
    let results: CheckResult[];
    try {
      results = await Promise.all([
        checkDocker(),
        Promise.resolve(checkDatabase()),
        Promise.resolve(checkChannels()),
        Promise.resolve(checkMemory()),
      ]);
    } catch (err) {
      console.error('[health-check] Unexpected error during health checks:', err);
      return;
    }

    const anyFailed = results.some((r) => !r.ok);
    if (!anyFailed) {
      log.debug('[health-check] All checks passed');
      return;
    }

    const lines = results.map((r) => `${icon(r.ok)} ${r.name}${r.ok ? '' : `: ${r.detail ?? 'failed'}`}`).join('\n');

    const alertText =
      `⚠️ ClawBridge Health Warning\n\n` +
      results.map((r) => `${icon(r.ok)} ${r.name}${!r.ok && r.detail ? `: ${r.detail}` : ''}`).join('\n') +
      `\n\nNo action required — monitoring.`;

    log.warn('[health-check] Health check failures detected', {
      failed: results
        .filter((r) => !r.ok)
        .map((r) => r.name)
        .join(', '),
    });

    await sendTelegramAlert(alertText);
  };

  // Run immediately, then on interval
  run().catch((err) => console.error('[health-check] Initial run error:', err));
  healthCheckTimer = setInterval(() => {
    run().catch((err) => console.error('[health-check] Interval run error:', err));
  }, intervalMs);

  log.info('[health-check] Started', { intervalMs });
}

export function stopHealthCheck(): void {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
    healthCheckTimer = null;
    log.info('[health-check] Stopped');
  }
}
