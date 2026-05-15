# ClawBridge Integrations

This folder contains the integration layer that gives ClawBridge agents access to third-party APIs via OAuth.

## What This Is

| Component   | Path           | Purpose                                      |
| ----------- | -------------- | -------------------------------------------- |
| MCP server  | `mcp-server/`  | Exposes integration tools to agents over MCP |
| Auth portal | `auth-portal/` | Web UI for clients to connect their accounts |

Agents call tools on the MCP server (e.g. `send_email`, `create_calendar_event`). The MCP server proxies requests to the integration server, which holds the OAuth tokens and proxies requests to the upstream APIs. Clients authorize their accounts once via the auth portal.

---

## Quick Start

### 1. Configure environment

```bash
cd integrations
cp .env.example .env
# Edit .env:
#   INTEGRATION_SECRET_KEY   — set to any secret string
#   INTEGRATION_SERVER_URL   — URL of your integration server
```

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
        "INTEGRATION_SECRET_KEY": "your-secret-key",
        "INTEGRATION_SERVER_URL": "http://localhost:3003"
      }
    }
  }
}
```

---

## How the MCP Server Connects to the Agent

1. The MCP server runs as a **stdio** process — the agent (Codex or any MCP client) spawns it.
2. Each tool call includes a `client_id` — this maps to a `connection_id`, identifying which client's tokens to use.
3. The integration server injects the OAuth access token and proxies the request to the upstream API.
4. The MCP server returns raw API JSON to the agent.

---

## How Clients Connect Their Accounts

1. Send the client to the auth portal: `http://localhost:3010?client_id=THEIR_ID`
2. The client clicks **Connect** next to any integration.
3. The portal calls `/api/connect`, which creates a session and redirects the client through OAuth.
4. After authorization, the token is stored. The agent can now use that client's integration.

---

## How to Add a New Integration

1. Add the integration provider to your integration server and enter your OAuth credentials.
2. **Add a card in the portal**: Add an entry to the `FEATURED` array in `auth-portal/index.html`.
3. **Add tools in the MCP server**: In `mcp-server/src/index.ts`, add a tool definition to `TOOLS` and a case in the `CallToolRequestSchema` handler. Use `integrationGet` or `integrationPost` with the provider key and real API endpoint.

---

## Featured Integrations

| Integration         | Key               | What the Agent Can Do                               |
| ------------------- | ----------------- | --------------------------------------------------- |
| **Google Calendar** | `google-calendar` | List events, create events, check availability      |
| **Gmail**           | `gmail`           | Send emails, read inbox, fetch message metadata     |
| **HubSpot**         | `hubspot`         | List/create contacts, create deals, manage pipeline |
| **Slack**           | `slack`           | Send messages, list channels, post notifications    |
| **Notion**          | `notion`          | Search pages/databases, create new pages            |
| **Google Drive**    | `google-drive`    | Read/write files, search documents                  |
| **LinkedIn**        | `linkedin`        | Post updates, look up profiles                      |
| **Calendly**        | `calendly`        | Check scheduling links, manage availability         |
| **QuickBooks**      | `quickbooks`      | View invoices, expenses, and financial summaries    |
| **Shopify**         | `shopify`         | Manage orders, products, and customers              |
| **Salesforce**      | `salesforce`      | CRM contacts, opportunities, accounts               |

---

## Environment Variables

| Variable                 | Description                                                      |
| ------------------------ | ---------------------------------------------------------------- |
| `INTEGRATION_SECRET_KEY` | Secret key for integration server API auth                       |
| `INTEGRATION_SERVER_URL` | URL of the integration server (default: `http://localhost:3003`) |

---

## Vision Tools

The MCP server includes image and document analysis tools powered by the configured OpenAI/Codex-compatible credential.

| Tool                      | Description                                        |
| ------------------------- | -------------------------------------------------- |
| `analyze_image`           | Describe any image/photo                           |
| `extract_text_from_image` | OCR: extract all text from an image                |
| `analyze_document`        | Parse invoices, contracts, forms → structured JSON |
| `describe_chart`          | Analyze charts/graphs → key insights               |

These tools automatically use the client's OpenAI API key stored in the portal (encrypted AES-256). Set `PORTAL_API_URL` and `PORTAL_ADMIN_TOKEN` in your MCP server env so it can fetch keys at runtime.
