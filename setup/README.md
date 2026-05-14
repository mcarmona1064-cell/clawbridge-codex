# ClawBridge Setup & Migration Guide

## Quick Start

### Interactive wizard (recommended)

```bash
npx clawbridge-agent setup
```

Or from a local checkout:

```bash
pnpm run setup:wizard
```

### Automated install (scripted / CI)

```bash
bash clawbridge.sh
# or
pnpm run setup:auto
```

---

## Fresh Install

The wizard walks you through these steps:

1. **Authenticate with Claude** — runs `claude setup-token` to get an OAuth token from your Claude Pro/Max subscription. Paste the token when prompted.
2. **Enable channels** — multi-select: Telegram, WhatsApp, Discord, Slack, Gmail
3. **Telegram bot token** — paste the token from @BotFather (if Telegram selected)
4. **Agent name** — what your assistant is called (default: `ClawBridge`)
5. **Retell AI key** (optional) — for voice agents
6. **Generate `.env`** — writes all config to `.env` in your project root
7. **docker compose up -d** — starts ClawBridge in the background

Success output:

```
✅ ClawBridge is running!
```

---

## Migrate from OpenClaw

```bash
npx clawbridge-agent setup
# → select "Migrate from OpenClaw"
```

The wizard will:

1. **Auto-detect** your OpenClaw install by scanning common paths:
   - `~/.openclaw/`
   - `~/openclaw/`
   - `~/clawdbot/`
   - `~/Projects/openclaw/`

2. **Show audit report** — groups, message count, custom skills, channels:

   ```
   📊 Migration Audit — OpenClaw at ~/openclaw
   ──────────────────────────────────────────
   Groups found:         3
   Messages:        12,847
   Custom skills:        5
   Channels:   Telegram, WhatsApp
   ```

3. **Select what to migrate** (checkboxes):
   - Groups & memory
   - Message history
   - Custom skills
   - Channel credentials

4. **Safety confirmation** — "This will NOT affect your existing OpenClaw installation"

5. **Run migration** with progress indicators

6. **Optionally deactivate OpenClaw** — adds a `.clawbridge-deactivated` marker, does not delete data

Migrated data lands in `~/.clawbridge/`:

```
~/.clawbridge/
  groups/           # copied group folders
  store/            # messages.db
  skills/           # custom skill files
  credentials/      # channel config
  .env.migrated     # review before applying
  migration-manifest.json
```

> **Note for OpenClaw users:** The message database schema may differ. After migration, verify with:
>
> ```bash
> sqlite3 ~/.clawbridge/store/messages.db .tables
> ```

---

## Migrate from NanoClaw

```bash
npx clawbridge-agent setup
# → select "Migrate from NanoClaw"
```

Same flow as OpenClaw migration. NanoClaw uses a near-identical schema to ClawBridge, so message history migrates as a direct copy without transformation.

Auto-detected paths:

- `~/.nanoclaw/`, `~/nanoclaw/`

---

## Rollback

If something goes wrong during migration, the wizard offers to roll back automatically. To roll back manually:

```typescript
import { rollback } from './src/setup/migrate.js';

await rollback({ type: 'openclaw', path: '/path/to/openclaw' });
```

This restores from `~/.clawbridge/migration-backup/` and removes the migrated files.

---

## Environment Variables Reference

| Variable                                 | Required | Description                                                           |
| ---------------------------------------- | -------- | --------------------------------------------------------------------- |
| `OPENAI_API_KEY` or `~/.codex/auth.json` | ✅       | OpenAI API key, or Codex login created by `codex login --device-auth` |
| `AGENT_NAME`                             | ✅       | Display name for your agent                                           |
| `TELEGRAM_BOT_TOKEN`                     | Channel  | From @BotFather                                                       |
| `DISCORD_BOT_TOKEN`                      | Channel  | Discord bot token                                                     |
| `SLACK_BOT_TOKEN`                        | Channel  | Slack bot token                                                       |
| `SLACK_SIGNING_SECRET`                   | Channel  | Slack signing secret                                                  |
| `WHATSAPP_PHONE_NUMBER_ID`               | Channel  | WhatsApp Cloud API                                                    |
| `WHATSAPP_ACCESS_TOKEN`                  | Channel  | WhatsApp Cloud API                                                    |
| `GMAIL_CLIENT_ID`                        | Channel  | Google OAuth client                                                   |
| `GMAIL_CLIENT_SECRET`                    | Channel  | Google OAuth secret                                                   |
| `RETELL_API_KEY`                         | Optional | Voice agent integration                                               |

### Example `.env`

```dotenv
# Codex Auth
# Option A: run `codex login --device-auth` to create ~/.codex/auth.json
# Option B: set an API key directly
OPENAI_API_KEY=sk-…

AGENT_NAME=ClawBridge
TELEGRAM_BOT_TOKEN=123456789:ABCdef…
```

---

## Scripted / Unattended Migration

For CI or scripted installs, use the migration engine directly:

```typescript
import { detectInstall, auditInstall, runMigration } from './src/setup/migrate.js';

const source = await detectInstall();
if (!source) throw new Error('No install found');

const audit = await auditInstall(source);
await runMigration(source, audit, ['groups', 'messages', 'skills'], (progress) => {
  console.log(`[${progress.step}] ${progress.detail ?? ''}`);
});
```
