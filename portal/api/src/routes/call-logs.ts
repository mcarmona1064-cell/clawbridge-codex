import { Router, Response } from 'express';
import { getDb } from '../db/index.js';
import { requireAuth, AuthRequest } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

router.get('/', (req: AuthRequest, res: Response): void => {
  const db = getDb();
  const { client_id, limit = '50' } = req.query as { client_id?: string; limit?: string };

  const rows = client_id
    ? db
        .prepare('SELECT * FROM call_logs WHERE client_id = ? ORDER BY created_at DESC LIMIT ?')
        .all(client_id, parseInt(limit))
    : db
        .prepare('SELECT * FROM call_logs ORDER BY created_at DESC LIMIT ?')
        .all(parseInt(limit));

  res.json(rows);
});

router.get('/:call_id', (req: AuthRequest, res: Response): void => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM call_logs WHERE call_id = ?').get(req.params.call_id);
  if (!row) {
    res.status(404).json({ error: 'Call not found' });
    return;
  }
  res.json(row);
});

export default router;
