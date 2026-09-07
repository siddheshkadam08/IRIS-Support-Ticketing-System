import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { AppError, newId } from '@iris/shared/types';
import { withScope, type Tx } from '../db/with-scope.js';
import { writeAudit } from '../audit/index.js';
import { emitEvent } from '../events/outbox.js';
import { logger } from '../logger.js';
import { assertTenant, requireRole, resolveAdminCaller } from './admin.context.js';

/**
 * AI operations — Phase 3 Step 8.
 *
 * Two questions an operator has after Steps 3–7 make the pipeline reliable:
 *
 *   "What happened to this AI execution?"   -> GET  /admin/api/ai/executions
 *   "Can I safely run it again?"            -> POST /admin/api/ai/executions/:id/replay
 *
 * WHY IT LIVES ON /admin/api. That surface already has an authenticated
 * support-user identity, role checks, product scoping and gateway routing.
 * `/internal/*` is service-authenticated and never routed by the gateway, so
 * it is the wrong home for a human-facing operational tool; /v1 belongs to
 * integrating products, who must never reach another tenant's AI history.
 *
 * NO NEW STORAGE. `ai_execution` is the source of truth, `event_outbox` is the
 * replay mechanism, `audit_event` is the record. Nothing here adds a table, a
 * queue, a scheduler or a second dispatch path.
 */

// ─────────────────────────────────────────────────────────────────────────
// Query
// ─────────────────────────────────────────────────────────────────────────

const MAX_PAGE = 100;
const DEFAULT_PAGE = 25;

const ListQuery = z.object({
  status: z.enum(['running', 'succeeded', 'failed']).optional(),
  feature: z.string().max(64).optional(),
  ticket_id: z.string().max(64).optional(),
  event_id: z.string().max(64).optional(),
  error_code: z.string().max(64).optional(),
  created_from: z.string().datetime().optional(),
  created_to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE).default(DEFAULT_PAGE),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

/**
 * The projection is a WHITELIST, not `SELECT *`.
 *
 * `ai_execution` also holds `result` — validated model output — and
 * `error_message`, which is bounded but derived from upstream text. Neither
 * belongs in an operational listing, and a `SELECT *` would have silently
 * started leaking them the day a column was added. Diagnosis needs the
 * identity, the outcome and the machine-readable cause; that is all.
 */
const VIEW_COLUMNS = `id AS execution_id, event_id, feature, job_id, product_id,
                      ticket_id, status, attempt, error_code, created_at, completed_at`;

interface ExecutionView {
  execution_id: string;
  event_id: string;
  feature: string;
  job_id: string | null;
  product_id: string;
  ticket_id: string;
  status: string;
  attempt: number;
  error_code: string | null;
  created_at: Date;
  completed_at: Date | null;
}

const serialise = (r: ExecutionView) => ({
  ...r,
  created_at: r.created_at.toISOString(),
  completed_at: r.completed_at?.toISOString() ?? null,
});

// ─────────────────────────────────────────────────────────────────────────
// Replay
// ─────────────────────────────────────────────────────────────────────────

/**
 * Which executions may be replayed.
 *
 * `failed` only — and that covers `abandoned`, which is a failure with an
 * error_code rather than a separate status.
 *
 *   succeeded  refused. The work is already applied; re-running it is a
 *              duplicate business effect, which is the single thing this whole
 *              phase exists to prevent. An operator who genuinely wants it can
 *              say so through a future explicit flag, not by accident.
 *   running    refused. It may still finish. Replaying would put two live
 *              executions on one ticket and race them.
 */
function assertReplayable(row: { status: string; error_code: string | null }): void {
  if (row.status === 'succeeded') {
    throw new AppError(
      'invalid_request',
      'This execution succeeded. Replaying it would apply the AI result twice.',
    );
  }
  if (row.status === 'running') {
    throw new AppError(
      'invalid_request',
      'This execution is still running. Wait for it to finish or be reaped first.',
    );
  }
}

/**
 * The event type whose dispatch produces this feature.
 *
 * Derived from the ORIGINAL event rather than chosen, so a replay re-enters
 * the pipeline through exactly the path the first execution took.
 */
async function originalEventType(tx: Tx, eventId: string): Promise<string> {
  const { rows } = await tx.query<{ event_type: string; aggregate: string }>(
    `SELECT event_type, aggregate FROM event_outbox WHERE event_id = $1`,
    [eventId],
  );
  const row = rows[0];
  if (!row) {
    // The outbox row is the authoritative fact this execution came from. With
    // it gone there is nothing to replay faithfully, and guessing an event
    // type would fabricate history.
    throw new AppError(
      'invalid_request',
      'The originating event is no longer in the outbox; this execution cannot be replayed.',
    );
  }
  return row.event_type;
}

/**
 * Is a replay of this execution already in flight?
 *
 * IDEMPOTENCY, without new infrastructure. A double-clicked button, a retried
 * fetch or a proxy retry must not produce two replays. Rather than adding a
 * key store, this asks the question directly of the tables that already know:
 * a previous replay is in flight if its outbox row is still unpublished, or if
 * the execution it produced is still `running`.
 *
 * The semantics are the ones an operator actually wants: a second click does
 * nothing, and a deliberate second replay AFTER the first finishes is allowed
 * — which a stored idempotency key would have blocked forever.
 *
 * Callers MUST hold the row lock taken by the SELECT ... FOR UPDATE above.
 * Without it this is a check-then-insert under READ COMMITTED, and two
 * concurrent requests would both see nothing in flight and both create a
 * replay — the exact fan-out this guard exists to prevent.
 */
async function replayInFlight(tx: Tx, executionId: string): Promise<string | null> {
  const { rows } = await tx.query<{ event_id: string }>(
    `SELECT o.event_id
       FROM event_outbox o
       LEFT JOIN ai_execution e ON e.event_id = o.event_id
      WHERE o.payload->>'replay_of' = $1
        AND (o.published_at IS NULL OR e.status = 'running')
      ORDER BY o.created_at DESC
      LIMIT 1`,
    [executionId],
  );
  return rows[0]?.event_id ?? null;
}

// ─────────────────────────────────────────────────────────────────────────

export async function aiOpsRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /admin/api/ai/executions
   *
   * RLS does the isolation: `withScope` sets the caller's product scope and
   * `ai_execution_isolation` adds the predicate. The route never has to
   * remember a `WHERE product_id = ...`, which is exactly the class of
   * omission that leaks a tenant.
   */
  app.get('/admin/api/ai/executions', async (req) => {
    const caller = resolveAdminCaller(req);
    requireRole(caller, 'super_admin', 'product_admin', 'manager');

    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success) {
      throw new AppError('invalid_request', 'Invalid filter parameters.');
    }
    const q = parsed.data;

    return withScope(caller.scope, async (tx) => {
      const params: unknown[] = [];
      const where: string[] = [];
      const add = (clause: string, value: unknown) => {
        params.push(value);
        where.push(clause.replace('?', `$${params.length}`));
      };

      if (q.status) add('status = ?', q.status);
      if (q.feature) add('feature = ?', q.feature);
      if (q.ticket_id) add('ticket_id = ?', q.ticket_id);
      if (q.event_id) add('event_id = ?', q.event_id);
      if (q.error_code) add('error_code = ?', q.error_code);
      if (q.created_from) add('created_at >= ?', new Date(q.created_from));
      if (q.created_to) add('created_at <= ?', new Date(q.created_to));

      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      params.push(q.limit, q.offset);

      const { rows } = await tx.query<ExecutionView>(
        `SELECT ${VIEW_COLUMNS}
           FROM ai_execution
          ${clause}
          -- id is a ULID, so it breaks created_at ties in insertion order and
          -- makes the page boundary stable across requests.
          ORDER BY created_at DESC, id DESC
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );

      const { rows: counted } = await tx.query<{ n: string }>(
        `SELECT count(*) AS n FROM ai_execution ${clause}`,
        params.slice(0, params.length - 2),
      );

      return {
        data: rows.map(serialise),
        page: { limit: q.limit, offset: q.offset, total: Number(counted[0]!.n) },
      };
    });
  });

  /** GET one execution. Same projection, same isolation. */
  app.get<{ Params: { id: string } }>('/admin/api/ai/executions/:id', async (req) => {
    const caller = resolveAdminCaller(req);
    requireRole(caller, 'super_admin', 'product_admin', 'manager');

    return withScope(caller.scope, async (tx) => {
      const { rows } = await tx.query<ExecutionView>(
        `SELECT ${VIEW_COLUMNS} FROM ai_execution WHERE id = $1`,
        [req.params.id],
      );
      // RLS already filtered another tenant's row to zero rows, so this is the
      // same answer for "does not exist" and "not yours" — deliberately.
      if (!rows[0]) throw new AppError('ticket_not_found', 'No such AI execution.');
      return serialise(rows[0]);
    });
  });

  /**
   * POST /admin/api/ai/executions/:id/replay
   *
   * Replay is a NEW execution, never an edit of an old one. The original row
   * is historical record and stays byte-for-byte unchanged; the replay enters
   * through the ordinary outbox -> dispatcher -> BullMQ path, so it is
   * indistinguishable downstream from any other AI execution and inherits
   * every guarantee Steps 3–7 established.
   *
   * The API deliberately does NOT enqueue a BullMQ job. Keeping one dispatch
   * path is what makes the watermark, the retry policy and the idempotency key
   * apply to replays without being re-implemented here.
   */
  app.post<{ Params: { id: string } }>('/admin/api/ai/executions/:id/replay', async (req, reply) => {
    const caller = resolveAdminCaller(req);
    // The strongest existing operational roles. An agent can read a ticket and
    // must NOT be able to re-run AI work on it.
    requireRole(caller, 'super_admin', 'product_admin');

    const body = z
      .object({ reason: z.string().min(1).max(500).optional() })
      .safeParse(req.body ?? {});
    if (!body.success) throw new AppError('invalid_request', 'Invalid replay request.');

    return withScope(caller.scope, async (tx) => {
      /**
       * EVERYTHING authoritative comes from this row.
       *
       * product_id, ticket_id and feature are read here, never taken from the
       * caller. A client-supplied product_id would be a cross-tenant write
       * primitive dressed as a convenience parameter. RLS has already scoped
       * this SELECT, so a foreign execution returns zero rows and never
       * reaches the code below.
       */
      const { rows } = await tx.query<{
        id: string;
        event_id: string;
        feature: string;
        product_id: string;
        ticket_id: string;
        status: string;
        error_code: string | null;
      }>(
        /**
         * FOR UPDATE serialises concurrent replays of the SAME execution.
         *
         * The in-flight check below is a read followed by a write, and under
         * READ COMMITTED two simultaneous requests would both read "nothing in
         * flight" and both insert. Locking the original row first makes the
         * pair atomic without a new table or key store — Postgres arbitrates,
         * which is the platform rule.
         *
         * The wait is bounded by the pool's 3s lock_timeout (Step 6), so a
         * contended replay fails fast instead of piling up.
         */
        `SELECT id, event_id, feature, product_id, ticket_id, status, error_code
           FROM ai_execution WHERE id = $1
           FOR UPDATE`,
        [req.params.id],
      );
      const original = rows[0];
      if (!original) throw new AppError('ticket_not_found', 'No such AI execution.');

      // Belt and braces over RLS: an explicit scope check on the row's own
      // product, so a future change to the policy cannot silently widen this.
      assertTenant(caller, original.product_id);
      assertReplayable(original);

      const inFlight = await replayInFlight(tx, original.id);
      if (inFlight) {
        // Not an error: the operator asked twice and got the same answer.
        return reply.status(200).send({
          replayed: false,
          reason: 'a replay of this execution is already in flight',
          original_execution_id: original.id,
          new_event_id: inFlight,
        });
      }

      const eventType = await originalEventType(tx, original.event_id);

      /**
       * The replay event. A fresh event_id is the whole point: idempotency is
       * anchored on UNIQUE(event_id, feature), so reusing the original id
       * would collide with the historical row and apply nothing.
       */
      const newEventId = await emitEvent(
        tx,
        caller.scope,
        eventType,
        {
          ticket_id: original.ticket_id,
          // Provenance, and the key `replayInFlight` reads back. No ticket
          // text, no model output — this payload is not a copy of the work.
          replay_of: original.id,
          replay_of_event_id: original.event_id,
          // Narrows dispatch to the feature that actually failed. Without it a
          // replay would re-run every feature the event type maps to.
          ai_features: [original.feature],
        },
        'ticket',
        original.ticket_id,
        // The authoritative product, from the execution row. Not from the
        // caller's scope: a super_admin's is empty and a product_admin's may
        // hold several tenants, and either would put the wrong (or no)
        // product on the event.
        original.product_id,
      );

      await writeAudit(tx, caller.scope, {
        action: 'ai.execution_replayed',
        entityType: 'ticket',
        entityId: original.ticket_id,
        productId: original.product_id,
        before: {
          execution_id: original.id,
          event_id: original.event_id,
          status: original.status,
          error_code: original.error_code,
        },
        after: {
          new_event_id: newEventId,
          feature: original.feature,
          ticket_id: original.ticket_id,
          reason: body.data.reason ?? null,
        },
        sourceIp: req.ip,
      });

      logger.info(
        {
          original_execution_id: original.id,
          original_event_id: original.event_id,
          new_event_id: newEventId,
          feature: original.feature,
          product_id: original.product_id,
          actor: caller.userId,
        },
        'AI execution replay requested',
      );

      return reply.status(202).send({
        replayed: true,
        original_execution_id: original.id,
        original_event_id: original.event_id,
        new_event_id: newEventId,
        feature: original.feature,
        ticket_id: original.ticket_id,
      });
    });
  });
}
