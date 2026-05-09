/**
 * ClawBridge Telemetry Relay — Cloudflare Worker
 *
 * Receives POST /report from installed ClawBridge instances,
 * formats a readable email, and sends it via Resend to mark@clawbridgeagency.com.
 *
 * Secrets (set via `wrangler secret put`):
 *   RESEND_API_KEY  — from resend.com (free tier: 3,000 emails/month)
 *
 * Rate limiting: max 1 report per installId per 60 seconds (via KV).
 */

export interface Env {
  RESEND_API_KEY: string;
  RATE_LIMIT_KV: KVNamespace;
}

const TO_EMAIL = 'mark@clawbridgeagency.com';
const FROM_EMAIL = 'telemetry@clawbridgeagency.com';
const RATE_LIMIT_SECONDS = 60;

// ── Types ────────────────────────────────────────────────────────────────────

interface BasePayload {
  installId: string;
  version: string;
  platform: string;
  nodeVersion: string;
  ts: string;
  uptime: number;
}

type TelemetryPayload = BasePayload &
  (
    | { event: 'crash'; error: string; stack: string; file: string; context?: string }
    | { event: 'doctor_failure'; failures: Array<{ label: string; detail: string }> }
    | { event: 'install'; success: boolean; channel?: string; errorMessage?: string }
    | { event: 'upgrade'; fromVersion: string; toVersion: string; success: boolean; errorMessage?: string }
  );

// ── Email formatting ─────────────────────────────────────────────────────────

function formatEmail(p: TelemetryPayload): { subject: string; html: string } {
  const meta = `
    <p style="color:#666;font-size:13px;margin:0">
      <b>Install:</b> ${p.installId} &nbsp;|&nbsp;
      <b>Version:</b> ${p.version} &nbsp;|&nbsp;
      <b>Platform:</b> ${p.platform} &nbsp;|&nbsp;
      <b>Node:</b> ${p.nodeVersion} &nbsp;|&nbsp;
      <b>Uptime:</b> ${p.uptime}s &nbsp;|&nbsp;
      <b>Time:</b> ${p.ts}
    </p>`;

  if (p.event === 'crash') {
    return {
      subject: `🚨 ClawBridge Crash — ${p.file} — v${p.version} (${p.platform})`,
      html: `
        <h2 style="color:#c0392b">🚨 ClawBridge Crash Report</h2>
        ${meta}
        <hr/>
        <p><b>Error:</b> ${escHtml(p.error)}</p>
        <p><b>File:</b> ${escHtml(p.file)}</p>
        ${p.context ? `<p><b>Context:</b> ${escHtml(p.context)}</p>` : ''}
        <h3>Stack Trace</h3>
        <pre style="background:#f5f5f5;padding:12px;border-radius:4px;font-size:12px;overflow:auto">${escHtml(p.stack)}</pre>
      `,
    };
  }

  if (p.event === 'doctor_failure') {
    const rows = p.failures
      .map(
        (f) =>
          `<tr><td style="padding:4px 8px;color:#c0392b">❌ ${escHtml(f.label)}</td><td style="padding:4px 8px;color:#555">${escHtml(f.detail)}</td></tr>`,
      )
      .join('');
    return {
      subject: `⚠️ ClawBridge Doctor: ${p.failures.length} failure${p.failures.length > 1 ? 's' : ''} — v${p.version} (${p.platform})`,
      html: `
        <h2 style="color:#e67e22">⚠️ ClawBridge Doctor Failures</h2>
        ${meta}
        <hr/>
        <table style="border-collapse:collapse;width:100%">
          <tr style="background:#f0f0f0"><th style="padding:4px 8px;text-align:left">Check</th><th style="padding:4px 8px;text-align:left">Detail</th></tr>
          ${rows}
        </table>
      `,
    };
  }

  if (p.event === 'install') {
    const icon = p.success ? '✅' : '❌';
    const color = p.success ? '#27ae60' : '#c0392b';
    return {
      subject: `${icon} ClawBridge Install ${p.success ? 'Success' : 'Failed'} — v${p.version} (${p.platform})`,
      html: `
        <h2 style="color:${color}">${icon} ClawBridge Install ${p.success ? 'Succeeded' : 'Failed'}</h2>
        ${meta}
        <hr/>
        ${p.channel ? `<p><b>Channel:</b> ${escHtml(p.channel)}</p>` : ''}
        ${p.errorMessage ? `<p><b>Error:</b> ${escHtml(p.errorMessage)}</p>` : ''}
      `,
    };
  }

  if (p.event === 'upgrade') {
    const icon = p.success ? '⬆️' : '❌';
    return {
      subject: `${icon} ClawBridge Upgrade ${p.success ? 'Success' : 'Failed'} — ${p.fromVersion} → ${p.toVersion} (${p.platform})`,
      html: `
        <h2>${icon} ClawBridge Upgrade ${p.success ? 'Succeeded' : 'Failed'}</h2>
        ${meta}
        <hr/>
        <p><b>From:</b> ${escHtml(p.fromVersion)} &nbsp;→&nbsp; <b>To:</b> ${escHtml(p.toVersion)}</p>
        ${p.errorMessage ? `<p><b>Error:</b> ${escHtml(p.errorMessage)}</p>` : ''}
      `,
    };
  }

  // Fallback
  return {
    subject: `ClawBridge Telemetry — ${(p as BasePayload & { event: string }).event} — v${p.version}`,
    html: `<pre>${escHtml(JSON.stringify(p, null, 2))}</pre>`,
  };
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Rate limiting ────────────────────────────────────────────────────────────

async function isRateLimited(kv: KVNamespace, installId: string, event: string): Promise<boolean> {
  const key = `rl:${installId}:${event}`;
  const existing = await kv.get(key);
  if (existing) return true;
  await kv.put(key, '1', { expirationTtl: RATE_LIMIT_SECONDS });
  return false;
}

// ── Worker handler ───────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    if (request.method !== 'POST' || new URL(request.url).pathname !== '/report') {
      return new Response('Not found', { status: 404 });
    }

    // Parse payload
    let payload: TelemetryPayload;
    try {
      payload = (await request.json()) as TelemetryPayload;
    } catch {
      return new Response('Bad request', { status: 400 });
    }

    // Validate required fields
    if (!payload.installId || !payload.event || !payload.version) {
      return new Response('Bad request', { status: 400 });
    }

    // Sanitise installId to prevent KV key injection
    if (!/^[a-zA-Z0-9_-]{4,64}$/.test(payload.installId)) {
      return new Response('Bad request', { status: 400 });
    }

    // Rate limit
    const limited = await isRateLimited(env.RATE_LIMIT_KV, payload.installId, payload.event);
    if (limited) {
      return new Response('Rate limited', { status: 429 });
    }

    // Format and send email
    const { subject, html } = formatEmail(payload);

    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [TO_EMAIL],
        subject,
        html,
      }),
    });

    if (!resendRes.ok) {
      const err = await resendRes.text();
      console.error('Resend error:', err);
      return new Response('Mail delivery failed', { status: 502 });
    }

    return new Response('OK', { status: 200 });
  },
};
