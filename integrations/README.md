# ClawBridge Integrations

Powered by [Nango](https://www.nango.dev/) — self-hosted OAuth + API proxy giving ClawBridge agents access to 700+ integrations.

## What This Is

This folder contains:

| Component | Path | Purpose |
|-----------|------|---------|
| Nango stack | `docker-compose.yml` | Self-hosted Nango (Postgres + Redis + server) |
| MCP server | `mcp-server/` | Exposes integration tools to agents over MCP |
| Auth portal | `auth-portal/` | Web UI for clients to connect their accounts |

Agents call tools on the MCP server (e.g. `send_email`, `create_calendar_event`). The MCP server calls Nango, which holds the OAuth tokens and proxies requests to the upstream APIs. Clients authorize their accounts once via the auth portal.

---

## Quick Start

### 1. Start Nango

```bash
cd integrations
cp .env.example .env
# Edit .env:
#   NANGO_SECRET_KEY   — set to any secret string
#   NANGO_ENCRYPTION_KEY — openssl rand -base64 32
#   NANGO_DB_PASSWORD  — set a strong password

docker compose up -d
```

Nango UI is at **http://localhost:3003** — use it to add integration credentials (OAuth client ID/secret).

### 2. Start everything

```bash
cd integrations
./start.sh
```

Or individually:

```bash
# Auth portal (http://localhost:3010)
cd integrations/auth-portal && npm install && npm run dev

# MCP server (stdio)
cd integrations/mcp-server && npm install && npm run dev
```

### 3. Add the MCP server to your agent

```json
{
  "mcpServers": {
    "clawbridge-integrations": {
      "command": "node",
      "args": ["--loader", "tsx", "/path/to/integrations/mcp-server/src/index.ts"],
      "env": {
        "NANGO_SECRET_KEY": "your-secret-key",
        "NANGO_SERVER_URL": "http://localhost:3003"
      }
    }
  }
}
```

---

## How the MCP Server Connects to the Agent

1. The MCP server runs as a **stdio** process — the agent (Claude Code or any MCP client) spawns it.
2. Each tool call includes a `client_id` — this maps to a Nango `connection_id`, identifying which client's tokens to use.
3. Nango injects the OAuth access token and proxies the request to the upstream API.
4. The MCP server returns raw API JSON to the agent.

---

## How Clients Connect Their Accounts

1. Send the client to the auth portal: `http://localhost:3010?client_id=THEIR_ID`
2. The client clicks **Connect** next to any integration.
3. The portal calls `/api/connect`, which creates a Nango session and redirects the client through OAuth.
4. After authorization, the token is stored in Nango. The agent can now use that client's integration.

---

## How to Add a New Integration

1. **Set up in Nango**: In the Nango dashboard (http://localhost:3003), add a new integration provider and enter your OAuth credentials.
2. **Add a card in the portal**: Add an entry to the `FEATURED` array in `auth-portal/index.html`.
3. **Add tools in the MCP server**: In `mcp-server/src/index.ts`, add a tool definition to `TOOLS` and a case in the `CallToolRequestSchema` handler. Use `nangoGet` or `nangoPost` with the provider key and real API endpoint.
4. No restart of Nango needed — it handles new providers dynamically.

---

## Featured Integrations

| Integration | Key | What the Agent Can Do |
|-------------|-----|-----------------------|
| **Google Calendar** | `google-calendar` | List events, create events, check availability |
| **Gmail** | `gmail` | Send emails, read inbox, fetch message metadata |
| **HubSpot** | `hubspot` | List/create contacts, create deals, manage pipeline |
| **Slack** | `slack` | Send messages, list channels, post notifications |
| **Stripe** | `stripe` | View payment intents, look up customers |
| **Notion** | `notion` | Search pages/databases, create new pages |
| **Google Drive** | `google-drive` | Read/write files, search documents |
| **LinkedIn** | `linkedin` | Post updates, look up profiles |
| **Calendly** | `calendly` | Check scheduling links, manage availability |
| **QuickBooks** | `quickbooks` | View invoices, expenses, and financial summaries |
| **Shopify** | `shopify` | Manage orders, products, and customers |
| **Salesforce** | `salesforce` | CRM contacts, opportunities, accounts |

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `NANGO_SECRET_KEY` | Secret key for Nango API auth — set to any strong random string |
| `NANGO_ENCRYPTION_KEY` | AES encryption key for stored tokens — `openssl rand -base64 32` |
| `NANGO_DB_*` | PostgreSQL connection settings |
| `NANGO_REDIS_URL` | Redis URL for Nango job queue |
| `SERVER_URL` | Public URL of Nango server (used for OAuth callbacks) |
| `CONNECT_URL` | Public URL of Nango Connect (auth flow) |

---

## Retell Voice Integration

ClawBridge includes a first-class Retell voice integration for AI-powered phone calls.

| Component | Path | Purpose |
|-----------|------|---------|
| Webhook server | `retell/src/index.ts` | Receives Retell events, saves transcripts to DB |
| Retell client | `retell/src/retell-client.ts` | Wrapper for Retell API (create agents, make calls) |

### Quick Start

```bash
cd integrations/retell
npm install

# Set env vars
export RETELL_API_KEY=your-retell-api-key
export RETELL_WEBHOOK_SECRET=your-webhook-secret
export DATABASE_PATH=../portal/portal.db   # shared with portal API

npm run dev   # starts webhook server on port 3020
```

### Webhook Events Handled

| Event | Action |
|-------|--------|
| `call_started` | Creates a call_log row in SQLite |
| `call_ended` | Updates duration, status, recording_url |
| `call_analyzed` | Saves transcript, detects sentiment, logs usage |

### MCP Tools (via integrations MCP server)

| Tool | Description |
|------|-------------|
| `create_voice_agent` | Create a Retell agent with a custom system prompt |
| `make_call` | Make an outbound call to any number |
| `get_call_transcript` | Fetch transcript + recording URL by call_id |
| `list_recent_calls` | List recent calls with status and duration |
| `get_call_analytics` | Deflection rate, avg duration, call stats |

---

## Claude Vision Tools

The MCP server includes Claude vision tools powered by each client's stored Anthropic API key.

| Tool | Description |
|------|-------------|
| `analyze_image` | Describe any image/photo |
| `extract_text_from_image` | OCR: extract all text from an image |
| `analyze_document` | Parse invoices, contracts, forms → structured JSON |
| `describe_chart` | Analyze charts/graphs → key insights |

These tools automatically use the client's Anthropic API key stored in the portal (encrypted AES-256). Set `PORTAL_API_URL` and `PORTAL_ADMIN_TOKEN` in your MCP server env so it can fetch keys at runtime.
