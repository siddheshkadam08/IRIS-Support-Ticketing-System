import type { Worker } from 'bullmq';
import { logger } from './logger.js';

/**
 * Bounded shutdown — Phase 3 Step 6.
 *
 * THE PROBLEM. `[CODE]` `Worker.close()` calls `whenCurrentJobsFinished(false)`
 * (bullmq worker.js:803) and waits for in-flight jobs INDEFINITELY. A worst-
 * case attempt here is ~20s (5s Core + 10s Python + 5s Core), which is longer
 * than any sane termination grace period — so an unbounded close does not
 * produce a graceful shutdown, it produces a SIGKILL mid-write.
 *
 * WHY A DEADLINE IS SAFE. The unfinished job is already protected by machinery
 * that exists: it keeps its BullMQ lock, the lock expires after
 * `lockDuration`, the stalled check re-runs it, and `UNIQUE(event_id, feature)`
 * makes the re-run idempotent. This adds NO recovery mechanism — it hands the
 * job back to the one that already owns this case.
 *
 * WHAT close() DOES IMMEDIATELY. It stops the worker taking NEW jobs before it
 * begins waiting, so the deadline only ever bounds the wait for work already
 * running. Nothing new is accepted during the drain window.
 *
 * `close()` memoises its promise (`if (this.closing) return this.closing`), so
 * a second, forced call cannot escalate the first. The deadline IS the
 * escalation.
 */

export interface DrainOutcome {
  /** true = in-flight jobs finished; false = the deadline won. */
  drained: boolean;
  elapsedMs: number;
}

/** The subset of Worker this needs — so tests can drive it without Redis. */
export interface ClosableWorker {
  close(force?: boolean): Promise<void>;
}

export async function drainWorker(
  worker: ClosableWorker | Worker,
  drainMs: number,
): Promise<DrainOutcome> {
  const started = Date.now();

  const drained = await Promise.race([
    worker.close().then(() => true),
    new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), drainMs);
      // Never let the deadline itself hold the process open.
      t.unref?.();
    }),
  ]).catch((err: unknown) => {
    // A close() that rejects still means we are shutting down. Log and treat
    // it as "not cleanly drained" rather than letting it escape into a signal
    // handler, where it would become an unhandled rejection.
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'worker close failed');
    return false;
  });

  return { drained, elapsedMs: Date.now() - started };
}
