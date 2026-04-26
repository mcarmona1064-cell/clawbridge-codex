# ClawBridge — Retell Voice Integration

AI-powered phone calls for ClawBridge clients, built on [Retell AI](https://www.retellai.com/).

## What It Does

- **Webhook server** (port 3020) — receives Retell call events and persists transcripts, recordings, and sentiment scores to the shared SQLite database
- **Retell client** — typed wrappers for creating agents, assigning phone numbers, and making outbound calls
- **MCP tools** — exposes voice capabilities to agents via the ClawBridge integrations MCP server

## Setup

### 1. Get a Retell API key

Sign up at [app.retellai.com](https://app.retellai.com) and copy your API key from the dashboard.

### 2. Install dependencies

```bash
cd integrations/retell
npm install
```

### 3. Configure environment

```bash
cp ../../../portal/.env.example .env
# Edit .env:
RETELL_API_KEY=key_xxxxxxxxxxxx
RETELL_WEBHOOK_SECRET=whsec_xxxxxxxxxx   # from Retell dashboard → Webhooks
RETELL_WEBHOOK_PORT=3020
DATABASE_PATH=../../portal/portal.db      # shared portal DB
```

### 4. Start the webhook server

```bash
npm run dev
```

The server starts on `http://localhost:3020`.

### 5. Configure Retell webhook

In the Retell dashboard → **Webhooks**, set your webhook URL to:

```
https://your-domain.com/webhook
```

Or use [ngrok](https://ngrok.com) for local testing:

```bash
ngrok http 3020
# Copy the https URL → paste into Retell dashboard
```

Enable events: `call_started`, `call_ended`, `call_analyzed`.

## Creating Your First Voice Agent

Use the MCP tool from any connected agent:

```
create_voice_agent(
  client_id: "acme-corp",
  agent_name: "Support Assistant",
  system_prompt: "You are a helpful support agent for Acme Corp. Answer questions about orders, returns, and product info. If you cannot help, offer to connect the caller to a human agent.",
  voice_id: "11labs-Adrian"   # optional
)
```

This returns an `agent_id`. Save it — you'll need it to make calls.

## Making an Outbound Call

```
make_call(
  client_id: "acme-corp",
  to_number: "+12125550100",
  from_number: "+18005550199",   # your Retell phone number
  message: "Customer John Doe is calling about order #12345"
)
```

## Viewing Transcripts

After a call ends:

```
get_call_transcript(client_id: "acme-corp", call_id: "call_xxxx")
```

Or browse the **Call Logs** section in the ClawBridge portal dashboard.

## Data Stored Per Call

| Field | Description |
|-------|-------------|
| `call_id` | Retell call identifier |
| `from_number` / `to_number` | Phone numbers |
| `direction` | inbound / outbound |
| `status` | in_progress / completed / failed |
| `duration_seconds` | Call length |
| `recording_url` | Link to recording (if enabled in Retell) |
| `transcript` | Full call transcript |
| `sentiment` | positive / neutral / negative (auto-detected) |
| `resolved` | 1 if call was resolved, 0 if escalated |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `RETELL_API_KEY` | Retell API key from dashboard |
| `RETELL_WEBHOOK_SECRET` | Webhook signing secret (optional but recommended) |
| `RETELL_WEBHOOK_PORT` | Port for webhook server (default: 3020) |
| `DATABASE_PATH` | Path to shared SQLite database |
