import { Router, Response } from 'express';
import { getDb } from '../db/index.js';
import { requireAuth, AuthRequest } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

router.get('/overview', (_req: AuthRequest, res: Response): void => {
  const db = getDb();

  const { totalClients } = db
    .prepare("SELECT COUNT(*) as totalClients FROM clients WHERE status = 'active'")
    .get() as { totalClients: number };

  const { tasksCompleted } = db
    .prepare("SELECT COUNT(*) as tasksCompleted FROM usage_logs WHERE event_type = 'task_completed'")
    .get() as { tasksCompleted: number };

  const { messagesProcessed } = db
    .prepare("SELECT COUNT(*) as messagesProcessed FROM usage_logs WHERE event_type = 'message_processed'")
    .get() as { messagesProcessed: number };

  // Revenue from plan mapping
  const planCosts: Record<string, number> = { starter: 299, pro: 599, enterprise: 1299 };
  const activeClients = db
    .prepare("SELECT plan FROM clients WHERE status = 'active'")
    .all() as { plan: string }[];
  const monthlyRevenue = activeClients.reduce((sum, c) => sum + (planCosts[c.plan] ?? 0), 0);

  res.json({ totalClients, tasksCompleted, messagesProcessed, monthlyRevenue });
});

router.get('/client/:id', (req: AuthRequest, res: Response): void => {
  const db = getDb();
  const { id } = req.params;

  const { tasksCompleted } = db
    .prepare(
      "SELECT COUNT(*) as tasksCompleted FROM usage_logs WHERE client_id = ? AND event_type = 'task_completed'"
    )
    .get(id) as { tasksCompleted: number };

  const { messagesProcessed } = db
    .prepare(
      "SELECT COUNT(*) as messagesProcessed FROM usage_logs WHERE client_id = ? AND event_type = 'message_processed'"
    )
    .get(id) as { messagesProcessed: number };

  const recentActivity = db
    .prepare(
      'SELECT event_type, metadata, created_at FROM usage_logs WHERE client_id = ? ORDER BY created_at DESC LIMIT 20'
    )
    .all(id);

  res.json({ tasksCompleted, messagesProcessed, recentActivity });
});

export default router;

router.get('/activity', (_req: AuthRequest, res: Response): void => {
  const db = getDb();
  try {
    const events = db.prepare(`
      SELECT ul.event_type, ul.metadata, ul.created_at, c.name as client_name
      FROM usage_logs ul
      JOIN clients c ON ul.client_id = c.id
      ORDER BY ul.created_at DESC
      LIMIT 50
    `).all();
    res.json(events);
  } catch {
    res.json([]);
  }
});
