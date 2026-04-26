import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import { getDb } from '../db/index.js';
import { requireAuth, AuthRequest } from '../middleware/auth.js';

const router = Router();

const PLANS = [
  {
    id: 'starter',
    name: 'Starter',
    price: 299,
    priceId: process.env.STRIPE_STARTER_PRICE_ID || 'price_starter',
    features: ['1 agent', 'WhatsApp + Telegram', '5,000 tasks/mo', 'Email support'],
  },
  {
    id: 'pro',
    name: 'Pro',
    price: 599,
    priceId: process.env.STRIPE_PRO_PRICE_ID || 'price_pro',
    features: ['3 agents', 'All channels', '20,000 tasks/mo', 'Priority support', 'Custom integrations'],
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    price: 1299,
    priceId: process.env.STRIPE_ENTERPRISE_PRICE_ID || 'price_enterprise',
    features: ['Unlimited agents', 'All channels', 'Unlimited tasks', 'Dedicated support', 'SLA', 'Custom setup'],
  },
];

function getStripe(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || key.startsWith('sk_test_your')) return null;
  return new Stripe(key, { apiVersion: '2023-10-16' });
}

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
    | { id: string; email: string; name: string; stripe_customer_id: string | null }
    | undefined;

  if (!client) {
    res.status(404).json({ error: 'Client not found' });
    return;
  }

  const stripe = getStripe();
  if (!stripe) {
    // Demo mode — just update plan in DB
    db.prepare("UPDATE clients SET plan = ? WHERE id = ?").run(planId, clientId);
    res.json({ ok: true, demo: true, plan: planId });
    return;
  }

  try {
    let customerId = client.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: client.email, name: client.name });
      customerId = customer.id;
      db.prepare('UPDATE clients SET stripe_customer_id = ? WHERE id = ?').run(customerId, clientId);
    }

    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: plan.priceId }],
      expand: ['latest_invoice.payment_intent'],
    });

    db.prepare('UPDATE clients SET stripe_subscription_id = ?, plan = ? WHERE id = ?').run(
      subscription.id, planId, clientId
    );

    res.json({ subscriptionId: subscription.id, plan: planId });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Stripe error';
    res.status(500).json({ error: message });
  }
});

router.get('/invoices/:clientId', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const db = getDb();
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.clientId) as
    | { stripe_customer_id: string | null }
    | undefined;

  if (!client) {
    res.status(404).json({ error: 'Client not found' });
    return;
  }

  const stripe = getStripe();
  if (!stripe || !client.stripe_customer_id) {
    res.json([]);
    return;
  }

  try {
    const invoices = await stripe.invoices.list({ customer: client.stripe_customer_id, limit: 10 });
    const formatted = invoices.data.map((inv) => ({
      id: inv.id,
      date: new Date(inv.created * 1000).toLocaleDateString(),
      amount: (inv.amount_paid / 100).toFixed(2),
      status: inv.status,
      url: inv.hosted_invoice_url,
    }));
    res.json(formatted);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Stripe error';
    res.status(500).json({ error: message });
  }
});

router.post('/cancel', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const { clientId } = req.body as { clientId?: string };
  if (!clientId) {
    res.status(400).json({ error: 'clientId required' });
    return;
  }

  const db = getDb();
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId) as
    | { stripe_subscription_id: string | null }
    | undefined;

  if (!client) {
    res.status(404).json({ error: 'Client not found' });
    return;
  }

  const stripe = getStripe();
  if (stripe && client.stripe_subscription_id) {
    await stripe.subscriptions.cancel(client.stripe_subscription_id);
  }

  db.prepare("UPDATE clients SET stripe_subscription_id = NULL, plan = 'starter' WHERE id = ?").run(clientId);
  res.json({ ok: true });
});

router.post('/webhook', async (req: Request, res: Response): Promise<void> => {
  const stripe = getStripe();
  if (!stripe) {
    res.json({ received: true });
    return;
  }

  const sig = req.headers['stripe-signature'] as string;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(req.body as Buffer, sig, webhookSecret);
  } catch {
    res.status(400).json({ error: 'Webhook signature verification failed' });
    return;
  }

  const db = getDb();

  switch (event.type) {
    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      db.prepare("UPDATE clients SET stripe_subscription_id = NULL, plan = 'starter' WHERE stripe_subscription_id = ?")
        .run(sub.id);
      break;
    }
    case 'invoice.payment_succeeded': {
      const invoice = event.data.object as Stripe.Invoice;
      db.prepare('UPDATE clients SET last_active = CURRENT_TIMESTAMP WHERE stripe_customer_id = ?')
        .run(invoice.customer as string);
      break;
    }
  }

  res.json({ received: true });
});

export default router;
