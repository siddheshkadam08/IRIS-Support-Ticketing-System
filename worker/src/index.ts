import { Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import { AI_RETRY_ATTEMPTS, aiRetryDelayMs, type AIJob } from '@iris/shared/types';
import { config } from './config.js';
import { logger } from './logger.js';
import { handleAIJob } from './consumers/ai.consumer.js';
import { isPermanent } from './errors.js';

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
   * Verified live: with 5 executions this handler saw 1,2,3,4,5 while
   * ai_execution recorded 1..5 from the processor. Using +1 here logged
   * "attempt 6" and declared retries exhausted one step early.
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
 * Stop taking new jobs, let in-flight ones finish, then close. A killed worker
 * must leave every job re-runnable, which the idempotency design already
 * guarantees — this just avoids creating unnecessary retries.
 */
const shutdown = async (signal: string) => {
  logger.info({ signal }, 'shutting down');
  await worker.close();
  connection.disconnect();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
