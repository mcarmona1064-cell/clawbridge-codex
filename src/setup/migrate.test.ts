import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadMigrateWithHome(home: string) {
  vi.resetModules();
  vi.doMock('os', async (importOriginal) => {
    const actual = await importOriginal<typeof import('os')>();
    return {
      ...actual,
      default: { ...actual, homedir: () => home },
      homedir: () => home,
    };
  });
  return import('./migrate.js');
}

describe('clawbridge-codex migration detection', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('does not auto-detect ~/.clawbridge as clawbridge-agent when it is already codex', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-codex-home-'));
    fs.mkdirSync(path.join(home, '.clawbridge'), { recursive: true });
    fs.writeFileSync(path.join(home, '.clawbridge', '.env'), 'AGENT_PROVIDER=codex\nTELEGRAM_BOT_TOKEN=x\n');

    const { detectInstall } = await loadMigrateWithHome(home);

    await expect(detectInstall()).resolves.toBeNull();
  });

  it('does not auto-detect an empty ~/.clawbridge data dir as a legacy clawbridge-agent install', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-empty-home-'));
    fs.mkdirSync(path.join(home, '.clawbridge'), { recursive: true });

    const { detectInstall } = await loadMigrateWithHome(home);

    await expect(detectInstall()).resolves.toBeNull();
  });

  it('auto-detects ~/.clawbridge only when it still declares a non-codex provider', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-legacy-home-'));
    fs.mkdirSync(path.join(home, '.clawbridge'), { recursive: true });
    fs.writeFileSync(path.join(home, '.clawbridge', '.env'), 'AGENT_PROVIDER=claude\nTELEGRAM_BOT_TOKEN=x\n');

    const { detectInstall } = await loadMigrateWithHome(home);

    await expect(detectInstall()).resolves.toEqual({
      type: 'clawbridge',
      path: path.join(home, '.clawbridge'),
    });
  });
});
