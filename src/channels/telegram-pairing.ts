/**
 * Telegram pairing — file-based IPC between the running host service and
 * the setup/pair-telegram step.
 *
 * Flow:
 *   1. setup/pair-telegram calls createPairing() → writes DATA_DIR/pairing.json
 *      with state=pending and waits.
 *   2. The running Telegram adapter (telegram.ts) intercepts the FIRST message
 *      received while pairing is pending, writes the result back to pairing.json,
 *      and swallows the message (does not route it to the agent).
 *   3. waitForPairing() polls pairing.json until consumed or timeout.
 *
 * No code entry required — the operator just sends /start (or any message)
 * to the bot from the chat they want to register.
 */

import fs from 'fs';
import path from 'path';
import { DATA_DIR } from '../config.js';

const PAIRING_FILE = path.join(DATA_DIR, 'pairing.json');
const POLL_INTERVAL_MS = 2000;
const TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export type PairingIntent = 'main' | { kind: 'wire-to'; folder: string } | { kind: 'new-agent'; folder: string };

interface PairingRecord {
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
 * message should be consumed as a pairing attempt.
 *
 * When pairing is pending, the FIRST message from any chat is accepted —
 * the operator just sends /start (or any text) to their bot.
 * Returns true if the message was consumed (caller should not route it).
 */
export function interceptPairingMessage(
  text: string,
  platformId: string,
  isGroup: boolean,
  adminUserId?: string,
): boolean {
  const record = readPairing();
  if (!record || record.state !== 'pending') return false;

  // Accept the first message received — no code required.
  // The operator is the one sending /start during setup.
  writePairing({
    ...record,
    state: 'consumed',
    result: { platformId, isGroup, adminUserId },
  });
  return true;
}

export async function createPairing(intent: PairingIntent): Promise<void> {
  writePairing({
    intent,
    state: 'pending',
    createdAt: new Date().toISOString(),
  });
}

export async function waitForPairing(): Promise<{
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
      if (!record) {
        clearInterval(poll);
        reject(new Error('Pairing record missing'));
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
