import type { Request, Response, NextFunction } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
export type SessionUser = { id: string; email: string; name: string; avatar: string | null };
export function issueSession(user: SessionUser): string {
  const payload = Buffer.from(JSON.stringify({ ...user, exp: Date.now() + 7 * 86400000 })).toString('base64url');
  const signature = createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}
export function userFromCookie(token?: string): SessionUser | null {
  if (!token) return null;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;
  const expected = createHmac('sha256', config.sessionSecret).update(payload).digest();
  let actual: Buffer;
  try { actual = Buffer.from(signature, 'base64url'); } catch { return null; }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try { const value = JSON.parse(Buffer.from(payload, 'base64url').toString()); return value.exp > Date.now() ? value : null; } catch { return null; }
}
export function requireUser(req: Request, res: Response, next: NextFunction) {
  const user = userFromCookie(req.cookies?.session);
  if (!user) return res.status(401).json({ error: 'Please sign in to continue.' });
  res.locals.user = user;
  next();
}
