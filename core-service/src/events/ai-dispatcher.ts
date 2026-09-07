import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import {
  AI_BACKOFF_TYPE,
  AI_EVENT_FEATURES,
  AI_RETRY_ATTEMPTS,
  newId,
  type AIFeature,
  type AIJob,
} from '@iris/shared/types';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { withSystemScope, type Tx } from '../db/with-scope.js';

/**
 * Outbox -> BullMQ bridge for AI work.
 *
 * WHY IT LIVES IN CORE. Draining the outbox is a database read, and exactly one
 * process in this system holds a database credential. The worker cannot poll
 * event_outbox without breaking Invariant 1, so the bridge sits here and the
 * worker only ever consumes from Redis.
 *
 * WHY IT IS A SEPARATE FILE FROM publisher.ts. That drainer delivers access
 * grant/revoke callbacks and is the highest-care code in the repo; a dead
 * revoke is a security incident. Adding AI branching to it would put the AI
 * pipeline one typo away from the access cycle. The two filter on disjoint
 * event_type sets, so they share the table and the published_at column without
 * ever seeing each other's rows.
 *
 * WHY IT IS NOT A GENERIC EVENT FRAMEWORK. It reads one map, emits one job
 * shape, onto one queue. Everything else is deliberately absent.
 */

const AI_EVENT_TYPES = Object.keys(AI_EVENT_FEATURES);

let queue: Queue<AIJob> | null = null;
let connection: IORedis | null = null;
let timer: NodeJS.Timeout | null = null;
let draining = false;

const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystemScope('ai-dispatcher', fn);

interface AIOutboxRow {
  id: string;
  event_id: string;
  product_id: string;
  aggregate_id: string | null;
  event_type: string;
  request_id: string | null;
  created_at: Date;
}

export function startAIDispatcher(): void {
  if (timer) return;

  // Three independent reasons not to start. Each is logged rather than thrown:
  // AI must never be able to stop core-service from serving tickets.
  if (!config.AI_DISPATCH_ENABLED) {
    logger.info('AI dispatcher disabled (AI_DISPATCH_ENABLED is not "true")');
    return;
  }
  if (!config.REDIS_URL) {
    logger.warn('AI dispatcher enabled but REDIS_URL is unset — not starting');
    return;
  }
  /**
   * FAIL CLOSED on the watermark.
   *
   * event_outbox already contains historical ticket.created rows that predate
   * this pipeline. Without an explicit floor, switching the dispatcher on
   * would enqueue AI work for every old ticket in one burst. Refusing to guess
   * is the safe default; the operator sets the date once.
   */
  if (!config.AI_DISPATCH_FROM) {
    logger.warn(
      'AI dispatcher enabled but AI_DISPATCH_FROM is unset — dispatching nothing. ' +
        'Set it to an ISO timestamp to define which outbox rows are eligible.',
    );
    return;
  }
  const from = new Date(config.AI_DISPATCH_FROM);
  if (Number.isNaN(from.getTime())) {
    logger.error({ value: config.AI_DISPATCH_FROM }, 'AI_DISPATCH_FROM is not a valid date');
    return;
  }

  connection = new IORedis(config.REDIS_URL, {
    // BullMQ requires this; it blocks on BRPOPLPUSH and must not give up.
    maxRetriesPerRequest: null,
  });
  connection.on('error', (err) => logger.warn({ err: err.message }, 'AI dispatcher redis error'));

  queue = new Queue<AIJob>(config.AI_QUEUE_NAME, { connection });

  logger.info(
    { queue: config.AI_QUEUE_NAME, from: from.toISOString(), events: AI_EVENT_TYPES },
    'AI dispatcher started',
  );

  timer = setInterval(() => {
    if (draining) return;
    draining = true;
    drain(from)
      .catch((err) => logger.error({ err }, 'AI dispatch failed'))
      .finally(() => {
        draining = false;
      });
  }, config.AI_DISPATCH_POLL_MS);
  timer.unref();
}

export async function stopAIDispatcher(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = null;
  await queue?.close().catch(() => undefined);
  connection?.disconnect();
  queue = null;
  connection = null;
}

async function drain(from: Date): Promise<void> {
  const q = queue;
  if (!q) return;

  const rows = await sys(async (tx) => {
    const { rows } = await tx.query<AIOutboxRow>(
      `SELECT id, event_id, product_id, aggregate_id, event_type, request_id, created_at
         FROM event_outbox
        WHERE published_at IS NULL
          AND event_type = ANY($1)
          AND aggregate = 'ticket'
          AND product_id IS NOT NULL
          AND aggregate_id IS NOT NULL
          AND created_at >= $2
        ORDER BY created_at ASC
        LIMIT $3`,
      [AI_EVENT_TYPES, from, config.AI_DISPATCH_BATCH],
    );
    return rows;
  });

  for (const row of rows) await dispatch(q, row);
}

async function dispatch(q: Queue<AIJob>, row: AIOutboxRow): Promise<void> {
  const features = (AI_EVENT_FEATURES[row.event_type] ?? []) as readonly AIFeature[];
  if (features.length === 0) return;

  try {
    for (const feature of features) {
      /**
       * job_id is minted FRESH on every dispatch and is deliberately not
       * derived from event_id. BullMQ owns work; the outbox owns the fact.
       * A re-dispatched row therefore carries a new job_id and the SAME
       * event_id — which is exactly why idempotency is anchored on
       * (event_id, feature) in Postgres and not on anything in Redis.
       */
      const job: AIJob = {
        job_id: newId('aij'),
        event_id: row.event_id,
        feature,
        product_id: row.product_id,
        ticket_id: row.aggregate_id!,
        correlation_id: row.request_id ?? row.event_id,
        requested_at: new Date().toISOString(),
        attempt: 1,
      };

      await q.add(feature, job, {
        jobId: job.job_id,
        /**
         * BullMQ is the ONE job-level retry owner.
         *
         * `custom` means "ask the Worker's settings.backoffStrategy", which
         * implements the curve in @iris/shared/types/ai-retry — 1s, 5s, 25s,
         * 120s (+/-20% jitter) across 5 attempts, a ~2.5 minute retry window.
         *
         * This replaces exponential(1000), which produced 1s/2s/4s/8s — a
         * ~15 second window that dead-lettered every in-flight job during a
         * 30-second AI restart, observed twice during the Phase 3 audit. The
         * comment that previously sat here claimed 1s/5s/25s/2m/10m and was
         * simply wrong about what the code did.
         *
         * DEPLOYMENT COUPLING: a worker without settings.backoffStrategy
         * throws "Unknown backoff strategy custom" on the first failure. Loud,
         * not silent — and both halves ship from this repository together.
         */
        attempts: AI_RETRY_ATTEMPTS,
        backoff: { type: AI_BACKOFF_TYPE },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      });
    }

    /**
     * Stamp published_at AFTER the enqueue succeeds, never before.
     *
     * A crash between the two leaves the row unpublished, so the next tick
     * re-dispatches it — a duplicate job, which UNIQUE(event_id, feature)
     * absorbs. The opposite order loses the job permanently and nothing ever
     * notices. This ordering is why no separate reconciliation sweep exists.
     */
    await sys((tx) =>
      tx.query(`UPDATE event_outbox SET published_at = now() WHERE id = $1`, [row.id]),
    );

    logger.info(
      { eventId: row.event_id, features, productId: row.product_id },
      'AI job(s) dispatched',
    );
  } catch (err) {
    // Left unpublished on purpose: the next tick retries it. An AI dispatch
    // failure must never affect the ticket that has already been committed.
    logger.warn(
      { err, eventId: row.event_id },
      'AI dispatch failed — row left unpublished for retry',
    );
  }
}
