# How Hindsight is wired into the per-message flow

This document explains the architecture decisions and concrete hook points that
landed in `eca04e1 feat: wire Hindsight recall/retain/reflect` (v2.2.0) plus
the rate-limit fixes in `54b178e` and `a09219c`. Suitable for promotion into
`docs/hindsight.md` or as a CHANGELOG section.

---

## Architecture: file-drop, not message-stream

The host injects recalled memory into the agent's next turn via a file in the
session directory:

```
<DATA_DIR>/v2-sessions/<agentGroupId>/<sessionId>/.memory_context.md
            (mounted into the container as /workspace/.memory_context.md, RW)
```

**Why not write a `kind:'system'` row into messages_in?** The container's
poll-loop filters those out (`container/agent-runner/src/poll-loop.ts:67`), so
they never reach the agent. The session-dir mount already exists, the file is
naturally per-turn, and overwriting on each turn means stale recall can't
accidentally bleed between turns.

```
                           ┌──────────────────────────┐
  Telegram inbound  ─────► │ host: router.ts          │
                           │  routeInbound            │
                           │   ├─ writeSessionMessage │
                           │   ├─ Hindsight RECALL ───┼──► <sessionDir>/.memory_context.md
                           │   └─ wakeContainer       │
                           └──────────────────────────┘
                                                            ▲
                                  /workspace mount  ────────┘
                                                            │
                           ┌──────────────────────────┐     │
                           │ container: claude.ts     │     │
                           │  query()                 │     │
                           │   ├─ read .memory_..md   │ ◄───┘
                           │   └─ prepend to          │
                           │      systemContext.      │
                           │      instructions        │
                           │  → Anthropic API         │
                           │  → reply lands in        │
                           │    messages_out          │
                           └──────────────────────────┘
                                       │
                           ┌───────────▼──────────────┐
                           │ host: delivery.ts        │
                           │  drainSession            │
                           │   ├─ markDelivered       │
                           │   ├─ Telegram send       │
                           │   └─ Hindsight RETAIN ───┼──► bank `client-global`
                           └──────────────────────────┘

       Nightly (host-sweep.ts):  Hindsight REFLECT (Sonnet) — synthesizes patterns
```

---

## Per-layer hook points

### Host — recall (`src/router.ts`)

In `deliverToAgent`, just before `wakeContainer`:

```ts
const queryText = safeParseContent(event.message.content).text ?? '';
if (queryText) {
  void recallToSessionFile('global', sessionDir(session.agent_group_id, session.id), queryText, {
    userId: userId ?? undefined,
    sessionId: session.id,
  }).catch((err) => log.warn('[hindsight] recall threw', { sessionId: session.id, err }));
}
```

Fire-and-forget. Hindsight latency cannot delay the user's reply. Failure logs at WARN; the next turn just gets no recall context.

### Host — recall helper (`src/memory/hindsight.ts`)

`recallToSessionFile(clientSlug, sessionDirPath, query, opts)`:
- Calls `hindsightRecall()`.
- If non-empty: writes to `<sessionDir>/.memory_context.md`.
- If empty or unavailable: **unlinks any stale file** so last turn's recall doesn't carry over.
- Wraps everything in try/catch — never throws.

### Container — read (`container/agent-runner/src/providers/claude.ts`)

In `query()`, before `sdkQuery({...})`:

```ts
let memoryContext = '';
try {
  if (fs.existsSync('/workspace/.memory_context.md')) {
    const content = fs.readFileSync('/workspace/.memory_context.md', 'utf-8').trim();
    if (content) memoryContext = content;
  }
} catch (err) { /* read failure is non-fatal */ }

const baseInstructions = input.systemContext?.instructions;
const instructions = [memoryContext, baseInstructions].filter((s) => s && s.length > 0).join('\n\n') || undefined;

// Passed to SDK:
//   systemPrompt: { type: 'preset', preset: 'claude_code', append: instructions }
```

Memory enters via `systemPrompt.append` so it does **not** appear in the agent's message history (no echo back to the channel, no resurrection on continuation).

### Host — retain (`src/delivery.ts`)

In `drainSession`, after `markDelivered` for a successful chat reply:

```ts
const userContent = getLatestInboundChatContent(inDb);
if (userContent) {
  const userText = extractText(userContent);
  const agentText = extractText(msg.content);
  if (userText && agentText) {
    void retainTurn('global', userText, agentText, { sessionId: session.id })
      .catch((err) => log.warn('[hindsight] retainTurn threw', { sessionId: session.id, err }));
  }
}
```

Skipped for `kind:'system'` rows and `channel_type:'agent'` (agent-to-agent traffic). The 40-char floor in `retainTurn` filters out trivia ("ok", "thanks").

### Host — retain helper (`src/memory/hindsight.ts`)

`retainTurn(clientSlug, userText, agentText, opts)` builds:

```
User: <user message>

Agent: <reply>
```

…and calls `hindsightRetain()` with `context: 'clawbridge-turn'`, tags `client:global`, `user:<id>`, `session:<id>`. Async retain (non-blocking).

### Host — DB helper (`src/db/session-db.ts`)

```ts
export function getLatestInboundChatContent(db: Database.Database): string | null {
  const row = db.prepare(
    `SELECT content FROM messages_in
     WHERE kind IN ('chat', 'chat-sdk')
     ORDER BY seq DESC
     LIMIT 1`,
  ).get() as { content: string } | undefined;
  return row?.content ?? null;
}
```

---

## Reflect — nightly synthesis with the right model

**Reflect uses Sonnet by design** — it synthesizes behavioral patterns and benefits from better reasoning. Retain and consolidation use Haiku for cost/latency. Documented in `integrations/docker-compose.yml:110`:

```yaml
HINDSIGHT_API_RETAIN_LLM_MODEL: claude-haiku-4-5-20251001
HINDSIGHT_API_CONSOLIDATION_LLM_MODEL: claude-haiku-4-5-20251001
HINDSIGHT_API_REFLECT_LLM_MODEL: claude-sonnet-4-5-20250929
```

### Rate-limit fix (commits `54b178e`, `a09219c`)

The Hindsight server uses `claude-code` provider mode so it can authenticate with `CLAUDE_CODE_OAUTH_TOKEN`. This means reflect competes for TPM budget with the live agent. Sonnet's per-minute window is sticky — when reflect ran during agent activity, both retried into 429s and reflect timed out at 300s wall-clock.

Mitigation already shipped: reflect runs from `host-sweep.ts` at the nightly low-traffic window when no agent traffic is hitting the same key.

### Optional production hardening (not yet shipped)

For installs where reflect needs to run against an active agent, support a dedicated key:

```yaml
HINDSIGHT_API_LLM_API_KEY: ${HINDSIGHT_LLM_API_KEY:-${CLAUDE_CODE_OAUTH_TOKEN}}
```

Setup wizard prompt: "For heavy use, set a dedicated `sk-ant-api03-...` Anthropic key for Hindsight (skip to share your Claude Code token, fine for light use)."

---

## Graceful degradation

All three operations are designed to never break the conversation flow:

| Failure | Behavior |
|---|---|
| Hindsight server unreachable | `isHindsightAvailable()` returns false, recall/retain return early, agent still replies |
| Recall returns empty | `.memory_context.md` is unlinked; agent gets no memory context this turn |
| Retain throws | Logged at WARN, message delivery already completed, no user-visible impact |
| Container can't read the file | `try/catch` around the read, agent proceeds with no memory context |

The only thing the user can observe when Hindsight is down is "the agent feels less context-aware" — never a stalled conversation, never a crash, never a message loss.

---

## Verification (live, evidence-based)

After deploy, on a real Telegram round-trip:

```
17:21:45  Message routed
17:21:45  [hindsight] recall written to session  chars=27   (FACTS: [] — bank empty initially)
17:22:36  Message delivered                      msg #40
17:22:36  [hindsight] turn retained              chars=123

# After the bank populated:
18:19:11  [hindsight] recall written to session  chars=10366
18:19:11  Message delivered                      msg #57
18:19:11  [hindsight] turn retained              chars=325

# Nightly reflect (Sonnet, no agent contention):
02:37:00  [hindsight] Nightly reflect complete
```

Bank growth (`client-global`):

```
session start  : 0 docs / 0 nodes / 0 links
+ 1 day        : 13 docs / 89 nodes / 1490 links
                 (39 experience, 44 observation, 6 world)
                 (497 temporal, 549 entity, 397 semantic links)
```

Cross-session recall verified end-to-end: user said "my favorite test phrase is mango skylight 47", later session asked "what's my favorite test phrase?", agent replied **"mango skylight 47"** — the recalled fact appeared in `.memory_context.md` (655 chars) before the container ran the turn.

---

## Tests

`src/memory/hindsight.test.ts` covers:
- recall writes the file when content is present
- recall unlinks stale file when content is absent
- recall does not throw when the Hindsight client throws
- retain skips empty user/agent text
- retain skips trivially-short turns (40-char floor)
- retain captures a substantive turn with `User:` / `Agent:` prefixes
- retain does not throw when the Hindsight client throws

Full host suite: 217/217 pass.

---

## Known follow-ups (not yet in repo)

1. **Per-agent-group client slug.** Currently hardcoded `'global'`. For multi-tenant or per-channel isolation, derive from `agentGroup.id` or messaging-group settings. See `cross-client.ts` for the existing tag-based isolation pattern.

2. **Surface degradation to the user.** When `isHindsightAvailable() === false`, optionally append a one-line preamble to the next reply ("I don't have access to remembered context this turn") behind `HINDSIGHT_SURFACE_DEGRADATION=true`.

3. **Container-side `/diagnose`.** A slash command the agent can invoke to ask the host for memory state, so it doesn't introspect its own (memory-less) container and report "no hindsight" — pairs with the `clawbridge doctor` proposal in `tasks/github-issues.md` (issue A6).

4. **Optional dedicated `HINDSIGHT_LLM_API_KEY`.** The reflect rate-limit issue is mitigated by nightly scheduling, but a separate key is the proper fix for installs where reflect needs to run against an active agent.

5. **e2e test in CI.** None of the unit tests boot Docker or drive a real Telegram round-trip. A nightly e2e job that asserts `.memory_context.md` is populated after a canary message would catch any future regression in the wiring.
