import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, hashPassword, verifyPassword } from '@iris/shared/types';
import { logger } from '../logger.js';
import { withSystemScope } from '../db/with-scope.js';
import { writeAudit } from '../audit/index.js';
import {
  allProductIds,
  findByEmailForAuth,
  findByIdForSession,
  recordLoginFailure,
  recordLoginSuccess,
  setPassword,
} from '../users/user.repo.js';
import { issueSession, SESSION_TTL_SECONDS } from './session.js';

const LoginBody = z.object({
  email: z.string().min(3).max(200),
  password: z.string().min(1).max(200),
});

const ChangePasswordBody = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(8).max(200),
});

/**
 * Effective tenant scope. A super_admin holds no scope rows — that absence
 * means "all tenants", resolved here rather than stored as a wildcard row, so
 * there is no magic value to leak or mistype.
 */
export async function effectiveScopes(role: string, scopes: string[]): Promise<string[]> {
  return role === 'super_admin' ? allProductIds() : scopes;
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // ── POST /admin/auth/login ─────────────────────────────────────────────
  app.post('/admin/api/auth/login', async (req, reply) => {
    const body = LoginBody.parse(req.body);
    // Uniform failure for every reason — a distinct "no such user" reply is a
    // user-enumeration oracle.
    const invalid = () => new AppError('unauthenticated', 'Email or password is incorrect.');

    const user = await findByEmailForAuth(body.email);
    if (!user || !user.is_active) {
      logger.warn({ email: body.email, ip: req.ip }, 'login failed: unknown or inactive user');
      throw invalid();
    }

    if (user.locked_until && user.locked_until.getTime() > Date.now()) {
      throw new AppError(
        'forbidden',
        'This account is temporarily locked after repeated failed sign-ins. Try again in a few minutes.',
      );
    }

    if (!verifyPassword(body.password, user.password_hash)) {
      await recordLoginFailure(user.id);
      logger.warn({ userId: user.id, ip: req.ip }, 'login failed: bad password');
      throw invalid();
    }

    await recordLoginSuccess(user.id);
    const scopes = await effectiveScopes(user.role, user.scopes);

    const token = issueSession({
      sub: user.id,
      role: user.role,
      scopes,
      email: user.email,
      name: user.display_name,
    });

    await withSystemScope(req.id as string, (tx) =>
      writeAudit(
        tx,
        { productScope: [], role: 'super_admin', supportUserId: user.id, requestId: req.id as string },
        {
          action: 'auth.login',
          entityType: 'support_user',
          entityId: user.id,
          after: { role: user.role, scopes },
          sourceIp: req.ip,
        },
      ),
    );

    logger.info({ userId: user.id, role: user.role, scopes }, 'support user signed in');

    return reply.send({
      token,
      expires_in: SESSION_TTL_SECONDS,
      user: {
        id: user.id,
        email: user.email,
        display_name: user.display_name,
        role: user.role,
        scopes,
        must_change_password: user.must_change_password,
      },
    });
  });

  // ── GET /admin/auth/me ─────────────────────────────────────────────────
  app.get('/admin/api/auth/me', async (req) => {
    const userId = req.headers['x-iris-support-user-id'] as string | undefined;
    if (!userId) throw new AppError('unauthenticated', 'No session.');

    const user = await findByIdForSession(userId);
    if (!user) throw new AppError('unauthenticated', 'Session user no longer exists.');

    const scopes = await effectiveScopes(user.role, user.scopes);
    const tenants = await withSystemScope(req.id as string, async (tx) => {
      const { rows } = await tx.query<{ id: string; name: string; slug: string; config: unknown }>(
        `SELECT id, name, slug, config FROM product
          WHERE is_active = true AND id = ANY($1::text[]) ORDER BY name`,
        [scopes],
      );
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        slug: r.slug,
        primary_color:
          (r.config as { widget?: { primary_color?: string } })?.widget?.primary_color ?? '#1D4ED8',
      }));
    });

    return {
      id: user.id,
      email: user.email,
      display_name: user.display_name,
      role: user.role,
      availability: user.availability,
      scopes,
      tenants,
      must_change_password: user.must_change_password,
      last_login_at: user.last_login_at?.toISOString() ?? null,
    };
  });

  // ── POST /admin/auth/change-password ───────────────────────────────────
  app.post('/admin/api/auth/change-password', async (req) => {
    const userId = req.headers['x-iris-support-user-id'] as string | undefined;
    if (!userId) throw new AppError('unauthenticated', 'No session.');

    const body = ChangePasswordBody.parse(req.body);
    const user = await findByIdForSession(userId);
    if (!user) throw new AppError('unauthenticated', 'Session user no longer exists.');

    if (!verifyPassword(body.current_password, user.password_hash)) {
      throw new AppError('forbidden', 'Current password is incorrect.');
    }
    if (body.new_password === body.current_password) {
      throw new AppError('invalid_request', 'The new password must be different.');
    }

    await setPassword(user.id, hashPassword(body.new_password));
    await withSystemScope(req.id as string, (tx) =>
      writeAudit(
        tx,
        { productScope: [], role: 'super_admin', supportUserId: user.id, requestId: req.id as string },
        { action: 'auth.password_changed', entityType: 'support_user', entityId: user.id, sourceIp: req.ip },
      ),
    );

    return { ok: true };
  });

  // ── POST /admin/auth/logout ────────────────────────────────────────────
  // Sessions are stateless; the gateway clears the cookie. Logged for audit.
  app.post('/admin/api/auth/logout', async (req) => {
    const userId = req.headers['x-iris-support-user-id'] as string | undefined;
    if (userId) {
      await withSystemScope(req.id as string, (tx) =>
        writeAudit(
          tx,
          { productScope: [], role: 'super_admin', supportUserId: userId, requestId: req.id as string },
          { action: 'auth.logout', entityType: 'support_user', entityId: userId, sourceIp: req.ip },
        ),
      );
    }
    return { ok: true };
  });
}
