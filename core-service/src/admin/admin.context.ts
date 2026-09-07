import type { FastifyRequest } from 'fastify';
import { AppError } from '@iris/shared/types';
import type { ActorRole, ScopeContext } from '../db/with-scope.js';

export interface AdminCaller {
  scope: ScopeContext;
  userId: string;
  role: ActorRole;
  isSuper: boolean;
  /** Product ids this user may work. For a super_admin, every active product. */
  scopes: string[];
}

const ADMIN_ROLES = new Set(['super_admin', 'product_admin', 'manager', 'agent']);

/**
 * Resolves the support user the gateway already authenticated.
 *
 * core-service trusts these headers because it is never publicly bound and the
 * internal key gates direct calls — the same contract as the /v1 surface.
 */
export function resolveAdminCaller(req: FastifyRequest): AdminCaller {
  const h = req.headers;
  const userId = str(h['x-iris-support-user-id']);
  const role = str(h['x-iris-role']) as ActorRole | undefined;
  const scopeHeader = str(h['x-iris-scope']) ?? '';

  if (!userId || !role || !ADMIN_ROLES.has(role)) {
    throw new AppError('unauthenticated', 'No support-user session.');
  }

  const scopes = scopeHeader ? scopeHeader.split(',').filter(Boolean) : [];
  // A non-super user with no tenants can see nothing. Fail closed and say so,
  // rather than returning empty lists that look like "no tickets exist".
  if (role !== 'super_admin' && scopes.length === 0) {
    throw new AppError('forbidden', 'This account is not assigned to any tenant yet.');
  }

  return {
    scope: {
      productScope: scopes,
      role,
      supportUserId: userId,
      requestId: req.id as string,
    },
    userId,
    role,
    isSuper: role === 'super_admin',
    scopes,
  };
}

/** Guard for endpoints only certain roles may reach. */
export function requireRole(caller: AdminCaller, ...allowed: ActorRole[]): void {
  if (!allowed.includes(caller.role)) {
    throw new AppError('forbidden', `This action requires: ${allowed.join(', ')}.`);
  }
}

/** Guard that a caller may act on a specific tenant. */
export function assertTenant(caller: AdminCaller, productId: string): void {
  if (caller.isSuper) return;
  if (!caller.scopes.includes(productId)) {
    // Deliberately the same shape as "not found" — confirming the tenant
    // exists would leak the platform's customer list.
    throw new AppError('ticket_not_found', 'No such tenant is visible to this account.');
  }
}

function str(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}
