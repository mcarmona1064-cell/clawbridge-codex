import 'dotenv/config';
import express from 'express';
import { corsMiddleware } from './middleware/cors.js';
import { initDb } from './db/index.js';
import authRoutes from './routes/auth.js';
import clientRoutes from './routes/clients.js';
import statsRoutes from './routes/stats.js';
import billingRoutes from './routes/billing.js';
import integrationsRoutes from './routes/integrations.js';
import callLogsRoutes from './routes/call-logs.js';

const app = express();
const PORT = parseInt(process.env.PORT || '3010', 10);

// Middlewares
app.use(corsMiddleware);

// JSON body parser for all other routes
app.use(express.json());

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/clients', clientRoutes);
app.use('/api/stats', statsRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/integrations', integrationsRoutes);
app.use('/api/call-logs', callLogsRoutes);

// Health check
app.get('/health', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// Init DB and start
initDb();

app.listen(PORT, () => {
  console.log(`ClawBridge Portal API running on http://localhost:${PORT}`);
});

export default app;
