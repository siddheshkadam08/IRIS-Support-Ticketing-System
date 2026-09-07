import type { PoolClient } from 'pg';
import { pool } from './pool.js';

export type ActorRole =
  | 'product'
  | 'raiser'
  | 'agent'
  | 'manager'
  | 'product_admin'
  | 'super_admin'
  | 'none';

export interface ScopeContext {
  /** Product ids this actor may see. Empty means "nothing" — RLS fails closed. */
  productScope: string[];
  role: ActorRole;
  /** The end user's opaque `sub`, when role === 'raiser'. */
  raiserRef?: string | null;
  supportUserId?: string | null;
  requestId: string;
}

export type Tx = PoolClient;

/**
 * The ONLY way to reach Postgres.
 *
 * Opens a transaction, sets the RLS session variables, runs the callback,
 * commits. Two things here are load-bearing:
 *
 *  1. set_config(..., true) is SET LOCAL — scoped to this transaction. Plain
 *     SET persists for the life of the pooled connection, so request A's
 *     product scope would leak into request B. That is a cross-tenant read
 *     with no code defect visible anywhere.
 *
 *  2. Every statement inside runs with the GUCs set, so the RLS policies in
 *     infra/migrations/005_rls.sql apply. If a query forgets a product_id
 *     predicate the result is zero rows, never another product's rows.
 */
export async function withScope<T>(ctx: ScopeContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.product_scope',   $1, true),
              set_config('app.role',            $2, true),
              set_config('app.raiser_ref',      $3, true),
              set_config('app.support_user_id', $4, true),
              set_config('app.request_id',      $5, true)`,
      [
        ctx.productScope.join(','),
        ctx.role,
        ctx.raiserRef ?? '',
        ctx.supportUserId ?? '',
        ctx.requestId,
      ],
    );
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connection already broken; the pool will discard it */
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Read-only convenience wrapper. Same guarantees. */
export function withReadScope<T>(ctx: ScopeContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withScope(ctx, fn);
}

/**
 * Bootstrap lookups that legitimately run BEFORE a scope exists.
 *
 * Resolving *which* product is calling is what establishes the scope, so that
 * query cannot itself be scoped — it would be circular. RLS correctly denies
 * an unscoped read, so these lookups run with an explicit elevated role.
 *
 * Strictly limited to credential resolution by unique key, which can only ever
 * match one product and therefore cannot widen anyone's visibility. Never use
 * this to read ticket data — that is what withScope() is for.
 */
export async function withSystemScope<T>(requestId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withScope(
    { productScope: [], role: 'super_admin', requestId },
    fn,
  );
}

/** Scope for a product-authenticated (server credential) call. */
export function productScope(productId: string, requestId: string): ScopeContext {
  return { productScope: [productId], role: 'product', requestId };
}

/** Scope for a widget call carrying an end-user identity. */
export function raiserScope(
  productId: string,
  raiserRef: string,
  requestId: string,
): ScopeContext {
  return { productScope: [productId], role: 'raiser', raiserRef, requestId };
}
