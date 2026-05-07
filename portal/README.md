# ClawBridge Client Portal — Phase 3

A full-stack client portal for the ClawBridge Agent Platform.

## Stack

- **Frontend**: Next.js 14 (App Router), Tailwind CSS, TypeScript — port 4000
- **Backend**: Express + SQLite (better-sqlite3), TypeScript — port 3010
- **Billing**: Subscription plans (Starter $299 / Pro $599 / Enterprise $1299)
- **Integrations**: Integration proxy (optional)

## Quick Start

```bash
cd portal
cp .env.example .env

docker compose up
```

Open http://localhost:4000 — you'll be redirected to login.

## Default Login

| Field    | Value                        |
|----------|------------------------------|
| Email    | admin@clawbridgeagency.com   |
| Password | changeme                     |

**Change this immediately in production** — update via the API:
```bash
curl -X PUT http://localhost:3010/api/auth/password \
  -H "Authorization: Bearer <token>" \
  -d '{"newPassword": "your-secure-password"}'
```

## Adding a Client

**Via the dashboard**: Dashboard → Clients → Add Client

**Via the API**:
```bash
curl -X POST http://localhost:3010/api/clients \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Acme Corp",
    "email": "admin@acme.com",
    "subdomain": "acme",
    "plan": "pro"
  }'
```

The client's portal will be available at `http://localhost:4000/acme` (or `https://acme.clawbridgeagency.com` in production with subdomain routing).


## Subdomain Routing (Production)

For `client.clawbridgeagency.com` → `/[client]` routing:

### nginx

```nginx
server {
    listen 443 ssl;
    server_name *.clawbridgeagency.com;

    location / {
        proxy_pass http://localhost:4000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

### Next.js `middleware.ts` (add to `app/src/`)

```ts
import { NextRequest, NextResponse } from 'next/server';

export function middleware(req: NextRequest) {
  const host = req.headers.get('host') || '';
  const subdomain = host.split('.')[0];
  if (subdomain && subdomain !== 'www' && subdomain !== 'clawbridgeagency') {
    return NextResponse.rewrite(new URL(`/${subdomain}${req.nextUrl.pathname}`, req.url));
  }
}
```

## API Reference

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/auth/login | Get JWT token |
| GET | /api/auth/me | Current admin info |
| GET | /api/clients | List all clients |
| POST | /api/clients | Create client |
| GET | /api/clients/:id | Get client |
| PUT | /api/clients/:id | Update client |
| DELETE | /api/clients/:id | Deactivate client |
| GET | /api/stats/overview | Platform-wide stats |
| GET | /api/stats/client/:id | Per-client stats |
| GET | /api/billing/plans | List plans |
| POST | /api/billing/subscribe | Subscribe client to plan |
| GET | /api/billing/invoices/:clientId | List invoices |
| POST | /api/billing/cancel | Cancel subscription |
| GET | /api/integrations | List integrations |
| GET | /health | Health check |

## Project Structure

```
portal/
  app/              Next.js 14 frontend (port 4000)
  api/              Express backend (port 3010)
  docker-compose.yml
  .env.example
```
