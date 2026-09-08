import {
  EMBEDDING_DIM,
  type AIExecuteRequest,
  type EmbeddingApplyItem,
  type EmbeddingApplyResponse,
  type EmbeddingFailureItem,
  type EmbeddingPendingResponse,
  type EmbeddingWorkItem,
} from '@iris/shared/types';
import { executeAI } from './ai-client.js';
import { postToCore, type FetchLike } from './core-client.js';
import { config } from './config.js';
import { isPermanent } from './errors.js';
import { logger } from './logger.js';

/**
 * The embedding cycle — Phase 10.
 *
 * WHAT THIS IS. A bounded sweep: ask Core what still needs embedding, embed
 * it, hand the vectors back. Backfill and incremental maintenance are the SAME
 * code path, because "pending" is a property of the row's own text rather than
 * of an event that fired once (see migration 014). There is no backfill script
 * to run and no separate incremental trigger to wire up — the first cycles
 * after deployment happen to have 120 items to do, and later ones have none.
 *
 * WHY THE WORKER OWNS IT. It is already the only process holding both HMAC
 * credentials — one for Core, a different one for Python — and giving Core the
 * Python-facing secret would create a trust edge that does not exist today.
 * Core keeps the database and every decision; Python keeps the model; the
 * worker carries bytes between them, exactly as it does for ai.jobs.
 *
 * ⚠️ WHY NOT BullMQ. Spelled out in shared/types/embedding.ts. The short
 * version: `ai_execution.ticket_id` is NOT NULL and 48 of the 120 corpus items
 * are KB articles, and the queue's idempotency key (`UNIQUE(event_id,
 * feature)`) cannot express "the text changed, embed it again".
 *
 * WHAT IT REUSES UNCHANGED: `executeAI` and its timeout, both signing paths,
 * and `isPermanent` — so the temporary/permanent distinction this cycle acts
 * on is the same one BullMQ acts on, decided by the same code.
 */

/**
 * How many items are in flight against the provider at once.
 *
 * Deliberately below AI_WORKER_CONCURRENCY. Embedding is background
 * maintenance and must never be the reason a user-facing classification or
 * summary job waits for a provider slot — those are on the critical path of a
 * ticket someone just raised, and this is not.
 */
const PROVIDER_CONCURRENCY = 4;

export interface CycleResult {
  claimed: number;
  applied: number;
  quarantined: number;
  skipped: number;
  failedTemporarily: number;
}

const EMPTY: CycleResult = {
  claimed: 0,
  applied: 0,
  quarantined: 0,
  skipped: 0,
  failedTemporarily: 0,
};

/**
 * One cycle. NEVER THROWS.
 *
 * Every failure mode leaves the corpus exactly as it was and the affected rows
 * pending, so the next cycle retries them. That is the entire retry mechanism:
 * there is no backoff state, no attempt counter and no dead-letter queue,
 * because "still pending" already means "not done yet" and the interval
 * already paces the retry. Adding a second retry owner here would repeat the
 * mistake the whole AI pipeline is built to avoid.
 */
export async function runEmbeddingCycle(fetchImpl?: FetchLike): Promise<CycleResult> {
  let pending: EmbeddingPendingResponse;
  try {
    pending = await postToCore<EmbeddingPendingResponse>(
      '/internal/embeddings/pending',
      { limit: config.EMBEDDING_BATCH_SIZE },
      'embedding-cycle',
      fetchImpl,
    );
  } catch (err) {
    // Core unreachable or restarting. Nothing has been claimed and nothing is
    // half-done — there is no state to unwind.
    logger.warn({ err: message(err) }, 'embedding cycle: could not claim work');
    return EMPTY;
  }

  const items = pending.items ?? [];
  if (items.length === 0) return EMPTY;

  const applied: EmbeddingApplyItem[] = [];
  const failures: EmbeddingFailureItem[] = [];
  let failedTemporarily = 0;

  /**
   * Bounded concurrency without a dependency: N workers pulling from a shared
   * cursor. `Promise.all` over the whole batch would put 16 simultaneous
   * requests on the provider — the burst pattern that produced the Phase 5
   * timeout spiral — and a chunked loop would idle on the slowest item in each
   * chunk.
   */
  let cursor = 0;
  const embedOne = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      const item = items[index]!;

      try {
        const result = await embed(item, fetchImpl);
        if (result) applied.push(result);
      } catch (err) {
        if (isPermanent(err)) {
          /**
           * The same call will fail the same way forever — an Azure content
           * filter refusal is the realistic case. Report it so Core quarantines
           * the row against THIS text (migration 015). Editing the text clears
           * it automatically.
           *
           * Only the stable CODE travels. Provider prose can quote the input,
           * and this value is written to a column operational queries read.
           */
          failures.push({
            subject_type: item.subject_type,
            subject_id: item.subject_id,
            fingerprint: item.fingerprint,
            code: codeOf(err),
          });
        } else {
          // Temporary. Leave it pending; the next cycle picks it up. No
          // counter, no backoff, no re-enqueue.
          failedTemporarily += 1;
        }
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(PROVIDER_CONCURRENCY, items.length) }, embedOne),
  );

  if (applied.length === 0 && failures.length === 0) {
    logger.warn(
      { claimed: items.length, temporary_failures: failedTemporarily },
      'embedding cycle: nothing to persist',
    );
    return { ...EMPTY, claimed: items.length, failedTemporarily };
  }

  let response: EmbeddingApplyResponse;
  try {
    // ONE request carrying both, so a crash between two calls cannot persist
    // the vectors while losing the failures.
    response = await postToCore<EmbeddingApplyResponse>(
      '/internal/embeddings/apply',
      { items: applied, failures },
      'embedding-cycle',
      fetchImpl,
    );
  } catch (err) {
    // The vectors are lost, but nothing is corrupted: none of these rows were
    // marked done, so all of them are still pending. The cost of this failure
    // is exactly the provider calls already made.
    logger.warn(
      { err: message(err), vectors: applied.length },
      'embedding cycle: could not persist — items remain pending',
    );
    return { ...EMPTY, claimed: items.length, failedTemporarily };
  }

  const result: CycleResult = {
    claimed: items.length,
    applied: response.applied,
    quarantined: response.quarantined,
    skipped: response.skipped.length,
    failedTemporarily,
  };

  logger.info(result, 'embedding cycle complete');
  return result;
}

/**
 * Embed one item.
 *
 * ⚠️ `subject: null`. The canonical text arrives already assembled by Postgres
 * and is passed through as one string. Splitting it back into subject and body
 * would create a second spelling of the exact text whose single spelling IS
 * the idempotency mechanism — the fingerprint is computed over it, in SQL, and
 * a divergence here would re-embed the whole corpus on every cycle with
 * nothing failing to signal it.
 */
async function embed(
  item: EmbeddingWorkItem,
  fetchImpl?: FetchLike,
): Promise<EmbeddingApplyItem | null> {
  const request: AIExecuteRequest = {
    feature: 'embedding',
    // The subject id is an opaque ULID and identifies no tenant. It is the
    // correlation handle, matching what the ai.jobs path sends.
    request_id: `emb_${item.subject_id}`,
    input: { subject: null, description: item.text },
  };

  const result = await executeAI(request, fetchImpl);
  const data = result.data as { vector?: unknown; dim?: unknown; model?: unknown };

  /**
   * Structural check only — Core validates finiteness and non-zero-ness, and
   * is the authority. This exists so a garbage response fails here with a
   * clear message rather than becoming a confusing 400 from Core, which is the
   * same division `parseAIResult` already draws.
   */
  if (!Array.isArray(data.vector) || data.vector.length !== EMBEDDING_DIM) {
    logger.warn(
      { subject_id: item.subject_id, got: Array.isArray(data.vector) ? data.vector.length : null },
      'embedding response had the wrong shape',
    );
    return null;
  }

  return {
    subject_type: item.subject_type,
    subject_id: item.subject_id,
    fingerprint: item.fingerprint,
    vector: data.vector as number[],
    model: String(data.model ?? ''),
  };
}

function codeOf(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.length > 0 ? code : 'embedding_failed';
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ─────────────────────────────────────────────────────────────────────────
// The loop
// ─────────────────────────────────────────────────────────────────────────

let timer: NodeJS.Timeout | null = null;
let running = false;

/**
 * Start the periodic sweep.
 *
 * Three properties copied deliberately from the Phase 3 reaper, for the same
 * reasons:
 *
 *   `unref()`        the timer must never be the reason the process stays
 *                    alive; shutdown is owned by the BullMQ drain.
 *   `running` guard  a cycle that outruns the interval must not overlap
 *                    itself, which would double the provider load exactly when
 *                    the provider is already slow.
 *   NO IMMEDIATE RUN a sweep at t=0 competes with startup, when connections
 *                    are still being established and the queue is draining
 *                    whatever accumulated while the process was down.
 */
export function startEmbeddingRunner(): void {
  if (!config.EMBEDDING_ENABLED) {
    logger.info('embedding runner disabled');
    return;
  }
  if (timer) return;

  timer = setInterval(() => {
    if (running) {
      logger.info('embedding cycle still running — skipping this tick');
      return;
    }
    running = true;
    void runEmbeddingCycle()
      .catch((err: unknown) => {
        // Unreachable by contract: runEmbeddingCycle catches everything. If it
        // fires, that contract has a bug — say so loudly rather than letting an
        // unhandled rejection abort the process.
        logger.error({ err: message(err) }, 'embedding cycle threw — this should be impossible');
      })
      .finally(() => {
        running = false;
      });
  }, config.EMBEDDING_INTERVAL_MS);

  timer.unref();
  logger.info(
    { interval_ms: config.EMBEDDING_INTERVAL_MS, batch: config.EMBEDDING_BATCH_SIZE },
    'embedding runner started',
  );
}

/** Stop the sweep. Used by tests and by shutdown. */
export function stopEmbeddingRunner(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
