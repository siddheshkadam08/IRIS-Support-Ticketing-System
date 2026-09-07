import type { ScopeContext, Tx } from '../db/with-scope.js';

export interface AuditInput {
  action: string;
  entityType: string;
  entityId?: string | null;
  productId?: string | null;
  before?: unknown;
  after?: unknown;
  sourceIp?: string | null;
}

/**
 * Append-only audit writer.
 *
 * Always called with the SAME `tx` as the state change it describes, so the
 * change and its audit row commit together or not at all. There is no update
 * or delete function here, and iris_app has those privileges revoked at the
 * database — the application cannot rewrite history even if compromised.
 */
export async function writeAudit(tx: Tx, ctx: ScopeContext, input: AuditInput): Promise<void> {
  const actorType =
    ctx.role === 'raiser'
      ? 'raiser'
      : ctx.role === 'product'
        ? 'product'
        : ctx.role === 'none'
          ? 'system'
          : 'support_user';

  const actorRef = ctx.raiserRef ?? ctx.supportUserId ?? null;

  await tx.query(
    `INSERT INTO audit_event
       (product_id, actor_type, actor_ref, action, entity_type, entity_id,
        before, after, request_id, source_ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      input.productId ?? ctx.productScope[0] ?? null,
      actorType,
      actorRef,
      input.action,
      input.entityType,
      input.entityId ?? null,
      input.before === undefined ? null : JSON.stringify(input.before),
      input.after === undefined ? null : JSON.stringify(input.after),
      ctx.requestId,
      input.sourceIp ?? null,
    ],
  );
}
