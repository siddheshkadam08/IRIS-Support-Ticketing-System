import { afterAll, describe, expect, it } from 'vitest';
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { config } from './config.js';
import { drainWorker } from './shutdown.js';

/**
 * Phase 3 Step 6 — bounded shutdown, against a REAL BullMQ worker and Redis.
 *
 * A stub cannot prove the thing under test. The claim is that BullMQ's own
 * `close()` waits for in-flight jobs indefinitely and that the deadline is
 * what makes shutdown bounded — so the test uses a real worker holding a real
 * long-running job. If BullMQ ever changed that behaviour, the first test here
 * would start passing for the wrong reason, which the explicit unbounded
 * assertion below is there to catch.
 *
 * Runs on its own queue name so it can never touch ai.jobs.
 */

const QUEUE = `ai.jobs.shutdown-test.${process.pid}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const connections: IORedis[] = [];
const conn = () => {
  const c = new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null });
  c.on('error', () => undefined);
  connections.push(c);
  return c;
};

afterAll(async () => {
  const q = new Queue(QUEUE, { connection: conn() });
  await q.obliterate({ force: true }).catch(() => undefined);
  await q.close().catch(() => undefined);
  for (const c of connections) c.disconnect();
});

/** A worker whose job runs for `holdMs`, and a promise that fires when it starts. */
function busyWorker(holdMs: number) {
  let onStarted: () => void;
  const started = new Promise<void>((r) => (onStarted = r));
  let finished = false;

  const worker = new Worker(
    QUEUE,
    async () => {
      onStarted();
      await sleep(holdMs);
      finished = true;
    },
    { connection: conn(), concurrency: 1, lockDuration: 60_000 },
  );

  return { worker, started, didFinish: () => finished };
}

describe('the drain deadline bounds shutdown', () => {
  it('returns within the deadline while a job is still running', async () => {
    const q = new Queue(QUEUE, { connection: conn() });
    const { worker, started, didFinish } = busyWorker(60_000);
    await q.add('hold', {});
    await started; // the job is genuinely active, not merely queued

    const { drained, elapsedMs } = await drainWorker(worker, 2_000);

    expect(drained, 'the job could not finish in 2s').toBe(false);
    expect(elapsedMs, 'shutdown must be bounded, not wait 60s').toBeLessThan(6_000);
    expect(didFinish(), 'the job was abandoned mid-flight, as designed').toBe(false);

    await q.close();
    // Deliberately not awaited: close() is still waiting on the abandoned job.
    void worker.close(true).catch(() => undefined);
  }, 60_000);

  it('reports a CLEAN drain when the job finishes in time', async () => {
    const q = new Queue(QUEUE, { connection: conn() });
    const { worker, started, didFinish } = busyWorker(300);
    await q.add('quick', {});
    await started;

    const { drained, elapsedMs } = await drainWorker(worker, 8_000);

    expect(drained, 'a fast job must drain cleanly').toBe(true);
    expect(didFinish()).toBe(true);
    expect(elapsedMs).toBeLessThan(8_000);
    await q.close();
  }, 60_000);

  it('an idle worker shuts down immediately', async () => {
    const { worker } = busyWorker(0);
    const { drained, elapsedMs } = await drainWorker(worker, 8_000);
    expect(drained).toBe(true);
    expect(elapsedMs).toBeLessThan(3_000);
  }, 30_000);
});

describe('the unfinished job stays recoverable', () => {
  it('accepts NO new job after the drain begins, and leaves the old one in Redis', async () => {
    const q = new Queue(QUEUE, { connection: conn() });
    const { worker, started } = busyWorker(60_000);
    await q.add('hold', {});
    await started;

    await drainWorker(worker, 1_500);

    // Enqueued after shutdown: a closed worker must not pick it up.
    const late = await q.add('after-shutdown', {});
    await sleep(1_000);
    expect(await late.getState(), 'a closing worker must not take new work').toBe('waiting');

    /**
     * The abandoned job is still `active` and still holds its lock. That is
     * exactly right: nothing is lost, and BullMQ's stalled check re-runs it
     * once the lock expires. This step adds no recovery mechanism of its own.
     */
    const counts = await q.getJobCounts('active', 'waiting', 'failed');
    expect(counts.active, 'the in-flight job is still owned, not lost').toBeGreaterThanOrEqual(1);
    expect(counts.failed, 'a drained-out job must NOT be dead-lettered').toBe(0);

    await q.close();
    void worker.close(true).catch(() => undefined);
  }, 60_000);
});

describe('the deadline is what makes it bounded', () => {
  it('BullMQ close() alone is unbounded — the premise of this design', async () => {
    /**
     * Asserted rather than assumed. If a future BullMQ bounded close() itself,
     * this fails and the deadline can be reconsidered; without it, the whole
     * mechanism could quietly become redundant and nobody would know.
     */
    const q = new Queue(QUEUE, { connection: conn() });
    const { worker, started } = busyWorker(60_000);
    await q.add('hold', {});
    await started;

    const raw = worker.close();
    const settledFirst = await Promise.race([
      raw.then(() => 'closed' as const),
      sleep(3_000).then(() => 'still-waiting' as const),
    ]);

    expect(settledFirst, 'close() waits for in-flight jobs indefinitely').toBe('still-waiting');

    await q.close();
    void raw.catch(() => undefined);
    void worker.close(true).catch(() => undefined);
  }, 60_000);

  it('never rejects, so a signal handler cannot produce an unhandled rejection', async () => {
    const seen: unknown[] = [];
    const onUnhandled = (r: unknown) => seen.push(r);
    process.on('unhandledRejection', onUnhandled);
    try {
      const exploding = { close: async () => Promise.reject(new Error('redis gone')) };
      const outcome = await drainWorker(exploding, 1_000);
      expect(outcome.drained).toBe(false);
      await sleep(100);
      expect(seen, 'shutdown must not crash the process it is shutting down').toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('the configured deadline', () => {
  it('is 8s and fits inside the 10s container grace period', () => {
    expect(config.AI_WORKER_DRAIN_MS).toBe(8000);
    expect(config.AI_WORKER_DRAIN_MS).toBeLessThan(10_000);
  });

  it('is shorter than a worst-case attempt, deliberately', () => {
    // 5 + 10 + 5 = 20s. A job caught mid-flight will NOT finish in the window;
    // it is handed to stall recovery instead. Documented, not accidental.
    const worstAttemptMs = config.CORE_TIMEOUT_MS * 2 + config.AI_TIMEOUT_MS;
    expect(config.AI_WORKER_DRAIN_MS).toBeLessThan(worstAttemptMs);
  });
});
