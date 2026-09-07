import { Queue, type JobState } from 'bullmq';
import IORedis from 'ioredis';
import type { AIJob } from '@iris/shared/types';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { withScope, withSystemScope, type ScopeContext, type Tx } from '../db/with-scope.js';
import { writeAudit } from '../audit/index.js';
import {
  findStaleRunningExecutions,
  reapExecution,
  type StaleExecution,
} from '../internal/ai.repo.js';

/**
 * Abandoned-execution reaper — Phase 3 Step 5.
 *
 * WHAT IT IS. A reconciliation mechanism for the case where BullMQ state and
 * database state have diverged: the job can no longer produce a result, but
 * `ai_execution` still says `running`. Step 4 closes this whenever the worker
 * is alive to report it; the reaper closes the rest — worker crashed
 * mid-report, Core was down when the report was attempted, the job stalled out
 * (stall failures never emit a `failed` event), or Redis evicted the job.
 *
 * WHAT IT IS NOT. It is not a retry mechanism and never re-enqueues anything.
 * BullMQ remains the sole retry owner. The reaper only moves a dead execution
 * out of `running` so the row stops lying about what is happening.
 *
 * WHY IT OWNS ITS OWN QUEUE. The dispatcher's Queue is module-private and is
 * only constructed when AI_DISPATCH_ENABLED is true — so a reaper borrowing it
 * would silently do nothing in exactly the configuration where orphans still
 * accumulate. One extra Redis connection buys an independent lifecycle and no
 * coupling to a dispatch feature flag.
 */

/** Fixed, not configurable: none of these need operational tuning. */
const INTERVAL_MS = 60_000;
const BATCH = 50;

/**
 * How long one BullMQ state lookup may take before Redis is declared down.
 *
 * NOT belt-and-braces. `Queue.getJobState` awaits BullMQ's `waitUntilReady()`,
 * and that promise does not settle while Redis is unreachable — it does not
 * reject, it simply never resolves, whatever ioredis is configured with
 * (verified live against a dead port with both `maxRetriesPerRequest: null`
 * and `enableOfflineQueue: false`). Without this bound the cycle would hang
 * forever on its first candidate instead of taking the retain-on-outage path,
 * so that safety rule would exist only in tests.
 *
 * 5s is orders of magnitude above a healthy lookup (single-digit ms) and well
 * inside the 60s interval.
 */
export const LOOKUP_TIMEOUT_MS = 5_000;

/** Raised when BullMQ could not be consulted — never "the job is gone". */
class RedisUnavailableError extends Error {}

/**
 * `getJobState`, bounded.
 *
 * The losing promise is left with a no-op handler rather than abandoned: if it
 * settles later with a rejection, an unattached rejection would take the
 * process down.
 */
async function lookupJobState(q: Queue<AIJob>, jobId: string): Promise<JobStateOrUnknown> {
  let timer: NodeJS.Timeout | undefined;
  const lookup = q.getJobState(jobId);
  lookup.catch(() => undefined);
  try {
    return await Promise.race([
      lookup,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new RedisUnavailableError(`job state lookup exceeded ${LOOKUP_TIMEOUT_MS}ms`)),
          LOOKUP_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** `getJobState` returns a JobState, or 'unknown' when the job is not found. */
type JobStateOrUnknown = JobState | 'unknown';

/** What the reaper decided about one candidate, and why. */
export type ReapDecision =
  | { action: 'reap'; jobState: JobStateOrUnknown }
  | { action: 'retain'; reason: 'live_job'; jobState: JobStateOrUnknown }
  | { action: 'retain'; reason: 'redis_unreachable' };

/**
 * The decision matrix, as an exhaustive switch.
 *
 * Exhaustive on purpose: the `never` assignment below means a BullMQ upgrade
 * that adds a JobState fails the BUILD rather than silently falling into the
 * reap branch. Defaulting an unrecognised state to "reap" is precisely how a
 * reconciliation job destroys live work.
 */
export function decideForJobState(jobState: JobStateOrUnknown): ReapDecision {
  switch (jobState) {
    // The job may still legitimately run. Never reap.
    case 'active': // a worker holds it right now
    case 'waiting': // queued
    case 'delayed': // scheduled — the 600s retry tail lives here for 10 minutes
    case 'waiting-children': // flow dependency; unused today, protected anyway
    case 'prioritized': // prioritised wait; unused today, protected anyway
      return { action: 'retain', reason: 'live_job', jobState };

    // The job is over, or gone. Combined with the stale threshold, reapable.
    case 'failed': // dead-lettered; BullMQ will never run it again
    case 'completed': // job finished but Core never recorded a result
    case 'unknown': // evicted by retention, lost to a Redis flush, or never enqueued
      return { action: 'reap', jobState };

    default: {
      // If this stops compiling, BullMQ added a state. Decide it deliberately.
      const exhaustive: never = jobState;
      return { action: 'retain', reason: 'live_job', jobState: exhaustive };
    }
  }
}

/** A row with no job id can never be resolved by a worker, so it is reapable. */
export function decideForCandidate(
  row: Pick<StaleExecution, 'job_id'>,
  jobState: JobStateOrUnknown | null,
): ReapDecision {
  if (row.job_id === null) return { action: 'reap', jobState: 'unknown' };
  if (jobState === null) return { action: 'retain', reason: 'redis_unreachable' };
  return decideForJobState(jobState);
}

/** Safe, deterministic, and derived from the configured threshold. */
export function abandonedMessage(staleMinutes: number, jobState: JobStateOrUnknown): string {
  return `AI execution abandoned after ${staleMinutes} minutes; BullMQ job state: ${jobState}`;
}

// ─────────────────────────────────────────────────────────────────────────
// Lifecycle
// ─────────────────────────────────────────────────────────────────────────

let queue: Queue<AIJob> | null = null;
let connection: IORedis | null = null;
let timer: NodeJS.Timeout | null = null;
let isRunning = false;

const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystemScope('ai-reaper', fn);

export function startAIReaper(): void {
  if (timer) return;

  // Both refusals are logged rather than thrown: reconciliation must never be
  // able to stop core-service from serving tickets.
  if (!config.AI_REAPER_ENABLED) {
    logger.info('AI reaper disabled (AI_REAPER_ENABLED is not "true")');
    return;
  }
  if (!config.REDIS_URL) {
    // Without Redis the reaper cannot distinguish an abandoned job from a live
    // one, and reaping blind is worse than not reaping at all.
    logger.warn('AI reaper enabled but REDIS_URL is unset — not starting');
    return;
  }

  connection = new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null });
  connection.on('error', (err) => logger.warn({ err: err.message }, 'AI reaper redis error'));
  queue = new Queue<AIJob>(config.AI_QUEUE_NAME, { connection });

  logger.info(
    {
      queue: config.AI_QUEUE_NAME,
      stale_minutes: config.AI_REAPER_STALE_MINUTES,
      interval_ms: INTERVAL_MS,
      batch: BATCH,
    },
    'AI reaper started',
  );

  /**
   * No immediate cycle. The first runs one interval in, so a restart storm
   * cannot produce a reaping burst before the system has settled.
   */
  timer = setInterval(() => {
    if (isRunning) return; // overlap guard; the conditional UPDATE is the real arbitration
    isRunning = true;
    runReaperCycle()
      .catch((err) => logger.error({ err: err instanceof Error ? err.message : String(err) }, 'AI reaper cycle failed'))
      .finally(() => {
        isRunning = false;
      });
  }, INTERVAL_MS);
  timer.unref();
}

export async function stopAIReaper(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = null;
  isRunning = false;
  await queue?.close().catch(() => undefined);
  connection?.disconnect();
  queue = null;
  connection = null;
}

// ─────────────────────────────────────────────────────────────────────────
// One cycle
// ─────────────────────────────────────────────────────────────────────────

export interface CycleStats {
  candidates: number;
  reaped: number;
  retained: number;
  skipped_redis: number;
  races: number;
}

/**
 * Three phases, deliberately separated.
 *
 *   1. candidate SELECT   short, read-only, cross-tenant
 *   2. BullMQ state check OUTSIDE any transaction
 *   3. one short write    per reapable row, scoped to that row's tenant
 *
 * Phase 2 must not run inside a transaction: holding row locks across Redis
 * latency would couple database availability to Redis responsiveness, which is
 * the opposite of what a recovery mechanism should do.
 *
 * Exported for tests. Both the queue and the threshold are injectable so a
 * cycle can be driven deterministically, without the timer and without
 * depending on process configuration.
 */
export async function runReaperCycle(
  q: Queue<AIJob> | null = queue,
  staleMinutes: number = config.AI_REAPER_STALE_MINUTES,
): Promise<CycleStats> {
  const started = Date.now();
  const stats: CycleStats = { candidates: 0, reaped: 0, retained: 0, skipped_redis: 0, races: 0 };
  if (!q) return stats;

  // ── Phase 1 ────────────────────────────────────────────────────────────
  const candidates = await sys((tx) => findStaleRunningExecutions(tx, staleMinutes, BATCH));
  stats.candidates = candidates.length;
  if (candidates.length === 0) return stats; // a quiet cycle logs nothing

  /**
   * Redis is up or it is down; it is not down for one job and up for the next.
   * Once a lookup fails, the rest of the batch is skipped immediately instead
   * of waiting out LOOKUP_TIMEOUT_MS fifty times over.
   */
  let redisDown = false;

  for (const row of candidates) {
    // ── Phase 2: ask BullMQ, outside any transaction ─────────────────────
    let jobState: JobStateOrUnknown | null = null;
    if (row.job_id !== null) {
      if (redisDown) {
        stats.skipped_redis++;
        continue;
      }
      try {
        jobState = await lookupJobState(q, row.job_id);
      } catch (err) {
        /**
         * MANDATORY: a failed lookup is NOT evidence that the job is gone.
         * Reading it that way during an outage would mass-abandon live work —
         * converting a recoverable blip into permanent data loss.
         */
        jobState = null;
        redisDown = true;
        logger.error(
          {
            execution_id: row.id,
            job_id: row.job_id,
            remaining: candidates.length - candidates.indexOf(row) - 1,
            reason: err instanceof Error ? err.message : String(err),
          },
          'AI reaper skipping this cycle — BullMQ unreachable, retaining every candidate',
        );
      }
    }

    const decision = decideForCandidate(row, jobState);

    if (decision.action === 'retain') {
      if (decision.reason === 'redis_unreachable') stats.skipped_redis++;
      else {
        stats.retained++;
        logger.debug(
          { execution_id: row.id, job_id: row.job_id, job_state: decision.jobState },
          'AI reaper retained live job',
        );
      }
      continue;
    }

    // ── Phase 3: one short transaction, scoped to THIS row's tenant ──────
    const reaped = await reapOne(row, decision.jobState, staleMinutes);
    if (reaped) stats.reaped++;
    else stats.races++;
  }

  logger.info(
    { ...stats, stale_minutes: staleMinutes, duration_ms: Date.now() - started },
    'AI reaper cycle completed',
  );
  return stats;
}

/**
 * Close one execution.
 *
 * Tenant scope comes from the DATABASE ROW, never from the BullMQ payload —
 * the reaper only ever sends BullMQ a job id and receives a state string back.
 * RLS then confines the UPDATE and the audit row to that product.
 */
async function reapOne(
  row: StaleExecution,
  jobState: JobStateOrUnknown,
  staleMinutes: number,
): Promise<boolean> {
  const scope: ScopeContext = {
    productScope: [row.product_id],
    // role 'none' maps to actor_type 'system' in writeAudit — the honest
    // description of a background reconciliation actor. Identical to the scope
    // ai.service.ts builds for a worker-reported result, so the reaped row is
    // isolated and attributed exactly like every other AI write.
    role: 'none',
    // The originating request id, so the abandoned row joins the same trace as
    // the ticket that produced it. Falls back to something searchable.
    requestId: row.correlation_id ?? `ai-reaper:${row.id}`,
  };

  return withScope(scope, async (tx) => {
    const updated = await reapExecution(tx, {
      id: row.id,
      expectedJobId: row.job_id,
      errorMessage: abandonedMessage(staleMinutes, jobState),
    });

    if (!updated) {
      // A result, a Step 4 terminal report, another reaper, or a re-claim with
      // a new job_id won. Expected — the conditional UPDATE is the arbitration.
      logger.info(
        { execution_id: row.id, job_id: row.job_id, job_state: jobState },
        'AI reaper lost the race — execution already resolved or re-claimed',
      );
      return false;
    }

    // Same transaction as the UPDATE: an execution can never become terminal
    // without its audit row. Same action as any other AI failure, so the ticket
    // history reads identically; error_code and `reaped` say what happened.
    await writeAudit(tx, scope, {
      action: 'ai.execution_failed',
      entityType: 'ticket',
      entityId: row.ticket_id,
      productId: row.product_id,
      // Same shape ai.service.ts writes for a reported failure, so
      // GET /v1/tickets/:id/history renders it with no endpoint change. The
      // three extra keys are what distinguishes a reaped row from a reported
      // one. No ticket text, no PII.
      after: {
        execution_id: updated.id,
        feature: updated.feature,
        status: 'failed',
        attempt: updated.attempt,
        error_code: 'abandoned',
        ticket_updated: false,
        job_id: updated.job_id,
        job_state: jobState,
        reaped: true,
      },
    });

    logger.warn(
      {
        execution_id: updated.id,
        event_id: row.event_id,
        feature: row.feature,
        job_id: row.job_id,
        job_state: jobState,
        product_id: row.product_id,
        ticket_id: row.ticket_id,
        attempt: updated.attempt,
        age_minutes: Math.round((Date.now() - row.created_at.getTime()) / 60_000),
        stale_minutes: staleMinutes,
      },
      'AI execution abandoned',
    );
    return true;
  });
}
