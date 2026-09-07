import { newId } from '@iris/shared/types';
import type { ScopeContext, Tx } from '../db/with-scope.js';

/**
 * Transactional outbox.
 *
 * ALWAYS called with the same `tx` as the state change. Never enqueue to Redis
 * after COMMIT: if the process or the broker dies in between, the job is lost
 * forever — and a lost access.revoke means access outlives its ticket,
 * silently. That is a two-phase-commit failure, not a crypto failure, and it
 * is how this feature actually breaks in production. (HLD §11.1)
 *
 * A publisher process drains unpublished rows to the queue. It does not exist
 * yet (no worker this round), so rows accumulate harmlessly and are visible
 * for inspection — which is itself the point: nothing is lost.
 */
export async function emitEvent(
  tx: Tx,
  ctx: ScopeContext,
  eventType: string,
  payload: Record<string, unknown>,
  aggregate = 'ticket',
  aggregateId?: string,
): Promise<string> {
  const eventId = newId('evt');
  await tx.query(
    `INSERT INTO event_outbox
       (event_id, product_id, aggregate, aggregate_id, event_type, payload, request_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      eventId,
      ctx.productScope[0] ?? null,
      aggregate,
      aggregateId ?? null,
      eventType,
      JSON.stringify(payload),
      ctx.requestId,
    ],
  );
  return eventId;
}
