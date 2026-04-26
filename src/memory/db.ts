import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { log } from '../log.js';
import type { Memory, MemorySegment } from './types.js';

// ── DB path ──────────────────────────────────────────────────────────────────

const MEMORY_DIR = path.join(os.homedir(), '.clawbridge');
const MEMORY_DB_PATH = path.join(MEMORY_DIR, 'memory.db');

let _db: Database.Database | null = null;

function getMemDb(): Database.Database {
  if (!_db) throw new Error('Memory DB not initialized. Call initMemoryDb() first.');
  return _db;
}

// ── Schema ───────────────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  segment TEXT NOT NULL,
  content TEXT NOT NULL,
  importance REAL NOT NULL,
  decay_rate REAL NOT NULL,
  created_at TEXT NOT NULL,
  last_accessed_at TEXT NOT NULL,
  expires_at TEXT,
  embedding TEXT
);
CREATE INDEX IF NOT EXISTS idx_memories_client ON memories(client_id);
CREATE INDEX IF NOT EXISTS idx_memories_segment ON memories(client_id, segment);
`;

// ── Row type ─────────────────────────────────────────────────────────────────

interface MemoryRow {
  id: string;
  client_id: string;
  segment: string;
  content: string;
  importance: number;
  decay_rate: number;
  created_at: string;
  last_accessed_at: string;
  expires_at: string | null;
  embedding: string | null;
}

function rowToMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    clientId: row.client_id,
    segment: row.segment as MemorySegment,
    content: row.content,
    importance: row.importance,
    decayRate: row.decay_rate,
    createdAt: row.created_at,
    lastAccessedAt: row.last_accessed_at,
    ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
    ...(row.embedding ? { embedding: JSON.parse(row.embedding) as number[] } : {}),
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

export function initMemoryDb(dbPath?: string): void {
  const resolvedPath = dbPath ?? MEMORY_DB_PATH;
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  _db = new Database(resolvedPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.exec(SCHEMA);
  log.info('[memory] DB initialized', { path: resolvedPath });
}

export function upsertMemory(memory: Memory): void {
  const db = getMemDb();
  db.prepare(
    `
    INSERT OR REPLACE INTO memories
      (id, client_id, segment, content, importance, decay_rate, created_at, last_accessed_at, expires_at, embedding)
    VALUES
      (@id, @clientId, @segment, @content, @importance, @decayRate, @createdAt, @lastAccessedAt, @expiresAt, @embedding)
  `,
  ).run({
    id: memory.id,
    clientId: memory.clientId,
    segment: memory.segment,
    content: memory.content,
    importance: memory.importance,
    decayRate: memory.decayRate,
    createdAt: memory.createdAt,
    lastAccessedAt: memory.lastAccessedAt,
    expiresAt: memory.expiresAt ?? null,
    embedding: (memory as any).embedding ? JSON.stringify((memory as any).embedding) : null,
  });
}

export function getMemories(clientId: string, minImportance = 0.3): Memory[] {
  const db = getMemDb();
  const now = new Date();

  const rows = db.prepare(`SELECT * FROM memories WHERE client_id = ?`).all(clientId) as MemoryRow[];

  const results: Memory[] = [];

  for (const row of rows) {
    // Check expiry
    if (row.expires_at && new Date(row.expires_at) < now) {
      db.prepare('DELETE FROM memories WHERE id = ?').run(row.id);
      continue;
    }

    // Apply decay based on days since last access
    const daysSince = (now.getTime() - new Date(row.last_accessed_at).getTime()) / (1000 * 60 * 60 * 24);
    const decayed = row.importance * Math.pow(1 - row.decay_rate, daysSince);

    if (decayed < minImportance) continue;

    results.push({
      ...rowToMemory(row),
      importance: decayed,
    });
  }

  return results;
}

export function deleteMemory(id: string): void {
  getMemDb().prepare('DELETE FROM memories WHERE id = ?').run(id);
}

export function resolveConflicts(clientId: string, newContent: string, segment: MemorySegment): string | null {
  const db = getMemDb();
  const rows = db
    .prepare(`SELECT * FROM memories WHERE client_id = ? AND segment = ?`)
    .all(clientId, segment) as MemoryRow[];

  if (rows.length === 0) return null;

  // Simple keyword overlap: tokenise both strings and check for shared
  // meaningful words (>3 chars, not stop words)
  const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'they', 'will']);
  const tokens = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 3 && !STOP.has(w));

  const newTokens = new Set(tokens(newContent));

  for (const row of rows) {
    const existingTokens = tokens(row.content);
    const overlap = existingTokens.filter((t) => newTokens.has(t));
    // If more than 30% of existing tokens overlap, consider it a conflict
    if (existingTokens.length > 0 && overlap.length / existingTokens.length > 0.3) {
      return row.id;
    }
  }

  return null;
}

export function touchMemory(id: string): void {
  getMemDb().prepare('UPDATE memories SET last_accessed_at = ? WHERE id = ?').run(new Date().toISOString(), id);
}


export function searchSimilar(
  clientId: string,
  querySimilarityFn: (content: string) => number,
  topK = 10,
  minImportance = 0.3,
): Memory[] {
  const memories = getMemories(clientId, minImportance)
  const scored = memories.map((m) => ({ m, score: querySimilarityFn(m.content) }))
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((s) => s.m)
}

/** For tests — close and reset the singleton. */
export function closeMemoryDb(): void {
  _db?.close();
  _db = null;
}
