import { log } from '../log.js';
import { runCodexPrompt } from '../codex-cli.js';
import { upsertMemory } from './db.js';
import { SEGMENT_DEFAULTS } from './types.js';
import type { Memory } from './types.js';
import { MemoryManager } from './manager.js';

// ── Minimum memories needed to draw patterns ──────────────────────────────────

const MIN_MEMORIES_FOR_REFLECTION = 10;

// ── Reflection agent ──────────────────────────────────────────────────────────

interface RawInsight {
  content: string;
  importance: number;
}

/**
 * Reads all memories for a client, sends them to Codex CLI using the local
 * OAuth/subscription session, and stores behavioral pattern insights back as 'behavioral' segment memories.
 *
 * Returns the number of behavioral memories written.
 * Skips silently when fewer than MIN_MEMORIES_FOR_REFLECTION exist.
 */
export async function runReflectionAgent(clientId: string): Promise<number> {
  const manager = new MemoryManager(clientId);
  const dump = await manager.dump();

  // Count lines that look like memory entries (start with "- [")
  const memoryLineCount = dump.split('\n').filter((l) => l.trimStart().startsWith('- [')).length;
  if (memoryLineCount < MIN_MEMORIES_FOR_REFLECTION) {
    log.debug('[memory:reflection] Not enough memories for reflection', {
      clientId,
      memoryLineCount,
    });
    return 0;
  }

  const systemPrompt = `You are a reflection agent. Analyze these memories about a user and identify clear behavioral patterns.

Output a JSON object with a single key "insights" whose value is an array of behavioral insights. Each insight must have:
- content: one sentence describing a pattern (max 25 words, e.g. "Consistently raises cost concerns before approving new features")
- importance: 0.5-0.8

Rules:
- Only output patterns with clear evidence from 3+ memories
- Focus on actionable patterns the assistant should proactively act on
- Skip generic or obvious observations
- Output valid JSON only, no explanation`;

  let insights: RawInsight[];
  try {
    const textBlock = await runCodexPrompt(`${systemPrompt}\n\nMemories:\n${dump}\n\nReturn JSON only.`, {
      sandbox: 'read-only',
      timeout: 120_000,
    });
    if (!textBlock) return 0;

    const json = textBlock
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
    const parsed = JSON.parse(json) as { insights?: RawInsight[] } | RawInsight[];
    insights = Array.isArray(parsed) ? parsed : (parsed.insights ?? []);
  } catch (err) {
    log.error('[memory:reflection] Failed to run reflection', { err });
    return 0;
  }

  if (!Array.isArray(insights) || insights.length === 0) return 0;

  const now = new Date().toISOString();
  const defaults = SEGMENT_DEFAULTS['behavioral'];
  let written = 0;

  for (const insight of insights) {
    if (!insight.content) continue;
    const memory: Memory = {
      id: crypto.randomUUID(),
      clientId,
      segment: 'behavioral',
      content: insight.content,
      importance: Math.min(0.8, Math.max(0.5, insight.importance ?? defaults.importance)),
      decayRate: defaults.decayRate,
      createdAt: now,
      lastAccessedAt: now,
    };
    upsertMemory(memory);
    written++;
  }

  log.info('[memory:reflection] Wrote behavioral insights', { clientId, written });
  return written;
}
