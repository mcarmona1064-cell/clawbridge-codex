// ── Stop words ────────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'have',
  'they',
  'will',
  'uses',
  'their',
  'been',
  'also',
  'into',
  'about',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOP_WORDS.has(w));
}

// ── Keyword similarity (TF-IDF style, no external API needed) ─────────────────

export function keywordSimilarity(query: string, memory: string): number {
  const queryWords = new Set(tokenize(query));
  if (queryWords.size === 0) return 0;
  const memoryWords = tokenize(memory);
  const matches = memoryWords.filter((w) => queryWords.has(w)).length;
  return matches / queryWords.size;
}

// ── Cosine similarity (for future vector use) ─────────────────────────────────

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ── embed stub (returns null — keyword similarity is used instead) ────────────

export async function embed(_text: string): Promise<number[] | null> {
  return null;
}
