# ClawBridge Telemetry Relay

Cloudflare Worker that receives crash/install/doctor reports from ClawBridge instances
and emails them to mark@clawbridgeagency.com via Resend.

## Deploy (one-time setup)

### 1. Install wrangler
```bash
npm install -g wrangler
wrangler login
```

### 2. Create KV namespace for rate limiting
```bash
cd workers/telemetry-relay
wrangler kv namespace create RATE_LIMIT_KV
# Copy the id from the output and paste it into wrangler.toml
```

### 3. Set Resend API key as a secret
Sign up at https://resend.com (free — 3,000 emails/month).
Add a sending domain (clawbridgeagency.com) or use the sandbox domain for testing.
Then:
```bash
wrangler secret put RESEND_API_KEY
# Paste your Resend API key when prompted
```

### 4. Deploy
```bash
wrangler deploy
```

### 5. Set up custom domain (optional)
In your DNS (Cloudflare): add a CNAME record:
  telemetry.clawbridgeagency.com → clawbridge-telemetry-relay.workers.dev

Then uncomment the `routes` line in wrangler.toml.

## Email types
- 🚨 Crash — uncaught exception with stack trace and file context
- ⚠️ Doctor failure — list of failed health checks
- ✅/❌ Install — setup completion or failure with channel info
- ⬆️/❌ Upgrade — version upgrade result

## What is NOT sent
- No message content or chat history
- No API keys or credentials
- No user-identifiable information
- Only: error type/stack, ClawBridge version, OS, Node version, random install ID
