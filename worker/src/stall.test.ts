import { afterAll, describe, expect, it } from 'vitest';
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { config } from './config.js';
import { LOCK_DURATION_MS } from './limits.js';

/**
 * Phase 3 Step 7, case A — worker crash, BullMQ half.
 *
 * `ai.reliability.test.ts` proves the DATABASE half: a claimed execution left
 * `running` by a dead worker is closed by the reaper. This proves the other
 * half — that BullMQ genuinely recovers the JOB, so the reaper is a backstop
 * for the case where nothing comes back rather than the primary mechanism.
 *
 * A real worker is killed mid-job. Nothing is stubbed, because the property
 * under test is BullMQ's own stalled-job recovery, and a stub of BullMQ would
 * be a test of the stub.
 *
 * Own queue name, so it can never touch ai.jobs.
 */

const QUEUE = `ai.jobs.stall-test.${process.pid}`;
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

describe('a job held by a dead worker is recovered, not lost', () => {
  it('a second worker re-runs it after the stalled check', async () => {
    const q = new Queue(QUEUE, { connection: conn() });

    /**
     * Worker 1 takes the job and never finishes — the crash. Short lock and
     * stalled interval so the recovery that normally takes ~30s takes ~1s;
     * the MECHANISM is identical, only the clock differs. Production values
     * are asserted separately below.
     */
    let firstStarted = false;
    const dying = new Worker(
      QUEUE,
      async () => {
        firstStarted = true;
        await sleep(60_000); // never returns
      },
      { connection: conn(), concurrency: 1, lockDuration: 1_000, stalledInterval: 1_000 },
    );

    await q.add('crash-me', { probe: true });
    for (let i = 0; i < 100 && !firstStarted; i++) await sleep(50);
    expect(firstStarted, 'worker 1 must actually hold the job').toBe(true);

    // The crash: stop renewing the lock without releasing the job.
    await dying.close(true).catch(() => undefined);

    // Worker 2 arrives and should pick the job back up.
    let recovered = false;
    const rescuer = new Worker(
      QUEUE,
      async () => {
        recovered = true;
      },
      { connection: conn(), concurrency: 1, lockDuration: 5_000, stalledInterval: 1_000 },
    );

    for (let i = 0; i < 200 && !recovered; i++) await sleep(50);

    expect(recovered, 'BullMQ must re-run a job whose owner died').toBe(true);
    await rescuer.close();
    await q.close();
  }, 60_000);

  it('a stall does NOT dead-letter the job on the first occurrence', async () => {
    /**
     * `[CODE]` maxStalledCount defaults to 1, so ONE stall is forgiven and the
     * job is re-queued. That is what makes the crash path recoverable rather
     * than a silent loss — and it is also why a stall never reaches the
     * 'failed' handler, which is precisely why the reaper exists.
     */
    const q = new Queue(QUEUE, { connection: conn() });

    let started = false;
    const dying = new Worker(
      QUEUE,
      async () => {
        started = true;
        await sleep(60_000);
      },
      { connection: conn(), concurrency: 1, lockDuration: 1_000, stalledInterval: 1_000 },
    );

    const job = await q.add('stall-once', { probe: true });
    for (let i = 0; i < 100 && !started; i++) await sleep(50);
    await dying.close(true).catch(() => undefined);

    // A worker that merely runs the stalled check, without taking work.
    const checker = new Worker(QUEUE, async () => undefined, {
      connection: conn(),
      concurrency: 1,
      lockDuration: 5_000,
      stalledInterval: 500,
    });

    let state = await job.getState();
    for (let i = 0; i < 60 && state === 'active'; i++) {
      await sleep(100);
      state = await job.getState();
    }

    expect(state, 'a first stall is recovered, never dead-lettered').not.toBe('failed');
    await checker.close();
    await q.close();
  }, 60_000);
});

describe('the production lock leaves room for a real attempt', () => {
  it('a 20s attempt renews well before the 60s lock expires', () => {
    /**
     * The relationship the crash path depends on: a HEALTHY job must never
     * stall. If the lock could lapse during normal work, every slow attempt
     * would become a duplicate execution recovered by the mechanism above.
     */
    const worstAttemptMs = config.CORE_TIMEOUT_MS * 2 + config.AI_TIMEOUT_MS;
    const renewAt = LOCK_DURATION_MS / 2; // BullMQ default: lockDuration / 2

    // 20s of work under a 60s lock: 3x headroom.
    expect(worstAttemptMs).toBe(20_000);
    expect(LOCK_DURATION_MS / worstAttemptMs).toBeGreaterThanOrEqual(3);

    // The first renewal (30s) falls AFTER even a worst-case attempt has
    // finished (20s), so normal work never depends on renewal landing at all.
    expect(renewAt).toBeGreaterThan(worstAttemptMs);
    expect(renewAt).toBeLessThan(LOCK_DURATION_MS);
  });
});
