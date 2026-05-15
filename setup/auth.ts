/**
 * Step: auth — verify Codex subscription OAuth for the agent runtime.
 *
 * ClawBridge Codex runs the `codex` CLI in subscription/OAuth mode. Runtime
 * auth is the host login file created by `codex login --device-auth`:
 *   ~/.codex/auth.json
 *
 * API-key billing env vars are intentionally not accepted here. The container
 * provider strips API-key env vars before spawning Codex so setup cannot pass
 * while runtime later fails or accidentally bills a key-based account.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { emitStatus } from './status.js';

interface Args {
  mode: 'check';
}

const CODEX_AUTH_PATH = path.join(os.homedir(), '.codex', 'auth.json');

function parseArgs(args: string[]): Args {
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    switch (key) {
      case '--check':
        break;
      case '--create':
      case '--value':
      case '--force':
        emitStatus('AUTH', {
          STATUS: 'failed',
          ERROR: 'api_key_auth_not_supported',
          HINT: 'Run: codex login --device-auth',
          LOG: 'logs/setup.log',
        });
        process.exit(2);
        break;
    }
  }

  return { mode: 'check' };
}

export async function run(args: string[]): Promise<void> {
  parseArgs(args);

  const hasCodexLogin = fs.existsSync(CODEX_AUTH_PATH);

  emitStatus('AUTH', {
    SECRET_PRESENT: hasCodexLogin,
    CODEX_OAUTH_OK: hasCodexLogin,
    STATUS: hasCodexLogin ? 'success' : 'missing',
    SOURCE: hasCodexLogin ? 'codex_login' : 'missing_codex_login',
    HINT: hasCodexLogin ? '~/.codex/auth.json present' : 'Run: codex login --device-auth',
    LOG: 'logs/setup.log',
  });
}
