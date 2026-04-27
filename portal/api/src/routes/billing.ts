import { Router, Request, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth.js';
import { getDb } from '../db/index.js';

// Billing: integrate your own payment provider

const router = Router();

const PLANS = [
  {
    id: 'starter',
    name: 'Starter',
    price: 299,
    features: ['1 agent', 'WhatsApp + Telegram', '5,000 tasks/mo', 'Email support'],
  },
  {
    id: 'pro',
    name: 'Pro',
    price: 599,
    features: ['3 agents', 'All channels', '20,000 tasks/mo', 'Priority support', 'Custom integrations'],
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    price: 1299,
    features: ['Unlimited agents', 'All channels', 'Unlimited tasks', 'Dedicated support', 'SLA', 'Custom setup'],
  },
];

router.get('/plans', (_req: Request, res: Response): void => {
  res.json(PLANS);
});

router.post('/subscribe', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const { clientId, planId } = req.body as { clientId?: string; planId?: string };
  if (!clientId || !planId) {
    res.status(400).json({ error: 'clientId and planId are required' });
    return;
  }

  const plan = PLANS.find((p) => p.id === planId);
  if (!plan) {
    res.status(400).json({ error: 'Invalid plan' });
    return;
  }

  const db = getDb();
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId) as
    | { id: string }
    | undefined;

  if (!client) {
    res.status(404).json({ error: 'Client not found' });
    return;
  }

  // Billing: integrate your own payment provider
  db.prepare('UPDATE clients SET plan = ? WHERE id = ?').run(planId, clientId);
  res.json({ ok: true, plan: planId });
});

router.get('/invoices/:clientId', requireAuth, async (_req: AuthRequest, res: Response): Promise<void> => {
  // Billing: integrate your own payment provider
  res.json([]);
});

router.post('/cancel', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const { clientId } = req.body as { clientId?: string };
  if (!clientId) {
    res.status(400).json({ error: 'clientId required' });
    return;
  }

  const db = getDb();
  // Billing: integrate your own payment provider
  db.prepare("UPDATE clients SET plan = 'starter' WHERE id = ?").run(clientId);
  res.json({ ok: true });
});

export default router;
