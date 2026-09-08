import {
  EMBEDDING_MODEL_ID,
  validateEmbeddingVector,
  type EmbeddingApplyItem,
  type EmbeddingApplyResponse,
  type EmbeddingFailureItem,
  type EmbeddingPendingResponse,
} from '@iris/shared/types';
import { withScope, withSystemScope } from '../db/with-scope.js';
import { logger } from '../logger.js';
import {
  applyEmbedding,
  recordPermanentFailure,
  resolveOwner,
  selectPending,
} from './embedding.repo.js';

/**
 * Embedding orchestration — Phase 10.
 *
 * Core's half of the contract, and the only place a vector is allowed to reach
 * a column. The division is the same one the rest of the AI pipeline uses:
 *
 *   Python   computes a vector from text and asserts nothing about it
 *   worker   carries bytes between two services it cannot read the meaning of
 *   CORE     decides what is eligible, validates what came back, and persists
 *
 * The worker never chooses what to embed and never decides whether a vector is
 * acceptable. It receives a list, returns results in the same shape, and every
 * claim it makes is re-checked here.
 */

/**
 * Batch ceiling for one pending request.
 *
 * Bounds the worker's per-cycle work AND the size of this response, which
 * carries ticket text. 32 items is roughly a quarter of the whole corpus, so
 * a full backfill is four cycles — deliberately not one, so a provider outage
 * mid-backfill costs one batch rather than everything.
 */
const MAX_PENDING_BATCH = 32;

export async function getPendingEmbeddings(limit: number): Promise<EmbeddingPendingResponse> {
  const bounded = Math.max(1, Math.min(limit, MAX_PENDING_BATCH));

  /**
   * withSystemScope, with the same narrow justification as the reaper's
   * resolve step: this is a platform maintenance sweep, and "which rows across
   * every tenant still need embedding?" cannot be answered from inside one
   * tenant's scope.
   *
   * What keeps it safe is the shape of what leaves: EmbeddingWorkItem carries
   * no product_id, no tenant id, no reference and no raiser identity. The
   * worker physically cannot attribute the text it is holding to a tenant, so
   * it cannot mix two of them up — and every write below re-scopes to one
   * product before touching anything.
   */
  const items = await withSystemScope('embedding-pending', (tx) =>
    selectPending(tx, { model: EMBEDDING_MODEL_ID, limit: bounded }),
  );

  return { items };
}

/**
 * Validate and persist a batch of vectors.
 *
 * EVERY item is validated independently and one bad item never costs the
 * others their write. That matters more here than on the classification path:
 * a batch is a quarter of the corpus, and discarding 31 good vectors because
 * the provider hiccuped on one would turn a transient fault into a re-billed
 * re-embedding of everything.
 */
export async function applyEmbeddings(
  items: EmbeddingApplyItem[],
  failures: EmbeddingFailureItem[] = [],
): Promise<EmbeddingApplyResponse> {
  const skipped: EmbeddingApplyResponse['skipped'] = [];
  let applied = 0;
  let quarantined = 0;

  for (const item of items) {
    /**
     * THE VALIDATION BOUNDARY. Python is not trusted to have produced a usable
     * vector, exactly as it is not trusted to have produced a usable
     * classification.
     *
     * NaN is the case this exists for. pgvector stores NaN without complaint,
     * every distance involving it evaluates to NaN, and NaN sorts LAST under
     * ORDER BY ASC — so a poisoned row does not fail a query, it silently
     * never appears in one. Nothing anywhere would report the corpus rotting.
     */
    const check = validateEmbeddingVector(item.vector);
    if (!check.ok) {
      skipped.push({ subject_id: item.subject_id, reason: check.reason });
      // The vector is NOT logged — it is a lossy but real encoding of customer
      // text. Only the reason and the opaque id.
      logger.warn(
        { subject_id: item.subject_id, subject_type: item.subject_type, reason: check.reason },
        'embedding rejected by validation',
      );
      continue;
    }

    if (item.model !== EMBEDDING_MODEL_ID) {
      // A vector from a model this deployment is not configured for would be
      // stored alongside — and compared against — vectors it has no shared
      // geometry with. Silently mixing two embedding spaces degrades every
      // ranking in the corpus and looks like nothing at all.
      skipped.push({ subject_id: item.subject_id, reason: 'model_mismatch' });
      continue;
    }

    /**
     * Resolve the owner under system scope, then do the WRITE inside that one
     * product's scope — the reaper's pattern exactly. The write is therefore
     * subject to the same RLS policy any tenant-facing write is, so a bug in
     * this file cannot put a vector on another product's row.
     */
    const owner = await withSystemScope(`embedding-owner:${item.subject_id}`, (tx) =>
      resolveOwner(tx, item.subject_type, item.subject_id),
    );
    if (!owner) {
      // The row was deleted between the pending sweep and now, or the id was
      // never real. Either way there is nothing to write and nothing wrong.
      skipped.push({ subject_id: item.subject_id, reason: 'subject_not_found' });
      continue;
    }

    const ok = await withScope(
      {
        productScope: [owner],
        /**
         * role 'none' — NOT 'super_admin'.
         *
         * The RLS policy is `product_id = ANY(app_scope()) OR app_role() =
         * 'super_admin'`, so a super_admin scope would bypass isolation
         * entirely and make `productScope` decorative. 'none' maps to
         * actor_type 'system' and is the same role ai.service.ts and the
         * reaper use for exactly this kind of background write, which is what
         * makes the product scope actually constrain the statement.
         */
        role: 'none',
        requestId: `embedding-apply:${item.subject_id}`,
      },
      (tx) =>
        applyEmbedding(tx, {
          subjectType: item.subject_type,
          subjectId: item.subject_id,
          productId: owner,
          fingerprint: item.fingerprint,
          vector: check.vector,
          model: item.model,
        }),
    );

    if (ok) {
      applied += 1;
    } else {
      /**
       * The fingerprint guard bit: the row's text changed while its embedding
       * was in flight. A NORMAL outcome, not an error — the row stays pending
       * and the next cycle embeds the new text. Recorded so a row that keeps
       * losing this race (an item being edited faster than it can be embedded)
       * is visible rather than mysterious.
       */
      skipped.push({ subject_id: item.subject_id, reason: 'fingerprint_changed' });
    }
  }

  /**
   * Quarantine the permanent failures, in the SAME request that applied the
   * successes. A worker that crashed between two endpoints would otherwise
   * persist the vectors and lose the failures, leaving those rows pending
   * forever — precisely what the quarantine exists to prevent.
   */
  for (const failure of failures) {
    const owner = await withSystemScope(`embedding-owner:${failure.subject_id}`, (tx) =>
      resolveOwner(tx, failure.subject_type, failure.subject_id),
    );
    if (!owner) {
      skipped.push({ subject_id: failure.subject_id, reason: 'subject_not_found' });
      continue;
    }

    const stamped = await withScope(
      {
        productScope: [owner],
        role: 'none',
        requestId: `embedding-quarantine:${failure.subject_id}`,
      },
      (tx) =>
        recordPermanentFailure(tx, {
          subjectType: failure.subject_type,
          subjectId: failure.subject_id,
          productId: owner,
          fingerprint: failure.fingerprint,
          code: failure.code,
        }),
    );

    if (stamped) {
      quarantined += 1;
      // WARN, not error: the platform is working correctly — a permanent
      // failure is being handled permanently. The code is logged; the ticket
      // text and the provider's prose are not.
      logger.warn(
        {
          subject_id: failure.subject_id,
          subject_type: failure.subject_type,
          code: failure.code,
        },
        'embedding quarantined after permanent failure',
      );
    } else {
      // The text changed after the failure. The row is pending again on its
      // own, which is the outcome we would have wanted anyway.
      skipped.push({ subject_id: failure.subject_id, reason: 'fingerprint_changed' });
    }
  }

  return { applied, skipped, quarantined };
}
