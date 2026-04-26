import { readEnvFile } from '../env.js'
import { log } from '../log.js'

// ── Auth ─────────────────────────────────────────────────────────────────────

const envCfg = readEnvFile(['OPENAI_API_KEY'])

function getOpenAiKey(): string | null {
  return process.env['OPENAI_API_KEY'] || envCfg['OPENAI_API_KEY'] || null
}

// ── OpenAI embeddings (when key is available) ─────────────────────────────────

async function embedOpenAi(text: string): Promise<number[] | null> {
  const key = getOpenAiKey()
  if (!key) return null

  try {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: text }),
    })

    const data = (await res.json()) as {
      data?: Array<{ embedding: number[] }>
      error?: { message: string }
    }

    if (data.error) {
      log.warn('[memory] OpenAI embedding error', { error: data.error.message })
      return null
    }

    return data.data?.[0]?.embedding ?? null
  } catch (err) {
    log.warn('[memory] OpenAI embedding fetch failed', { err })
    return null
  }
}

// ── TF-IDF keyword similarity (zero-cost fallback) ────────────────────────────

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have',
  'they', 'will', 'uses', 'their', 'been', 'also', 'into', 'about',
])

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOP_WORDS.has(w))
}

export function keywordSimilarity(query: string, memory: string): number {
  const queryWords = new Set(tokenize(query))
  if (queryWords.size === 0) return 0
  const memoryWords = tokenize(memory)
  const matches = memoryWords.filter((w) => queryWords.has(w)).length
  return matches / queryWords.size
}

// ── Cosine similarity ─────────────────────────────────────────────────────────

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

// ── Public embed function ─────────────────────────────────────────────────────

/**
 * Generate an embedding for text.
 * Uses OpenAI text-embedding-3-small when OPENAI_API_KEY is set.
 * Returns null when no embedding API is available (caller falls back to keyword similarity).
 */
export async function embed(text: string): Promise<number[] | null> {
  return embedOpenAi(text)
}
