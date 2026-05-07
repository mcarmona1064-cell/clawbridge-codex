import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

const INTEGRATION_SERVER = process.env.INTEGRATION_SERVER_URL || 'http://localhost:3003';
const INTEGRATION_KEY = process.env.INTEGRATION_SECRET_KEY || '';

router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const clientId = req.query.clientId as string | undefined;

  if (!INTEGRATION_KEY) {
    // Return mock integrations when integration server is not configured
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
      ? `${INTEGRATION_SERVER}/connection?connection_id=${clientId}`
      : `${INTEGRATION_SERVER}/connection`;

    const integrationRes = await fetch(url, {
      headers: { Authorization: `Bearer ${INTEGRATION_KEY}` },
    });

    if (!integrationRes.ok) {
      res.status(integrationRes.status).json({ error: 'Integration error' });
      return;
    }

    const data = await integrationRes.json();
    res.json(data);
  } catch {
    res.status(502).json({ error: 'Could not reach integration server' });
  }
});

export default router;
