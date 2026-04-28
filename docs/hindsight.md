# Hindsight — Semantic Memory

## What is Hindsight?

Hindsight is a self-hosted semantic memory layer built on [vectorize-io/hindsight](https://github.com/vectorize-io/hindsight). It gives ClawBridge persistent, searchable memory across conversations — storing, indexing, and recalling facts using vector embeddings rather than keyword search.

ClawBridge runs Hindsight as a Docker container alongside the other services defined in `integrations/docker-compose.yml`.

---

## Host/Container Boundary — CRITICAL

Hindsight runs on the **host only**. Agent containers never see Hindsight environment variables.

| Layer | Has Hindsight access? |
|---|---|
| Host process (`src/index.ts`) | Yes — reads `HINDSIGHT_URL` and `HINDSIGHT_API_KEY` from `~/.clawbridge/.env` |
| Agent containers | No — Hindsight env vars are intentionally excluded from container env |

This is by design: containers are untrusted sandboxes. Memory operations happen in the host process before and after each container turn.

---

## The Three Operations

### 1. Recall (before container wake)

Before spinning up an agent container for a new message, the host process queries Hindsight for relevant memories:

```
host receives message
  → recall(query=message, bank=client-{agentGroupId})
  → inject top-k results into container's CLAUDE.md context
  → wake container
```

### 2. Retain (after each delivered turn)

After the container produces a response and it is delivered to the user, the host distils the turn into memory:

```
container turn completes
  → retain(content=turn_summary, bank=client-{agentGroupId})
```

Model used: **claude-haiku** (fast, cheap — runs after every turn).

### 3. Reflect (nightly via host-sweep)

The host sweep (`src/host-sweep.ts`) runs nightly and triggers a consolidation pass over each agent's memory bank:

```
nightly cron
  → reflect(bank=client-{agentGroupId})
```

This merges redundant memories, promotes important facts to long-term storage, and prunes stale entries.

Model used: **claude-sonnet** (higher quality — runs once per night, not per turn).

---

## Model Config

| Operation | Model | Rationale |
|---|---|---|
| retain | Haiku | Runs every turn — must be fast and cheap |
| consolidation | Haiku | Background batch work |
| reflect | Sonnet | Nightly quality pass — worth the extra cost |

---

## Authentication

Hindsight uses the `claude-code` provider, which reads `CLAUDE_CODE_OAUTH_TOKEN` from the environment.

**This is not a bare Anthropic API key.** It is the long-lived OAuth token issued by `claude setup-token` (starts with `sk-ant-oat`).

If you have a separate API budget for Hindsight LLM operations, set `HINDSIGHT_LLM_API_KEY` in `~/.clawbridge/.env`. If unset, Hindsight falls back to `CLAUDE_CODE_OAUTH_TOKEN`.

---

## Bank Naming

Each registered agent group gets its own isolated memory bank:

```
client-{agentGroupId}
```

Where `agentGroupId` is the group's JID (e.g. `120363336345536173@g.us` → bank `client-120363336345536173@g.us`).

Banks are created automatically on first use.

---

## Configuration Keys (`~/.clawbridge/.env`)

| Key | Description |
|---|---|
| `HINDSIGHT_URL` | Base URL of the Hindsight API (default: `http://localhost:8888`) |
| `HINDSIGHT_API_KEY` | API key for authenticating requests to Hindsight |
| `HINDSIGHT_DB_PASSWORD` | PostgreSQL password for the Hindsight database container |
| `HINDSIGHT_LLM_API_KEY` | Optional separate OAuth token for Hindsight's LLM calls |

---

## Troubleshooting

**Check if Hindsight is healthy:**
```bash
curl -s http://localhost:8888/health -H "x-api-key: <your-key>" | jq
# Expected: {"status":"healthy","database":"connected"}
```

**Check container logs:**
```bash
docker logs hindsight-api --tail 50
docker logs hindsight-db --tail 20
```

**reflect returns 401:**
The `reflect` call is being made with a wrong or expired token. Check that `CLAUDE_CODE_OAUTH_TOKEN` (or `HINDSIGHT_LLM_API_KEY` if set) is a valid long-lived OAuth token — not a short-lived keychain credential. Regenerate with `claude setup-token`.

**Hindsight not healthy after `clawbridge upgrade`:**
The Docker image may need pulling. Run:
```bash
cd ~/.clawbridge && docker compose pull hindsight-api && docker compose up -d hindsight-api
```

**Run `clawbridge doctor`** to check Hindsight health alongside all other services.
