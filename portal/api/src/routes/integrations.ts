import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

const NANGO_SERVER = process.env.NANGO_SERVER_URL || 'http://localhost:3003';
const NANGO_KEY = process.env.NANGO_SECRET_KEY || '';

router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const clientId = req.query.clientId as string | undefined;

  if (!NANGO_KEY) {
    // Return mock integrations when Nango is not configured
    res.json([
      { name: 'WhatsApp', provider: 'whatsapp', status: 'connected', lastSync: '2 min ago' },
      { name: 'Slack', provider: 'slack', status: 'disconnected' },
      { name: 'Telegram', provider: 'telegram', status: 'disconnected' },
      { name: 'Google Calendar', provider: 'google-calendar', status: 'disconnected' },
    ]);
    return;
  }

  try {
    const url = clientId
      ? `${NANGO_SERVER}/connection?connection_id=${clientId}`
      : `${NANGO_SERVER}/connection`;

    const nangoRes = await fetch(url, {
      headers: { Authorization: `Bearer ${NANGO_KEY}` },
    });

    if (!nangoRes.ok) {
      res.status(nangoRes.status).json({ error: 'Nango error' });
      return;
    }

    const data = await nangoRes.json();
    res.json(data);
  } catch {
    res.status(502).json({ error: 'Could not reach Nango server' });
  }
});

export default router;
