/**
 * Tests for the tiered memory system.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const { runCodexPromptMock } = vi.hoisted(() => ({
  runCodexPromptMock: vi.fn(),
}));

// ── Mocks ────────────────────────────────────────────────────────────────────

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

vi.mock('../codex-cli.js', () => ({
  runCodexPrompt: runCodexPromptMock,
}));

// ── Test DB setup ─────────────────────────────────────────────────────────────

const TEST_DB_DIR = path.join(os.tmpdir(), `clawbridge-memory-test-${process.pid}`);
const TEST_DB_PATH = path.join(TEST_DB_DIR, 'memory.db');

// Import after mocks are defined
const { initMemoryDb, upsertMemory, getMemories, closeMemoryDb } = await import('./db.js');
const { MemoryManager } = await import('./manager.js');

beforeEach(() => {
  fs.mkdirSync(TEST_DB_DIR, { recursive: true });
  initMemoryDb(TEST_DB_PATH);
});

afterEach(() => {
  closeMemoryDb();
  runCodexPromptMock.mockReset();
  delete process.env['OPENAI_API_KEY'];
  vi.unstubAllGlobals();
  try {
    fs.rmSync(TEST_DB_DIR, { recursive: true });
  } catch {
    // ignore
  }
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('initMemoryDb', () => {
  it('creates the DB file', () => {
    expect(fs.existsSync(TEST_DB_PATH)).toBe(true);
  });
});

describe('upsertMemory / getMemories', () => {
  it('stores and retrieves a memory', () => {
    const now = new Date().toISOString();
    const mem = {
      id: crypto.randomUUID(),
      clientId: 'client-1',
      segment: 'preference' as const,
      content: 'Prefers bullet points over paragraphs',
      importance: 0.7,
      decayRate: 0.002,
      createdAt: now,
      lastAccessedAt: now,
    };

    upsertMemory(mem);

    const results = getMemories('client-1', 0);
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('Prefers bullet points over paragraphs');
    expect(results[0].segment).toBe('preference');
  });

  it('filters memories below minImportance after decay', () => {
    // Create a memory with high decay rate and old lastAccessedAt (30 days ago)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const mem = {
      id: crypto.randomUUID(),
      clientId: 'client-decay',
      segment: 'context' as const,
      content: 'Working on a deadline project',
      importance: 0.4,
      decayRate: 0.08, // context segment — fast decay
      createdAt: thirtyDaysAgo,
      lastAccessedAt: thirtyDaysAgo,
    };

    upsertMemory(mem);

    // After 30 days at 8%/day: 0.4 * (0.92^30) ≈ 0.4 * 0.079 ≈ 0.032 — well below 0.3
    const results = getMemories('client-decay', 0.3);
    expect(results).toHaveLength(0);
  });

  it('decay reduces importance correctly', () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const mem = {
      id: crypto.randomUUID(),
      clientId: 'client-math',
      segment: 'preference' as const,
      content: 'Likes short answers',
      importance: 0.7,
      decayRate: 0.002,
      createdAt: tenDaysAgo,
      lastAccessedAt: tenDaysAgo,
    };

    upsertMemory(mem);

    const results = getMemories('client-math', 0);
    expect(results).toHaveLength(1);
    // After 10 days at 0.2%/day: 0.7 * (0.998^10) ≈ 0.7 * 0.980 ≈ 0.686
    const decayed = results[0].importance;
    expect(decayed).toBeGreaterThan(0.68);
    expect(decayed).toBeLessThan(0.7);
  });
});

describe('MemoryManager.loadForSession', () => {
  it('returns a formatted string with segment headers', async () => {
    const now = new Date().toISOString();
    const clientId = 'session-client';

    upsertMemory({
      id: crypto.randomUUID(),
      clientId,
      segment: 'identity',
      content: 'Mark owns ClawBridge agency in Philippines',
      importance: 0.9,
      decayRate: 0,
      createdAt: now,
      lastAccessedAt: now,
    });

    upsertMemory({
      id: crypto.randomUUID(),
      clientId,
      segment: 'preference',
      content: 'Prefers bullet points over long paragraphs',
      importance: 0.7,
      decayRate: 0.002,
      createdAt: now,
      lastAccessedAt: now,
    });

    const manager = new MemoryManager(clientId);
    const output = await manager.loadForSession();

    expect(output).toContain('## Remembered Context');
    expect(output).toContain('**Identity:** Mark owns ClawBridge agency in Philippines');
    expect(output).toContain('**Preference:** Prefers bullet points over long paragraphs');
  });

  it('returns empty string when no memories exist', async () => {
    const manager = new MemoryManager('empty-client');
    const output = await manager.loadForSession();
    expect(output).toBe('');
  });
});

describe('extractMemories', () => {
  it('parses Codex CLI OAuth response and returns memories without API-key billing', async () => {
    const mockMemories = [
      { segment: 'preference', content: 'Prefers concise answers without filler', importance: 0.75 },
      { segment: 'identity', content: 'User is a senior software engineer', importance: 0.85 },
    ];
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    process.env['OPENAI_API_KEY'] = 'should-not-be-used';
    runCodexPromptMock.mockResolvedValue(JSON.stringify({ memories: mockMemories }));

    const { extractMemories } = await import('./extractor.js');
    const results = await extractMemories('User said they prefer short answers and mentioned their job', 'test-client');

    expect(results.length).toBe(2);
    expect(results[0].segment).toBe('preference');
    expect(results[0].decayRate).toBe(0.002); // preference default
    expect(results[1].segment).toBe('identity');
    expect(results[1].decayRate).toBe(0); // identity never decays
    expect(results[0].id).toBeTruthy();
    expect(results[0].createdAt).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(runCodexPromptMock).toHaveBeenCalledWith(expect.stringContaining('Return JSON only'), {
      sandbox: 'read-only',
      timeout: 120_000,
    });
  });

  it('returns empty array when Codex CLI returns no memory JSON', async () => {
    runCodexPromptMock.mockResolvedValue('');

    const mod = await import('./extractor.js');
    const results = await mod.extractMemories('some text', 'empty-codex-client');
    expect(results).toEqual([]);
  });
});
