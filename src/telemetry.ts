/**
 * Telemetry — fire-and-forget crash/install/doctor-failure reports.
 *
 * Sends anonymous structured events to the ClawBridge relay, which
 * forwards them to mark@clawbridgeagency.com.
 *
 * NEVER sends: credentials, API keys, message content, user data.
 * ALWAYS sends: error type/stack, ClawBridge version, OS, Node version,
 *               a random per-install ID (not tied to any user identity).
 *
 * Opt out: set CLAWBRIDGE_NO_TELEMETRY=true in ~/.clawbridge/.env
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { readEnvFile } from './env.js';

// ── Config ──────────────────────────────────────────────────────────────────

const RELAY_URL = 'https://telemetry.clawbridgeagency.com/report';
const TIMEOUT_MS = 5_000;
const INSTALL_ID_FILE = path.join(os.homedir(), '.clawbridge', 'install-id');

export type TelemetryEvent =
  | {
      event: 'crash';
      error: string;
      stack: string;
      file: string;
      context?: string;
    }
  | {
      event: 'doctor_failure';
      failures: Array<{ label: string; detail: string }>;
    }
  | {
      event: 'install';
      success: boolean;
      channel?: string;
      errorMessage?: string;
    }
  | {
      event: 'upgrade';
      fromVersion: string;
      toVersion: string;
      success: boolean;
      errorMessage?: string;
    };

// ── Install ID ───────────────────────────────────────────────────────────────

/** Returns a stable random ID for this installation. Created once on first call. */
function getInstallId(): string {
  try {
    if (fs.existsSync(INSTALL_ID_FILE)) {
      const id = fs.readFileSync(INSTALL_ID_FILE, 'utf-8').trim();
      if (id.length > 8) return id;
    }
  } catch {
    // fall through to generate
  }
  // Generate a new UUID-like ID
  const id = 'cb-' + [...Array(16)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');
  try {
    fs.mkdirSync(path.dirname(INSTALL_ID_FILE), { recursive: true });
    fs.writeFileSync(INSTALL_ID_FILE, id, 'utf-8');
  } catch {
    // non-fatal — we'll just use a one-time ID if the file can't be written
  }
  return id;
}

// ── Package version ──────────────────────────────────────────────────────────

function getVersion(): string {
  try {
    const pkgPath = new URL('../package.json', import.meta.url);
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version: string };
    return pkg.version;
  } catch {
    return 'unknown';
  }
}

// ── Opt-out check ────────────────────────────────────────────────────────────

function isTelemetryEnabled(): boolean {
  if (process.env.CLAWBRIDGE_NO_TELEMETRY === 'true') return false;
  try {
    const env = readEnvFile(['CLAWBRIDGE_NO_TELEMETRY']);
    if (env.CLAWBRIDGE_NO_TELEMETRY === 'true') return false;
  } catch {
    // env file unreadable — default to enabled
  }
  return true;
}

// ── Report ───────────────────────────────────────────────────────────────────

/**
 * Send a telemetry event. Fire-and-forget — never throws, never blocks.
 * Safe to call from error handlers and shutdown paths.
 */
export function reportTelemetry(payload: TelemetryEvent): void {
  if (!isTelemetryEnabled()) return;

  const body = JSON.stringify({
    ...payload,
    installId: getInstallId(),
    version: getVersion(),
    platform: process.platform,
    nodeVersion: process.version,
    ts: new Date().toISOString(),
    uptime: Math.round(process.uptime()),
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  fetch(RELAY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: controller.signal,
  })
    .catch(() => {
      /* silently ignore — telemetry must never affect the host process */
    })
    .finally(() => clearTimeout(timer));
}
