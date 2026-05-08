/**
 * Step: auth — Verify or write an Anthropic credential to .env.
 *
 * Modes:
 *   --check                   (default) Verify a credential exists in .env.
 *   --create --value <token>  Write a credential to .env. Errors if one
 *                             already exists unless --force is passed.
 *
 * Credentials are stored in .clawbridge/.env and injected at container spawn
 * time by container-runner.ts. The token value is never logged.
 */
import fs from 'fs';
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

const ENV_KEYS = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'] as const;

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

function detectCredentialKey(value: string): 'CLAUDE_CODE_OAUTH_TOKEN' | 'ANTHROPIC_API_KEY' {
  return value.startsWith('sk-ant-oat') ? 'CLAUDE_CODE_OAUTH_TOKEN' : 'ANTHROPIC_API_KEY';
}

export async function run(args: string[]): Promise<void> {
  const { mode, value, force } = parseArgs(args);

  const envFile = path.join(process.cwd(), '.env');
  const env = readEnvFile(envFile);
  const existingKey = ENV_KEYS.find((k) => env[k]);

  if (mode === 'check') {
    emitStatus('AUTH', {
      SECRET_PRESENT: !!existingKey,
      ANTHROPIC_OK: !!existingKey,
      STATUS: existingKey ? 'success' : 'missing',
      ...(existingKey ? { ENV_KEY: existingKey } : {}),
      LOG: 'logs/setup.log',
    });
    return;
  }

  // mode === 'create'
  if (existingKey && !force) {
    emitStatus('AUTH', {
      SECRET_PRESENT: true,
      STATUS: 'skipped',
      REASON: 'credential_already_exists',
      ENV_KEY: existingKey,
      HINT: 'Re-run with --force to replace.',
      LOG: 'logs/setup.log',
    });
    return;
  }

  const credKey = detectCredentialKey(value!);

  try {
    writeEnvKey(envFile, credKey, value!);
    log.info('Wrote credential to .env', { key: credKey });
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
  const ok = ENV_KEYS.some((k) => updated[k]);

  emitStatus('AUTH', {
    SECRET_PRESENT: ok,
    ANTHROPIC_OK: ok,
    CREATED: true,
    STATUS: ok ? 'success' : 'failed',
    ENV_KEY: credKey,
    LOG: 'logs/setup.log',
  });
}
