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

function checkContainers(): void {
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
        fail(name, found.status, `run: clawbridge upgrade`);
      }
    } else {
      fail(name, 'container not found', 'run: clawbridge upgrade');
    }
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

function checkLaunchd(): void {
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
      fail(
        'LaunchD service',
        `${label} not loaded`,
        `run: launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/${plists[0]}`,
      );
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
        fail(
          'LaunchD service',
          `loaded but not running (LastExitStatus=${lastExit})`,
          `check: tail -f ~/.clawbridge/logs/agent.log`,
        );
      }
    }
  } catch (err: unknown) {
    // launchctl not available (non-macOS)
    const msg = err instanceof Error ? err.message : String(err);
    fail('LaunchD service', `launchctl error: ${msg}`);
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

function checkDockerComposeSymlink(): void {
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
    fail('docker-compose', `${dim(destPath.replace(os.homedir(), '~'))} not found`, 'run: clawbridge setup');
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

  const requiredKeys = ['CLAUDE_CODE_OAUTH_TOKEN', 'ASSISTANT_NAME', 'HINDSIGHT_URL', 'HINDSIGHT_API_KEY'];
  for (const key of requiredKeys) {
    if (env.get(key)) {
      pass(key, dim('set'));
    } else {
      fail(key, `missing from ~/.clawbridge/.env`);
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function runDoctor(): Promise<void> {
  const version = checkVersion();

  const divider = USE_COLOR ? `\x1b[2m${'═'.repeat(32)}\x1b[0m` : '═'.repeat(32);
  const thin = USE_COLOR ? `\x1b[2m${'─'.repeat(32)}\x1b[0m` : '─'.repeat(32);

  console.log('');
  console.log(bold(cyan('ClawBridge Doctor')) + `  ${dim('v' + version)}`);
  console.log(divider);

  const env = readDotEnv();

  // ── System ───────────────────────────────────────────────────────────────
  console.log('');
  console.log(bold('System'));
  checkDocker();
  checkLaunchd();

  // ── Config ───────────────────────────────────────────────────────────────
  console.log('');
  console.log(bold(`Config (${dim('~/.clawbridge/.env')})`));
  checkConfigFile(env);

  // ── Services ─────────────────────────────────────────────────────────────
  console.log('');
  console.log(bold('Services'));
  checkContainers();
  await checkHindsightHealth(env);

  // ── Storage ──────────────────────────────────────────────────────────────
  console.log('');
  console.log(bold('Storage'));
  checkDatabase();
  checkDockerComposeSymlink();

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
