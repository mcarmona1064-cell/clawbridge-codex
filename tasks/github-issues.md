# Install-flow feedback — Hindsight + Nango

Findings from a live debugging session that started as "is the clawbridge update
working?" and ended with the per-message Hindsight wiring (this PR) plus a
clearer picture of where the install experience hurts.

Each section below is shaped as a copy-pasteable GitHub issue. `_meta_` lines
are label suggestions; remove before posting. Group A = Hindsight; Group B =
Nango; Group C = cross-cutting setup/diagnostics.

---

# Group A — Hindsight

## A1. [DONE in this PR] Per-message Hindsight recall + retain were unimplemented

_meta_: `bug, hindsight, priority:critical`

`hindsightRecall` was exported from `src/memory/index.ts:12` with **zero call sites** anywhere in `src/`. `hindsightRetain` was imported in `host-sweep.ts:52` but **never called** there either. The README/CHANGELOG described Hindsight as "semantic memory integration", but live conversations never queried the bank or fed it back. Only `setup/migrate.ts` actually touched Hindsight.

This PR wires:
- `recallToSessionFile()` host-side, hooked in `router.deliverToAgent` just before `wakeContainer`. Writes `<sessionDir>/.memory_context.md` (sessionDir is already RW-mounted to `/workspace`).
- `retainTurn()` host-side, hooked in `delivery.drainSession` after `markDelivered`.
- Container reads `/workspace/.memory_context.md` in `providers/claude.ts` and prepends to `systemContext.instructions`.

Verified live: turn 1 retained 123 chars, turn 2 recall surfaced 655 chars including the canary fact "mango skylight 47", bot replied with the recalled value.

---

## A2. [NEW finding] Reflect hits Anthropic rate limits because Hindsight shares CLAUDE_CODE_OAUTH_TOKEN with the live agent

_meta_: `bug, hindsight, install, priority:high`

### Symptom
`hindsightReflect` returns `504` after 300s. Hindsight server log:
```
[REFLECT client-g-67297] LLM error on iteration 2: Error code: 429 - rate_limit_error (45209ms)
[REFLECT client-g-24986] Wall-clock timeout after 300.0s (limit: 300s)
```

### Root cause — NOT the model choice
**Sonnet for reflect is the right call** — `integrations/docker-compose.yml:110` documents the rationale: "Haiku for extraction (cheap + fast), Sonnet for reflection (better reasoning)". Reflect synthesizes patterns; Haiku would degrade output quality. Keep Sonnet.

The actual problem is `integrations/docker-compose.yml:109`:
```yaml
HINDSIGHT_API_LLM_API_KEY: ${CLAUDE_CODE_OAUTH_TOKEN}
```

This makes Hindsight's reflect/retain/consolidation **share the user's Claude Code subscription rate limit with the live agent**. When reflect runs while a Telegram conversation is active (or just after — Sonnet's per-minute window is sticky), both compete for the same TPM budget, retry into 429s, and reflect exhausts its 300s wall-clock before making progress.

This is a rate-limit-budget problem, not a model-quality problem.

### Fix — separate the LLM credential
Change the compose to prefer a dedicated key, falling back to the OAuth token only when one isn't set:
```yaml
HINDSIGHT_API_LLM_API_KEY: ${HINDSIGHT_LLM_API_KEY:-${CLAUDE_CODE_OAUTH_TOKEN}}
```

Then in setup:
1. **Wizard step**: "Hindsight reflect uses Sonnet to synthesize patterns. To avoid rate-limit conflict with your live agent, set a dedicated Anthropic API key (`sk-ant-api03-...` from console.anthropic.com). Skip to share your Claude Code token (works for light use)."
2. **README**: a "Production Hindsight" callout explaining the dedicated-key recommendation.
3. **A6 (`clawbridge doctor`)** flags `Hindsight LLM key: shared with CLAUDE_CODE_OAUTH_TOKEN ⚠ (see docs/hindsight.md)` so the diagnosis is one command away next time.

### Belt-and-braces: surface the rate limit when it happens
When the host catches a 429 in `hindsightRetain`/`hindsightReflect` (Hindsight returns it through), log a one-time per-process warning pointing to the doc — same shape as how `isHindsightAvailable()` already caches the boolean.

### Why this matters for install smoothness
With the OAuth-token default, reflect is unreliable any time the agent is active. Users who turn reflect on during setup will see timeouts and assume the install is broken, when actually it's two systems competing for one TPM budget. A dedicated-key path removes the contention without changing the model choice.

---

## A3. hindsightReflect imported in host-sweep but never called (no nightly job)

_meta_: `bug, hindsight, priority:medium`

`src/host-sweep.ts:52-53` imports `hindsightRetain, hindsightReflect` but neither is called in that file. The README + commit `b0fd68f` describe a "nightly reflect" job; it doesn't exist.

### Fix
Either:
- Wire `hindsightReflect` into `runNightlyMemoryDecay()` (or a sibling `runNightlyHindsightReflect()` that runs at a low-traffic hour and respects A2 above), or
- Remove the imports and the marketing claim until you implement it.

`hindsightRetain` is now called from `delivery.ts` per A1 — its host-sweep import can be removed.

---

## A4. Container `kind:'system'` filter has dead-code that suggests system messages reach the agent

_meta_: `cleanup, priority:medium`

`container/agent-runner/src/poll-loop.ts:67` filters out `kind:'system'` messages from `getPendingMessages()`. Meanwhile `formatter.ts:formatSystemMessage()` exists with logic to format system messages — **dead code**, since system messages never reach the formatter.

The only consumer of `kind:'system'` rows today is `interactive.ts:113`, which polls the session DB directly via `findQuestionResponse(questionId)` — bypasses the message stream.

### Fix
- Delete `formatSystemMessage()` (or re-route it via the audit's Option A if you ever decide to surface system events through the agent), AND
- Document the filter at line 67 with a comment explaining why system messages are routed out-of-band.

This trip-wire cost an extra 30 minutes during this PR's planning — the natural assumption was that writing a `kind:'system'` row would reach the agent.

---

## A5. Misleading comment in container-runner.ts:455 was aspirational pre-PR

_meta_: `docs, hindsight, priority:low`

Pre-PR, `src/container-runner.ts:455-459` claimed:
> "memory retrieval is injected into context by the host before the container session starts."

True statement of intent, but no code path implemented it. After this PR's `recallToSessionFile()` it's accurate. Just close the loop in code review and consider adding a pointer to `hindsight.ts:recallToSessionFile()` in the comment so future readers know where the implementation lives.

---

## A6. Add `clawbridge doctor` for end-to-end health diagnostics

_meta_: `enhancement, dx, priority:high`

### Problem
This 10-message debug session exists because nothing surfaces the host/container boundary clearly. The container-side agent reasonably introspected its own MCP servers / skills list and reported "no hindsight" — correct from inside the container (Hindsight is host-only) but misleading.

### Proposal
Single host-side command that prints:
```
Host process       : RUNNING (pid 26106, uptime 4h12m, version 2.1.2)
Service mode       : launchd (com.clawbridge-v2-b607ee54)
.env               : ~/.clawbridge/.env (loaded, 14 keys)
Anthropic auth     : CLAUDE_CODE_OAUTH_TOKEN ✓
Hindsight server   : http://localhost:8888 ✓ (200 OK)
Hindsight env      : URL ✓  API_KEY ✓  DB_PASSWORD ✓
Hindsight LLM key  : shared with CLAUDE_CODE_OAUTH_TOKEN  ⚠  (see A2)
Hindsight calls    : recall=12  retain=4  reflect=0/2 timed-out  (last 24h)
Reflection         : never run (A3)
Nango              : nango-server ✓  nango-db ✓  nango-redis ✓ (port 3003)
Channel adapters   : telegram ✓  cli ✓
Active sessions    : 3
```

The "shared with CLAUDE_CODE_OAUTH_TOKEN" + reflect timeout count would have collapsed today's reflect investigation to one command.

### Implementation hooks
- Counts come from a small in-memory metrics map written to from `recallToSessionFile`, `retainTurn`, and `hindsightReflect` (already log-instrumented; surface the count too).
- Health checks from existing patterns in `src/health-check.ts`.

### Bonus: container-side `/diagnose` slash command
Routes a request to the host doctor and renders the result in chat. Stops the agent from introspecting its own (memory-less) container and reporting "no hindsight."

---

## A7. Document the host/container boundary for memory + credentials

_meta_: `docs, priority:high`

Add `docs/hindsight.md` (linked from README) covering:
- Diagram: host process / Hindsight server / agent container as separate trust boundaries.
- Which env vars cross which boundary. `CLAUDE_CODE_OAUTH_TOKEN` crosses (set explicitly in `container-runner.ts:445-447`); `HINDSIGHT_*` does not (intentional, see comment at line 455).
- Where to debug: host logs (`~/.clawbridge/logs/`), bank state (`curl localhost:8888/v1/default/banks`), recall file (`cat <sessionDir>/.memory_context.md`).
- Where NOT to debug: container shell, `container.json`, skills list, MCP server list — these all live in the container's narrower world and won't show host-side memory.
- Cover the new file convention introduced in A1: `<sessionDir>/.memory_context.md`.

---

## A8. Post-migration smoke test for Hindsight round-trip

_meta_: `enhancement, setup, priority:medium`

`setup/migrate.ts` retains memories during migration but never verifies recall works. If Hindsight is misconfigured (auth, network, schema), migration prints "✓ Retained: N" and exits clean — recall would fail later.

Fix: at end of migrate, retain a known canary, recall it, log PASS/FAIL. Refuse to mark migration complete on FAIL.

```ts
const canary = `__migration_canary_${Date.now()}__`;
await hindsightRetain(clientSlug, canary, { tags: ['__canary__'] });
const back = await hindsightRecall(clientSlug, canary, { tags: ['__canary__'] });
const ok = back.includes(canary);
emit(ok ? 'pass' : 'fail', `Hindsight round-trip: ${ok ? 'OK' : 'FAILED'}`);
```

---

## A9. Setup wizard should bring up Hindsight Docker explicitly + verify

_meta_: `enhancement, setup, priority:medium`

Today the user can have `HINDSIGHT_*` env vars in `.env` but the Hindsight + Postgres containers may not be running. The README lists Hindsight as a feature without making the Docker dependency explicit.

Fix:
- Setup wizard step "Start Hindsight" runs `docker compose up -d hindsight-db hindsight-api` with a clear log line.
- After start, poll `http://localhost:8888/v1/default/banks` until 200 OK or 30s timeout. On timeout, print logs and exit non-zero.
- README's Hindsight section gets a "this requires Docker and runs 2 containers totaling ~600MB" callout.
- A6's `clawbridge doctor` covers the steady-state version of this check.

---

## A10. Backup story for Hindsight

_meta_: `docs, security, priority:low`

`HINDSIGHT_DB_PASSWORD` in `.env` is useless without the `pgvector/pgvector` Docker volume. A user who backs up only `.env` (instinctive — secrets file) and loses the volume cannot restore.

Fix:
- Add a `## Backup` section to `docs/hindsight.md` (A7) listing what to back up: `.env` PLUS the `hindsight-db-data` volume.
- Or ship `clawbridge backup` that tars both into one timestamped archive.

---

## A11. Surface Hindsight degradation to the user

_meta_: `enhancement, priority:low`

Post-A1, when Hindsight is unavailable the agent silently degrades. Correct for reliability but invisible — users may assume the agent has memory it doesn't.

Fix: when `isHindsightAvailable() === false`, emit a one-time per-session log line and let `clawbridge doctor` (A6) flag it. Optional: surface inline to the agent prompt under `HINDSIGHT_SURFACE_DEGRADATION=true`.

---

# Group B — Nango

## B1. Existing installs don't pick up `integrations/docker-compose.yml` updates

_meta_: `bug, nango, install, priority:high`

### Symptom
Source `integrations/docker-compose.yml` line 60 has `"3003:8080"` (per fix `3df93da`). My deployed copy at `~/.clawbridge/docker-compose.yml` still has `"3003:3003"` — older. Setup writes the compose file once during install (`src/setup/index.ts`) and never reconciles on upgrade.

```
$ diff integrations/docker-compose.yml ~/.clawbridge/docker-compose.yml
60c60
<       - "3003:8080"
---
>       - "3003:3003"
```

Same drift will affect any future compose change. Existing users miss every fix unless they wipe `~/.clawbridge/docker-compose.yml` and re-run setup, which would also regenerate secrets (B2).

### Fix options
- **`clawbridge upgrade-compose`** command that reads the source template, preserves user-set env-driven values from `.env`, and rewrites `~/.clawbridge/docker-compose.yml`. Diff-then-confirm before writing.
- Or: don't generate `docker-compose.yml` at install time at all. Symlink `~/.clawbridge/docker-compose.yml -> $(npm root -g)/clawbridge-agent/integrations/docker-compose.yml` and use only env-var interpolation. New installs and `npm i -g clawbridge-agent` upgrades both pick up changes.

The symlink approach is much simpler and matches what `~/.clawbridge/container -> clawbridge-agent/container` already does for the container source.

---

## B2. Re-running setup regenerates Nango secrets, breaking all OAuth connections

_meta_: `bug, nango, setup, priority:high`

`src/setup/index.ts:220-232` generates fresh `NANGO_DB_PASSWORD`, `NANGO_SECRET_KEY`, `NANGO_ENCRYPTION_KEY` via `crypto.randomBytes()` on every setup run. If a user re-runs setup (because of B1, or just to add a channel), these get rewritten, the Nango DB is unreadable with the new password, and **every saved OAuth token becomes garbage**.

### Fix
Guard the generation behind "only if the value is not already in `.env`":
```ts
const nangoSecretKey = sourceEnv.get('NANGO_SECRET_KEY') ?? crypto.randomBytes(16).toString('hex');
```

Surface a wizard step "Reuse existing Nango credentials" → "Yes, keep them (default) / No, rotate (will require re-authenticating all integrations)".

---

## B3. Nango health/status not visible to user

_meta_: `enhancement, nango, dx, priority:medium`

Nango runs three containers (`nango-db`, `nango-redis`, `nango-server`) plus depends on the user's network setup. When something's wrong, the user sees a vague "auth flow failed" message in whatever channel they're configuring.

### Fix
- A6's `clawbridge doctor` reports each Nango container's status.
- Add a one-shot `clawbridge nango status` that prints port bindings, DB connectivity, and recent server logs (last 20 lines) so users can paste into bug reports.
- When the wizard launches Nango, it should poll `http://localhost:3003/health` (or whatever the server's health endpoint is) until OK before claiming success.

---

## B4. Nango Docker image / port pain has been recurring

_meta_: `chore, nango, install, priority:low`

Recent commits `da471b5 fix: correct Nango Docker image tag and auto-generate Nango env vars` and `3df93da fix: nango port 3003→8080, env var name consistency, portal retry hint` show this area churns. Lock down with:
- Pin the Nango image to an explicit tag (not `:latest`) and document upgrade procedure.
- Add a CI check that boots the compose file in a clean container and verifies Nango reaches healthy state. Catches future image / port regressions before users hit them.

---

## B5. Document Nango's role and the OAuth lifecycle

_meta_: `docs, nango, priority:medium`

The README mentions Nango under "integrations" but doesn't explain:
- That Nango is the OAuth broker — every Gmail/GCal/Slack/etc. integration goes through it.
- That `NANGO_ENCRYPTION_KEY` is the master key for stored OAuth tokens; rotating it (B2) invalidates everything.
- That existing OAuth connections survive `clawbridge update` only if Nango secrets are stable.

Add `docs/nango.md` with the trust model, secrets layout, and "I want to rotate keys safely" runbook.

---

# Group C — Cross-cutting

## C1. Source/deployed drift is the meta-problem

_meta_: `bug, install, priority:high`

This shows up in three places now:
- A1 (host code drift — `dist/` in global install was 8 hours old until I rsync'd today)
- B1 (`docker-compose.yml` drift — fix in source not deployed)
- B2 (regenerate-on-restart drift — secrets get rotated)

There's no single "upgrade your install" command that reconciles source → deployed safely. `npm i -g clawbridge-agent` updates `dist/` but doesn't touch `~/.clawbridge/docker-compose.yml` or the launchd plist or the container symlink target.

### Proposal
A `clawbridge upgrade` command that:
1. Updates the npm global package (or trusts the user did so).
2. Diffs `integrations/docker-compose.yml` against `~/.clawbridge/docker-compose.yml`. Shows the diff, asks confirmation, applies non-secret changes only.
3. Restarts launchd service.
4. Verifies via A6's doctor that everything came back up.

This single command is what saves you from writing the same fix-rollout-issue three times next year.

---

## C2. The integration tests don't run any of this in a real container

_meta_: `enhancement, ci, priority:medium`

The 217 unit/integration tests pass, but none of them spin up Docker, none touch a real Hindsight server, and none drive a Telegram round-trip. The recall/retain wiring works; we proved it manually. A future change could break it without any test failing.

### Fix
A nightly e2e job that:
- Boots compose (Hindsight + Nango).
- Starts a host process pointing at a fake-Telegram adapter.
- Sends a canary message, waits for reply, asserts the recall file contains the seeded fact.
- Tears everything down.

Even the simplest version of this would have caught the pre-PR "recall has zero call sites" bug at PR-time, not by user report.
