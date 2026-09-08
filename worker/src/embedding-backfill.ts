/**
 * One-shot embedding backfill — Phase 10.
 *
 * ⚠️ THIS CONTAINS NO EMBEDDING LOGIC, and that is the point.
 *
 * It calls `runEmbeddingCycle()` — the exact function the periodic runner
 * calls — until the corpus stops yielding pending work. Backfill and steady-
 * state maintenance are the same code path because "pending" is a property of
 * the row's own text rather than of an event that fired once (migration 014),
 * so a separate backfill implementation would be a second thing to keep
 * correct and a second thing to get subtly wrong.
 *
 * Run it to fill a fresh corpus without waiting out EMBEDDING_INTERVAL_MS, or
 * after a model change. Running it twice is free: the second run claims
 * nothing, because every row's fingerprint already matches.
 *
 *   npm run backfill:embeddings --workspace=worker
 *
 * Requires core-service and ai-service to be running. It holds no database
 * credential and reaches data only through Core, exactly as the worker does.
 */

import { runEmbeddingCycle } from './embedding-runner.js';
import { logger } from './logger.js';

/**
 * A hard stop, not a target. If the corpus never drains — a permanently
 * failing provider, or a bug that keeps re-offering the same rows — this exits
 * with a report instead of billing provider calls in an unbounded loop.
 */
const MAX_CYCLES = 40;

async function main(): Promise<void> {
  let cycles = 0;
  const totals = { claimed: 0, applied: 0, quarantined: 0, skipped: 0, failedTemporarily: 0 };

  for (; cycles < MAX_CYCLES; cycles++) {
    const r = await runEmbeddingCycle();
    totals.claimed += r.claimed;
    totals.applied += r.applied;
    totals.quarantined += r.quarantined;
    totals.skipped += r.skipped;
    totals.failedTemporarily += r.failedTemporarily;

    // Nothing claimed means the corpus is current. This is the ONLY success
    // condition — "applied === 0" is not, because a cycle can legitimately
    // claim work and apply none of it (every item quarantined, say).
    if (r.claimed === 0) {
      logger.info({ cycles: cycles + 1, ...totals }, 'backfill complete — corpus current');
      return;
    }

    /**
     * A cycle that claimed work but made NO progress at all would otherwise
     * repeat forever. Temporary failures are the expected cause (provider
     * down), and retrying them is this loop's job — but not 40 times in a row
     * with no pause, which would be a retry storm rather than a backfill.
     */
    if (r.applied === 0 && r.quarantined === 0) {
      logger.warn(
        { cycle: cycles + 1, ...r },
        'backfill made no progress — stopping; items remain pending and the runner will retry',
      );
      return;
    }
  }

  logger.warn({ cycles, ...totals }, `backfill stopped at the ${MAX_CYCLES}-cycle ceiling`);
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'backfill failed');
    process.exit(1);
  },
);
