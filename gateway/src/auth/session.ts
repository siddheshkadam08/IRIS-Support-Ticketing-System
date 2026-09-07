import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { AppError } from '@iris/shared/types';
import { config, isDev } from '../config.js';

/**
 * Support-user session verification at the edge.
 *
 * The token is minted by core-service (which owns the user store) and verified
 * here so an invalid session never reaches the internal network. Both sides
 * share SESSION_SECRET — same party signs and verifies, so HMAC is the right
 * primitive; asymmetric keys would buy nothing.
 */
export interface SessionClaims {
  sub: string;
  role: string;
  scopes: string[];
  email: string;
  name: string;
  exp: number;
}

export const SESSION_COOKIE = 'iris_admin_session';
const SESSION_TTL_SECONDS = 8 * 60 * 60;

function sign(payload: string): string {
  return createHmac('sha256', config.SESSION_SECRET).update(payload, 'utf8').digest('base64url');
}

export function verifySession(token: string | undefined): SessionClaims {
  if (!token) throw new AppError('unauthenticated', 'Please sign in.');

  const [payload, signature] = token.split('.');
  if (!payload || !signature) throw new AppError('unauthenticated', 'Malformed session.');

  const expected = Buffer.from(sign(payload), 'utf8');
  const provided = Buffer.from(signature, 'utf8');
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
    throw new AppError('unauthenticated', 'Your session has expired. Please sign in again.');
  }
  return claims;
}

export function readSessionCookie(req: FastifyRequest): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

/**
 * httpOnly so JavaScript cannot read it — an XSS on the admin panel then
 * cannot exfiltrate the session. SameSite=Strict blocks CSRF from other
 * origins. Secure is omitted only on local http.
 */
export function sessionCookie(token: string): string {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ];
  if (!isDev) parts.push('Secure');
  return parts.join('; ');
}

export function clearedSessionCookie(): string {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (!isDev) parts.push('Secure');
  return parts.join('; ');
}
