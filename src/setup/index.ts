#!/usr/bin/env node
/**
 * ClawBridge interactive setup wizard.
 *
 * Entry point for `npx clawbridge-agent setup` and `pnpm run setup:wizard`.
 *
 * Three paths:
 *   1. Fresh install  — guided .env generation + docker compose up
 *   2. Migrate from OpenClaw
 *   3. Migrate from NanoClaw
 */
import { spawnSync, execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

import * as p from '@clack/prompts';
import k from 'kleur';

import {
  auditInstall,
  deactivateSource,
  detectInstall,
  resolveManualPath,
  rollback,
  runMigration,
  verifyMigration,
  type HindsightConfig,
  type MigrationAudit,
  type MigrationResult,
  type MigrationSelection,
  type MigrationSource,
  type VerificationCheck,
} from './migrate.js';

import { checkForUpdate, runUpgrade } from '../updater.js';
import { getLaunchdLabel } from '../install-slug.js';

// Handle "clawbridge doctor" command
if (process.argv[2] === 'doctor') {
  const { runDoctor } = await import('../doctor.js');
  await runDoctor();
  process.exit(0);
}

// Handle "clawbridge upgrade" / "clawbridge update" command
if (process.argv[2] === 'upgrade' || process.argv[2] === 'update') {
  await runUpgrade();
  process.exit(0);
}

// Handle "clawbridge chat" command
if (process.argv[2] === 'chat') {
  const { main: startChat } = await import('../cli-chat.js');
  await startChat();
  process.exit(0);
}

if (process.argv[2] === 'build-image') {
  console.log('Building ClawBridge agent container image…');
  const ok = await buildContainerImage();
  process.exit(ok ? 0 : 1);
}

// Silent version check on startup (non-blocking)
checkForUpdate().catch(() => {});

// ─── Brand helpers ────────────────────────────────────────────────────────────

const USE_ANSI = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const TRUECOLOR = USE_ANSI && (process.env.COLORTERM === 'truecolor' || process.env.COLORTERM === '24bit');

function brand(s: string): string {
  if (!USE_ANSI) return s;
  if (TRUECOLOR) return `\x1b[38;2;43;183;206m${s}\x1b[0m`;
  return k.cyan(s);
}
function brandBold(s: string): string {
  if (!USE_ANSI) return s;
  if (TRUECOLOR) return `\x1b[1;38;2;43;183;206m${s}\x1b[0m`;
  return k.bold(k.cyan(s));
}
function dim(s: string): string {
  return USE_ANSI ? k.dim(s) : s;
}

function ensure<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    p.cancel('Setup cancelled.');
    process.exit(0);
  }
  return value as T;
}

// ─── Intro banner ─────────────────────────────────────────────────────────────

function printBanner(): void {
  const lines = [
    '',
    `  ${brand('/')}  ${brand('/')}  ${brand('/')}  ${brandBold('●')}`,
    ` ${brand('/')}  ${brand('/')}  ${brand('/')}  ${brandBold('●')}   ${k.bold('ClawBridge Agent')}`,
    `${brand('/')}  ${brand('/')}  ${brand('/')}  ${brandBold('●')}    ${dim('AI Agent Platform')}`,
    '',
  ];
  for (const line of lines) console.log(line);
}

// ─── Validation helpers ───────────────────────────────────────────────────────

function validateOAuthToken(value: string | undefined): string | undefined {
  const t = (value ?? '').trim();
  if (!t) return 'Required';
  if (!t.startsWith('sk-ant-oat')) return 'Should start with sk-ant-oat…';
  return undefined;
}

function validateTelegramToken(value: string | undefined): string | undefined {
  const t = (value ?? '').trim();
  if (!t) return 'Required';
  if (!/^\d+:[A-Za-z0-9_-]{35,}$/.test(t)) return 'Expected format: 123456789:ABCdef…';
  return undefined;
}

function validateEmail(value: string | undefined): string | undefined {
  const v = (value ?? '').trim();
  if (!v) return 'Required';
  if (!v.includes('@')) return 'Enter a valid email address';
  return undefined;
}

function validatePassword(value: string | undefined): string | undefined {
  const v = value ?? '';
  if (!v || v.length < 8) return 'Minimum 8 characters';
  return undefined;
}

function validateRequired(value: string | undefined): string | undefined {
  return !(value ?? '').trim() ? 'Required' : undefined;
}

function testOAuthToken(token: string): boolean {
  try {
    const result = spawnSync(
      'node',
      [
        '--input-type=module',
        '-e',
        `
import https from 'https';
const opts = {
  hostname: 'api.anthropic.com',
  path: '/v1/models',
  method: 'GET',
  headers: {
    'Authorization': 'Bearer ${token.trim()}',
    'anthropic-version': '2023-06-01',
  },
};
const req = https.request(opts, (res) => {
  process.exit(res.statusCode === 200 || res.statusCode === 404 ? 0 : 1);
});
req.on('error', () => process.exit(0));
req.end();
        `,
      ],
      { encoding: 'utf-8', timeout: 8000 },
    );
    return result.status === 0;
  } catch {
    return true;
  }
}

// ─── .env generation ─────────────────────────────────────────────────────────

interface FreshConfig {
  agentName: string;
  oauthToken: string;
  telegramToken?: string;
  channels: string[];
  hindsightDbPassword?: string;
  hindsightApiKey?: string;
  hindsightUrl?: string;
}

function buildEnvFile(cfg: FreshConfig, existingEnv?: Map<string, string>): string {
  const lines: string[] = [
    '# ClawBridge Agent — generated by setup wizard',
    `# Generated: ${new Date().toISOString()}`,
    '',
    '# Agent identity',
    `ASSISTANT_NAME=${cfg.agentName}`,
    '',
    '# Claude Auth (Claude Pro/Max subscription)',
    '# Get this token by running: claude setup-token',
    `CLAUDE_CODE_OAUTH_TOKEN=${cfg.oauthToken}`,
    '',
  ];

  if (cfg.telegramToken) {
    lines.push('# Telegram', `TELEGRAM_BOT_TOKEN=${cfg.telegramToken}`, '');
  }
  if (cfg.channels.includes('discord')) {
    lines.push('# Discord', 'DISCORD_BOT_TOKEN=', '');
  }
  if (cfg.channels.includes('slack')) {
    lines.push('# Slack', 'SLACK_BOT_TOKEN=', 'SLACK_SIGNING_SECRET=', '');
  }
  if (cfg.channels.includes('whatsapp')) {
    lines.push('# WhatsApp', 'WHATSAPP_PHONE_NUMBER_ID=', 'WHATSAPP_ACCESS_TOKEN=', '');
  }
  if (cfg.channels.includes('gmail')) {
    lines.push('# Gmail', 'GMAIL_CLIENT_ID=', 'GMAIL_CLIENT_SECRET=', '');
  }
  if (cfg.hindsightDbPassword && cfg.hindsightApiKey && cfg.hindsightUrl) {
    lines.push(
      '# Hindsight semantic memory',
      `HINDSIGHT_URL=${cfg.hindsightUrl}`,
      `HINDSIGHT_API_KEY=${cfg.hindsightApiKey}`,
      `HINDSIGHT_DB_PASSWORD=${cfg.hindsightDbPassword}`,
      '# Optional: separate API key for Hindsight LLM ops (avoids sharing main OAuth rate limit)',
      '# Leave empty to fall back to CLAUDE_CODE_OAUTH_TOKEN',
      `HINDSIGHT_LLM_API_KEY=${existingEnv?.get('HINDSIGHT_LLM_API_KEY') ?? ''}`,
      '',
    );
  }

  return lines.join('\n') + '\n';
}

// ─── Source .env reader ───────────────────────────────────────────────────────

function parseEnvFile(envPath: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!fs.existsSync(envPath)) return map;
  try {
    for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq === -1) continue;
      map.set(t.slice(0, eq).trim(), t.slice(eq + 1).trim());
    }
  } catch {
    /* ignore */
  }
  return map;
}

// ─── Shared prompt helpers ────────────────────────────────────────────────────

async function setupClaudeAuth(existingValue?: string): Promise<string> {
  if (existingValue) {
    p.log.success('Claude OAuth token found in source ✓');
    return existingValue;
  }

  // 1. Check if claude CLI is installed
  const claudeCheck = spawnSync('which', ['claude'], { encoding: 'utf8' });
  if (claudeCheck.status !== 0) {
    p.log.info('Claude Code is not installed. Installing now...');
    const s = p.spinner();
    s.start('Installing Claude Code (npm install -g @anthropic-ai/claude-code)…');
    const installResult = spawnSync('npm', ['install', '-g', '@anthropic-ai/claude-code'], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
    if (installResult.status !== 0) {
      s.stop(k.red('Failed to install Claude Code.'));
      p.log.error('Please install manually: npm install -g @anthropic-ai/claude-code');
      process.exit(1);
    }
    s.stop(k.green('Claude Code installed ✓'));
  } else {
    p.log.success('Claude Code detected ✓');
  }

  // 2. Check if already authenticated (try reading credentials)
  const existingToken = tryReadClaudeToken();
  if (existingToken) {
    p.log.success('Claude authentication found ✓');
    return existingToken;
  }

  // 3. Run claude setup-token interactively
  p.log.message(dim('  Your browser will open to authenticate with Claude.\n  Complete the login, then return here.'));
  p.log.message(dim('  Running: claude setup-token'));

  // Run interactively so user sees the browser flow
  spawnSync('claude', ['setup-token'], { stdio: 'inherit', encoding: 'utf8' });

  // 4. Try reading the token that claude just saved
  const token = tryReadClaudeToken();
  if (token) {
    p.log.success('Claude authenticated successfully ✓');
    return token;
  }

  // 5. Fallback: ask user to paste token once
  p.log.message(dim('  Could not read token automatically. Please paste it below.'));
  const pasted = ensure(
    await p.password({
      message: 'Paste your Claude OAuth token',
      validate: validateOAuthToken,
    }),
  ) as string;
  return pasted.trim();
}

function tryReadClaudeToken(): string | null {
  try {
    // claude setup-token saves to ~/.claude/.credentials.json
    const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
    if (fs.existsSync(credPath)) {
      const creds = JSON.parse(fs.readFileSync(credPath, 'utf8'));
      // Try known key shapes
      const token =
        creds?.claudeAiOauth?.accessToken ||
        creds?.claudeAiOauth?.longLivedToken ||
        creds?.oauthToken ||
        creds?.token ||
        null;
      if (token && typeof token === 'string' && token.length > 20) return token;
    }
  } catch {
    /* ignore */
  }
  return null;
}

async function promptAgentName(existingValue?: string): Promise<string> {
  if (existingValue) {
    const keep = ensure(
      await p.confirm({
        message: `Agent name from source: "${existingValue}". Keep this name?`,
        initialValue: true,
      }),
    ) as boolean;
    if (keep) return existingValue;
  }
  const raw = ensure(
    await p.text({
      message: 'Agent name',
      placeholder: 'ClawBridge',
      defaultValue: 'ClawBridge',
    }),
  ) as string;
  return raw.trim() || 'ClawBridge';
}

async function promptAdminCreds(existing?: {
  email?: string;
  password?: string;
}): Promise<{ email: string; password: string }> {
  if (existing?.email && existing?.password) {
    return { email: existing.email, password: existing.password };
  }
  const email = ensure(
    await p.text({
      message: 'Admin email (for portal login)',
      placeholder: 'admin@example.com',
      validate: validateEmail,
    }),
  ) as string;
  const password = ensure(
    await p.password({
      message: 'Admin password',
      validate: validatePassword,
    }),
  ) as string;
  return { email: email.trim(), password };
}

async function promptHindsight(existingUrl?: string): Promise<{ dbPassword?: string; apiKey?: string; url?: string }> {
  if (existingUrl) {
    p.log.success('Hindsight already configured ✓');
    return {};
  }
  const wants = ensure(
    await p.confirm({
      message: 'Enable Hindsight semantic memory? (recommended for production — skip for now)',
      initialValue: false,
    }),
  ) as boolean;
  if (!wants) return {};
  const dbPassword = crypto.randomBytes(16).toString('hex');
  const apiKey = crypto.randomBytes(16).toString('hex');
  const url = 'http://localhost:8888';
  p.log.info(dim('Hindsight credentials generated and will be written to .env'));
  return { dbPassword, apiKey, url };
}

// ─── Telegram channel verification ───────────────────────────────────────────

async function verifyTelegramChannel(token: string): Promise<string | undefined> {
  // Get bot username first
  let botUsername: string | undefined;
  try {
    const meRes = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    if (meRes.ok) {
      const meData = (await meRes.json()) as { ok: boolean; result?: { username?: string } };
      botUsername = meData.result?.username;
    }
  } catch {
    /* ignore — username is optional */
  }

  p.note(
    `Open Telegram, send any message to your bot (${botUsername ? '@' + botUsername : 'your bot'}).\nI'll wait here to confirm it's working.`,
    'Telegram verification',
  );

  // Poll getUpdates for up to 60 seconds
  let offset: number | undefined;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const url = `https://api.telegram.org/bot${token}/getUpdates${offset !== undefined ? `?offset=${offset}` : ''}`;
      const res = await fetch(url);
      if (res.ok) {
        const data = (await res.json()) as { ok: boolean; result?: Array<{ update_id: number }> };
        if (data.ok && data.result && data.result.length > 0) {
          p.log.success('✅ Telegram is connected! Your bot is receiving messages.');
          return botUsername;
        }
      }
    } catch {
      /* network hiccup — keep polling */
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  p.log.warn('No message received in 60s — Telegram may still work, but verify manually by messaging your bot.');
  return botUsername;
}

// ─── Docker pre-flight check ─────────────────────────────────────────────────

function checkDockerPrerequisites(): void {
  const dockerCheck = spawnSync('docker', ['--version'], { encoding: 'utf8' });
  if (dockerCheck.error || dockerCheck.status !== 0) {
    p.log.error('Docker Desktop is not installed.');
    p.log.info('Download it at: https://docs.docker.com/get-docker/');
    process.exit(1);
  }

  const daemonCheck = spawnSync('docker', ['info'], { encoding: 'utf8', timeout: 5000 });
  if (daemonCheck.status !== 0) {
    p.log.error('Docker Desktop is not running.');
    p.log.info('Please start Docker Desktop and try again.');
    process.exit(1);
  }

  const composeCheck = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' });
  if (composeCheck.error || composeCheck.status !== 0) {
    p.log.error('Docker Compose not found. Make sure Docker Desktop is up to date.');
    process.exit(1);
  }

  p.log.success('Docker Desktop detected ✓');
}

// ─── Node.js pre-flight check ─────────────────────────────────────────────────

function checkNodePrerequisites(): void {
  // Check Node.js is installed
  const nodeCheck = spawnSync('node', ['--version'], { encoding: 'utf8' });
  if (nodeCheck.error || nodeCheck.status !== 0) {
    p.log.error('Node.js is not installed.');
    p.log.info('Download it at: https://nodejs.org/');
    process.exit(1);
  }

  // Check Node.js version >= 20
  const version = nodeCheck.stdout.trim();
  const major = parseInt(version.replace(/^v/, '').split('.')[0], 10);
  if (major < 20) {
    p.log.error('Node.js v20 or higher is required. You have ' + version);
    p.log.info('Download latest at: https://nodejs.org/');
    process.exit(1);
  }
  p.log.success('Node.js ' + version + ' \u2713');

  // pnpm is a dev-only tool — not required for users who install via npm install -g
  // Skip the check to avoid blocking fresh installs that don't have pnpm.
}

// ─── Fresh install flow ───────────────────────────────────────────────────────

async function runFreshInstall(): Promise<void> {
  checkDockerPrerequisites();
  checkNodePrerequisites();
  p.log.step('Starting fresh install…');

  // Step 1 — Claude OAuth token
  const oauthToken = await setupClaudeAuth();

  // Step 2 — Channels
  type ChannelOption = { value: string; label: string; hint?: string };
  const channelOptions: ChannelOption[] = [
    { value: 'telegram', label: 'Telegram', hint: 'recommended' },
    { value: 'whatsapp', label: 'WhatsApp' },
    { value: 'discord', label: 'Discord' },
    { value: 'slack', label: 'Slack' },
    { value: 'gmail', label: 'Gmail' },
  ];
  const channelChoices = ensure(
    await p.multiselect<string>({
      message: 'Which channels would you like to enable?',
      options: channelOptions,
      required: false,
    }),
  ) as string[];

  // Step 3 — Telegram token (if selected)
  let telegramToken: string | undefined;
  if (channelChoices.includes('telegram')) {
    telegramToken = ensure(
      await p.text({
        message: 'Telegram bot token (from @BotFather)',
        placeholder: '123456789:ABCdef…',
        validate: validateTelegramToken,
      }),
    ) as string;
    telegramToken = telegramToken.trim();
  }

  // Step 4 — Agent name
  const agentName = await promptAgentName();

  // Step 5 — Hindsight (optional)
  const { dbPassword: hindsightDbPassword, apiKey: hindsightApiKey, url: hindsightUrl } = await promptHindsight();

  // Generate .env
  const cfg: FreshConfig = {
    agentName,
    oauthToken: oauthToken.trim(),
    telegramToken,
    channels: channelChoices,
    hindsightDbPassword,
    hindsightApiKey,
    hindsightUrl,
  };

  const clawbridgeDir = path.join(os.homedir(), '.clawbridge');
  const envPath = path.join(clawbridgeDir, '.env');
  const existingEnvForBuild = parseEnvFile(envPath);
  const envContent = buildEnvFile(cfg, existingEnvForBuild);
  const packageIntegrationsDir = path.resolve(fileURLToPath(new URL(import.meta.url)), '../../../integrations');

  // Create ~/.clawbridge/ and logs/ if they don't exist
  fs.mkdirSync(clawbridgeDir, { recursive: true });
  fs.mkdirSync(path.join(clawbridgeDir, 'logs'), { recursive: true });

  // Symlink docker-compose.yml from package so upgrades auto-pick latest compose
  const srcCompose = path.join(packageIntegrationsDir, 'docker-compose.yml');
  const destCompose = path.join(clawbridgeDir, 'docker-compose.yml');
  if (fs.existsSync(srcCompose)) {
    try {
      fs.unlinkSync(destCompose);
    } catch {
      /* not present */
    }
    fs.symlinkSync(srcCompose, destCompose);
    p.log.success('docker-compose.yml linked to package source');
  }

  const confirmWrite = ensure(
    await p.confirm({
      message: `.env will be written to ~/.clawbridge/.env. Continue?`,
      initialValue: true,
    }),
  ) as boolean;
  if (!confirmWrite) {
    p.cancel('Aborted. No files written.');
    process.exit(0);
  }

  fs.writeFileSync(envPath, envContent);
  p.log.success(`.env written to ~/.clawbridge/.env`);

  // docker compose up
  const wantsDocker = ensure(
    await p.confirm({
      message: 'Start ClawBridge with docker compose now?',
      initialValue: true,
    }),
  ) as boolean;
  let composeSuccess = false;
  if (wantsDocker) {
    const s2 = p.spinner();
    s2.start('Running docker compose up -d…');
    const result = spawnSync('docker', ['compose', 'up', '-d'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf-8',
      cwd: clawbridgeDir,
    });
    if (result.error) {
      s2.stop(k.red('Docker not found — install Docker Desktop first: https://docs.docker.com/get-docker/'));
    } else if (result.status === 0) {
      composeSuccess = true;
      s2.stop(k.green('ClawBridge is running.'));
      // Wait for Hindsight to be healthy (A9)
      {
        const hindsightUrl = envContent.includes('HINDSIGHT_URL=')
          ? (envContent.split('\n').find((l) => l.startsWith('HINDSIGHT_URL=')) ?? '').split('=')[1]?.trim() ||
            'http://localhost:8888'
          : 'http://localhost:8888';
        p.log.step('Waiting for Hindsight to be ready…');
        let hindsightHealthy = false;
        for (let i = 0; i < 30; i++) {
          try {
            const r = await fetch(`${hindsightUrl}/health`);
            if (r.ok) {
              hindsightHealthy = true;
              break;
            }
          } catch {
            /* not up yet */
          }
          await new Promise((r) => setTimeout(r, 1000));
        }
        if (hindsightHealthy) {
          p.log.success('Hindsight is ready');
        } else {
          p.log.warn('Hindsight did not become healthy in 30s — check: docker logs hindsight-api');
        }
      }
    } else {
      s2.stop(k.yellow('docker compose returned an error — check output below.'));
      if (result.stderr) console.error(result.stderr);
    }
  }

  // Start portal if portal/docker-compose.yml exists in package dir
  // Run from the package's portal/ dir so ./api and ./app volume paths resolve correctly.
  // Pass --env-file so vars from ~/.clawbridge/.env are available.
  try {
    const packageRoot = path.resolve(fileURLToPath(new URL(import.meta.url)), '../../..');
    const portalDir = path.join(packageRoot, 'portal');
    const portalComposeFile = path.join(portalDir, 'docker-compose.yml');
    if (fs.existsSync(portalComposeFile)) {
      const ps = p.spinner();
      ps.start('Starting portal…');
      const portalResult = spawnSync('docker', ['compose', '--env-file', envPath, 'up', '-d'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf-8',
        cwd: portalDir,
      });
      if (portalResult.status === 0) {
        ps.stop(k.green('Portal started.'));
      } else {
        ps.stop(k.yellow('Portal start failed (non-critical) — check logs in portal/'));
        if (portalResult.stderr) console.error(portalResult.stderr);
        p.log.info(
          dim(
            'If the portal fails to start, run:\n' +
              '  docker volume rm portal_portal-db 2>/dev/null; docker compose -f ~/.clawbridge/portal-docker-compose.yml up -d',
          ),
        );
      }
    }
  } catch {
    // portal is optional — don't fail setup
  }

  await buildContainerImageWithRetry();
  await registerLaunchd(cfg.agentName);

  // Telegram channel verification (after everything is running)
  let botUsername: string | undefined;
  if (composeSuccess && telegramToken) {
    botUsername = await verifyTelegramChannel(telegramToken);
  }

  // ── Auto health check before completion ─────────────────────────────────
  if (composeSuccess) {
    const hs = p.spinner();
    hs.start('Running setup verification…');
    const checks: Array<{ label: string; ok: boolean; fix?: string }> = [];

    // Docker daemon
    const dockerCheck = spawnSync('docker', ['info'], { stdio: 'pipe', encoding: 'utf-8', timeout: 5000 });
    checks.push({ label: 'Docker daemon', ok: dockerCheck.status === 0 });

    // Container image
    const { getDefaultContainerImage } = await import('../install-slug.js');
    const imageTag = getDefaultContainerImage();
    let imageOk = false;
    try {
      const ir = spawnSync('docker', ['image', 'inspect', imageTag], {
        stdio: 'pipe',
        encoding: 'utf-8',
        timeout: 5000,
      });
      imageOk = ir.status === 0;
    } catch {
      /* */
    }
    checks.push({ label: 'Agent image', ok: imageOk, fix: 'run: clawbridge build-image' });

    // Hindsight
    let hindsightOk = false;
    try {
      const hr = await fetch('http://localhost:8888/health');
      hindsightOk = hr.ok;
    } catch {
      /* */
    }
    checks.push({ label: 'Hindsight memory', ok: hindsightOk, fix: 'run: docker compose up -d' });

    // Launchd service
    const launchCheck = spawnSync('launchctl', ['list', cfg.agentName.toLowerCase()], {
      stdio: 'pipe',
      encoding: 'utf-8',
      timeout: 3000,
    });
    checks.push({ label: 'Launchd service', ok: launchCheck.status === 0, fix: 'run: clawbridge doctor' });

    hs.stop('Setup verification:');
    for (const c of checks) {
      if (c.ok) {
        p.log.success(c.label);
      } else {
        p.log.warn(`${c.label}${c.fix ? ' — ' + c.fix : ''}`);
      }
    }
  }

  if (composeSuccess) {
    const outroLines = [k.green('✅ ClawBridge is running!'), '', `  • Portal:    ${k.bold('http://localhost:4000')}`];
    if (botUsername) {
      outroLines.push(`  • Telegram:  ${k.bold('@' + botUsername)}  ← message me to start`);
    } else if (telegramToken) {
      outroLines.push(`  • Telegram:  configured ← message your bot to start`);
    }
    outroLines.push(`  • Docs:      ${k.bold('https://docs.clawbridge.dev')}`);
    p.outro(outroLines.join('\n'));
  } else {
    p.outro(
      k.red('✗ Docker compose failed') +
        ` — your .env is saved at ~/.clawbridge/.env
  To start manually: cd ~/.clawbridge && docker compose up -d`,
    );
  }
}

// ─── Migration audit display ──────────────────────────────────────────────────

function printAuditReport(source: MigrationSource, audit: MigrationAudit): void {
  const typeLabel: Record<string, string> = {
    openclaw: 'OpenClaw',
    nanoclaw: 'NanoClaw',
  };
  const label = typeLabel[source.type] ?? source.type;
  const rows: Array<[string, string]> = [
    ['Groups found:', String(audit.groups.length)],
    ['Messages:', audit.messageCount.toLocaleString()],
    ['Custom skills:', String(audit.skills.length)],
    ['Channels:', audit.channels.length > 0 ? audit.channels.join(', ') : 'none detected'],
  ];
  const keyWidth = Math.max(...rows.map(([key]) => key.length));
  const tableLines = rows.map(([key, val]) => `  ${dim(key.padEnd(keyWidth))}  ${k.bold(val)}`).join('\n');

  p.note(tableLines, `📊 Migration Audit — ${label} at ${source.path}`);
}

// ─── Migration flow ───────────────────────────────────────────────────────────

async function runMigrationFlow(): Promise<void> {
  checkDockerPrerequisites();
  checkNodePrerequisites();
  const typeLabel: Record<string, string> = {
    openclaw: 'OpenClaw',
    nanoclaw: 'NanoClaw',
  };

  // 1. Detect install
  const s = p.spinner();
  s.start('Scanning for existing installs…');
  const detected = await detectInstall();
  s.stop(
    detected
      ? k.green(`Found ${typeLabel[detected.type] ?? detected.type} at ${detected.path}`)
      : dim('No install auto-detected.'),
  );

  let source: MigrationSource;
  if (detected) {
    const use = ensure(
      await p.confirm({
        message: `Use ${typeLabel[detected.type] ?? detected.type} at ${detected.path}?`,
        initialValue: true,
      }),
    ) as boolean;
    source = use ? detected : await askManualPath();
  } else {
    source = await askManualPath();
  }

  // 2. Audit
  const s2 = p.spinner();
  s2.start('Auditing install…');
  const audit = await auditInstall(source);
  s2.stop('Audit complete.');
  printAuditReport(source, audit);

  // 3. What to migrate
  type SelectionOption = { value: MigrationSelection; label: string; hint: string };
  const selectionOptions: SelectionOption[] = [];
  if (audit.groups.length > 0) {
    selectionOptions.push({
      value: 'groups',
      label: 'Groups & memory',
      hint: `${audit.groups.length} group(s)`,
    });
  }
  if (audit.messageCount > 0) {
    selectionOptions.push({
      value: 'messages',
      label: 'Message history',
      hint: `${audit.messageCount.toLocaleString()} messages`,
    });
  }
  if (audit.skills.length > 0) {
    selectionOptions.push({
      value: 'skills',
      label: 'Custom skills',
      hint: `${audit.skills.length} file(s)`,
    });
  }
  if (audit.channels.length > 0 || audit.configFiles.includes('.env')) {
    selectionOptions.push({
      value: 'credentials',
      label: 'Channel credentials',
      hint: audit.channels.join(', ') || '.env',
    });
  }

  if (selectionOptions.length === 0) {
    p.log.warn('Nothing migratable was found in that directory.');
    p.outro(dim('Nothing to do.'));
    return;
  }

  // 3a. "Migrate everything" fast path
  const migrateAll = ensure(
    await p.confirm({
      message: 'Migrate everything? (recommended)',
      initialValue: true,
    }),
  ) as boolean;

  let selections: MigrationSelection[];
  if (migrateAll) {
    selections = selectionOptions.map((o) => o.value);
  } else {
    selections = ensure(
      await p.multiselect<MigrationSelection>({
        message: 'What would you like to migrate?',
        options: selectionOptions,
        required: true,
      }),
    ) as MigrationSelection[];
  }

  // 3b. Hindsight config (optional — if user has Hindsight enabled)
  let hindsightCfg: HindsightConfig | undefined;
  const wantsHindsightMigration = ensure(
    await p.confirm({
      message: 'Migrate memory entries to Hindsight semantic memory? (requires Hindsight running)',
      initialValue: false,
    }),
  ) as boolean;
  if (wantsHindsightMigration) {
    const hindsightUrl = (
      ensure(
        await p.text({
          message: 'Hindsight URL',
          placeholder: 'http://localhost:8888',
          defaultValue: 'http://localhost:8888',
        }),
      ) as string
    ).trim();
    const hindsightApiKey = (
      ensure(
        await p.password({
          message: 'Hindsight API key',
          validate: validateRequired,
        }),
      ) as string
    ).trim();
    hindsightCfg = { url: hindsightUrl, apiKey: hindsightApiKey };
  }

  // 4. Safety notice + confirm
  p.log.info(dim('This will NOT affect your existing installation. Your data there is untouched.'));
  const confirmed = ensure(await p.confirm({ message: 'Start migration?', initialValue: true })) as boolean;
  if (!confirmed) {
    p.cancel('Migration cancelled. Nothing was changed.');
    process.exit(0);
  }

  // 5. Run migration with progress
  const migSpinner = p.spinner();
  migSpinner.start('Migrating…');
  let migrationResult: MigrationResult | undefined;
  try {
    migrationResult = await runMigration(
      source,
      audit,
      selections,
      ({ step, detail }) => {
        migSpinner.message(detail ?? step);
      },
      hindsightCfg,
    );
    migSpinner.stop(k.green('Migration complete.'));
  } catch (err) {
    migSpinner.stop(k.red('Migration failed.'));
    p.log.error(err instanceof Error ? err.message : String(err));
    const wantsRollback = ensure(
      await p.confirm({
        message: 'Roll back to pre-migration state?',
        initialValue: true,
      }),
    ) as boolean;
    if (wantsRollback) {
      const rb = p.spinner();
      rb.start('Rolling back…');
      try {
        await rollback(source);
        rb.stop(k.green('Rolled back successfully.'));
      } catch (rbErr) {
        rb.stop(k.red('Rollback also failed.'));
        p.log.error(rbErr instanceof Error ? rbErr.message : String(rbErr));
      }
    }
    process.exit(1);
  }

  // 5a. Post-migration verification (automatic)
  const verifySpinner = p.spinner();
  verifySpinner.start('Verifying migration…');
  const verifyResult = await verifyMigration(source, audit, selections, migrationResult, hindsightCfg);
  verifySpinner.stop('Verification complete.');

  for (const check of verifyResult.checks) {
    if (check.passed) {
      p.log.success(check.message);
    } else {
      p.log.warn(check.message);
    }
  }

  if (verifyResult.passed) {
    p.log.success(k.green('✓ Migration verified — everything looks good'));
  } else {
    const continueAnyway = ensure(
      await p.confirm({
        message: 'Continue anyway?',
        initialValue: false,
      }),
    ) as boolean;
    if (!continueAnyway) {
      const rb = p.spinner();
      rb.start('Rolling back…');
      try {
        await rollback(source);
        rb.stop(k.green('Rolled back successfully.'));
      } catch (rbErr) {
        rb.stop(k.red('Rollback also failed.'));
        p.log.error(rbErr instanceof Error ? rbErr.message : String(rbErr));
      }
      process.exit(1);
    }
  }

  // ── Configure new features ─────────────────────────────────────────────────
  p.intro(dim("Let's configure ClawBridge's new features for your migrated install."));

  // Read source .env for pre-existing values
  const sourceEnvPaths = [
    path.join(source.path, '.env'),
    path.join(source.path, '.env.local'),
    path.join(source.path, 'config', '.env'),
  ];
  let sourceEnv = new Map<string, string>();
  for (const ep of sourceEnvPaths) {
    const parsed = parseEnvFile(ep);
    if (parsed.size > 0) {
      sourceEnv = parsed;
      break;
    }
  }

  const clawbridgeDir = path.join(os.homedir(), '.clawbridge');
  const packageIntegrationsDir = path.resolve(fileURLToPath(new URL(import.meta.url)), '../../../integrations');

  // Create ~/.clawbridge/ and logs/ if they don't exist
  fs.mkdirSync(clawbridgeDir, { recursive: true });
  fs.mkdirSync(path.join(clawbridgeDir, 'logs'), { recursive: true });

  // Symlink docker-compose.yml from package so upgrades auto-pick latest compose
  const srcCompose = path.join(packageIntegrationsDir, 'docker-compose.yml');
  const destCompose = path.join(clawbridgeDir, 'docker-compose.yml');
  if (fs.existsSync(srcCompose)) {
    try {
      fs.unlinkSync(destCompose);
    } catch {
      /* not present */
    }
    fs.symlinkSync(srcCompose, destCompose);
  }

  // Step A — Claude OAuth token
  const migratedOauthToken = await setupClaudeAuth(sourceEnv.get('CLAUDE_CODE_OAUTH_TOKEN'));

  // Step B — Agent name
  const migratedAgentName = await promptAgentName(sourceEnv.get('ASSISTANT_NAME') ?? sourceEnv.get('AGENT_NAME'));

  // Step C — Admin credentials (reuse silently if found)
  const existingAdminEmail = sourceEnv.get('ADMIN_EMAIL');
  const existingAdminPassword = sourceEnv.get('ADMIN_PASSWORD');
  if (existingAdminEmail && existingAdminPassword) {
    p.log.success('Admin credentials found in source ✓');
  }

  // Step E — Hindsight (skip if already configured in source)
  const {
    dbPassword: migratedHindsightDbPw,
    apiKey: migratedHindsightApiKey,
    url: migratedHindsightUrl,
  } = await promptHindsight(sourceEnv.get('HINDSIGHT_URL'));

  // Detect channels from source .env for the new .env
  const migratedChannels: string[] = [];
  if (sourceEnv.get('TELEGRAM_BOT_TOKEN')) migratedChannels.push('telegram');
  if ([...sourceEnv.keys()].some((k) => /WHATSAPP/i.test(k))) migratedChannels.push('whatsapp');
  if ([...sourceEnv.keys()].some((k) => /DISCORD/i.test(k))) migratedChannels.push('discord');
  if ([...sourceEnv.keys()].some((k) => /SLACK/i.test(k))) migratedChannels.push('slack');
  if ([...sourceEnv.keys()].some((k) => /GMAIL|GOOGLE_OAUTH/i.test(k))) migratedChannels.push('gmail');

  // Step F — Generate complete .env
  const migratedCfg: FreshConfig = {
    agentName: migratedAgentName,
    oauthToken: migratedOauthToken,
    telegramToken: sourceEnv.get('TELEGRAM_BOT_TOKEN'),
    channels: migratedChannels,
    hindsightDbPassword: migratedHindsightDbPw ?? sourceEnv.get('HINDSIGHT_DB_PASSWORD'),
    hindsightApiKey: migratedHindsightApiKey ?? sourceEnv.get('HINDSIGHT_API_KEY'),
    hindsightUrl: migratedHindsightUrl ?? sourceEnv.get('HINDSIGHT_URL'),
  };

  const envPath = path.join(clawbridgeDir, '.env');
  const confirmEnvWrite = ensure(
    await p.confirm({
      message: `.env will be written to ~/.clawbridge/.env. Continue?`,
      initialValue: true,
    }),
  ) as boolean;
  if (confirmEnvWrite) {
    fs.writeFileSync(envPath, buildEnvFile(migratedCfg, sourceEnv));
    p.log.success(`.env written to ~/.clawbridge/.env`);
  }

  // Step G — docker compose up
  const wantsMigrationDocker = ensure(
    await p.confirm({
      message: 'Start ClawBridge with docker compose now?',
      initialValue: true,
    }),
  ) as boolean;
  if (wantsMigrationDocker) {
    const ds = p.spinner();
    ds.start('Running docker compose up -d…');
    const dockerResult = spawnSync('docker', ['compose', 'up', '-d'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf-8',
      cwd: clawbridgeDir,
    });
    if (dockerResult.error) {
      ds.stop(k.red('Docker not found — install Docker Desktop first: https://docs.docker.com/get-docker/'));
    } else if (dockerResult.status === 0) {
      ds.stop(k.green('ClawBridge is running.'));
      // Wait for Hindsight to be healthy (A9)
      {
        const hUrl = sourceEnv.get('HINDSIGHT_URL') ?? 'http://localhost:8888';
        p.log.step('Waiting for Hindsight to be ready…');
        let hHealthy = false;
        for (let i = 0; i < 30; i++) {
          try {
            const r = await fetch(`${hUrl}/health`);
            if (r.ok) {
              hHealthy = true;
              break;
            }
          } catch {
            /* not up yet */
          }
          await new Promise((r) => setTimeout(r, 1000));
        }
        if (hHealthy) {
          p.log.success('Hindsight is ready');
        } else {
          p.log.warn('Hindsight did not become healthy in 30s — check: docker logs hindsight-api');
        }
      }
    } else {
      ds.stop(k.yellow('docker compose returned an error — check output below.'));
      if (dockerResult.stderr) console.error(dockerResult.stderr);
    }
  }

  // Start portal if portal/docker-compose.yml exists in package dir
  // Run from the package's portal/ dir so ./api and ./app volume paths resolve correctly.
  // Pass --env-file so vars from ~/.clawbridge/.env are available.
  try {
    const packageRoot2 = path.resolve(fileURLToPath(new URL(import.meta.url)), '../../..');
    const portalDir2 = path.join(packageRoot2, 'portal');
    const portalComposeFile2 = path.join(portalDir2, 'docker-compose.yml');
    if (fs.existsSync(portalComposeFile2)) {
      const ps2 = p.spinner();
      ps2.start('Starting portal…');
      const portalResult2 = spawnSync('docker', ['compose', '--env-file', envPath, 'up', '-d'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf-8',
        cwd: portalDir2,
      });
      if (portalResult2.status === 0) {
        ps2.stop(k.green('Portal started.'));
      } else {
        ps2.stop(k.yellow('Portal start failed (non-critical) — check logs in portal/'));
        if (portalResult2.stderr) console.error(portalResult2.stderr);
        p.log.info(
          dim(
            'If the portal fails to start, run:\n' +
              '  docker volume rm portal_portal-db 2>/dev/null; docker compose -f ~/.clawbridge/portal-docker-compose.yml up -d',
          ),
        );
      }
    }
  } catch {
    // portal is optional — don't fail setup
  }

  // 6. Optionally deactivate source
  const label = typeLabel[source.type] ?? source.type;
  const wantsDeactivate = ensure(
    await p.confirm({
      message: `Would you like to deactivate ${label}? (Your data is safe — this adds a .disabled marker)`,
      initialValue: false,
    }),
  ) as boolean;
  if (wantsDeactivate) {
    deactivateSource(source);
    p.log.success(`${label} marked as deactivated.`);
  }

  await buildContainerImageWithRetry();
  await registerLaunchd(migratedCfg.agentName);

  p.outro(k.green('✅ Migration done!') + `  ClawBridge data is at ${k.bold(os.homedir() + '/.clawbridge')}`);
}

async function askManualPath(): Promise<MigrationSource> {
  while (true) {
    const input = ensure(
      await p.text({
        message: 'Enter the path to your existing install',
        placeholder: '~/openclaw',
        validate: validateRequired,
      }),
    ) as string;
    const result = resolveManualPath(input.trim().replace(/^~/, os.homedir()));
    if ('error' in result) {
      p.log.error(result.error);
      continue;
    }
    return result;
  }
}

// ─── Container image build ────────────────────────────────────────────────────

async function buildContainerImageWithRetry(): Promise<boolean> {
  while (true) {
    const ok = await buildContainerImage();
    if (ok) return true;

    // Check if Docker is running
    const dockerCheck = spawnSync('docker', ['info'], { stdio: 'pipe', encoding: 'utf-8', timeout: 5000 });
    const dockerRunning = dockerCheck.status === 0;

    if (!dockerRunning) {
      p.log.warn('Docker Desktop is not running. Please start it and press Enter to retry.');
      const retry = ensure(
        await p.confirm({ message: 'Docker Desktop started? Retry image build?', initialValue: true }),
      ) as boolean;
      if (!retry) {
        p.log.warn('⚠️  Image not built — run: clawbridge build-image once Docker is running');
        return false;
      }
      continue;
    }

    const retry = ensure(await p.confirm({ message: 'Image build failed. Retry?', initialValue: true })) as boolean;
    if (!retry) {
      p.log.warn('⚠️  Image not built — run: clawbridge build-image to finish setup');
      return false;
    }
  }
}

async function buildContainerImage(): Promise<boolean> {
  try {
    const packageRoot = path.resolve(fileURLToPath(new URL(import.meta.url)), '../../..');
    const buildScript = path.join(packageRoot, 'container', 'build.sh');
    if (!fs.existsSync(buildScript)) {
      p.log.warn('container/build.sh not found — image build skipped');
      return false;
    }
    const s = p.spinner();
    s.start('Building agent container image (this takes 1–2 min on first run)…');
    const result = spawnSync('bash', [buildScript], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf-8',
      cwd: path.join(packageRoot, 'container'),
      timeout: 300_000, // 5 min max
    });
    if (result.status === 0) {
      s.stop(k.green('Container image built.'));
      return true;
    } else {
      s.stop(k.red('Image build failed.'));
      if (result.stderr) console.error(result.stderr);
      p.log.warn('To retry: clawbridge build-image');
      return false;
    }
  } catch (err) {
    p.log.warn(`Image build error — run: clawbridge build-image\n${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

// ─── launchd registration ─────────────────────────────────────────────────────

async function registerLaunchd(assistantName: string): Promise<void> {
  try {
    const home = os.homedir();
    const packageRoot = path.resolve(fileURLToPath(new URL(import.meta.url)), '../../..');
    const tmplPath = path.join(packageRoot, 'launchd', 'com.clawbridge.plist.tmpl');
    if (!fs.existsSync(tmplPath)) {
      p.log.warn('launchd template not found — skipping service registration.');
      return;
    }
    const slug = getLaunchdLabel(packageRoot);
    let nodePath = process.execPath;
    try {
      const which = spawnSync('which', ['node'], { encoding: 'utf-8' });
      if (which.status === 0 && which.stdout.trim()) nodePath = which.stdout.trim();
    } catch {
      /* use process.execPath */
    }

    const tmpl = fs.readFileSync(tmplPath, 'utf-8');
    const plistContent = tmpl
      .replace(/\{\{SLUG\}\}/g, slug)
      .replace(/\{\{HOME\}\}/g, home)
      .replace(/\{\{NODE_PATH\}\}/g, nodePath)
      .replace(/\{\{PROJECT_ROOT\}\}/g, packageRoot);

    const launchAgentsDir = path.join(home, 'Library', 'LaunchAgents');
    fs.mkdirSync(launchAgentsDir, { recursive: true });
    const plistPath = path.join(launchAgentsDir, `${slug}.plist`);
    fs.writeFileSync(plistPath, plistContent);
    p.log.success(`launchd plist written to ~/Library/LaunchAgents/${slug}.plist`);

    try {
      const uid = execSync('id -u', { encoding: 'utf-8' }).trim();
      execSync(`launchctl bootstrap gui/${uid} ${plistPath}`, { encoding: 'utf-8' });
      p.log.success('ClawBridge agent registered with launchd and will start automatically.');
    } catch (err) {
      p.log.warn(`launchctl bootstrap failed: ${err instanceof Error ? err.message : String(err)}`);
      p.log.info(`To register manually: launchctl bootstrap gui/$(id -u) ${plistPath}`);
    }
  } catch (err) {
    p.log.warn(`launchd registration failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  printBanner();
  p.intro(`${brandBold('Welcome to ClawBridge Agent setup.')}`);

  const mode = ensure(
    await p.select({
      message: 'How would you like to get started?',
      options: [
        { value: 'fresh', label: 'Fresh install' },
        { value: 'openclaw', label: 'Migrate from OpenClaw' },
        { value: 'nanoclaw', label: 'Migrate from NanoClaw' },
      ],
    }),
  ) as 'fresh' | 'openclaw' | 'nanoclaw';

  if (mode === 'fresh') {
    await runFreshInstall();
  } else {
    await runMigrationFlow();
  }
}

main().catch((err) => {
  p.log.error(err instanceof Error ? err.message : String(err));
  p.cancel('Setup aborted.');
  process.exit(1);
});
