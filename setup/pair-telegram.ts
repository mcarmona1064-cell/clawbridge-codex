/**
 * Step: pair-telegram — wait for the operator to send /start (or any message)
 * to the bot from the chat they want to register.
 *
 * No code entry required. The running Telegram adapter intercepts the first
 * incoming message while pairing.json is pending and records the chat ID.
 *
 * Emits machine-readable status blocks only. The parent driver
 * (`setup:auto`) renders the UI with clack.
 *
 * Blocks emitted:
 *   PAIR_TELEGRAM_READY (signals operator should now send /start)
 *   PAIR_TELEGRAM (final)  { STATUS=success, INTENT, PLATFORM_ID,
 *                            IS_GROUP, PAIRED_USER_ID }
 *                       or { STATUS=failed, ERROR }
 */
import path from 'path';

import {
  createPairing,
  waitForPairing,
  type PairingIntent,
} from '../src/channels/telegram-pairing.js';
import { DATA_DIR } from '../src/config.js';
import { initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';

import { emitStatus } from './status.js';

function parseArgs(args: string[]): PairingIntent {
  let intent: PairingIntent = 'main';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--intent') {
      const raw = args[++i] || 'main';
      if (raw === 'main') {
        intent = 'main';
      } else if (raw.startsWith('wire-to:')) {
        intent = { kind: 'wire-to', folder: raw.slice('wire-to:'.length) };
      } else if (raw.startsWith('new-agent:')) {
        intent = { kind: 'new-agent', folder: raw.slice('new-agent:'.length) };
      } else {
        throw new Error(`Unknown intent: ${raw}`);
      }
    }
  }
  return intent;
}

function intentToString(intent: PairingIntent): string {
  if (intent === 'main') return 'main';
  return `${intent.kind}:${intent.folder}`;
}

export async function run(args: string[]): Promise<void> {
  const intent = parseArgs(args);

  // Touch the DB so migrations are applied before the interceptor fires.
  const db = initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(db);

  await createPairing(intent);

  // Signal the UI that pairing is ready — operator should now send /start
  emitStatus('PAIR_TELEGRAM_READY', {});

  try {
    const consumed = await waitForPairing();

    emitStatus('PAIR_TELEGRAM', {
      STATUS: 'success',
      INTENT: intentToString(consumed.intent),
      PLATFORM_ID: consumed.consumed!.platformId,
      IS_GROUP: consumed.consumed!.isGroup,
      PAIRED_USER_ID: consumed.consumed!.adminUserId
        ? `telegram:${consumed.consumed!.adminUserId}`
        : '',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emitStatus('PAIR_TELEGRAM', {
      STATUS: 'failed',
      ERROR: message,
    });
    process.exit(2);
  }
}
