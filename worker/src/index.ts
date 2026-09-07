import { Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import { AI_RETRY_ATTEMPTS, aiRetryDelayMs, type AIJob } from '@iris/shared/types';
import { config } from './config.js';
import { logger } from './logger.js';
import { handleAIJob } from './consumers/ai.consumer.js';
import { isPermanent } from './errors.js';
import { reportTerminalFailure } from './terminal-report.js';
import { drainWorker } from './shutdown.js';
import { LOCK_DURATION_MS } from './limits.js';

/**
 * The worker process. One queue, one handler, one retry policy.
 *
 * It has no HTTP port — it is a consumer, not a server — and no database
 * credential. Everything it knows about tickets arrives from
 * core-service/internal/*.
 */

const connection = new IORedis(config.REDIS_URL, {
  // Required by BullMQ: it blocks on the queue and must not give up on a
  // command that is deliberately long-running.
  maxRetriesPerRequest: null,
});

connection.on('error', (err) => logger.warn({ err: err.message }, 'redis error'));
connection.on('ready', () => logger.info({ url: redacted(config.REDIS_URL) }, 'redis connected'));

const worker = new Worker<AIJob>(
  config.AI_QUEUE_NAME,
  async (job: Job<AIJob>) => {
    // attemptsMade is 0 on the first run, so +1 gives a 1-based attempt that
    // matches what ai_execution.attempt records.
    return handleAIJob(job.data, { attempt: job.attemptsMade + 1 });
  },
  {
    connection,
    concurrency: config.AI_WORKER_CONCURRENCY,
    lockDuration: LOCK_DURATION_MS,
    /**
     * The retry curve. BullMQ calls this when a job fails and is eligible for
     * another attempt, passing the 1-based number of the attempt that just
     * failed; the returned value is how long it waits.
     *
     * This is the worker half of the policy — the dispatcher supplies
     * `attempts` and `backoff: { type: 'custom' }`. Both halves import their
     * constants from @iris/shared/types/ai-retry so they cannot drift.
     *
     * It does not retry anything itself: BullMQ remains the sole retry owner,
     * and this only answers "how long?".
     */
    settings: {
      backoffStrategy: (attemptsMade: number) => aiRetryDelayMs(attemptsMade),
    },
  },
);

/**
 * BullMQ does NOT await event listeners (`this.emit('failed', ...)` is a plain
 * EventEmitter call), so a rejected promise here would be an unhandled
 * rejection — which Node aborts the process on by default.
 *
 * The listener is therefore `void`-returning and delegates to a function that
 * is contractually incapable of throwing. `void` on the call makes the
 * floating promise deliberate rather than accidental, and the extra `.catch`
 * is belt-and-braces for a bug inside the reporter itself.
 */
worker.on('failed', (job, err) => {
  // "Which attempt failed, was it worth retrying, and when does the next one
  // run" are the first three debugging questions. Log the classification and
  // the scheduled delay — never the payload, never a signature.
  /**
   * `attemptsMade` means DIFFERENT things in the two places we read it.
   *
   *   processor      : 0 on the first run  -> attempt = attemptsMade + 1
   *   'failed' event : already incremented -> attempt = attemptsMade
   *
   * Verified live: with N executions this handler sees 1..N while the
   * processor sees 0..N-1. Using +1 here logged one attempt too many and
   * declared retries exhausted a step early.
   */
  const attempt = job?.attemptsMade ?? 0;
  const permanent = isPermanent(err);
  const willRetry = !permanent && attempt < (job?.opts?.attempts ?? AI_RETRY_ATTEMPTS);

  logger.error(
    {
      event_id: job?.data?.event_id,
      job_id: job?.id,
      feature: job?.data?.feature,
      request_id: job?.data?.correlation_id,
      attempt,
      classification: permanent ? 'permanent' : 'temporary',
      will_retry: willRetry,
      // Indicative: BullMQ computes the authoritative value with its own
      // jitter draw. Logged so a retry storm is diagnosable from logs alone.
      retry_in_ms: willRetry ? aiRetryDelayMs(attempt) : null,
      err: err.message,
    },
    permanent
      ? 'AI job failed permanently — not retrying'
      : willRetry
        ? 'AI job failed — will retry'
        : 'AI job failed — retries exhausted',
  );

  /**
   * Phase 3 Step 4: close the execution in Core when the job is genuinely
   * dead. Non-final temporary failures fall through — BullMQ will retry them
   * and the row must stay `running`.
   *
   * reportTerminalFailure never throws and never retries; see its contract.
   */
  void reportTerminalFailure(job, err).catch((unexpected: unknown) => {
    // Unreachable by contract. If it ever fires, the reporter has a bug — say
    // so loudly rather than letting the process die on an unhandled rejection.
    logger.error(
      { event_id: job?.data?.event_id, err: String(unexpected) },
      'terminal failure reporter threw — this should be impossible',
    );
  });
});

worker.on('error', (err) => logger.error({ err: err.message }, 'worker error'));

logger.info(
  { queue: config.AI_QUEUE_NAME, concurrency: config.AI_WORKER_CONCURRENCY },
  'worker listening',
);

/** Never print a password that happens to live in a connection string. */
function redacted(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return '[unparseable]';
  }
}

/**
 * Stop taking new jobs, let in-flight ones finish, then close — WITH A HARD
 * DEADLINE.
 *
 * `[CODE]` `worker.close()` calls `whenCurrentJobsFinished(false)`
 * (bullmq worker.js:803) and waits for in-flight jobs indefinitely. A worst-
 * case attempt is ~20s, longer than any sane termination grace period, so an
 * unbounded close means the orchestrator SIGKILLs us mid-write instead.
 *
 * Exiting on our own terms is strictly better, because the unfinished job is
 * already safe: it keeps its lock, the lock expires after LOCK_DURATION_MS,
 * BullMQ's stalled check re-runs it, and `UNIQUE(event_id, feature)` makes the
 * re-run idempotent. This adds NO recovery mechanism — it hands the job back
 * to the one that already exists.
 *
 * The deadline logic lives in shutdown.ts so it can be tested against a real
 * BullMQ worker without importing this module's side effects.
 */
let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return; // a second SIGTERM must not restart the clock
  shuttingDown = true;

  logger.info({ signal, drain_ms: config.AI_WORKER_DRAIN_MS }, 'shutting down');
  const { drained, elapsedMs } = await drainWorker(worker, config.AI_WORKER_DRAIN_MS);

  logger.info(
    { signal, drained, elapsed_ms: elapsedMs },
    drained
      ? 'in-flight jobs finished — clean shutdown'
      : 'drain deadline reached — exiting; BullMQ stall recovery owns the unfinished job',
  );

  connection.disconnect();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
