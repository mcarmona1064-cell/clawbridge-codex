import { Router, Response } from 'express';
import { randomUUID, createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { getDb } from '../db/index.js';
import { requireAuth, AuthRequest } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// ---------------------------------------------------------------------------
// Encryption helpers for Anthropic API keys (AES-256-GCM)
// ---------------------------------------------------------------------------

const ENCRYPTION_KEY_HEX = process.env.ENCRYPTION_KEY ?? '';

function getEncryptionKey(): Buffer {
  if (!ENCRYPTION_KEY_HEX || ENCRYPTION_KEY_HEX.length < 64) {
    // Fall back to a deterministic key derived from JWT_SECRET — not ideal for prod
    // but prevents crashes in dev without ENCRYPTION_KEY set
    const secret = process.env.JWT_SECRET ?? 'dev-secret-change-me';
    const padded = secret.padEnd(64, '0').slice(0, 64);
    return Buffer.from(padded, 'utf-8');
  }
  return Buffer.from(ENCRYPTION_KEY_HEX, 'hex');
}

function encryptApiKey(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: iv:tag:ciphertext (all hex)
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decryptApiKey(encoded: string): string {
  const key = getEncryptionKey();
  const [ivHex, tagHex, ctHex] = encoded.split(':');
  if (!ivHex || !tagHex || !ctHex) throw new Error('Invalid encrypted key format');
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const ct = Buffer.from(ctHex, 'hex');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ct).toString('utf8') + decipher.final('utf8');
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

router.get('/', (req: AuthRequest, res: Response): void => {
  const db = getDb();
  const clients = db
    .prepare('SELECT id, name, email, subdomain, plan, status, created_at, last_active FROM clients ORDER BY created_at DESC')
    .all();
  res.json(clients);
});

// POST /api/clients/validate-key — validate an Anthropic API key via a cheap test call
router.post('/validate-key', async (req: AuthRequest, res: Response): Promise<void> => {
  const { api_key } = req.body as { api_key?: string };
  if (!api_key || !api_key.startsWith('sk-ant-')) {
    res.status(400).json({ valid: false, error: 'Key must start with sk-ant-' });
    return;
  }
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': api_key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-3-haiku-20240307',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    if (response.status === 401 || response.status === 403) {
      res.status(200).json({ valid: false, error: 'Invalid API key' });
      return;
    }
    // 200 or even 429 (rate limit) means the key is valid
    res.json({ valid: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ valid: false, error: message });
  }
});

router.post('/', (req: AuthRequest, res: Response): void => {
  const { name, email, subdomain, plan, anthropic_api_key } = req.body as {
    name?: string;
    email?: string;
    subdomain?: string;
    plan?: string;
    anthropic_api_key?: string;
  };

  if (!name || !email || !subdomain) {
    res.status(400).json({ error: 'name, email, and subdomain are required' });
    return;
  }

  const db = getDb();
  const id = randomUUID();

  const encryptedKey = anthropic_api_key ? encryptApiKey(anthropic_api_key) : null;

  try {
    db.prepare(
      'INSERT INTO clients (id, name, email, subdomain, plan, anthropic_api_key) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, name, email, subdomain, plan ?? 'starter', encryptedKey);

    const client = db
      .prepare('SELECT id, name, email, subdomain, plan, status, created_at FROM clients WHERE id = ?')
      .get(id);
    res.status(201).json(client);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('UNIQUE')) {
      res.status(409).json({ error: 'Email or subdomain already in use' });
    } else {
      res.status(500).json({ error: 'Failed to create client' });
    }
  }
});

router.get('/:id', (req: AuthRequest, res: Response): void => {
  const db = getDb();
  const client = db
    .prepare('SELECT id, name, email, subdomain, plan, status, created_at, last_active FROM clients WHERE id = ?')
    .get(req.params.id);
  if (!client) {
    res.status(404).json({ error: 'Client not found' });
    return;
  }
  res.json(client);
});

// GET /api/clients/:id/anthropic-key — returns decrypted key (internal use only)
router.get('/:id/anthropic-key', (req: AuthRequest, res: Response): void => {
  const db = getDb();
  const row = db
    .prepare('SELECT anthropic_api_key FROM clients WHERE id = ?')
    .get(req.params.id) as { anthropic_api_key: string | null } | undefined;
  if (!row) {
    res.status(404).json({ error: 'Client not found' });
    return;
  }
  if (!row.anthropic_api_key) {
    res.status(404).json({ error: 'No Anthropic API key stored for this client' });
    return;
  }
  try {
    const key = decryptApiKey(row.anthropic_api_key);
    res.json({ api_key: key });
  } catch {
    res.status(500).json({ error: 'Failed to decrypt API key' });
  }
});

router.put('/:id', (req: AuthRequest, res: Response): void => {
  const { name, email, plan, status, anthropic_api_key } = req.body as {
    name?: string;
    email?: string;
    plan?: string;
    status?: string;
    anthropic_api_key?: string;
  };

  const db = getDb();
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id) as
    | Record<string, unknown>
    | undefined;

  if (!client) {
    res.status(404).json({ error: 'Client not found' });
    return;
  }

  const encryptedKey = anthropic_api_key ? encryptApiKey(anthropic_api_key) : null;

  db.prepare(
    `UPDATE clients SET
      name = COALESCE(?, name),
      email = COALESCE(?, email),
      plan = COALESCE(?, plan),
      status = COALESCE(?, status),
      anthropic_api_key = COALESCE(?, anthropic_api_key)
    WHERE id = ?`
  ).run(name ?? null, email ?? null, plan ?? null, status ?? null, encryptedKey, req.params.id);

  const updated = db
    .prepare('SELECT id, name, email, subdomain, plan, status, created_at FROM clients WHERE id = ?')
    .get(req.params.id);
  res.json(updated);
});

router.delete('/:id', (req: AuthRequest, res: Response): void => {
  const db = getDb();
  db.prepare("UPDATE clients SET status = 'inactive' WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

export default router;
