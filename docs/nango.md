# Nango — OAuth Integration Broker

## What is Nango?

[Nango](https://www.nango.dev/) is a self-hosted OAuth broker that manages third-party integrations for ClawBridge channels. Instead of each channel integration handling its own OAuth dance, refresh token rotation, and credential storage, Nango centralises all of that in one place.

ClawBridge runs Nango as three Docker containers defined in `integrations/docker-compose.yml`:

| Container | Role |
|---|---|
| `nango-server` | API server + OAuth callback handler |
| `nango-db` | PostgreSQL — stores OAuth connections and tokens |
| `nango-redis` | Redis — job queue and session state |

---

## Port Mapping

Nango's internal HTTP server listens on port **8080**. It is exposed to the host on port **3003**:

```
host:3003  →  nango-server container:8080
```

The ClawBridge host process communicates with Nango at `http://localhost:3003`.

> **Note:** Telegram does not use Nango. Telegram bots use a direct bot token (`TELEGRAM_BOT_TOKEN`) with no OAuth flow.

---

## Encryption Key

All OAuth tokens stored in the Nango database are encrypted at rest. The encryption key must be:

- Exactly **32 bytes**, base64-encoded (44 characters)
- Set in `~/.clawbridge/.env` as `NANGO_ENCRYPTION_KEY`
- Consistent across restarts — changing it invalidates all stored tokens

The `NANGO_SECRET_KEY` is a separate value used for API authentication between ClawBridge and the Nango server.

**Relevant `.env` keys:**

| Key | Description |
|---|---|
| `NANGO_SECRET_KEY` | API key for ClawBridge → Nango server requests |
| `NANGO_ENCRYPTION_KEY` | 32-byte base64 key for token encryption at rest |
| `NANGO_DB_PASSWORD` | PostgreSQL password for the `nango-db` container |
| `NANGO_DB_HOST` | Database host (default: `nango-db`) |
| `NANGO_DB_PORT` | Database port (default: `5432`) |
| `NANGO_DB_USER` | Database user (default: `nango`) |
| `NANGO_DB_NAME` | Database name (default: `nango`) |
| `NANGO_REDIS_URL` | Redis URL (default: `redis://nango-redis:6379`) |
| `SERVER_URL` | Public URL Nango uses for OAuth callbacks (default: `http://localhost:3003`) |
| `CONNECT_URL` | Connect UI URL (default: `http://localhost:3006`) |

---

## Idempotency — Safe to Re-run Setup

The ClawBridge setup wizard reads existing `NANGO_*` secrets from `~/.clawbridge/.env` before generating new ones. If `NANGO_SECRET_KEY` and `NANGO_ENCRYPTION_KEY` already exist, they are preserved exactly.

**This means running `clawbridge setup` again will not wipe your OAuth connections.** New secrets are only generated on a truly fresh install where the keys are absent.

If you manually rotate these keys, all stored OAuth tokens become unreadable and connections must be re-authorised.

---

## Adding OAuth Connections for Channels

OAuth-based channels (Discord, Slack, Gmail, WhatsApp via API) establish their connection through Nango:

1. **Configure the integration** in the Nango UI at `http://localhost:3003` or via the ClawBridge portal at `http://localhost:4000`.
2. **Trigger the OAuth flow** — ClawBridge directs the user to the provider's auth page, with Nango handling the callback.
3. **Tokens are stored** in `nango-db`, encrypted with `NANGO_ENCRYPTION_KEY`.
4. **Automatic refresh** — Nango refreshes access tokens before they expire, no manual intervention needed.

> Telegram is the exception: it uses a long-lived bot token directly and does not go through Nango.

---

## Troubleshooting

**Check container status:**
```bash
docker ps --filter name=nango
docker logs nango-server --tail 50
docker logs nango-db --tail 20
```

**Nango not responding on port 3003:**
```bash
# Check the port mapping
docker ps --filter name=nango-server --format "{{.Ports}}"
# Expected: 0.0.0.0:3003->8080/tcp
```

**OAuth connections lost after re-setup:**
If `NANGO_ENCRYPTION_KEY` or `NANGO_SECRET_KEY` changed between runs, stored tokens are unreadable. Check the setup didn't regenerate these keys — they should be preserved if present in `.env`. Re-authorise each affected channel.

**Missing NANGO_ vars in `.env`:**
Run `clawbridge doctor` to identify missing config keys. Re-run the setup wizard to regenerate them.

**Database connection errors in nango-server logs:**
Ensure `nango-db` is healthy before `nango-server` starts. If needed:
```bash
cd ~/.clawbridge && docker compose restart nango-server
```

**Run `clawbridge doctor`** to check Nango container status alongside all other services.
