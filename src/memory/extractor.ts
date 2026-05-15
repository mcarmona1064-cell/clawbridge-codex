import { log } from '../log.js';
import { runCodexPrompt } from '../codex-cli.js';
import { deleteMemory, resolveConflicts, upsertMemory } from './db.js';
import { SEGMENT_DEFAULTS } from './types.js';
import type { Memory, MemorySegment } from './types.js';

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a memory extraction agent. Given a conversation or summary, extract factual memories worth storing long-term.

Output a JSON object with a single key "memories" whose value is an array of memory objects. Each has:
- segment: one of identity|preference|correction|relationship|knowledge|behavioral|context
- content: one plain-english sentence (max 20 words)
- importance: 0.0-1.0 based on segment defaults and how specific/useful this is

Segment guide:
- identity: permanent facts about who the person is
- preference: how they like things done
- correction: explicit corrections they gave ("don't do X", "use Y instead")
- relationship: people/orgs they work with
- knowledge: tools, tech, domain knowledge they have
- behavioral: observed patterns in how they work
- context: current/temporary situation (project, deadline, task)

Only extract clear, specific, useful facts. Skip vague or obvious things.
Output JSON only, no explanation.`;

// ── Types ─────────────────────────────────────────────────────────────────────

interface RawMemory {
  segment: MemorySegment;
  content: string;
  importance: number;
}

// ── Extractor ─────────────────────────────────────────────────────────────────

export async function extractMemories(text: string, clientId: string): Promise<Memory[]> {
  let raw: RawMemory[];
  try {
    const textBlock = await runCodexPrompt(
      `${SYSTEM_PROMPT}\n\nConversation or summary:\n${text}\n\nReturn JSON only.`,
      { sandbox: 'read-only', timeout: 120_000 },
    );
    if (!textBlock) return [];

    // Strip markdown code fences if present.
    const json = textBlock
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
    const parsed = JSON.parse(json) as { memories?: RawMemory[] } | RawMemory[];
    raw = Array.isArray(parsed) ? parsed : (parsed.memories ?? []);
  } catch (err) {
    log.error('[memory] Failed to extract memories', { err });
    return [];
  }

  const now = new Date().toISOString();
  const memories: Memory[] = [];

  for (const item of raw) {
    if (!item.segment || !item.content) continue;

    const defaults = SEGMENT_DEFAULTS[item.segment];
    if (!defaults) continue;

    // Conflict resolution — replace conflicting memory with new one
    const conflictId = resolveConflicts(clientId, item.content, item.segment);
    if (conflictId) {
      log.debug('[memory] Replacing conflicting memory', { conflictId, segment: item.segment });
      deleteMemory(conflictId);
    }

    const memory: Memory = {
      id: crypto.randomUUID(),
      clientId,
      segment: item.segment,
      content: item.content,
      importance: Math.min(1, Math.max(0, item.importance ?? defaults.importance)),
      decayRate: defaults.decayRate,
      createdAt: now,
      lastAccessedAt: now,
    };

    upsertMemory(memory);
    memories.push(memory);
  }

  log.info('[memory] Extracted memories', { count: memories.length, clientId });
  return memories;
}
