# ClawBridge Codex Setup & Migration Guide

## Quick Start

### Interactive wizard (recommended)

```bash
npx clawbridge-codex
```

Or from a local checkout:

```bash
pnpm run setup:wizard
```

### Bootstrap script

```bash
bash clawbridge.sh
```

The interactive wizard is the source of truth. It checks prerequisites, installs the Codex CLI if needed, runs `codex login --device-auth`, writes `~/.clawbridge/.env`, links `~/.clawbridge/docker-compose.yml`, optionally enables Hindsight, builds the agent image, registers the background service, and verifies the install.

---

## Fresh Install

The wizard walks you through these steps:

1. **Authenticate with Codex** — installs `@openai/codex` if missing and runs `codex login --device-auth` to create `~/.codex/auth.json`.
2. **Enable channels** — multi-select: Telegram, WhatsApp, Discord, Slack, Gmail.
3. **Telegram bot token** — paste the token from @BotFather if Telegram is selected.
4. **Agent name** — what your assistant is called (default: `ClawBridge`).
5. **Hindsight memory** — optional host-side semantic memory services.
6. **Generate `.env`** — writes host config to `~/.clawbridge/.env`.
7. **Start services** — runs Docker Compose where needed, builds the Codex agent image, and registers launchd/systemd.

Success output:

```
✅ Setup done!
```

---

## Migrate from OpenClaw or NanoClaw

```bash
npx clawbridge-codex
# → select the migration path
```

The wizard will:

1. **Auto-detect** existing installs by scanning common paths.
2. **Show an audit report** with groups, message counts, custom skills, and channels.
3. **Let you select what to migrate**: groups, memory, message history, custom skills, and channel credentials.
4. **Preserve the source install** unless you choose to deactivate it.
5. **Configure Codex auth** with `codex login --device-auth`.
6. **Write `~/.clawbridge/.env`** and start ClawBridge Codex.

Migration code may detect legacy provider env vars so it can import older installs, but the runtime uses `@openai/codex` and subscription OAuth.

---

## Health Checks and Repair

```bash
clawbridge-codex doctor
clawbridge-codex doctor --fix
```

`doctor` checks Docker, service registration, config, Codex auth, Hindsight, channels, DB state, compose symlink, and the agent image.

`doctor --fix` can restart launchd/systemd, start Hindsight containers, rebuild the missing agent image, recreate the compose symlink, restart channel services, and set default Hindsight model variables.

---

## Upgrade

```bash
clawbridge-codex upgrade
# or
clawbridge-codex update
```

Upgrade checks npm for the latest `clawbridge-codex` release, stops the running service, installs the latest package, refreshes the compose symlink, rebuilds the agent image, restarts the service, and runs `doctor`.

Your `~/.clawbridge` data, messages, and memories are preserved.

---

## Files Created

- `~/.codex/auth.json` — Codex subscription OAuth credentials from `codex login --device-auth`.
- `~/.clawbridge/.env` — host-side channel and optional Hindsight config.
- `~/.clawbridge/docker-compose.yml` — symlink to the installed package compose file.
- `~/.clawbridge/logs/` — service logs.
- `~/.clawbridge/groups/` — per-agent group persona, memory, and container config.

---

## Troubleshooting

- Start Docker Desktop or Docker Engine, then rerun setup or `doctor --fix`.
- If Codex auth fails, run `codex login --device-auth` manually and rerun `clawbridge-codex doctor`.
- If the compose symlink is missing, run `clawbridge-codex doctor --fix`.
- If an upgrade fails, retry with `npm install -g clawbridge-codex@latest` and then `clawbridge-codex doctor --fix`.
