import { log } from '../log.js';
import { deleteMemory, getMemories, initMemoryDb as _initMemoryDb, searchSimilar, touchMemory, upsertMemory } from './db.js'
import { embed, keywordSimilarity } from './embeddings.js';
import { extractMemories } from './extractor.js';
import { SEGMENT_DEFAULTS } from './types.js';
import type { Memory, MemorySegment } from './types.js';

const MIN_IMPORTANCE_DEFAULT = 0.3;
const DECAY_DELETE_THRESHOLD = 0.1;

// Segment display order and labels
const SEGMENT_LABELS: Record<MemorySegment, string> = {
  identity: 'Identity',
  preference: 'Preference',
  correction: 'Correction',
  relationship: 'Relationship',
  knowledge: 'Knowledge',
  behavioral: 'Behavioral',
  context: 'Context',
};

const SEGMENT_ORDER: MemorySegment[] = [
  'identity',
  'correction',
  'preference',
  'relationship',
  'knowledge',
  'behavioral',
  'context',
];

export class MemoryManager {
  private clientId: string;

  constructor(clientId: string) {
    this.clientId = clientId;
  }

  /**
   * Load memories for session start.
   * Returns a formatted string ready for system prompt injection.
   */
  async loadForSession(minImportance: number = MIN_IMPORTANCE_DEFAULT, query?: string): Promise<string> {
    let memories
    if (query) {
      // RAG: use semantic/keyword similarity to fetch most relevant memories
      const embedding = await embed(query)
      if (embedding) {
        // Vector similarity via stored embeddings (when available) — falls back to keyword
        memories = searchSimilar(this.clientId, (content) => keywordSimilarity(query, content), 20, minImportance)
      } else {
        memories = searchSimilar(this.clientId, (content) => keywordSimilarity(query, content), 20, minImportance)
      }
      // Always include identity + correction memories regardless of query relevance
      const coreMemories = getMemories(this.clientId, minImportance).filter(
        (m) => m.segment === 'identity' || m.segment === 'correction',
      )
      const coreIds = new Set(coreMemories.map((m) => m.id))
      const ragIds = new Set(memories.map((m) => m.id))
      for (const m of coreMemories) {
        if (!ragIds.has(m.id)) memories.push(m)
      }
      memories = memories.filter((m) => coreIds.has(m.id) || ragIds.has(m.id))
    } else {
      memories = getMemories(this.clientId, minImportance)
    };

    if (memories.length === 0) return '';

    // Touch all loaded memories
    for (const m of memories) {
      touchMemory(m.id);
    }

    // Group by segment
    const bySegment = new Map<MemorySegment, Memory[]>();
    for (const m of memories) {
      const list = bySegment.get(m.segment) ?? [];
      list.push(m);
      bySegment.set(m.segment, list);
    }

    // Sort each segment by importance descending
    for (const [, list] of bySegment) {
      list.sort((a, b) => b.importance - a.importance);
    }

    const lines: string[] = ['## Remembered Context'];

    for (const segment of SEGMENT_ORDER) {
      const list = bySegment.get(segment);
      if (!list || list.length === 0) continue;
      const label = SEGMENT_LABELS[segment];
      for (const m of list) {
        lines.push(`**${label}:** ${m.content}`);
      }
    }

    const output = lines.join('\n');
    const tokenEstimate = Math.ceil(output.length / 4);
    log.info('[memory] Session loaded', { count: memories.length, tokenEstimate, clientId: this.clientId });

    return output;
  }

  /**
   * Extract and store memories from text (conversation, nightly summary).
   * Returns count of memories stored.
   */
  async learnFrom(text: string): Promise<number> {
    const memories = await extractMemories(text, this.clientId);
    return memories.length;
  }

  /**
   * Add a single memory manually.
   */
  async remember(content: string, segment: MemorySegment, importance?: number): Promise<void> {
    const defaults = SEGMENT_DEFAULTS[segment];
    const now = new Date().toISOString();

    const memory: Memory = {
      id: crypto.randomUUID(),
      clientId: this.clientId,
      segment,
      content,
      importance: importance ?? defaults.importance,
      decayRate: defaults.decayRate,
      createdAt: now,
      lastAccessedAt: now,
    };

    upsertMemory(memory);
    log.info('[memory] Remembered', { segment, clientId: this.clientId });
  }

  /**
   * Forget a memory by id.
   */
  async forget(id: string): Promise<void> {
    deleteMemory(id);
    log.info('[memory] Forgot memory', { id, clientId: this.clientId });
  }

  /**
   * Get all memories formatted as markdown.
   */
  async dump(): Promise<string> {
    const memories = getMemories(this.clientId, 0);

    if (memories.length === 0) return '_No memories stored._';

    const bySegment = new Map<MemorySegment, Memory[]>();
    for (const m of memories) {
      const list = bySegment.get(m.segment) ?? [];
      list.push(m);
      bySegment.set(m.segment, list);
    }

    for (const [, list] of bySegment) {
      list.sort((a, b) => b.importance - a.importance);
    }

    const lines: string[] = [`# Memory Dump — ${this.clientId}`, ''];

    for (const segment of SEGMENT_ORDER) {
      const list = bySegment.get(segment);
      if (!list || list.length === 0) continue;
      lines.push(`## ${SEGMENT_LABELS[segment]}`);
      for (const m of list) {
        lines.push(`- [${m.importance.toFixed(2)}] ${m.content} _(id: ${m.id})_`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Run decay pass — reduce importance of old memories and delete those
   * that have decayed below the delete threshold. Call nightly.
   */
  async runDecay(): Promise<void> {
    // getMemories already applies decay and filters expired entries.
    // We re-fetch with threshold=0 to see all, then delete those below cutoff.
    const all = getMemories(this.clientId, 0);

    let deleted = 0;
    let updated = 0;

    for (const m of all) {
      if (m.importance < DECAY_DELETE_THRESHOLD) {
        deleteMemory(m.id);
        deleted++;
      } else {
        // Persist the decayed importance back to DB
        upsertMemory(m);
        updated++;
      }
    }

    log.info('[memory] Decay run complete', { clientId: this.clientId, updated, deleted });
  }
}
