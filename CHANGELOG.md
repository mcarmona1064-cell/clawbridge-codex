# Changelog

## v3.0.0-codex.0 — 2026-05-14

**Fork**: `clawbridge-agent` → `clawbridge-codex`. Repository moved to
`mcarmona1064-cell/clawbridge-codex`. This is a hard fork that swaps the
default AI provider from Anthropic Claude to OpenAI Codex; the Claude
provider has been removed entirely.

### Breaking changes
- **Default AI provider is now `codex`** (`AGENT_PROVIDER=codex`). The
  `claude` provider was removed from both host (`src/providers/`) and
  container (`container/agent-runner/src/providers/`).
- **Auth model**: `CLAUDE_CODE_OAUTH_TOKEN` env var is no longer used.
  Codex stores credentials in `~/.codex/auth.json` (populated by
  `codex login --device-auth`).
- **CLI binary renamed** from `clawbridge` / `clawbridge-agent` to
  `clawbridge-codex`.
- **Docker image tag base** renamed from `clawbridge-agent-v2-<slug>` to
  `clawbridge-codex-v2-<slug>`. Existing installs need to rebuild.
- **Integrations MCP server**: vision tools (analyze_image,
  extract_text_from_image, analyze_document, describe_chart) now call
  `gpt-4o` via `openai` SDK instead of Claude 3.5 Sonnet via
  `@anthropic-ai/sdk`.
- **Setup wizard**: `setup/install-claude.sh` / `setup/register-claude-token.sh`
  removed; replaced by `setup/install-codex.sh` / `setup/register-codex.sh`.

### Carried forward from clawbridge-agent
All features from clawbridge-agent v2.9.2 are preserved: multi-channel
adapters (Telegram, WhatsApp, Discord, Slack), Hindsight memory, scheduling,
host-exec, OpenClaw migration, unified transcription, attachment forwarding.

### Known follow-ups
- The container-side composition pipeline still uses `CLAUDE.md` /
  `CLAUDE.local.md` filenames. A follow-up commit will rename these to
  `AGENTS.md` / `AGENTS.local.md` so Codex picks up agent persona files
  by default. Until then, the runtime continues to read `CLAUDE.local.md`.
- The container Dockerfile still installs the Claude binary alongside
  Codex. To be removed in a follow-up once the runtime composition switch
  lands.

---


## v2.1.2 — 2026-04-27
- fix: #22 — Hindsight env vars clarified as host-only; added explicit exclusion comment in container-runner.ts so the non-passthrough is intentional and documented; updated .env.example section header
- fix: #23 — composed CLAUDE.md renamed to `_composed.md` (underscore prefix = machine-managed, do not edit); `CLAUDE.local.md` is now the sole user-editable persona file, seeded with a default template on first group init; README documents the distinction

## v2.1.1 — 2026-04-27
- fix: add `container/` and `scripts/` to npm package files (critical — fixes exit 125 on every container spawn)
- fix: auto-build Docker image during setup
- fix: boot warning when DB-paired channel has no active adapter
- fix: exit code 125 now logs actionable diagnostic hint
- fix: agent_groups name now uses ASSISTANT_NAME from .env (default changed from "Andy" to "ClawBridge")
- docs: update README credential model (post-OneCLI)
- docs: .env.example now has REQUIRED/OPTIONAL sections

## v2.1.0 — 2026-04-27
### Breaking Change
- feat: remove OneCLI dependency — credentials now injected from ~/.clawbridge/.env directly
- If you had `ONECLI_URL` / `ONECLI_API_KEY` in your .env, they are no longer used. Ensure `CLAUDE_CODE_OAUTH_TOKEN` is set instead.

## v2.0.32 — 2026-04-27
- fix: integration server port mapping 3003→8080
- fix: portal retry hint on failure

## v2.0.31 — 2026-04-27
- fix: WhatsApp setup — 4× missing await on fail() calls
- fix: all 4 channel SKILL.md files — remove hardcoded git fetch origin channels

## v2.0.30 — 2026-04-27
- feat: Telegram channel adapter bundled in main branch
- fix: install-telegram.sh — remove broken upstream/channels fetch

## v2.0.29 — 2026-04-27
- fix: portal Docker volume permission — bind mount instead of named volume

## v2.0.28 — 2026-04-27
- fix: legacy migration option removed (fresh install only, OpenClaw + NanoClaw)

## v2.0.27 — 2026-04-27
- fix: fileURLToPath() for all import.meta.url path resolution
- fix: pnpm pre-flight no longer exits on missing pnpm (dev-only tool)
- fix: portal docker compose runs from correct cwd with --env-file

## v2.0.26 — 2026-04-27
- fix: 7 install bugs — launchd, encryption key format, package files, portal, logs dir

## v2.0.25 — 2026-04-27
- feat: ClawBridge ASCII splash screen on clawbridge chat

## v2.0.24 — 2026-04-27
- feat: clawbridge chat — launches Claude Code with ClawBridge credentials
