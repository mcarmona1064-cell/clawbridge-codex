/**
 * Health monitoring for ClawBridge.
 *
 * Call startHealthCheck() once at startup. Every intervalMs it verifies:
 *   1. Docker daemon is accessible
 *   2. Hindsight containers are running
 *   3. Database is readable
 *   4. At least one channel adapter is registered
 *   5. Memory usage is under 80% of available
 *
 * On failure, auto-heal is attempted first. If the fix succeeds a "fixed"
 * notification is sent; if it fails a "still broken" alert is sent instead.
 * A 5-minute cooldown per component prevents fix-spam on persistent failures.
 */

import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { log } from './log.js';
import { getDb } from './db/connection.js';
import { getActiveAdapters } from './channels/channel-registry.js';

const MEMORY_THRESHOLD = 0.8; // 80%
const FIX_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes between fix attempts per component

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

// ── Auto-heal cooldown ────────────────────────────────────────────────────────

const lastFixAttempt = new Map<string, number>();

function canAttemptFix(key: string): boolean {
  const last = lastFixAttempt.get(key) ?? 0;
  return Date.now() - last > FIX_COOLDOWN_MS;
}

function markFixAttempt(key: string): void {
  lastFixAttempt.set(key, Date.now());
}

// ── Auto-heal actions ─────────────────────────────────────────────────────────

async function tryStartDockerDaemon(): Promise<boolean> {
  if (!canAttemptFix('docker-daemon')) return false;
  markFixAttempt('docker-daemon');

  try {
    if (process.platform === 'darwin') {
      spawnSync('open', ['-a', 'Docker'], { stdio: 'pipe' });
      // Poll up to 30s for Docker Desktop to start
      for (let i = 0; i < 6; i++) {
        await new Promise<void>((r) => setTimeout(r, 5000));
        const r = spawnSync('docker', ['info'], { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' });
        if (r.status === 0) return true;
      }
    } else {
      // Linux/VPS: try user systemctl first, then sudo
      const tried = spawnSync('systemctl', ['start', 'docker'], { stdio: 'pipe', timeout: 10000 });
      if (tried.status !== 0) {
        spawnSync('sudo', ['systemctl', 'start', 'docker'], { stdio: 'pipe', timeout: 10000 });
      }
      await new Promise<void>((r) => setTimeout(r, 3000));
      const r = spawnSync('docker', ['info'], { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' });
      return r.status === 0;
    }
  } catch {
    /* ignore */
  }
  return false;
}

async function tryStartContainers(): Promise<boolean> {
  if (!canAttemptFix('docker-containers')) return false;
  markFixAttempt('docker-containers');

  try {
    const clawbridgeDir = path.join(os.homedir(), '.clawbridge');
    execFileSync('docker', ['compose', 'up', '-d'], { cwd: clawbridgeDir, stdio: 'pipe' });
    await new Promise<void>((r) => setTimeout(r, 3000));
    return true;
  } catch {
    return false;
  }
}

async function tryRestartClawBridgeService(): Promise<boolean> {
  if (!canAttemptFix('clawbridge-service')) return false;
  markFixAttempt('clawbridge-service');

  try {
    if (process.platform === 'darwin') {
      const launchAgentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
      let plists: string[] = [];
      try {
        plists = fs.readdirSync(launchAgentsDir).filter(
          (f) => f.startsWith('com.clawbridge-v2-') && f.endsWith('.plist'),
        );
      } catch { /* ignore */ }
      if (plists.length === 0) return false;
      const label = plists[0].replace(/\.plist$/, '');
      const uid = execFileSync('id', ['-u'], { encoding: 'utf-8' }).trim();
      spawnSync('launchctl', ['kickstart', '-k', `gui/${uid}/${label}`], {
        encoding: 'utf-8',
        timeout: 15000,
        stdio: 'pipe',
      });
      return true;
    } else {
      // Linux/VPS
      const homeDir = os.homedir();
      const userUnitDir = path.join(homeDir, '.config', 'systemd', 'user');
      let unitName: string | null = null;

      try {
        const files = fs.readdirSync(userUnitDir);
        const unit = files.find((f) => f.startsWith('clawbridge') && f.endsWith('.service'));
        if (unit) unitName = unit.replace('.service', '');
      } catch { /* ignore */ }

      if (!unitName) {
        try {
          const sysFiles = fs.readdirSync('/etc/systemd/system/');
          const unit = sysFiles.find((f) => f.startsWith('clawbridge') && f.endsWith('.service'));
          if (unit) unitName = unit.replace('.service', '');
        } catch { /* ignore */ }
      }

      if (!unitName) return false;
      const isRoot = process.getuid?.() === 0;
      const args = isRoot ? ['restart', unitName] : ['--user', 'restart', unitName];
      execFileSync('systemctl', args, { stdio: 'pipe' });
      return true;
    }
  } catch {
    return false;
  }
}

// ── Individual checks ─────────────────────────────────────────────────────────

interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

async function checkDocker(): Promise<CheckResult> {
  const r = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
    encoding: 'utf-8',
    timeout: 10_000,
    stdio: 'pipe',
  });
  if (r.status === 0 && r.stdout.trim()) {
    return { name: 'Docker', ok: true };
  }
  return { name: 'Docker', ok: false, detail: 'daemon not running' };
}

async function checkDockerContainers(): Promise<CheckResult> {
  const required = ['hindsight-api', 'hindsight-db'];
  const r = spawnSync('docker', ['ps', '--format', '{{.Names}}\t{{.Status}}'], {
    encoding: 'utf-8',
    timeout: 8000,
    stdio: 'pipe',
  });
  if (r.status !== 0) {
    return { name: 'Containers', ok: false, detail: 'docker ps failed' };
  }
  const running = r.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('\t')[0].trim());
  const missing = required.filter(
    (name) => !running.some((n) => n === name || n.endsWith(`_${name}_1`) || n.endsWith(`-${name}-1`)),
  );
  if (missing.length > 0) {
    return { name: 'Containers', ok: false, detail: `not running: ${missing.join(', ')}` };
  }
  return { name: 'Containers', ok: true };
}

function checkDatabase(): CheckResult {
  try {
    const db = getDb();
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

function icon(ok: boolean): string {
  return ok ? '✅' : '❌';
}

// ── Main health check loop ────────────────────────────────────────────────────

let healthCheckTimer: NodeJS.Timeout | null = null;

export function startHealthCheck(intervalMs = 60_000): void {
  if (healthCheckTimer) return;

  const run = async () => {
    let results: CheckResult[];
    try {
      results = await Promise.all([
        checkDocker(),
        checkDockerContainers(),
        Promise.resolve(checkDatabase()),
        Promise.resolve(checkChannels()),
        Promise.resolve(checkMemory()),
      ]);
    } catch (err) {
      console.error('[health-check] Unexpected error during health checks:', err);
      return;
    }

    if (results.every((r) => r.ok)) {
      log.debug('[health-check] All checks passed');
      return;
    }

    // ── Auto-heal pass ──────────────────────────────────────────────────────
    const fixed: string[] = [];
    const stillBroken: CheckResult[] = [];

    for (const result of results) {
      if (result.ok) continue;

      switch (result.name) {
        case 'Docker': {
          log.warn('[health-check] Docker daemon down — attempting auto-start');
          await tryStartDockerDaemon();
          const recheck = await checkDocker();
          if (recheck.ok) {
            fixed.push('Docker daemon');
          } else {
            stillBroken.push(result);
          }
          break;
        }

        case 'Containers': {
          log.warn('[health-check] Hindsight containers down — attempting docker compose up');
          await tryStartContainers();
          const recheck = await checkDockerContainers();
          if (recheck.ok) {
            fixed.push('Hindsight containers');
          } else {
            stillBroken.push(result);
          }
          break;
        }

        case 'Channels': {
          log.warn('[health-check] No channels registered — attempting service restart');
          const ok = await tryRestartClawBridgeService();
          if (ok) {
            // Process is being replaced; can't re-verify channels in same process
            fixed.push('ClawBridge service (restarted)');
          } else {
            stillBroken.push(result);
          }
          break;
        }

        default:
          // Database failures and memory pressure: cannot auto-fix, just alert
          stillBroken.push(result);
      }
    }

    // ── Notifications ───────────────────────────────────────────────────────
    if (fixed.length > 0) {
      const fixedText =
        `🔧 <b>ClawBridge Auto-Healed</b>\n\n` +
        fixed.map((f) => `✅ Fixed: ${f}`).join('\n') +
        (stillBroken.length > 0
          ? `\n\n⚠️ Still needs attention:\n` +
            stillBroken.map((r) => `${icon(r.ok)} ${r.name}: ${r.detail ?? 'failed'}`).join('\n')
          : '');
      log.info('[health-check] Auto-heal succeeded', { fixed });
      await sendTelegramAlert(fixedText);
    }

    if (stillBroken.length > 0) {
      const alertText =
        `⚠️ <b>ClawBridge Health Warning</b>\n\n` +
        stillBroken.map((r) => `${icon(r.ok)} ${r.name}: ${r.detail ?? 'failed'}`).join('\n') +
        (fixed.length === 0
          ? `\n\nAuto-fix attempted but failed — manual intervention needed.`
          : `\n\nSome issues could not be auto-fixed.`);
      log.warn('[health-check] Health check failures after auto-heal', {
        failed: stillBroken.map((r) => r.name).join(', '),
      });
      await sendTelegramAlert(alertText);
    }
  };

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
