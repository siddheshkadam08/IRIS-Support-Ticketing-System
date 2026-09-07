import { newId } from '@iris/shared/types';
import type { ScopeContext, Tx } from '../db/with-scope.js';
import { emitEvent } from '../events/outbox.js';
import { writeAudit } from '../audit/index.js';

/**
 * The dual just-in-time access grant.
 *
 * Support users hold ZERO standing access to ticket payloads. One assignment
 * writes TWO grant rows:
 *
 *   layer='platform'  — enforced by RLS, synchronously, in this transaction.
 *                       No network, no callback, no trust gap: we enforce our
 *                       own data directly.
 *   layer='product'   — relayed to the integrating product, asynchronously.
 *                       We do NOT own their permission model; we signal it.
 *
 * Resolve revokes both. Reopen re-issues both.
 * See docs/HLD.md §13 and docs/adr/008-dual-access-mechanism.md
 */

/** Hard ceiling regardless of what a product configures. */
const MAX_TTL_SECONDS = 72 * 60 * 60;

interface ProductAccessConfig {
  access_mechanism: 'callback' | 'preauth' | 'both';
  access_callback_url: string | null;
  config: { access?: { max_ttl_seconds?: number; scope_kind?: string } };
}

function expiryFor(product: ProductAccessConfig): Date {
  const configured = product.config?.access?.max_ttl_seconds ?? MAX_TTL_SECONDS;
  return new Date(Date.now() + Math.min(configured, MAX_TTL_SECONDS) * 1000);
}

/**
 * Issue both layers. Called inside the SAME transaction as the assignment, so
 * the grant, the audit row and the outbox event commit together or not at all.
 */
export async function issueGrants(
  tx: Tx,
  ctx: ScopeContext,
  args: {
    productId: string;
    ticketId: string;
    ticketReference: string;
    supportUserId: string;
    product: ProductAccessConfig;
  },
): Promise<{ platformGrantId: string; productGrantId: string | null }> {
  // Reopening a ticket must not stack grants on top of stale ones.
  await revokeGrants(tx, ctx, {
    ticketId: args.ticketId,
    reason: 'reassigned',
    silent: true,
  });

  const expiresAt = expiryFor(args.product);

  // ── T1: platform layer. Effective the instant this commits. ───────────
  const platformGrantId = newId('grt');
  await tx.query(
    `INSERT INTO access_grant
       (id, product_id, ticket_id, support_user_id, layer, mechanism, state, expires_at)
     VALUES ($1,$2,$3,$4,'platform','rls','granted',$5)`,
    [platformGrantId, args.productId, args.ticketId, args.supportUserId, expiresAt],
  );

  // ── T2: product layer. Delivered by the outbox drainer. ───────────────
  let productGrantId: string | null = null;
  const mechanism =
    args.product.access_mechanism === 'both' ? 'callback' : args.product.access_mechanism;

  if (mechanism === 'callback' && args.product.access_callback_url) {
    productGrantId = newId('grt');
    await tx.query(
      `INSERT INTO access_grant
         (id, product_id, ticket_id, support_user_id, layer, mechanism, state,
          scope_kind, resource_ref, expires_at)
       VALUES ($1,$2,$3,$4,'product','callback','grant_pending',$5,$6,$7)`,
      [
        productGrantId,
        args.productId,
        args.ticketId,
        args.supportUserId,
        args.product.config?.access?.scope_kind ?? 'ticket',
        // The product chooses the real resource on its side; we pass the
        // ticket reference so it can resolve one. We never invent a scope.
        args.ticketReference,
        expiresAt,
      ],
    );
    await emitEvent(
      tx,
      ctx,
      'access.grant_requested',
      { grant_id: productGrantId, ticket_id: args.ticketId, support_user_id: args.supportUserId },
      'access_grant',
      productGrantId,
    );
  } else if (mechanism === 'preauth') {
    // Bind the product-minted token to this assignee. It arrived inert; all we
    // can do is bind and time-box. We never hold the product's signing key.
    const { rowCount } = await tx.query(
      `UPDATE preauth_token
          SET bound_support_user_id = $2, state = 'active', bound_at = now(),
              expires_at = LEAST($3::timestamptz, now() + (max_ttl_seconds || ' seconds')::interval)
        WHERE ticket_id = $1 AND state = 'inert'`,
      [args.ticketId, args.supportUserId, expiresAt],
    );
    if (rowCount && rowCount > 0) {
      productGrantId = newId('grt');
      await tx.query(
        `INSERT INTO access_grant
           (id, product_id, ticket_id, support_user_id, layer, mechanism, state, expires_at)
         VALUES ($1,$2,$3,$4,'product','preauth_link','granted',$5)`,
        [productGrantId, args.productId, args.ticketId, args.supportUserId, expiresAt],
      );
    }
    // No token minted at raise time means no T2 access. That is correct and
    // silent — the product simply did not offer one for this ticket.
  }

  await writeAudit(tx, ctx, {
    action: 'access.granted',
    entityType: 'ticket',
    entityId: args.ticketId,
    productId: args.productId,
    after: {
      support_user_id: args.supportUserId,
      layers: productGrantId ? ['platform', 'product'] : ['platform'],
      mechanism,
      expires_at: expiresAt.toISOString(),
    },
  });

  return { platformGrantId, productGrantId };
}

/**
 * Revoke every active grant on a ticket.
 *
 * Called on resolve, and again — idempotently — on close. The brief says
 * revoke on close; resolve is tighter because access should not survive the
 * customer-rating window. Doing both costs one no-op. (HLD §3.5)
 */
export async function revokeGrants(
  tx: Tx,
  ctx: ScopeContext,
  args: { ticketId: string; reason: string; silent?: boolean },
): Promise<number> {
  // T1 closes immediately — it is our own data and this transaction is the
  // enforcement point.
  const platform = await tx.query(
    `UPDATE access_grant
        SET state = 'revoked', revoked_at = now()
      WHERE ticket_id = $1 AND layer = 'platform' AND state = 'granted'
      RETURNING id`,
    [args.ticketId],
  );

  // T2 needs the product told. Mark pending and let the drainer deliver.
  const { rows: pending } = await tx.query<{ id: string; mechanism: string }>(
    `UPDATE access_grant
        SET state = CASE WHEN mechanism = 'callback' THEN 'revoke_pending' ELSE 'revoked' END,
            revoked_at = CASE WHEN mechanism = 'callback' THEN revoked_at ELSE now() END,
            revoke_due_at = now()
      WHERE ticket_id = $1 AND layer = 'product'
        AND state IN ('granted','grant_pending','grant_failed')
      RETURNING id, mechanism`,
    [args.ticketId],
  );

  // A revoked pre-auth token fails the product's next validation, and
  // max_ttl caps it regardless — it degrades safely even if nothing is
  // ever delivered.
  await tx.query(
    `UPDATE preauth_token SET state = 'revoked' WHERE ticket_id = $1 AND state = 'active'`,
    [args.ticketId],
  );

  for (const grant of pending) {
    if (grant.mechanism === 'callback') {
      await emitEvent(
        tx,
        ctx,
        'access.revoke_requested',
        { grant_id: grant.id, ticket_id: args.ticketId, reason: args.reason },
        'access_grant',
        grant.id,
      );
    }
  }

  const total = (platform.rowCount ?? 0) + pending.length;
  if (total > 0 && !args.silent) {
    await writeAudit(tx, ctx, {
      action: 'access.revoked',
      entityType: 'ticket',
      entityId: args.ticketId,
      after: { reason: args.reason, grants_revoked: total },
    });
  }
  return total;
}

export interface GrantView {
  id: string;
  layer: 'platform' | 'product';
  mechanism: string;
  state: string;
  support_user_id: string;
  support_user_name: string | null;
  scope_kind: string | null;
  resource_ref: string | null;
  granted_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  product_grant_ref: string | null;
  activation_response: unknown;
  revoke_response: unknown;
  attempt_count: number;
  last_error: string | null;
}

/** Grants for a ticket, for the Ticket Detail timeline. */
export async function grantsForTicket(tx: Tx, ticketId: string): Promise<GrantView[]> {
  const { rows } = await tx.query<
    Omit<GrantView, 'granted_at' | 'expires_at' | 'revoked_at'> & {
      granted_at: Date;
      expires_at: Date | null;
      revoked_at: Date | null;
    }
  >(
    `SELECT g.id, g.layer, g.mechanism, g.state, g.support_user_id,
            u.display_name AS support_user_name,
            g.scope_kind, g.resource_ref, g.granted_at, g.expires_at, g.revoked_at,
            g.product_grant_ref, g.activation_response, g.revoke_response,
            g.attempt_count, g.last_error
       FROM access_grant g
       LEFT JOIN support_user u ON u.id = g.support_user_id
      WHERE g.ticket_id = $1
      ORDER BY g.granted_at ASC, g.layer ASC`,
    [ticketId],
  );
  return rows.map((r) => ({
    ...r,
    granted_at: r.granted_at.toISOString(),
    expires_at: r.expires_at?.toISOString() ?? null,
    revoked_at: r.revoked_at?.toISOString() ?? null,
  }));
}

/** Delivery attempts for a ticket's grants — response bodies and latencies. */
export async function deliveriesForTicket(tx: Tx, ticketId: string) {
  const { rows } = await tx.query<{
    channel: string;
    event_id: string | null;
    target: string | null;
    attempt: number;
    status_code: number | null;
    ok: boolean;
    response_body: string | null;
    error: string | null;
    latency_ms: number | null;
    attempted_at: Date;
  }>(
    `SELECT d.channel, d.event_id, d.target, d.attempt, d.status_code, d.ok,
            d.response_body, d.error, d.latency_ms, d.attempted_at
       FROM delivery_log d
      WHERE d.event_id IN (
        SELECT o.event_id FROM event_outbox o
         WHERE o.aggregate_id IN (SELECT id FROM access_grant WHERE ticket_id = $1)
      )
      ORDER BY d.attempted_at ASC`,
    [ticketId],
  );
  return rows.map((r) => ({ ...r, attempted_at: r.attempted_at.toISOString() }));
}
