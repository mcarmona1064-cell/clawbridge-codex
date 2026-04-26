import { Router, Response } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from '../db/index.js';
import { requireAuth, AuthRequest } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

router.get('/', (req: AuthRequest, res: Response): void => {
  const db = getDb();
  const clients = db.prepare('SELECT * FROM clients ORDER BY created_at DESC').all();
  res.json(clients);
});

router.post('/', (req: AuthRequest, res: Response): void => {
  const { name, email, subdomain, plan } = req.body as {
    name?: string;
    email?: string;
    subdomain?: string;
    plan?: string;
  };

  if (!name || !email || !subdomain) {
    res.status(400).json({ error: 'name, email, and subdomain are required' });
    return;
  }

  const db = getDb();
  const id = randomUUID();

  try {
    db.prepare(
      'INSERT INTO clients (id, name, email, subdomain, plan) VALUES (?, ?, ?, ?, ?)'
    ).run(id, name, email, subdomain, plan ?? 'starter');

    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
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
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!client) {
    res.status(404).json({ error: 'Client not found' });
    return;
  }
  res.json(client);
});

router.put('/:id', (req: AuthRequest, res: Response): void => {
  const { name, email, plan, status } = req.body as {
    name?: string;
    email?: string;
    plan?: string;
    status?: string;
  };

  const db = getDb();
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id) as
    | Record<string, unknown>
    | undefined;

  if (!client) {
    res.status(404).json({ error: 'Client not found' });
    return;
  }

  db.prepare(
    `UPDATE clients SET
      name = COALESCE(?, name),
      email = COALESCE(?, email),
      plan = COALESCE(?, plan),
      status = COALESCE(?, status)
    WHERE id = ?`
  ).run(name ?? null, email ?? null, plan ?? null, status ?? null, req.params.id);

  const updated = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  res.json(updated);
});

router.delete('/:id', (req: AuthRequest, res: Response): void => {
  const db = getDb();
  db.prepare("UPDATE clients SET status = 'inactive' WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

export default router;
