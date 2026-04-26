import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { getDb } from '../db/index.js';
import { requireAuth, AuthRequest } from '../middleware/auth.js';

const router = Router();

router.post('/login', (req: Request, res: Response): void => {
  const { email, password } = req.body as { email?: string; password?: string };
  if (!email || !password) {
    res.status(400).json({ error: 'Email and password required' });
    return;
  }

  const db = getDb();
  const admin = db.prepare('SELECT * FROM admins WHERE email = ?').get(email) as
    | { id: string; email: string; password_hash: string }
    | undefined;

  if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  const secret = process.env.JWT_SECRET || 'dev-secret-change-me';
  const token = jwt.sign({ sub: admin.id, email: admin.email }, secret, { expiresIn: '7d' });

  res.json({ token, email: admin.email });
});

router.post('/logout', (_req: Request, res: Response): void => {
  // JWT is stateless — client should discard the token
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req: AuthRequest, res: Response): void => {
  res.json({ id: req.adminId, email: req.adminEmail });
});

export default router;
