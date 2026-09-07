import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError } from '@iris/shared/types';
import { config } from '../config.js';

/**
 * Support-user sessions.
 *
 * A compact signed token — same party signs and verifies, so HMAC-SHA256 is
 * the right primitive; asymmetric keys would buy nothing here. Carried in an
 * httpOnly cookie (see gateway), never in localStorage.
 */
export interface SessionClaims {
  sub: string; // support_user id
  role: string;
  /** Product ids. Empty for super_admin, meaning ALL tenants. */
  scopes: string[];
  email: string;
  name: string;
  exp: number; // unix seconds
}

export const SESSION_TTL_SECONDS = 8 * 60 * 60;
export const SESSION_COOKIE = 'iris_admin_session';

const b64 = (buf: Buffer | string): string =>
  Buffer.isBuffer(buf) ? buf.toString('base64url') : Buffer.from(buf, 'utf8').toString('base64url');

function sign(payload: string): string {
  return createHmac('sha256', config.SESSION_SECRET).update(payload, 'utf8').digest('base64url');
}

export function issueSession(claims: Omit<SessionClaims, 'exp'>): string {
  const full: SessionClaims = {
    ...claims,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  };
  const payload = b64(JSON.stringify(full));
  return `${payload}.${sign(payload)}`;
}

export function verifySession(token: string | undefined): SessionClaims {
  if (!token) throw new AppError('unauthenticated', 'No session.');

  const [payload, signature] = token.split('.');
  if (!payload || !signature) throw new AppError('unauthenticated', 'Malformed session.');

  const expected = Buffer.from(sign(payload), 'utf8');
  const provided = Buffer.from(signature, 'utf8');
  // Constant-time — a `===` here is a timing oracle on the signature.
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    throw new AppError('unauthenticated', 'Invalid session.');
  }

  let claims: SessionClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as SessionClaims;
  } catch {
    throw new AppError('unauthenticated', 'Unreadable session.');
  }

  if (!claims.exp || claims.exp < Math.floor(Date.now() / 1000)) {
    throw new AppError('unauthenticated', 'Session expired.');
  }
  return claims;
}
