/**
 * Tests for the Hindsight session-injection helpers.
 *
 * recallToSessionFile and retainTurn are the two hooks the router and
 * delivery code use; this exercises their graceful-degradation paths
 * without standing up a real Hindsight server.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../log.js', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

vi.mock('../env.js', () => ({
  readEnvFile: () => ({}),
}));

const recallMock = vi.fn();
const retainMock = vi.fn();
const availableMock = vi.fn();

vi.mock('@vectorize-io/hindsight-client', () => ({
  HindsightClient: class {
    recall = recallMock;
    retain = retainMock;
    health = availableMock;
  },
  HindsightError: class HindsightError extends Error {
    statusCode: number;
    constructor(message: string, statusCode = 500) {
      super(message);
      this.statusCode = statusCode;
    }
  },
  recallResponseToPromptString: (r: { text?: string } | string): string =>
    typeof r === 'string' ? r : r?.text ?? '',
}));

import { recallToSessionFile, retainTurn, MEMORY_CONTEXT_FILENAME } from './hindsight.js';

const TEST_DIR = path.join(os.tmpdir(), `clawbridge-hindsight-test-${process.pid}-${Date.now()}`);

beforeEach(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  recallMock.mockReset();
  retainMock.mockReset();
  availableMock.mockReset();
  availableMock.mockResolvedValue({ ok: true });
});

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

describe('recallToSessionFile', () => {
  it('writes recalled text to <sessionDir>/.memory_context.md', async () => {
    recallMock.mockResolvedValue({
      results: [{ id: '1' }],
      text: 'remembered: user prefers brevity',
    });

    await recallToSessionFile('global', TEST_DIR, 'how should i write this?', { sessionId: 'sess-1' });

    const target = path.join(TEST_DIR, MEMORY_CONTEXT_FILENAME);
    expect(fs.existsSync(target)).toBe(true);
    const content = fs.readFileSync(target, 'utf-8');
    expect(content).toContain('remembered: user prefers brevity');
  });

  it('removes any stale file when recall returns nothing', async () => {
    const target = path.join(TEST_DIR, MEMORY_CONTEXT_FILENAME);
    fs.writeFileSync(target, 'stale memory from a prior turn', 'utf-8');
    recallMock.mockResolvedValue({ results: [], text: '' });

    await recallToSessionFile('global', TEST_DIR, 'irrelevant query');

    expect(fs.existsSync(target)).toBe(false);
  });

  it('does not throw when Hindsight client throws', async () => {
    recallMock.mockRejectedValue(new Error('connection refused'));

    await expect(
      recallToSessionFile('global', TEST_DIR, 'q', { sessionId: 'sess-1' }),
    ).resolves.toBeUndefined();
  });
});

describe('retainTurn', () => {
  it('skips empty user or agent text', async () => {
    await retainTurn('global', '', 'agent reply', { sessionId: 'sess-1' });
    await retainTurn('global', 'user msg', '', { sessionId: 'sess-1' });
    expect(retainMock).not.toHaveBeenCalled();
  });

  it('skips trivially-short turns to avoid noise', async () => {
    await retainTurn('global', 'hi', 'ok', { sessionId: 'sess-1' });
    expect(retainMock).not.toHaveBeenCalled();
  });

  it('retains a substantive turn', async () => {
    retainMock.mockResolvedValue(undefined);
    await retainTurn(
      'global',
      'remember that my dog is named Rex and he is a corgi',
      'Got it — Rex the corgi, noted.',
      { sessionId: 'sess-1', userId: 'u-1' },
    );
    expect(retainMock).toHaveBeenCalledTimes(1);
    const [, content] = retainMock.mock.calls[0];
    expect(content).toContain('User:');
    expect(content).toContain('Agent:');
    expect(content).toContain('Rex');
  });

  it('does not throw when Hindsight client throws', async () => {
    retainMock.mockRejectedValue(new Error('500 internal'));
    await expect(
      retainTurn(
        'global',
        'a substantive user message that exceeds the noise threshold',
        'a substantive agent reply',
        { sessionId: 'sess-1' },
      ),
    ).resolves.toBeUndefined();
  });
});
