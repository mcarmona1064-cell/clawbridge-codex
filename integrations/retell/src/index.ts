import 'dotenv/config';
import express, { Request, Response } from 'express';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.RETELL_WEBHOOK_PORT ? parseInt(process.env.RETELL_WEBHOOK_PORT) : 3020;
const WEBHOOK_SECRET = process.env.RETELL_WEBHOOK_SECRET ?? '';
const DB_PATH = process.env.DATABASE_PATH ?? path.resolve(__dirname, '../../../portal/portal.db');

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
    // Ensure call_logs table exists (idempotent)
    _db.exec(`
      CREATE TABLE IF NOT EXISTS call_logs (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        call_id TEXT UNIQUE NOT NULL,
        agent_id TEXT,
        from_number TEXT,
        to_number TEXT,
        direction TEXT DEFAULT 'outbound',
        status TEXT DEFAULT 'completed',
        duration_seconds INTEGER,
        recording_url TEXT,
        transcript TEXT,
        sentiment TEXT,
        resolved INTEGER DEFAULT 0,
        metadata TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }
  return _db;
}

// ---------------------------------------------------------------------------
// Webhook signature verification
// ---------------------------------------------------------------------------

function verifySignature(rawBody: string, signature: string, secret: string): boolean {
  if (!secret) return true; // skip verification in dev if secret not set
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(rawBody);
  const expected = hmac.digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Sentiment detection (lightweight, no API call needed)
// ---------------------------------------------------------------------------

function detectSentiment(transcript: string): 'positive' | 'neutral' | 'negative' {
  const lower = transcript.toLowerCase();
  const positive = ['thank', 'great', 'awesome', 'perfect', 'happy', 'resolved', 'solved', 'excellent'];
  const negative = ['angry', 'frustrated', 'terrible', 'awful', 'unacceptable', 'cancel', 'refund', 'complaint'];
  const posScore = positive.filter((w) => lower.includes(w)).length;
  const negScore = negative.filter((w) => lower.includes(w)).length;
  if (posScore > negScore) return 'positive';
  if (negScore > posScore) return 'negative';
  return 'neutral';
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();

// Capture raw body for signature verification
app.use(
  express.json({
    verify: (req: Request & { rawBody?: string }, _res, buf) => {
      req.rawBody = buf.toString('utf8');
    },
  })
);

type RetellEvent = {
  event: 'call_started' | 'call_ended' | 'call_analyzed';
  call: {
    call_id: string;
    agent_id?: string;
    from_number?: string;
    to_number?: string;
    direction?: string;
    call_status?: string;
    duration_ms?: number;
    recording_url?: string;
    transcript?: string;
    call_analysis?: {
      call_summary?: string;
      user_sentiment?: string;
      call_successful?: boolean;
    };
    metadata?: Record<string, string>;
  };
};

app.post('/webhook', (req: Request & { rawBody?: string }, res: Response): void => {
  const signature = req.headers['x-retell-signature'] as string | undefined;

  if (WEBHOOK_SECRET && signature) {
    if (!verifySignature(req.rawBody ?? '', signature, WEBHOOK_SECRET)) {
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }
  }

  const payload = req.body as RetellEvent;
  const { event, call } = payload;

  console.log(`[Retell webhook] event=${event} call_id=${call?.call_id}`);

  try {
    const db = getDb();

    if (event === 'call_started') {
      const clientId = call.metadata?.client_id ?? 'unknown';
      db.prepare(`
        INSERT OR IGNORE INTO call_logs (id, client_id, call_id, agent_id, from_number, to_number, direction, status, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'in_progress', ?)
      `).run(
        randomUUID(),
        clientId,
        call.call_id,
        call.agent_id ?? null,
        call.from_number ?? null,
        call.to_number ?? null,
        call.direction ?? 'outbound',
        JSON.stringify(call.metadata ?? {})
      );
    } else if (event === 'call_ended') {
      db.prepare(`
        UPDATE call_logs SET
          status = ?,
          duration_seconds = ?,
          recording_url = ?
        WHERE call_id = ?
      `).run(
        call.call_status ?? 'completed',
        call.duration_ms ? Math.round(call.duration_ms / 1000) : null,
        call.recording_url ?? null,
        call.call_id
      );
    } else if (event === 'call_analyzed') {
      const transcript = call.transcript ?? '';
      const sentiment = detectSentiment(transcript);
      const resolved = call.call_analysis?.call_successful ? 1 : 0;

      db.prepare(`
        UPDATE call_logs SET
          transcript = ?,
          sentiment = ?,
          resolved = ?,
          recording_url = COALESCE(?, recording_url)
        WHERE call_id = ?
      `).run(
        transcript,
        sentiment,
        resolved,
        call.recording_url ?? null,
        call.call_id
      );

      // Log to usage_logs
      const logRow = db
        .prepare('SELECT id, client_id FROM call_logs WHERE call_id = ?')
        .get(call.call_id) as { id: string; client_id: string } | undefined;
      if (logRow) {
        db.prepare(`
          INSERT INTO usage_logs (id, client_id, event_type, metadata)
          VALUES (?, ?, 'call_analyzed', ?)
        `).run(
          randomUUID(),
          logRow.client_id,
          JSON.stringify({ call_id: call.call_id, sentiment, resolved })
        );
      }
    }
  } catch (err) {
    console.error('[Retell webhook] DB error:', err);
    // Still return 200 to Retell so it doesn't retry
  }

  res.json({ ok: true });
});

app.get('/health', (_req, res) => res.json({ ok: true, service: 'retell-webhook' }));

app.listen(PORT, () => {
  console.log(`Retell webhook server running on port ${PORT}`);
});
