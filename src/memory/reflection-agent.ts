import { readEnvFile } from '../env.js'
import { log } from '../log.js'
import { upsertMemory } from './db.js'
import { SEGMENT_DEFAULTS } from './types.js'
import type { Memory } from './types.js'
import { MemoryManager } from './manager.js'

// ── Auth ─────────────────────────────────────────────────────────────────────

const envCfg = readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'])

function getAuthHeaders(): Record<string, string> | null {
  const oauthToken = process.env['CLAUDE_CODE_OAUTH_TOKEN'] || envCfg['CLAUDE_CODE_OAUTH_TOKEN']
  const apiKey = process.env['ANTHROPIC_API_KEY'] || envCfg['ANTHROPIC_API_KEY']

  if (oauthToken) {
    return {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      Authorization: `Bearer ${oauthToken}`,
    }
  }
  if (apiKey) {
    return {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': apiKey,
    }
  }
  return null
}

// ── Minimum memories needed to draw patterns ──────────────────────────────────

const MIN_MEMORIES_FOR_REFLECTION = 10

// ── Reflection agent ──────────────────────────────────────────────────────────

interface RawInsight {
  content: string
  importance: number
}

/**
 * Reads all memories for a client, sends them to Claude, and stores
 * behavioral pattern insights back as 'behavioral' segment memories.
 *
 * Returns the number of behavioral memories written.
 * Skips silently when fewer than MIN_MEMORIES_FOR_REFLECTION exist.
 */
export async function runReflectionAgent(clientId: string): Promise<number> {
  const headers = getAuthHeaders()
  if (!headers) {
    log.warn('[memory:reflection] No Anthropic credentials — skipping')
    return 0
  }

  const manager = new MemoryManager(clientId)
  const dump = await manager.dump()

  // Count lines that look like memory entries (start with "- [")
  const memoryLineCount = dump.split('\n').filter((l) => l.trimStart().startsWith('- [')).length
  if (memoryLineCount < MIN_MEMORIES_FOR_REFLECTION) {
    log.debug('[memory:reflection] Not enough memories for reflection', { clientId, memoryLineCount })
    return 0
  }

  const systemPrompt = `You are a reflection agent. Analyze these memories about a user and identify clear behavioral patterns.

Output a JSON array of behavioral insights. Each insight must have:
- content: one sentence describing a pattern (max 25 words, e.g. "Consistently raises cost concerns before approving new features")
- importance: 0.5-0.8

Rules:
- Only output patterns with clear evidence from 3+ memories
- Focus on actionable patterns the assistant should proactively act on
- Skip generic or obvious observations
- Output valid JSON array only, no explanation`

  let insights: RawInsight[]
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 512,
        system: systemPrompt,
        messages: [{ role: 'user', content: dump }],
      }),
    })

    const data = (await res.json()) as {
      content?: Array<{ type: string; text: string }>
      error?: { message: string }
    }

    if (data.error) {
      log.error('[memory:reflection] Claude API error', { error: data.error.message })
      return 0
    }

    const textBlock = data.content?.find((b) => b.type === 'text')?.text
    if (!textBlock) return 0

    const json = textBlock
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim()
    insights = JSON.parse(json) as RawInsight[]
  } catch (err) {
    log.error('[memory:reflection] Failed to run reflection', { err })
    return 0
  }

  if (!Array.isArray(insights) || insights.length === 0) return 0

  const now = new Date().toISOString()
  const defaults = SEGMENT_DEFAULTS['behavioral']
  let written = 0

  for (const insight of insights) {
    if (!insight.content) continue
    const memory: Memory = {
      id: crypto.randomUUID(),
      clientId,
      segment: 'behavioral',
      content: insight.content,
      importance: Math.min(0.8, Math.max(0.5, insight.importance ?? defaults.importance)),
      decayRate: defaults.decayRate,
      createdAt: now,
      lastAccessedAt: now,
    }
    upsertMemory(memory)
    written++
  }

  log.info('[memory:reflection] Wrote behavioral insights', { clientId, written })
  return written
}
