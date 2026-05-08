/**
 * Telegram pairing — file-based IPC between the running host service and
 * the setup/pair-telegram step.
 *
 * Flow:
 *   1. setup/pair-telegram calls createPairing() → writes DATA_DIR/pairing.json
 *      with a random code and waits.
 *   2. The running Telegram adapter (telegram.ts) intercepts any message whose
 *      text matches the code, writes the result back to pairing.json, and
 *      swallows the message (does not route it to the agent).
 *   3. waitForPairing() polls pairing.json until consumed or timeout.
 */

import fs from 'fs';
import path from 'path';
import { DATA_DIR } from '../config.js';

const PAIRING_FILE = path.join(DATA_DIR, 'pairing.json');
const POLL_INTERVAL_MS = 2000;
const TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export type PairingIntent =
  | 'main'
  | { kind: 'wire-to'; folder: string }
  | { kind: 'new-agent'; folder: string };

interface PairingRecord {
  code: string;
  intent: PairingIntent;
  state: 'pending' | 'consumed' | 'failed';
  createdAt: string;
  result?: {
    platformId: string;
    isGroup: boolean;
    adminUserId?: string;
  };
  error?: string;
}

function generateCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'CB-';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function readPairing(): PairingRecord | null {
  try {
    return JSON.parse(fs.readFileSync(PAIRING_FILE, 'utf-8')) as PairingRecord;
  } catch {
    return null;
  }
}

function writePairing(record: PairingRecord): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PAIRING_FILE, JSON.stringify(record, null, 2), 'utf-8');
}

export function clearPairing(): void {
  try {
    fs.unlinkSync(PAIRING_FILE);
  } catch {
    // ignore if not present
  }
}

/**
 * Called by the Telegram adapter in handleMessage to check if an incoming
 * message is a pairing code submission. Returns true if the message was
 * consumed as a pairing attempt (caller should not route it to the agent).
 */
export function interceptPairingMessage(
  text: string,
  platformId: string,
  isGroup: boolean,
  adminUserId?: string,
): boolean {
  const record = readPairing();
  if (!record || record.state !== 'pending') return false;

  const normalized = text.trim().toUpperCase();

  // Notify about the attempt regardless of match
  if (normalized.length > 0) {
    // Update with attempt info (non-destructive, state stays pending unless match)
    // We don't write attempts to the file — setup/pair-telegram handles display
    // via the onAttempt callback through polling.
  }

  if (normalized === record.code) {
    writePairing({
      ...record,
      state: 'consumed',
      result: { platformId, isGroup, adminUserId },
    });
    return true;
  }

  // Wrong code — still consume the message silently if it looks like a pairing attempt
  // (starts with "CB-" prefix) to avoid confusing the agent.
  if (normalized.startsWith('CB-')) {
    return true;
  }

  return false;
}

export async function createPairing(intent: PairingIntent): Promise<{ code: string }> {
  const code = generateCode();
  writePairing({
    code,
    intent,
    state: 'pending',
    createdAt: new Date().toISOString(),
  });
  return { code };
}

export async function waitForPairing(
  code: string,
  options: { onAttempt?: (a: { candidate: string }) => void } = {},
): Promise<{
  intent: PairingIntent;
  consumed: { platformId: string; isGroup: boolean; adminUserId?: string } | null;
}> {
  const start = Date.now();

  return new Promise((resolve, reject) => {
    const poll = setInterval(() => {
      if (Date.now() - start > TIMEOUT_MS) {
        clearInterval(poll);
        clearPairing();
        reject(new Error('Pairing timed out after 10 minutes'));
        return;
      }

      const record = readPairing();
      if (!record || record.code !== code) {
        clearInterval(poll);
        reject(new Error('Pairing record missing or code mismatch'));
        return;
      }

      if (record.state === 'consumed' && record.result) {
        clearInterval(poll);
        clearPairing();
        resolve({
          intent: record.intent,
          consumed: record.result,
        });
        return;
      }

      if (record.state === 'failed') {
        clearInterval(poll);
        clearPairing();
        reject(new Error(record.error ?? 'Pairing failed'));
        return;
      }
    }, POLL_INTERVAL_MS);
  });
}
