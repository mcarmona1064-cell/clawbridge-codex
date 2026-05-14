/**
 * Step: auth — Verify or write an OpenAI/Codex credential.
 *
 * Modes:
 *   --check                   (default) Verify a credential is available.
 *                             Considers ~/.codex/auth.json (subscription
 *                             login) OR OPENAI_API_KEY in .env.
 *   --create --value <token>  Write OPENAI_API_KEY=<value> to .env.
 *                             Errors if a credential already exists unless
 *                             --force is passed.
 *
 * Credentials are stored in .clawbridge/.env and injected at container spawn
 * time by container-runner.ts. The token value is never logged.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { log } from '../src/log.js';
import { emitStatus } from './status.js';

interface Args {
  mode: 'check' | 'create';
  value?: string;
  force: boolean;
}

function parseArgs(args: string[]): Args {
  let mode: 'check' | 'create' = 'check';
  let value: string | undefined;
  let force = false;

  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    const val = args[i + 1];
    switch (key) {
      case '--check':
        mode = 'check';
        break;
      case '--create':
        mode = 'create';
        break;
      case '--value':
        value = val;
        i++;
        break;
      case '--force':
        force = true;
        break;
    }
  }

  if (mode === 'create' && !value) {
    emitStatus('AUTH', {
      STATUS: 'failed',
      ERROR: 'missing_value_for_create',
      LOG: 'logs/setup.log',
    });
    process.exit(2);
  }

  return { mode, value, force };
}

const ENV_KEY = 'OPENAI_API_KEY' as const;
const CODEX_AUTH_PATH = path.join(os.homedir(), '.codex', 'auth.json');

function readEnvFile(envFile: string): Record<string, string> {
  if (!fs.existsSync(envFile)) return {};
  const content = fs.readFileSync(envFile, 'utf-8');
  const result: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (m) result[m[1]] = m[2];
  }
  return result;
}

function writeEnvKey(envFile: string, key: string, value: string): void {
  let content = '';
  if (fs.existsSync(envFile)) {
    content = fs.readFileSync(envFile, 'utf-8');
  }
  const lineRegex = new RegExp(`^${key}=.*$`, 'm');
  const newLine = `${key}=${value}`;
  if (lineRegex.test(content)) {
    content = content.replace(lineRegex, newLine);
  } else {
    const sep = content && !content.endsWith('\n') ? '\n' : '';
    content = content + sep + newLine + '\n';
  }
  fs.mkdirSync(path.dirname(envFile), { recursive: true });
  fs.writeFileSync(envFile, content, { mode: 0o600 });
}

export async function run(args: string[]): Promise<void> {
  const { mode, value, force } = parseArgs(args);

  const envFile = path.join(process.cwd(), '.env');
  const env = readEnvFile(envFile);
  const hasApiKey = !!env[ENV_KEY];
  const hasCodexLogin = fs.existsSync(CODEX_AUTH_PATH);
  const hasCredential = hasApiKey || hasCodexLogin;

  if (mode === 'check') {
    emitStatus('AUTH', {
      SECRET_PRESENT: hasCredential,
      OPENAI_OK: hasCredential,
      STATUS: hasCredential ? 'success' : 'missing',
      ...(hasApiKey ? { ENV_KEY } : {}),
      ...(hasCodexLogin && !hasApiKey ? { SOURCE: 'codex_login' } : {}),
      LOG: 'logs/setup.log',
    });
    return;
  }

  // mode === 'create'
  if (hasCredential && !force) {
    emitStatus('AUTH', {
      SECRET_PRESENT: true,
      STATUS: 'skipped',
      REASON: 'credential_already_exists',
      ...(hasApiKey ? { ENV_KEY } : { SOURCE: 'codex_login' }),
      HINT: 'Re-run with --force to replace.',
      LOG: 'logs/setup.log',
    });
    return;
  }

  try {
    writeEnvKey(envFile, ENV_KEY, value!);
    log.info('Wrote credential to .env', { key: ENV_KEY });
  } catch (err) {
    const e = err as { message?: string };
    log.error('Failed to write credential to .env', { err });
    emitStatus('AUTH', {
      STATUS: 'failed',
      ERROR: 'env_write_failed',
      DETAIL: e.message ?? String(err),
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  // Re-verify
  const updated = readEnvFile(envFile);
  const ok = !!updated[ENV_KEY];

  emitStatus('AUTH', {
    SECRET_PRESENT: ok,
    OPENAI_OK: ok,
    CREATED: true,
    STATUS: ok ? 'success' : 'failed',
    ENV_KEY,
    LOG: 'logs/setup.log',
  });
}
