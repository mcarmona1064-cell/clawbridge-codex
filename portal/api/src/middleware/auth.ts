import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

export interface AuthRequest extends Request {
  adminId?: string;
  adminEmail?: string;
}

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing authorization header' });
    return;
  }

  const token = header.slice(7);
  const secret = process.env.JWT_SECRET || 'dev-secret-change-me';

  try {
    const payload = jwt.verify(token, secret) as { sub: string; email: string };
    req.adminId = payload.sub;
    req.adminEmail = payload.email;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}
