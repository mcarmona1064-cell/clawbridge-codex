import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { homedir } from 'os';
import { log } from './log.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Parse the .env file and return values for the requested keys.
 * Does NOT load anything into process.env — callers decide what to
 * do with the values. This keeps secrets out of the process environment
 * so they don't leak to child processes.
 */
export function readEnvFile(keys: string[]): Record<string, string> {
  const candidates = [
    path.join(homedir(), '.clawbridge', '.env'),
    path.resolve(__dirname, '../../integrations/.env'),
  ];
  const envFile = candidates.find(p => fs.existsSync(p)) ?? candidates[0];
  let content: string;
  try {
    content = fs.readFileSync(envFile, 'utf-8');
  } catch (err) {
    if (!fs.existsSync(envFile) && !process.env['CLAUDE_CODE_OAUTH_TOKEN']) {
      log.warn('Warning: .env not found and no environment variables set. Run the setup wizard first.');
    } else {
      log.debug('.env file not found, using defaults', { err });
    }
    return {};
  }

  const result: Record<string, string> = {};
  const wanted = new Set(keys);

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!wanted.has(key)) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (value) result[key] = value;
  }

  return result;
}
