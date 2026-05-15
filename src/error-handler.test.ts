/**
 * Basic tests for error-handler.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
}));

// We need to mock the env module before importing error-handler
vi.mock('./env.js', () => ({
  readEnvFile: () => ({}),
}));

vi.mock('./log.js', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFile: execFileMock,
  };
});

const TEST_LOG_DIR = path.join(os.tmpdir(), `clawbridge-test-${process.pid}`);
const TEST_LOG_FILE = path.join(TEST_LOG_DIR, 'errors.log');

// Patch the home dir for log path resolution
const originalHome = process.env.HOME;
beforeEach(() => {
  process.env.HOME = TEST_LOG_DIR.replace(/\/errors\.log$/, '').replace(/\/\.clawbridge$/, '');
  // Create a fake home so LOG_DIR resolves to our test dir
  // We'll patch the module-level constant instead by manipulating HOME before import
});

afterEach(() => {
  process.env.HOME = originalHome;
  delete process.env.OPENAI_API_KEY;
  execFileMock.mockReset();
  vi.restoreAllMocks();
  try {
    fs.rmSync(TEST_LOG_DIR, { recursive: true });
  } catch {
    /* ignore */
  }
});

describe('Codex subscription diagnosis', () => {
  it('gets runtime diagnosis through Codex CLI OAuth instead of OpenAI API key billing', async () => {
    process.env.OPENAI_API_KEY = 'should-not-be-used';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(null, 'Use the Codex subscription diagnosis.', '');
    });

    const { getDiagnosis } = await import('./error-handler.js');
    const diagnosis = await getDiagnosis(new Error('boom'), '1 >>> throw new Error("boom")');

    expect(diagnosis).toContain('Codex subscription diagnosis');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = execFileMock.mock.calls[0];
    expect(cmd).toBe('codex');
    expect(args).toEqual(expect.arrayContaining(['exec', '--sandbox', 'read-only', '--skip-git-repo-check']));
    expect(args.join(' ')).not.toContain('OPENAI_API_KEY');
    expect(opts).toMatchObject({ cwd: process.cwd() });
  });

  it('reports Codex OAuth login requirement when CLI diagnosis cannot run', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(new Error('not logged in'), '', 'Please run codex login --device-auth');
    });

    const { getDiagnosis } = await import('./error-handler.js');
    const diagnosis = await getDiagnosis(new Error('boom'), '(no source context)');

    expect(diagnosis).toContain('Codex CLI diagnosis unavailable');
    expect(diagnosis).toContain('codex login --device-auth');
    expect(consoleError).toHaveBeenCalledWith(
      '[error-handler] Failed to call Codex CLI for diagnosis:',
      expect.any(Error),
    );
  });
});

describe('initErrorHandler', () => {
  it('registers process handlers without throwing', async () => {
    // Clear any previously registered handlers
    process.removeAllListeners('uncaughtException');
    process.removeAllListeners('unhandledRejection');

    const { initErrorHandler } = await import('./error-handler.js');

    expect(() => initErrorHandler()).not.toThrow();

    const uncaughtListeners = process.listeners('uncaughtException');
    const rejectionListeners = process.listeners('unhandledRejection');

    expect(uncaughtListeners.length).toBeGreaterThan(0);
    expect(rejectionListeners.length).toBeGreaterThan(0);
  });

  it('is idempotent — calling twice does not double-register', async () => {
    process.removeAllListeners('uncaughtException');
    process.removeAllListeners('unhandledRejection');

    const { initErrorHandler } = await import('./error-handler.js');
    initErrorHandler();
    const countAfterFirst = process.listeners('uncaughtException').length;
    initErrorHandler();
    const countAfterSecond = process.listeners('uncaughtException').length;

    expect(countAfterSecond).toBe(countAfterFirst);
  });
});

describe('logError', () => {
  it('writes a JSON entry to the log file', async () => {
    // Point log to our temp dir
    fs.mkdirSync(TEST_LOG_DIR, { recursive: true });

    const { logError } = await import('./error-handler.js');

    // We can't easily change the LOG_FILE constant after module load,
    // so we verify the module-level behaviour by checking the real log dir
    const homeDir = os.homedir();
    const logDir = path.join(homeDir, '.clawbridge');
    const logFile = path.join(logDir, 'errors.log');

    const sizeBefore = (() => {
      try {
        return fs.statSync(logFile).size;
      } catch {
        return 0;
      }
    })();

    const testError = new Error('test logError write');
    logError(testError, 'test-context');

    const sizeAfter = (() => {
      try {
        return fs.statSync(logFile).size;
      } catch {
        return 0;
      }
    })();

    expect(sizeAfter).toBeGreaterThan(sizeBefore);

    // Verify the last line is valid JSON with expected fields
    const content = fs.readFileSync(logFile, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    const last = JSON.parse(lines[lines.length - 1]);
    expect(last.error).toBe('test logError write');
    expect(last.context).toBe('test-context');
    expect(last.ts).toBeTruthy();
    expect(last.stack).toBeTruthy();
  });
});

describe('getRecentErrors', () => {
  it('returns an empty array when no log file exists', async () => {
    // Temporarily rename the log file if it exists
    const homeDir = os.homedir();
    const logFile = path.join(homeDir, '.clawbridge', 'errors.log');
    const backup = logFile + '.bak-test';
    let renamed = false;
    try {
      fs.renameSync(logFile, backup);
      renamed = true;
    } catch {
      /* file doesn't exist */
    }

    const { getRecentErrors } = await import('./error-handler.js');
    const errors = getRecentErrors();
    expect(errors).toEqual([]);

    if (renamed) {
      try {
        fs.renameSync(backup, logFile);
      } catch {
        /* ignore */
      }
    }
  });

  it('returns the most recent N errors', async () => {
    const homeDir = os.homedir();
    const logDir = path.join(homeDir, '.clawbridge');
    const logFile = path.join(logDir, 'errors.log');
    fs.mkdirSync(logDir, { recursive: true });

    // Write 5 entries
    const entries = Array.from({ length: 5 }, (_, i) => ({
      ts: new Date().toISOString(),
      error: `error-${i}`,
      stack: '',
      file: 'test.ts:1',
      uptime: i,
    }));
    // Append them without disturbing existing content
    const backup = (() => {
      try {
        return fs.readFileSync(logFile, 'utf-8');
      } catch {
        return '';
      }
    })();
    for (const e of entries) {
      fs.appendFileSync(logFile, JSON.stringify(e) + '\n');
    }

    const { getRecentErrors } = await import('./error-handler.js');
    const result = getRecentErrors(3);
    expect(result.length).toBe(3);
    // Restore
    fs.writeFileSync(logFile, backup);
  });
});
