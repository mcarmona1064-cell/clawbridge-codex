/**
 * Hindsight memory client for ClawBridge.
 *
 * Wraps @vectorize-io/hindsight-client with:
 * - Per-client bank isolation (client-{slug} naming)
 * - 7-segment tagging (segment:identity, segment:preference, etc.)
 * - Graceful degradation — falls back silently if Hindsight is unavailable
 * - Strict tag matching (any_strict) to prevent cross-client data leakage
 */

import fs from 'fs';
import path from 'path';

import { HindsightClient, HindsightError, recallResponseToPromptString } from '@vectorize-io/hindsight-client';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import type { MemorySegment } from './types.js';

/** Filename written into the session directory for the container to pick up. */
export const MEMORY_CONTEXT_FILENAME = '.memory_context.md';

// ── Config ────────────────────────────────────────────────────────────────────

const envCfg = readEnvFile(['HINDSIGHT_URL', 'HINDSIGHT_API_KEY']);

function getHindsightUrl(): string {
  return process.env['HINDSIGHT_URL'] || envCfg['HINDSIGHT_URL'] || 'http://localhost:8888';
}

function getHindsightApiKey(): string | undefined {
  return process.env['HINDSIGHT_API_KEY'] || envCfg['HINDSIGHT_API_KEY'] || undefined;
}

// ── Singleton client ──────────────────────────────────────────────────────────

let _client: HindsightClient | null = null;

export function getHindsightClient(): HindsightClient {
  if (!_client) {
    _client = new HindsightClient({
      baseUrl: getHindsightUrl(),
      apiKey: getHindsightApiKey(),
    });
  }
  return _client;
}

// ── Bank naming ───────────────────────────────────────────────────────────────

/**
 * Returns the Hindsight bank ID for a client.
 * Convention: client-{slug} (e.g. client-acme, client-global)
 */
export function bankId(clientSlug: string): string {
  // Sanitize: lowercase, replace spaces/special chars with hyphens
  const slug = clientSlug.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  return `client-${slug}`;
}

// ── Tag helpers ───────────────────────────────────────────────────────────────

/**
 * Build the tag array for a retain/recall operation.
 * Always includes client tag. Optionally includes user, session, and segment tags.
 */
export function buildTags(opts: {
  clientSlug: string;
  userId?: string;
  sessionId?: string;
  segment?: MemorySegment;
}): string[] {
  const tags: string[] = [`client:${opts.clientSlug}`];
  if (opts.userId) tags.push(`user:${opts.userId}`);
  if (opts.sessionId) tags.push(`session:${opts.sessionId}`);
  if (opts.segment) tags.push(`segment:${opts.segment}`);
  return tags;
}

// ── Availability check ────────────────────────────────────────────────────────

let _hindsightAvailable: boolean | null = null;

export async function isHindsightAvailable(): Promise<boolean> {
  if (_hindsightAvailable !== null) return _hindsightAvailable;
  try {
    const res = await fetch(`${getHindsightUrl()}/health`, { signal: AbortSignal.timeout(2000) });
    _hindsightAvailable = res.ok;
  } catch {
    _hindsightAvailable = false;
  }
  log.info('[hindsight] Availability check', { available: _hindsightAvailable, url: getHindsightUrl() });
  return _hindsightAvailable;
}

// Reset availability cache (called on error to retry next time)
function resetAvailability() {
  _hindsightAvailable = null;
}

// ── Core operations ───────────────────────────────────────────────────────────

/**
 * Store a conversation or fact in a client's memory bank.
 * Runs async (non-blocking) by default.
 *
 * @param clientSlug - Client identifier (e.g. 'acme')
 * @param content    - Raw conversation text or fact to store
 * @param opts       - Tagging and document options
 */
export async function hindsightRetain(
  clientSlug: string,
  content: string,
  opts: {
    userId?: string;
    sessionId?: string;
    segment?: MemorySegment;
    context?: string;
    documentId?: string;
    async?: boolean;
    timestamp?: Date;
  } = {},
): Promise<void> {
  if (!(await isHindsightAvailable())) return;

  try {
    await getHindsightClient().retain(bankId(clientSlug), content, {
      context: opts.context ?? 'clawbridge-session',
      documentId: opts.documentId,
      tags: buildTags({ clientSlug, userId: opts.userId, sessionId: opts.sessionId, segment: opts.segment }),
      timestamp: opts.timestamp?.toISOString() ?? new Date().toISOString(),
      async: opts.async ?? true,
    });
    log.debug('[hindsight] Retained', { client: clientSlug, sessionId: opts.sessionId });
  } catch (e) {
    if (e instanceof HindsightError) {
      log.error('[hindsight] retain failed', { status: e.statusCode, message: e.message });
      if (e.statusCode === 503 || e.statusCode === 0) resetAvailability();
    } else {
      log.error('[hindsight] retain unexpected error', { err: e });
    }
    // Never crash the session over memory failure
  }
}

/**
 * Retrieve memories relevant to a query for session context injection.
 * Returns a formatted string ready for system prompt injection.
 * Returns '' if Hindsight is unavailable.
 *
 * @param clientSlug - Client identifier
 * @param query      - What to retrieve (e.g. 'user background and preferences')
 * @param opts       - Tag filters and retrieval options
 */
export async function hindsightRecall(
  clientSlug: string,
  query: string,
  opts: {
    userId?: string;
    sessionId?: string;
    budget?: 'low' | 'mid' | 'high';
    maxTokens?: number;
    types?: Array<'world' | 'experience' | 'observation'>;
  } = {},
): Promise<string> {
  if (!(await isHindsightAvailable())) return '';

  try {
    const tags = buildTags({ clientSlug, userId: opts.userId });
    const response = await getHindsightClient().recall(bankId(clientSlug), query, {
      tags,
      tagsMatch: 'any_strict', // CRITICAL: prevents cross-client data leakage
      budget: opts.budget ?? 'mid',
      maxTokens: opts.maxTokens ?? 3000,
      types: opts.types ?? (['observation', 'world'] as string[]),
      queryTimestamp: new Date().toISOString(),
    });

    const text = recallResponseToPromptString(response);
    if (!text.trim()) return '';

    log.debug('[hindsight] Recalled', { client: clientSlug, results: response.results.length });
    return `## Memory Context\n${text}`;
  } catch (e) {
    if (e instanceof HindsightError) {
      log.error('[hindsight] recall failed', { status: e.statusCode, message: e.message });
      if (e.statusCode === 503 || e.statusCode === 0) resetAvailability();
    } else {
      log.error('[hindsight] recall unexpected error', { err: e });
    }
    return ''; // Graceful degradation — session continues without memory context
  }
}

/**
 * Recall and write the result to `<sessionDir>/.memory_context.md` so the
 * container's prompt builder can pick it up on the next turn. Always
 * overwrites — never accumulates stale context across turns. When recall
 * yields nothing or Hindsight is unavailable, removes any existing file.
 *
 * Caller should fire-and-forget; this never throws on Hindsight or filesystem
 * errors (logs and returns).
 */
export async function recallToSessionFile(
  clientSlug: string,
  sessionDirPath: string,
  query: string,
  opts: { userId?: string; sessionId?: string; maxTokens?: number } = {},
): Promise<void> {
  const target = path.join(sessionDirPath, MEMORY_CONTEXT_FILENAME);

  try {
    const text = await hindsightRecall(clientSlug, query, opts);
    if (!text) {
      // Clear any stale file from a prior turn so the container doesn't
      // silently use last-turn's recall.
      if (fs.existsSync(target)) fs.unlinkSync(target);
      return;
    }
    fs.writeFileSync(target, text, 'utf-8');
    log.info('[hindsight] recall written to session', {
      sessionId: opts.sessionId,
      chars: text.length,
    });
  } catch (err) {
    log.warn('[hindsight] recallToSessionFile failed', { sessionId: opts.sessionId, err });
    // Best-effort cleanup — leave no half-written file.
    try {
      if (fs.existsSync(target)) fs.unlinkSync(target);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Retain a single conversation turn (user message + agent reply) into the
 * client's Hindsight bank. Fire-and-forget; never throws. Skips when
 * Hindsight is unavailable, when either side of the turn is empty, or when
 * the combined text is below the minimum-useful length threshold.
 */
export async function retainTurn(
  clientSlug: string,
  userText: string,
  agentText: string,
  opts: { userId?: string; sessionId?: string } = {},
): Promise<void> {
  const u = userText.trim();
  const a = agentText.trim();
  if (!u || !a) return;

  // Below this length, retain noise outweighs signal — skip "ok", "thanks", etc.
  const turn = `User: ${u}\n\nAgent: ${a}`;
  if (turn.length < 40) return;

  try {
    if (!(await isHindsightAvailable())) return;
    await hindsightRetain(clientSlug, turn, {
      userId: opts.userId,
      sessionId: opts.sessionId,
      context: 'clawbridge-turn',
    });
    log.info('[hindsight] turn retained', { sessionId: opts.sessionId, chars: turn.length });
  } catch (err) {
    log.warn('[hindsight] retainTurn failed', { sessionId: opts.sessionId, err });
  }
}

/**
 * Synthesize behavioral patterns and insights from a client's accumulated memories.
 * Expensive — call nightly or weekly, never per-message.
 *
 * @param clientSlug - Client identifier
 * @param query      - What to synthesize (e.g. 'key preferences and communication style')
 * @param opts       - Budget and tag options
 */
export async function hindsightReflect(
  clientSlug: string,
  query: string,
  opts: {
    userId?: string;
    budget?: 'low' | 'mid' | 'high';
    maxTokens?: number;
  } = {},
): Promise<string> {
  if (!(await isHindsightAvailable())) return '';

  try {
    const tags = buildTags({ clientSlug, userId: opts.userId });
    const response = await getHindsightClient().reflect(bankId(clientSlug), query, {
      tags,
      tagsMatch: 'any_strict',
      budget: opts.budget ?? 'mid',
    });

    log.debug('[hindsight] Reflected', { client: clientSlug, tokens: response.usage?.total_tokens });
    return response.text ?? '';
  } catch (e) {
    if (e instanceof HindsightError) {
      log.error('[hindsight] reflect failed', { status: e.statusCode, message: e.message });
      if (e.statusCode === 503 || e.statusCode === 0) resetAvailability();
    } else {
      log.error('[hindsight] reflect unexpected error', { err: e });
    }
    return '';
  }
}

/**
 * Ensure a client bank exists with the correct mission and disposition.
 * Safe to call multiple times — no-ops if bank already exists.
 */
export async function ensureClientBank(
  clientSlug: string,
  opts: {
    name?: string;
    mission?: string;
  } = {},
): Promise<void> {
  if (!(await isHindsightAvailable())) return;

  try {
    await getHindsightClient().createBank(bankId(clientSlug), {
      name: opts.name ?? `ClawBridge — ${clientSlug}`,
      mission:
        opts.mission ??
        `Track all interactions, preferences, corrections, and behavioral patterns for ${clientSlug}. Focus on actionable facts that improve agent responses over time.`,
    });
    log.info('[hindsight] Bank created/confirmed', { client: clientSlug });
  } catch (e) {
    // 409 Conflict = bank already exists, that's fine
    if (e instanceof HindsightError && e.statusCode === 409) return;
    log.warn('[hindsight] ensureClientBank warning', { err: e });
  }
}
