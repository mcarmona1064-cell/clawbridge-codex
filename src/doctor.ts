#!/usr/bin/env node
/**
 * clawbridge doctor — standalone health check CLI.
 * No runtime imports. No DB. No channel registry.
 * Uses only Node built-ins and fetch.
 */
import { execSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDefaultContainerImage } from './install-slug.js';
import { AGENT_PROVIDER } from './config.js';

// ─── ANSI helpers ─────────────────────────────────────────────────────────────

const USE_COLOR = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

function c(code: string, s: string): string {
  return USE_COLOR ? `\x1b[${code}m${s}\x1b[0m` : s;
}

const green = (s: string) => c('32', s);
const red = (s: string) => c('31', s);
const dim = (s: string) => c('2', s);
const bold = (s: string) => c('1', s);
const cyan = (s: string) => c('36', s);

const CHECK = green('✅');
const CROSS = red('❌');

// ─── .env reader ─────────────────────────────────────────────────────────────

function readDotEnv(): Map<string, string> {
  const envPath = path.join(os.homedir(), '.clawbridge', '.env');
  const map = new Map<string, string>();
  try {
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq === -1) continue;
      let val = t.slice(eq + 1).trim();
      if (
        val.length >= 2 &&
        ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
      ) {
        val = val.slice(1, -1);
      }
      map.set(t.slice(0, eq).trim(), val);
    }
  } catch {
    /* file missing */
  }
  return map;
}

// ─── Result tracking ──────────────────────────────────────────────────────────

interface FailedCheck {
  label: string;
  detail: string;
}

const failures: FailedCheck[] = [];

function pass(label: string, detail: string): void {
  const pad = 20;
  console.log(`  ${CHECK} ${label.padEnd(pad)} ${dim(detail)}`);
}

function fail(label: string, detail: string, hint?: string): void {
  const pad = 20;
  console.log(`  ${CROSS} ${label.padEnd(pad)} ${red(detail)}`);
  failures.push({ label, detail: hint ?? detail });
}

// ─── Checks ───────────────────────────────────────────────────────────────────

function checkVersion(): string {
  try {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version: string };
    return pkg.version;
  } catch {
    return 'unknown';
  }
}

function checkDocker(): void {
  try {
    const r = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
      encoding: 'utf-8',
      timeout: 8000,
    });
    if (r.status === 0 && r.stdout.trim()) {
      pass('Docker daemon', r.stdout.trim());
    } else {
      fail('Docker daemon', 'not running or not installed', 'start Docker Desktop');
    }
  } catch {
    fail('Docker daemon', 'not reachable (timeout)', 'start Docker Desktop');
  }
}

interface ContainerInfo {
  name: string;
  status: string;
}

function checkContainers(autoFix: boolean): void {
  const required = ['hindsight-api', 'hindsight-db'];

  let containers: ContainerInfo[] = [];
  try {
    const r = spawnSync('docker', ['ps', '-a', '--format', '{{.Names}}\t{{.Status}}'], {
      encoding: 'utf-8',
      timeout: 8000,
    });
    if (r.status === 0) {
      containers = r.stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [name, ...rest] = line.split('\t');
          return { name: name.trim(), status: rest.join('\t').trim() };
        });
    }
  } catch {
    /* docker not available */
  }

  for (const name of required) {
    const found = containers.find(
      (c) => c.name === name || c.name.endsWith(`_${name}_1`) || c.name.endsWith(`-${name}-1`),
    );
    if (found) {
      const isUp = found.status.toLowerCase().startsWith('up');
      if (isUp) {
        pass(name, found.status);
      } else {
        if (autoFix) {
          try {
            const clawbridgeDir = path.join(os.homedir(), '.clawbridge');
            execSync('docker compose up -d', { cwd: clawbridgeDir, stdio: 'pipe' });
            pass(name, 'started');
          } catch (e) {
            fail(name, found.status, 'run: cd ~/.clawbridge && docker compose up -d');
          }
        } else {
          fail(name, found.status, 'run: cd ~/.clawbridge && docker compose up -d');
        }
      }
    } else {
      if (autoFix) {
        try {
          const clawbridgeDir = path.join(os.homedir(), '.clawbridge');
          execSync('docker compose up -d', { cwd: clawbridgeDir, stdio: 'pipe' });
          pass(name, 'started');
        } catch (e) {
          fail(name, 'container not found', 'run: cd ~/.clawbridge && docker compose up -d');
        }
      } else {
        fail(name, 'container not found', 'run: cd ~/.clawbridge && docker compose up -d');
      }
    }
  }
}

function checkContainerImage(autoFix: boolean): void {
  try {
    // Derive the image tag from the installed service registration (source of truth
    // for this install's slug), not from process.cwd() which gives the wrong slug
    // when doctor is run from any directory other than the package root.
    let slug: string | undefined;

    // macOS: read slug from ~/Library/LaunchAgents/com.clawbridge-v2-<slug>.plist
    if (process.platform === 'darwin') {
      try {
        const launchAgentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
        const plist = fs
          .readdirSync(launchAgentsDir)
          .find((f) => f.startsWith('com.clawbridge-v2-') && f.endsWith('.plist'));
        if (plist) {
          slug = plist.replace(/^com\.clawbridge-v2-/, '').replace(/\.plist$/, '');
        }
      } catch {
        /* fall through */
      }
    }

    // Linux/VPS: read slug from systemd user unit clawbridge-v2-<slug>.service
    if (!slug && process.platform === 'linux') {
      const unitDirs = [path.join(os.homedir(), '.config', 'systemd', 'user'), '/etc/systemd/system'];
      for (const dir of unitDirs) {
        try {
          const unit = fs.readdirSync(dir).find((f) => f.startsWith('clawbridge-v2-') && f.endsWith('.service'));
          if (unit) {
            slug = unit.replace(/^clawbridge-v2-/, '').replace(/\.service$/, '');
            break;
          }
        } catch {
          /* dir may not exist */
        }
      }
    }

    const imageTag = slug ? `clawbridge-codex-v2-${slug}:latest` : getDefaultContainerImage();

    const r = spawnSync('docker', ['image', 'inspect', imageTag], {
      encoding: 'utf-8',
      timeout: 8000,
      stdio: 'pipe',
    });
    if (r.status === 0) {
      pass('Agent image', imageTag);
    } else {
      const buildCmd = 'clawbridge build-image';
      if (autoFix) {
        try {
          const pkgDir = path.dirname(fileURLToPath(import.meta.url));
          const projectRoot = path.resolve(pkgDir, '../..');
          execSync('bash container/build.sh', { cwd: projectRoot, stdio: 'inherit' });
          pass('Agent image', 'built');
        } catch {
          fail('Agent image', `"${imageTag}" not found`, `run: ${buildCmd}`);
        }
      } else {
        fail('Agent image', `"${imageTag}" not found`, `run: ${buildCmd}`);
      }
    }
  } catch {
    fail('Agent image', 'docker unavailable', 'start Docker Desktop');
  }
}

async function checkHindsightHealth(env: Map<string, string>): Promise<void> {
  const url = env.get('HINDSIGHT_URL') ?? 'http://localhost:8888';
  const apiKey = env.get('HINDSIGHT_API_KEY') ?? '';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(`${url}/health`, {
      signal: controller.signal,
      headers: apiKey ? { 'x-api-key': apiKey } : {},
    });
    clearTimeout(timer);
    const body = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = body;
    }
    const status = (parsed as Record<string, string>)?.status;
    if (status === 'healthy') {
      pass('Hindsight health', body.slice(0, 80));
    } else {
      fail('Hindsight health', `status: ${status ?? 'unknown'}`, `check: docker logs hindsight-api`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    fail('Hindsight health', `unreachable (${msg})`, `check: docker logs hindsight-api`);
  }
}

function checkLaunchd(autoFix: boolean): void {
  if (process.platform !== 'darwin') return; // Linux handled by checkSystemd
  try {
    const launchAgentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
    const plists = fs
      .readdirSync(launchAgentsDir)
      .filter((f) => f.startsWith('com.clawbridge-v2-') && f.endsWith('.plist'));
    if (plists.length === 0) {
      fail('LaunchD service', 'no com.clawbridge-v2-* plist found', 'run: clawbridge setup');
      return;
    }
    const label = plists[0].replace(/\.plist$/, '');
    const r = spawnSync('launchctl', ['list', label], { encoding: 'utf-8', timeout: 5000 });
    if (r.status !== 0 || r.stdout.includes('Could not find service')) {
      if (autoFix) {
        try {
          const uid = execSync('id -u', { encoding: 'utf-8' }).trim();
          const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', plists[0]);
          execSync(`launchctl bootstrap gui/${uid} ${plistPath}`, { encoding: 'utf-8' });
          pass('LaunchD service', `${label} (bootstrapped)`);
        } catch (e) {
          fail(
            'LaunchD service',
            `${label} not loaded, bootstrap failed`,
            `run: launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/${plists[0]}`,
          );
        }
      } else {
        fail(
          'LaunchD service',
          `${label} not loaded`,
          `run: launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/${plists[0]}`,
        );
      }
      return;
    }
    // Parse PID from launchctl list output
    const pidMatch = r.stdout.match(/"PID"\s*=\s*(\d+)/);
    const pid = pidMatch ? pidMatch[1] : null;
    if (pid) {
      pass('LaunchD service', `running (pid ${pid})  ${dim(label)}`);
    } else {
      // No PID means it's loaded but not running (exited or waiting)
      const lastExitMatch = r.stdout.match(/"LastExitStatus"\s*=\s*(-?\d+)/);
      const lastExit = lastExitMatch ? lastExitMatch[1] : '?';
      if (lastExit === '0') {
        pass('LaunchD service', `loaded, last exit 0  ${dim(label)}`);
      } else {
        if (autoFix) {
          try {
            const uid2 = execSync('id -u', { encoding: 'utf-8' }).trim();
            execSync(`launchctl kickstart -k gui/${uid2}/${label}`, { encoding: 'utf-8' });
            pass('LaunchD service', `${label} (restarted)`);
          } catch {
            fail(
              'LaunchD service',
              `loaded but not running (LastExitStatus=${lastExit})`,
              `check: tail -f ~/.clawbridge/logs/agent.log`,
            );
          }
        } else {
          fail(
            'LaunchD service',
            `loaded but not running (LastExitStatus=${lastExit})`,
            `check: tail -f ~/.clawbridge/logs/agent.log`,
          );
        }
      }
    }
  } catch (err: unknown) {
    // launchctl not available (non-macOS)
    const msg = err instanceof Error ? err.message : String(err);
    fail('LaunchD service', `launchctl error: ${msg}`);
  }
}

async function checkSystemd(autoFix: boolean): Promise<void> {
  try {
    const homeDir = os.homedir();
    const userUnitDir = path.join(homeDir, '.config', 'systemd', 'user');

    // Find any clawbridge service unit
    let unitName: string | null = null;
    try {
      const files = fs.readdirSync(userUnitDir);
      const unit = files.find((f) => f.startsWith('clawbridge') && f.endsWith('.service'));
      if (unit) unitName = unit.replace('.service', '');
    } catch {
      // dir doesn't exist
    }

    // Also check system-level
    if (!unitName) {
      try {
        const sysFiles = fs.readdirSync('/etc/systemd/system/');
        const unit = sysFiles.find((f) => f.startsWith('clawbridge') && f.endsWith('.service'));
        if (unit) unitName = unit.replace('.service', '');
      } catch {
        /* ignore */
      }
    }

    if (!unitName) {
      return fail(
        'Systemd service',
        'No ClawBridge systemd unit found',
        'run: clawbridge setup to register the service',
      );
    }

    // Check if active
    try {
      const isRoot = process.getuid?.() === 0;
      const prefix = isRoot ? 'systemctl' : 'systemctl --user';
      execSync(`${prefix} is-active ${unitName}`, { stdio: 'pipe' });
      pass('Systemd service', unitName);
    } catch {
      if (autoFix) {
        try {
          const isRoot = process.getuid?.() === 0;
          const prefix = isRoot ? 'systemctl' : 'systemctl --user';
          execSync(`${prefix} restart ${unitName}`, { stdio: 'pipe' });
          pass('Systemd service', `${unitName} (restarted)`);
        } catch (e) {
          fail(
            'Systemd service',
            `${unitName} not active, restart failed`,
            `run: systemctl --user restart ${unitName}`,
          );
        }
      } else {
        fail('Systemd service', `${unitName} not active`, `run: systemctl --user restart ${unitName}`);
      }
    }
  } catch (err) {
    fail('Systemd service', String(err));
  }
}

function checkDatabase(): void {
  const dbPath = path.join(os.homedir(), '.clawbridge', 'data', 'v2.db');
  try {
    const stat = fs.statSync(dbPath);
    if (stat.size > 0) {
      const sizeMb = (stat.size / 1_048_576).toFixed(1);
      pass('Database', `${dim(dbPath.replace(os.homedir(), '~'))} (${sizeMb} MB)`);
    } else {
      fail('Database', `${dbPath} exists but is empty`);
    }
  } catch {
    fail('Database', `${dim(dbPath.replace(os.homedir(), '~'))} not found`, 'run setup to initialise the database');
  }
}

function checkDockerComposeSymlink(autoFix: boolean): void {
  const destPath = path.join(os.homedir(), '.clawbridge', 'docker-compose.yml');
  try {
    const stat = fs.lstatSync(destPath);
    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(destPath);
      pass('docker-compose', `symlink → ${dim(target)}`);
    } else {
      fail('docker-compose', 'exists but is NOT a symlink — compose drift risk', 'run: clawbridge upgrade to re-link');
    }
  } catch {
    if (autoFix) {
      try {
        const pkgDir = path.dirname(fileURLToPath(import.meta.url));
        const composeSrc = path.resolve(pkgDir, '../../integrations/docker-compose.yml');
        const composeDest = path.join(os.homedir(), '.clawbridge', 'docker-compose.yml');
        fs.mkdirSync(path.dirname(composeDest), { recursive: true });
        fs.symlinkSync(composeSrc, composeDest);
        pass('docker-compose.yml symlink', 'created');
      } catch (e) {
        fail('docker-compose', `${dim(destPath.replace(os.homedir(), '~'))} not found`, 'run: clawbridge setup');
      }
    } else {
      fail('docker-compose', `${dim(destPath.replace(os.homedir(), '~'))} not found`, 'run: clawbridge setup');
    }
  }
}

function checkConfigFile(env: Map<string, string>): void {
  const envPath = path.join(os.homedir(), '.clawbridge', '.env');
  const exists = fs.existsSync(envPath);
  if (!exists) {
    fail('Config file', `~/.clawbridge/.env not found`, 'run: clawbridge setup');
    return;
  }
  pass('Config file', `~/.clawbridge/.env`);

  const requiredKeys = ['CLAUDE_CODE_OAUTH_TOKEN', 'ASSISTANT_NAME'];
  for (const key of requiredKeys) {
    if (env.get(key)) {
      pass(key, dim('set'));
    } else {
      fail(key, `missing from ~/.clawbridge/.env`);
    }
  }

  // Hindsight is optional — only flag if partially configured
  const hindsightUrl = env.get('HINDSIGHT_URL');
  const hindsightKey = env.get('HINDSIGHT_API_KEY');
  if (hindsightUrl && !hindsightKey) {
    fail('HINDSIGHT_API_KEY', 'HINDSIGHT_URL is set but HINDSIGHT_API_KEY is missing');
  } else if (hindsightUrl && hindsightKey) {
    pass('Hindsight', 'configured');
  }
  // If neither is set, Hindsight is just not enabled — that's fine, don't flag it
}

// ─── Channel checks ───────────────────────────────────────────────────────────

async function fixAndVerifyChannel(channelName: string, verify: () => Promise<boolean>): Promise<void> {
  console.log(`  🔄 Auto-fix: restarting ClawBridge service for ${channelName}…`);

  // Restart service
  try {
    if (process.platform === 'darwin') {
      const launchAgentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
      const plists = fs
        .readdirSync(launchAgentsDir)
        .filter((f) => f.startsWith('com.clawbridge-v2-') && f.endsWith('.plist'));
      if (plists.length > 0) {
        const label = plists[0].replace(/\.plist$/, '');
        const uid = execSync('id -u', { encoding: 'utf-8' }).trim();
        spawnSync('launchctl', ['kickstart', '-k', `gui/${uid}/${label}`], {
          encoding: 'utf-8',
          timeout: 15000,
        });
      }
    } else {
      // Linux: find and restart the systemd unit
      try {
        const homeDir = os.homedir();
        const userUnitDir = path.join(homeDir, '.config', 'systemd', 'user');
        const files = fs.readdirSync(userUnitDir);
        const unit = files.find((f) => f.startsWith('clawbridge') && f.endsWith('.service'));
        if (unit) {
          const unitName = unit.replace('.service', '');
          const isRoot = process.getuid?.() === 0;
          const prefix = isRoot ? 'systemctl' : 'systemctl --user';
          execSync(`${prefix} restart ${unitName}`, { stdio: 'pipe' });
        }
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore restart errors — we'll verify below */
  }

  // Poll until channel responds or timeout
  const maxAttempts = 5;
  const delays = [5000, 10000, 10000, 15000, 20000]; // escalating wait

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const waitSec = Math.round((delays[attempt - 1] ?? 10000) / 1000);
    process.stdout.write(
      `  ⏳ Waiting ${waitSec}s for ${channelName} to reconnect (attempt ${attempt}/${maxAttempts})…`,
    );
    await new Promise((r) => setTimeout(r, delays[attempt - 1] ?? 10000));
    process.stdout.write('\r' + ' '.repeat(80) + '\r');

    const connected = await verify();
    if (connected) {
      console.log(`  ✅ ${channelName} reconnected successfully!`);
      return;
    }
  }

  console.log(
    `  ❌ ${channelName} still not responding after ${maxAttempts} attempts. Check logs: tail -f ~/.clawbridge/logs/agent.log`,
  );
}

async function verifyTelegram(token: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 8000);
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: controller.signal });
    const data = (await res.json()) as { ok: boolean };
    return data.ok === true;
  } catch {
    return false;
  }
}

async function checkTelegram(env: Map<string, string>, autoFix: boolean): Promise<void> {
  const token = env.get('TELEGRAM_BOT_TOKEN');
  if (!token) return; // not configured — skip silently

  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 8000);
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: controller.signal });
    const data = (await res.json()) as { ok: boolean; result?: { username: string; first_name: string } };
    if (data.ok && data.result) {
      pass('Telegram', `@${data.result.username} (${data.result.first_name})`);
    } else {
      fail('Telegram', 'bot token invalid or bot unreachable', 'check TELEGRAM_BOT_TOKEN in ~/.clawbridge/.env');
      if (autoFix) {
        await fixAndVerifyChannel('Telegram', () => verifyTelegram(token));
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    fail('Telegram', `unreachable (${msg})`, 'check internet connection or TELEGRAM_BOT_TOKEN');
    if (autoFix) {
      await fixAndVerifyChannel('Telegram', () => verifyTelegram(token));
    }
  }
}

async function checkWhatsApp(env: Map<string, string>, autoFix: boolean): Promise<void> {
  const phoneNumberId = env.get('WHATSAPP_PHONE_NUMBER_ID');
  const accessToken = env.get('WHATSAPP_ACCESS_TOKEN');

  if (!phoneNumberId && !accessToken) return; // not configured

  if (!phoneNumberId) {
    fail('WhatsApp', 'WHATSAPP_PHONE_NUMBER_ID missing', 'check WHATSAPP_PHONE_NUMBER_ID in ~/.clawbridge/.env');
    return;
  }
  if (!accessToken) {
    fail('WhatsApp', 'WHATSAPP_ACCESS_TOKEN missing', 'check WHATSAPP_ACCESS_TOKEN in ~/.clawbridge/.env');
    return;
  }

  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 8000);
    const res = await fetch(
      `https://graph.facebook.com/v19.0/${phoneNumberId}?fields=display_phone_number,verified_name`,
      {
        signal: controller.signal,
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );
    const data = (await res.json()) as {
      display_phone_number?: string;
      verified_name?: string;
      error?: { message: string };
    };
    if (res.ok && data.display_phone_number) {
      pass('WhatsApp', `${data.verified_name ?? ''} (${data.display_phone_number})`);
    } else {
      const errMsg = data.error?.message ?? `HTTP ${res.status}`;
      fail('WhatsApp', `API error: ${errMsg}`, 'check WHATSAPP_ACCESS_TOKEN in ~/.clawbridge/.env');
      if (autoFix) {
        await fixAndVerifyChannel('WhatsApp', async () => {
          try {
            const r = await fetch(`https://graph.facebook.com/v19.0/${phoneNumberId}?fields=display_phone_number`, {
              headers: { Authorization: `Bearer ${accessToken}` },
            });
            return r.ok;
          } catch {
            return false;
          }
        });
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    fail('WhatsApp', `unreachable (${msg})`, 'check internet connection or WHATSAPP_ACCESS_TOKEN');
    if (autoFix) {
      await fixAndVerifyChannel('WhatsApp', async () => {
        try {
          const r = await fetch(`https://graph.facebook.com/v19.0/${phoneNumberId}?fields=display_phone_number`, {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          return r.ok;
        } catch {
          return false;
        }
      });
    }
  }
}

async function verifyDiscord(token: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 8000);
    const res = await fetch('https://discord.com/api/v10/users/@me', {
      signal: controller.signal,
      headers: { Authorization: `Bot ${token}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function checkDiscord(env: Map<string, string>, autoFix: boolean): Promise<void> {
  const token = env.get('DISCORD_TOKEN') || env.get('DISCORD_BOT_TOKEN');
  if (!token) return;

  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 8000);
    const res = await fetch('https://discord.com/api/v10/users/@me', {
      signal: controller.signal,
      headers: { Authorization: `Bot ${token}` },
    });
    if (res.ok) {
      const data = (await res.json()) as { username: string; discriminator: string };
      pass('Discord', `${data.username}#${data.discriminator}`);
    } else {
      fail('Discord', `bot token rejected (HTTP ${res.status})`, 'check DISCORD_BOT_TOKEN in ~/.clawbridge/.env');
      if (autoFix) {
        await fixAndVerifyChannel('Discord', () => verifyDiscord(token));
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    fail('Discord', `unreachable (${msg})`, 'check internet connection');
    if (autoFix) {
      await fixAndVerifyChannel('Discord', () => verifyDiscord(token));
    }
  }
}

async function verifySlack(token: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 8000);
    const res = await fetch('https://slack.com/api/auth.test', {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = (await res.json()) as { ok: boolean };
    return data.ok === true;
  } catch {
    return false;
  }
}

async function checkSlack(env: Map<string, string>, autoFix: boolean): Promise<void> {
  const token = env.get('SLACK_BOT_TOKEN');
  if (!token) return;

  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 8000);
    const res = await fetch('https://slack.com/api/auth.test', {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = (await res.json()) as { ok: boolean; bot_id?: string; team?: string; error?: string };
    if (data.ok) {
      pass('Slack', `${data.team ?? ''} (bot_id: ${data.bot_id ?? 'unknown'})`);
    } else {
      fail('Slack', `auth failed: ${data.error ?? 'unknown'}`, 'check SLACK_BOT_TOKEN in ~/.clawbridge/.env');
      if (autoFix) {
        await fixAndVerifyChannel('Slack', () => verifySlack(token));
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    fail('Slack', `unreachable (${msg})`, 'check internet connection');
    if (autoFix) {
      await fixAndVerifyChannel('Slack', () => verifySlack(token));
    }
  }
}

async function checkChannels(env: Map<string, string>, autoFix: boolean): Promise<void> {
  const hasAnyChannel = [
    'TELEGRAM_BOT_TOKEN',
    'DISCORD_TOKEN',
    'DISCORD_BOT_TOKEN',
    'SLACK_BOT_TOKEN',
    'WHATSAPP_PHONE_NUMBER_ID',
    'WHATSAPP_ACCESS_TOKEN',
  ].some((k) => env.get(k));

  if (!hasAnyChannel) {
    console.log(`  ${dim('No channels configured — run: clawbridge setup')}`);
    return;
  }

  await checkTelegram(env, autoFix);
  await checkWhatsApp(env, autoFix);
  await checkDiscord(env, autoFix);
  await checkSlack(env, autoFix);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function checkProvider(env: Map<string, string>): void {
  // Report current provider
  pass('AGENT_PROVIDER', AGENT_PROVIDER);

  // Check CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY
  const oauthToken = env.get('CLAUDE_CODE_OAUTH_TOKEN');
  const apiKey = env.get('ANTHROPIC_API_KEY');
  if (oauthToken) {
    pass('Claude auth', dim('CLAUDE_CODE_OAUTH_TOKEN set'));
  } else if (apiKey) {
    pass('Claude auth', dim('ANTHROPIC_API_KEY set'));
  } else {
    fail('Claude auth', 'no CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY', 'run: claude setup-token');
  }

  // Auto-fix Hindsight LLM vars if HINDSIGHT_URL is set
  const hindsightUrl = env.get('HINDSIGHT_URL');
  if (hindsightUrl) {
    const expectedLlmProvider = 'claude-code';
    const expectedModels = { retain: 'claude-haiku-4-5', recall: 'claude-haiku-4-5', reflect: 'claude-sonnet-4-5' };

    const envPath = path.join(os.homedir(), '.clawbridge', '.env');
    const autoFixEnv = (key: string, value: string): void => {
      try {
        let envContent = fs.readFileSync(envPath, 'utf-8');
        const lineRegex = new RegExp(`^${key}=.*$`, 'm');
        if (lineRegex.test(envContent)) {
          envContent = envContent.replace(lineRegex, `${key}=${value}`);
        } else {
          envContent = envContent.trimEnd() + `\n${key}=${value}\n`;
        }
        fs.writeFileSync(envPath, envContent, 'utf-8');
      } catch {
        /* ignore write errors */
      }
    };

    // HINDSIGHT_API_LLM_PROVIDER
    const actualLlmProvider = env.get('HINDSIGHT_API_LLM_PROVIDER');
    if (!actualLlmProvider || actualLlmProvider !== expectedLlmProvider) {
      autoFixEnv('HINDSIGHT_API_LLM_PROVIDER', expectedLlmProvider);
      pass('HINDSIGHT_API_LLM_PROVIDER', dim(`${expectedLlmProvider} (auto-set)`));
    } else {
      pass('HINDSIGHT_API_LLM_PROVIDER', dim(actualLlmProvider));
    }

    // HINDSIGHT_API_RETAIN_MODEL
    const actualRetain = env.get('HINDSIGHT_API_RETAIN_MODEL');
    if (!actualRetain || actualRetain !== expectedModels.retain) {
      autoFixEnv('HINDSIGHT_API_RETAIN_MODEL', expectedModels.retain);
      pass('HINDSIGHT_API_RETAIN_MODEL', dim(`${expectedModels.retain} (auto-set)`));
    } else {
      pass('HINDSIGHT_API_RETAIN_MODEL', dim(actualRetain));
    }

    // HINDSIGHT_API_RECALL_MODEL
    const actualRecall = env.get('HINDSIGHT_API_RECALL_MODEL');
    if (!actualRecall || actualRecall !== expectedModels.recall) {
      autoFixEnv('HINDSIGHT_API_RECALL_MODEL', expectedModels.recall);
      pass('HINDSIGHT_API_RECALL_MODEL', dim(`${expectedModels.recall} (auto-set)`));
    } else {
      pass('HINDSIGHT_API_RECALL_MODEL', dim(actualRecall));
    }

    // HINDSIGHT_API_REFLECT_MODEL
    const actualReflect = env.get('HINDSIGHT_API_REFLECT_MODEL');
    if (!actualReflect || actualReflect !== expectedModels.reflect) {
      autoFixEnv('HINDSIGHT_API_REFLECT_MODEL', expectedModels.reflect);
      pass('HINDSIGHT_API_REFLECT_MODEL', dim(`${expectedModels.reflect} (auto-set)`));
    } else {
      pass('HINDSIGHT_API_REFLECT_MODEL', dim(actualReflect));
    }
  }
}

export async function runDoctor(): Promise<void> {
  const version = checkVersion();

  const divider = USE_COLOR ? `\x1b[2m${'═'.repeat(32)}\x1b[0m` : '═'.repeat(32);
  const thin = USE_COLOR ? `\x1b[2m${'─'.repeat(32)}\x1b[0m` : '─'.repeat(32);

  console.log('');
  console.log(bold(cyan('ClawBridge Doctor')) + `  ${dim('v' + version)}`);
  console.log(divider);

  const env = readDotEnv();

  const autoFix = process.argv.includes('--fix');
  if (autoFix) {
    console.log(dim('  (auto-fix mode enabled)'));
  }

  // ── System ───────────────────────────────────────────────────────────────
  console.log('');
  console.log(bold('System'));
  checkDocker();
  if (process.platform === 'darwin') {
    checkLaunchd(autoFix);
  } else {
    await checkSystemd(autoFix);
  }

  // ── Config ───────────────────────────────────────────────────────────────
  console.log('');
  console.log(bold(`Config (${dim('~/.clawbridge/.env')})`));
  checkConfigFile(env);

  // ── Provider ─────────────────────────────────────────────────────────────
  console.log('');
  console.log(bold('Provider'));
  checkProvider(env);

  // ── Services ─────────────────────────────────────────────────────────────
  console.log('');
  console.log(bold('Services'));
  checkContainers(autoFix);
  checkContainerImage(autoFix);
  await checkHindsightHealth(env);

  // ── Channels ─────────────────────────────────────────────────────────────
  console.log('');
  console.log(bold('Channels'));
  await checkChannels(env, autoFix);

  // ── Storage ──────────────────────────────────────────────────────────────
  console.log('');
  console.log(bold('Storage'));
  checkDatabase();
  checkDockerComposeSymlink(autoFix);

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log('');
  console.log(thin);

  if (failures.length === 0) {
    console.log(green('✅ All checks passed'));
    console.log('');
  } else {
    console.log(red(`❌ ${failures.length} check${failures.length === 1 ? '' : 's'} failed`));
    console.log('');
    for (const f of failures) {
      console.log(`  ${red(f.label.padEnd(20))} ${dim(f.detail)}`);
    }
    console.log('');
    process.exitCode = 1;
  }
}
