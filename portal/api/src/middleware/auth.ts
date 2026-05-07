import { Request, Response, NextFunction } from 'express';

export interface AuthRequest extends Request {
  adminId?: string;
  adminEmail?: string;
}

export function requireAuth(_req: AuthRequest, _res: Response, next: NextFunction): void {
  next();
}
