# Wire Hindsight recall into the per-message flow — Option A (file drop)

## Problem
- `hindsightRecall` is defined and exported from `src/memory/index.ts:12` but has zero call sites in `src/`.
- Per-message Telegram path (`router.routeInbound` → `deliverToAgent` → `wakeContainer`) never consults Hindsight.
- `hindsightRetain` and `hindsightReflect` are wired only to one-time migration (`setup/migrate.ts`) and the nightly host-sweep (`host-sweep.ts`).
- **Audit finding:** `kind:'system'` messages are filtered out in `container/agent-runner/src/poll-loop.ts:67`, so a system-message-based injection would be silently dropped. The original Phase 1 plan was wrong.

## Goal
Each engaged inbound message (Telegram, CLI, any channel) recalls relevant Hindsight memories for the agent's client and prepends them to the next turn's `systemContext.instructions`. Delivery is via a file in the session directory — no message-stream changes, no filter changes. After the agent responds, fire `hindsightRetain` so live conversations feed back into the bank.

## Architecture (Option A — file drop)
- Session directory `<DATA_DIR>/v2-sessions/<agentGroupId>/<sessionId>/` is already mounted as `/workspace` (RW) in the container per `container-runner.ts:260`.
- Host writes recalled text to `<sessionDir>/.memory_context.md` before `wakeContainer`.
- Container's `providers/claude.ts:266` reads `/workspace/.memory_context.md` if present and appends to `instructions` (which is then passed to the SDK as `systemPrompt.append`).
- Host overwrites/clears the file each turn — never accumulates stale recall.

## Plan

### Phase 1 — Recall (host)
- [ ] Add `recallToSessionFile(clientSlug, agentGroupId, sessionId, query)` in `src/memory/hindsight.ts`. Logic:
  - Resolve target path via `sessionDir(agentGroupId, sessionId)` + `'/.memory_context.md'`.
  - If `await isHindsightAvailable() === false` → unlink any existing file and return.
  - Call `hindsightRecall(clientSlug, query)`.
  - If non-empty → write to file. Empty/error → unlink any existing file (no stale recall).
  - Log `[hindsight] recall {chars, sessionId}` at info; errors at warn.
- [ ] In `router.ts` `deliverToAgent`, just before `if (wake) { ... wakeContainer(freshSession) }`:
  - Build query from `event.message.content` (text portion via `safeParseContent`).
  - Use `clientSlug = 'global'` (matches `index.ts:89`).
  - Fire-and-forget: `void recallToSessionFile(...).catch(err => log.warn('[hindsight] recall threw', { err }))`.
  - **Do not block message routing on this call.**

### Phase 2 — Container reads memory_context (container)
- [ ] In `container/agent-runner/src/providers/claude.ts` `query()`:
  - Before `const instructions = input.systemContext?.instructions;`, read `/workspace/.memory_context.md` if it exists.
  - If non-empty, prepend to instructions: `[memoryText, instructions].filter(Boolean).join('\n\n')`.
  - Wrap file I/O in try/catch — file missing/unreadable is the common case, must not throw.
  - Log `[memory] context loaded {chars}` at debug.

### Phase 3 — Retain (host)
- [ ] Find the delivery completion point (likely `delivery.ts` after `messages_out` is dispatched).
- [ ] After successful delivery, fire-and-forget:
  - `hindsightRetain('global', `${userMessage}\n\n${agentReply}`, { tags: buildTags({ clientSlug: 'global', userId, sessionId }) })`
  - Log `[hindsight] retain {tokens}` at info; errors at warn.
- [ ] Skip retain when:
  - Hindsight unavailable.
  - Reply is a permission-denied stub (gate.action === 'deny').
  - Message was dropped/filtered.

### Phase 4 — Manual + log verification
- [ ] Send Telegram message stating a fact ("my dog's name is Rex"). Tail `~/.clawbridge/logs/out.log` — expect `[hindsight] recall` (likely 0 chars first turn) and `[hindsight] retain` after delivery.
- [ ] In a fresh session, ask "what's my dog's name?". Tail logs — expect `[hindsight] recall` with non-zero chars. Verify file content at `<sessDir>/.memory_context.md` contains the recalled text.
- [ ] Stop Hindsight container (`docker stop` the hindsight-server). Send a Telegram message — expect graceful degradation (no crash, no message loss, log warns once via `isHindsightAvailable()` cache).
- [ ] Restart Hindsight, run a Telegram round-trip — confirm recovery.

### Phase 5 — Tests
- [ ] Unit (`src/memory/hindsight.test.ts` — new file): mock `getHindsightClient` and assert `recallToSessionFile` writes when content present, unlinks when not, no-throw when client unavailable.
- [ ] Integration: extend `delivery.test.ts` or add `router.test.ts` — drive `routeInbound` with Hindsight mocked to return a known string, assert the file exists at the expected path before `wakeContainer`-equivalent fires.
- [ ] Run full suite: `pnpm test` — no regressions in `host-sweep.test.ts`, `delivery.test.ts`, etc.

## Out of scope (this PR)
- Per-agent-group / per-channel client-slug isolation (currently `'global'`).
- Reflection scheduling changes — `host-sweep` keeps doing nightly.
- CLAUDE.md regeneration changes.
- Surfacing degradation status to the user (separate enhancement, GitHub Issue #8 in `tasks/github-issues.md`).

## Review section

### Files touched
**Host (`src/`):**
- `src/memory/hindsight.ts` — added `MEMORY_CONTEXT_FILENAME` constant, `recallToSessionFile()`, `retainTurn()`. Added `fs` and `path` imports.
- `src/memory/index.ts` — re-exported `recallToSessionFile`, `retainTurn`, `MEMORY_CONTEXT_FILENAME`.
- `src/router.ts` — imported `sessionDir` and `recallToSessionFile`. Added recall hook in `deliverToAgent` just before `wakeContainer` (fire-and-forget).
- `src/db/session-db.ts` — added `getLatestInboundChatContent()` query helper.
- `src/delivery.ts` — imported `getLatestInboundChatContent`, `retainTurn`. Added `extractText()` local helper. Added retain hook in `drainSession` after `markDelivered` for chat messages (fire-and-forget).

**Container (`container/agent-runner/src/`):**
- `providers/claude.ts` — added file read of `/workspace/.memory_context.md` in `query()`, prepends to `systemContext.instructions`.

**Tests:**
- `src/memory/hindsight.test.ts` — new file. 7 tests covering recallToSessionFile (write/clear/throw paths) and retainTurn (skip empty, skip noise, retain substantive, no-throw on client errors).

### Verification done
- [x] `pnpm -w run build` — exit 0, no TypeScript errors.
- [x] `pnpm -w run test` — 217/217 pass (210 pre-existing + 7 new). No regressions.
- [x] Container `tsc --noEmit` — only pre-existing missing `@types/bun` warning, no real errors from the changes.

### Verification still needed (Phase 4 — live deploy)
- [ ] Build host, restart launchd service, send Telegram round-trip, tail logs for `[hindsight] recall written to session` and `[hindsight] turn retained`.
- [ ] In a new session, ask for a fact stated in a prior session — verify recall surfaces it.
- [ ] Stop Hindsight Docker container, send a message, verify graceful degradation (no crash, no message loss). Restart, verify recovery.

### Deviations from original plan
- **Phase 3 query API**: planned to query the user message inline; instead added `getLatestInboundChatContent()` in `db/session-db.ts` (proper helper, easier to test).
- **Trivia threshold**: added a 40-char floor to `retainTurn` so "ok"/"thanks" pairs don't pollute the bank. Not in the original plan but defensible.
- **Container `tsc`**: cannot fully typecheck without `bun install` in the container dir; pre-existing project state. The change is small (uses `fs` already imported on line 1) and host build passes.

### Out-of-scope follow-ups (for separate PRs)
- Per-agent-group client slug isolation (still `'global'`).
- Wire `clawbridge doctor` (Issue #3 in `tasks/github-issues.md`).
- Surface degradation to user (Issue #8).
- Delete dead `formatSystemMessage` in container formatter (Issue #2).
