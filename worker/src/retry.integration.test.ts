import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Queue, UnrecoverableError, Worker } from 'bullmq';
import IORedis from 'ioredis';
import {
  AI_BACKOFF_TYPE,
  AI_RETRY_ATTEMPTS,
  AI_RETRY_DELAYS_SECONDS,
  aiRetryDelayMs,
} from '@iris/shared/types';
import { config } from './config.js';
import { PermanentJobError, TemporaryJobError } from './errors.js';

/**
 * Retry behaviour against REAL BullMQ and REAL Redis.
 *
 * What this proves that a unit test cannot: that BullMQ's attempt arithmetic
 * matches our reading of it, that `backoff: { type: 'custom' }` actually
 * resolves to the worker's registered strategy, and that PermanentJobError is
 * genuinely terminal to BullMQ rather than merely named that way.
 *
 * TIMING IS SCALED. The production curve is 1s/5s/25s/120s — 151 seconds of
 * waiting, which is not a test. These suites register the SAME aiRetryDelayMs
 * function, divided down: /1000 where only the attempt COUNT matters, and /10
 * in the curve test, where the gaps must clear BullMQ's delayed-job scheduling
 * granularity to be observable at all. The SHAPE and RATIOS are the production
 * ones; the wall-clock is not. Absolute values are asserted by
 * shared/types/ai-retry.test.ts instead.
 *
 * Requires the compose stack (npm run infra:up).
 */

const connection = new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null });
const queues: Queue[] = [];
const workers: Worker[] = [];

/** A disposable queue per test so runs cannot interfere with each other. */
function makeQueue(suffix: string): Queue {
  const q = new Queue(`test.retry.${suffix}.${Date.now()}`, { connection });
  queues.push(q);
  return q;
}

function makeWorker(
  name: string,
  processor: (job: { attemptsMade: number }) => Promise<unknown>,
  opts: { backoffStrategy?: (a: number) => number } = {},
): Worker {
  const w = new Worker(name, processor as never, {
    connection,
    concurrency: 1,
    ...(opts.backoffStrategy ? { settings: { backoffStrategy: opts.backoffStrategy } } : {}),
  });
  workers.push(w);
  return w;
}

/** The production curve at 1/1000 scale — same shape, millisecond wall-clock. */
const scaledStrategy = (attemptsMade: number) => Math.max(1, Math.round(aiRetryDelayMs(attemptsMade) / 1000));

const waitFor = async (fn: () => boolean, timeoutMs = 15_000) => {
  const until = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > until) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
  return true;
};

beforeAll(async () => {
  await connection.ping();
});

afterAll(async () => {
  for (const w of workers) await w.close().catch(() => undefined);
  for (const q of queues) {
    await q.obliterate({ force: true }).catch(() => undefined);
    await q.close().catch(() => undefined);
  }
  connection.disconnect();
});

// ─────────────────────────────────────────────────────────────────────────

describe('a temporary failure is retried', () => {
  it(`runs exactly ${AI_RETRY_ATTEMPTS} times, then stops`, async () => {
    const q = makeQueue('temporary');
    const attempts: number[] = [];

    makeWorker(
      q.name,
      async (job) => {
        attempts.push(job.attemptsMade);
        throw new TemporaryJobError('ai_service_unreachable', 'injected');
      },
      { backoffStrategy: scaledStrategy },
    );

    await q.add('noop', { probe: true }, {
      attempts: AI_RETRY_ATTEMPTS,
      backoff: { type: AI_BACKOFF_TYPE },
    });

    const done = await waitFor(() => attempts.length >= AI_RETRY_ATTEMPTS);
    expect(done, `only ran ${attempts.length} times`).toBe(true);

    // Give any (incorrect) 6th attempt a chance to appear before asserting.
    await new Promise((r) => setTimeout(r, 400));
    expect(attempts.length, 'must not exceed the configured attempts').toBe(AI_RETRY_ATTEMPTS);

    // attemptsMade is 0 on the first execution — the basis for
    // `handleAIJob({ attempt: job.attemptsMade + 1 })`.
    expect(attempts).toEqual([0, 1, 2, 3, 4]);

    const failed = await q.getFailedCount();
    expect(failed, 'ends in the failed set, not lost').toBe(1);
  });
});

describe('a permanent failure is not retried', () => {
  it('runs exactly once', async () => {
    const q = makeQueue('permanent');
    let runs = 0;

    makeWorker(
      q.name,
      async () => {
        runs++;
        throw new PermanentJobError('invalid_job', 'missing event_id');
      },
      { backoffStrategy: scaledStrategy },
    );

    await q.add('noop', { probe: true }, {
      attempts: AI_RETRY_ATTEMPTS,
      backoff: { type: AI_BACKOFF_TYPE },
    });

    await waitFor(() => runs >= 1);
    // Long enough for several scaled retries to have happened if the error
    // were misclassified.
    await new Promise((r) => setTimeout(r, 800));

    expect(runs, 'PermanentJobError must terminate immediately').toBe(1);
    expect(await q.getFailedCount()).toBe(1);
  });

  it('a bare UnrecoverableError behaves identically', async () => {
    const q = makeQueue('unrecoverable');
    let runs = 0;

    makeWorker(
      q.name,
      async () => {
        runs++;
        throw new UnrecoverableError('nope');
      },
      { backoffStrategy: scaledStrategy },
    );

    await q.add('noop', {}, { attempts: AI_RETRY_ATTEMPTS, backoff: { type: AI_BACKOFF_TYPE } });
    await waitFor(() => runs >= 1);
    await new Promise((r) => setTimeout(r, 800));
    expect(runs).toBe(1);
  });
});

describe("attemptsMade means different things in different places", () => {
  it("is 0-based in the processor but ALREADY incremented in the failed event", async () => {
    /**
     * A real bug this caught, live: the failed-event handler used
     * `attemptsMade + 1`, which logged "attempt 6" for a 5-attempt job and
     * declared retries exhausted one step early.
     *
     * The two readings are genuinely different and BullMQ documents neither,
     * so this pins both.
     */
    const q = makeQueue('attempt-semantics');
    const inProcessor: number[] = [];
    const inFailedEvent: number[] = [];

    const w = makeWorker(
      q.name,
      async (job) => {
        inProcessor.push(job.attemptsMade);
        throw new TemporaryJobError('injected', 'x');
      },
      { backoffStrategy: scaledStrategy },
    );
    w.on('failed', (job) => {
      if (job) inFailedEvent.push(job.attemptsMade);
    });

    await q.add('noop', {}, { attempts: AI_RETRY_ATTEMPTS, backoff: { type: AI_BACKOFF_TYPE } });
    await waitFor(() => inFailedEvent.length >= AI_RETRY_ATTEMPTS);
    await new Promise((r) => setTimeout(r, 300));

    expect(inProcessor, 'processor: 0-based').toEqual([0, 1, 2, 3, 4]);
    expect(inFailedEvent, 'failed event: already incremented').toEqual([1, 2, 3, 4, 5]);

    // Therefore: processor uses +1, the failed handler must NOT.
    expect(inProcessor.map((a) => a + 1)).toEqual(inFailedEvent);
  });
});

describe('the custom strategy is actually consulted', () => {
  it('BullMQ calls it with 1,2,3,4 for a 5-attempt job', async () => {
    // Confirms our reading of `Backoffs.calculate(..., attemptsMade + 1, ...)`
    // and that the 5th delay in the curve is unreachable at 5 attempts.
    const q = makeQueue('strategy-args');
    const seen: number[] = [];

    makeWorker(
      q.name,
      async () => {
        throw new TemporaryJobError('injected', 'x');
      },
      {
        backoffStrategy: (attemptsMade) => {
          seen.push(attemptsMade);
          return 1;
        },
      },
    );

    await q.add('noop', {}, { attempts: AI_RETRY_ATTEMPTS, backoff: { type: AI_BACKOFF_TYPE } });
    await waitFor(() => seen.length >= AI_RETRY_ATTEMPTS - 1);
    await new Promise((r) => setTimeout(r, 400));

    expect(seen).toEqual([1, 2, 3, 4]);
    expect(seen).not.toContain(5);
    expect(
      AI_RETRY_DELAYS_SECONDS[4],
      'the 600s entry exists but is unreachable at 5 attempts',
    ).toBe(600);
  });

  it('a worker with NO strategy fails loudly, not silently', async () => {
    // The one deployment coupling: dispatcher says `custom`, worker must
    // supply the function. This proves the failure mode is an explicit error
    // rather than a silently wrong schedule.
    const q = makeQueue('missing-strategy');
    const messages: string[] = [];

    const w = makeWorker(q.name, async () => {
      throw new TemporaryJobError('injected', 'x');
    }); // deliberately no backoffStrategy
    // The error surfaces on the worker's `error` channel, not `failed`: it is
    // raised inside BullMQ's own moveToFailed bookkeeping rather than by the
    // processor, so the job never reaches a terminal state cleanly. Both are
    // captured so the assertion does not depend on which one carries it.
    w.on('failed', (_job, err) => messages.push(`failed:${err.message}`));
    w.on('error', (err) => messages.push(`error:${err.message}`));

    await q.add('noop', {}, { attempts: AI_RETRY_ATTEMPTS, backoff: { type: AI_BACKOFF_TYPE } });
    await waitFor(() => messages.some((m) => /unknown backoff strategy/i.test(m)), 8_000);

    expect(
      messages.join(' | '),
      'a worker without the strategy must surface an explicit error',
    ).toMatch(/unknown backoff strategy/i);
  });
});

describe('retry delays follow the configured curve', () => {
  it('inter-attempt gaps keep the 1 : 5 : 25 ratio (scaled)', async () => {
    // Shape, not wall-clock. A regression to exponential(1000) would produce
    // 1 : 2 : 4 and fail the ratio assertions below.
    const q = makeQueue('curve');
    const stamps: number[] = [];

    makeWorker(
      q.name,
      async () => {
        stamps.push(Date.now());
        throw new TemporaryJobError('injected', 'x');
      },
      // 1/10 scale -> 100/500/2500ms. BullMQ's delayed-job scheduling is
      // quantised, so 10/50/250ms was below its granularity and every gap
      // measured ~100ms regardless of the curve. This is the smallest scale at
      // which the SHAPE is actually observable.
      { backoffStrategy: (a) => Math.max(1, Math.round(aiRetryDelayMs(a) / 10)) },
    );

    await q.add('noop', {}, { attempts: 4, backoff: { type: AI_BACKOFF_TYPE } });
    const ok = await waitFor(() => stamps.length >= 4, 20_000);
    expect(ok, `only ${stamps.length} attempts observed`).toBe(true);

    const gaps = [stamps[1]! - stamps[0]!, stamps[2]! - stamps[1]!, stamps[3]! - stamps[2]!];

    // Target 100 / 500 / 2500ms (+/-20% jitter) plus additive scheduling
    // overhead — so assert lower bounds and growth, not tight upper bounds.
    expect(gaps[0]!).toBeGreaterThanOrEqual(70);
    expect(gaps[1]!).toBeGreaterThanOrEqual(380);
    expect(gaps[2]!).toBeGreaterThanOrEqual(1_900);

    expect(gaps[1]!, 'gap 2 must exceed gap 1').toBeGreaterThan(gaps[0]!);
    expect(gaps[2]!, 'gap 3 must exceed gap 2').toBeGreaterThan(gaps[1]!);

    // 2500/500 = 5x. Exponential(1000) would give 2x here and fail.
    expect(gaps[2]! / gaps[1]!).toBeGreaterThan(2.5);
  });
});

describe('there is no second retry loop', () => {
  it('a job that succeeds on its first run executes exactly once', async () => {
    const q = makeQueue('success');
    let runs = 0;

    makeWorker(q.name, async () => {
      runs++;
      return { ok: true };
    }, { backoffStrategy: scaledStrategy });

    await q.add('noop', {}, { attempts: AI_RETRY_ATTEMPTS, backoff: { type: AI_BACKOFF_TYPE } });
    await waitFor(() => runs >= 1);
    await new Promise((r) => setTimeout(r, 500));

    expect(runs, 'a success must never be re-executed').toBe(1);
    expect(await q.getCompletedCount()).toBe(1);
  });
});
