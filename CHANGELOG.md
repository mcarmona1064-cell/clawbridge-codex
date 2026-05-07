# Changelog

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
