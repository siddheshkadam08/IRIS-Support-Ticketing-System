/**
 * Embedding contracts — Phase 10.
 *
 * WHAT AN EMBEDDING IS HERE. A derived retrieval artifact: a vector that lets
 * Postgres rank one piece of the tenant's own text against another. It is not
 * a prediction, it carries no confidence, and it reaches no decision.
 *
 * ⚠️ WHY THIS IS NOT A `feature` ON THE ai.jobs QUEUE.
 *
 * Three concrete blockers, all in the existing schema and contracts rather
 * than in taste:
 *
 *   1. `ai_execution.ticket_id text NOT NULL REFERENCES ticket(id)`. Forty-
 *      eight of the 120 corpus items are KB articles, which have no ticket.
 *      Routing them through the queue means weakening the FK on the
 *      GOVERNANCE table — to store a 1536-float array in a `result` column
 *      whose own comment says it holds "the VALIDATED result only".
 *
 *   2. `AI_EVENT_FEATURES` is keyed on `ticket.created`. The corpus is
 *      RESOLVED tickets and PUBLISHED articles. Neither state is that event,
 *      so reuse would need two new event types plus outbox writes inside
 *      ticket and KB lifecycle code — and neither would notice a later EDIT.
 *
 *   3. Idempotency. The pipeline's durable key is `UNIQUE(event_id, feature)`,
 *      which cannot express "the text changed, embed it again". Embedding's
 *      correct key is a CONTENT FINGERPRINT, which makes backfill, incremental
 *      and re-embed-after-edit one operation instead of three.
 *
 * So the queue is not reused. What IS reused, deliberately and without
 * modification: the `/v1/execute` contract, both HMAC trust edges, the
 * temporary/permanent error model, the Core-internal route pattern, and the
 * worker as the only process that talks to both Core and Python. No new trust
 * relationship is created, and the AI service still holds no database
 * credential.
 */

/**
 * The provider's native output width for `text-embedding-3-small`, verified
 * live against the configured Azure deployment.
 *
 * ⚠️ CHANGING THIS IS A MIGRATION, not a config edit. `ticket.embedding` and
 * `kb_article.embedding` are `vector(1536)`; Postgres rejects a vector of any
 * other width outright. That rejection is the point — a dimension mismatch
 * fails at the write instead of silently poisoning the corpus with vectors
 * that cannot be compared to each other.
 */
export const EMBEDDING_DIM = 1536;

/**
 * Recorded on every row as `embedding_model`.
 *
 * Vectors from different models are not comparable, so this is what makes
 * "which of these rows are stale because we changed model?" answerable with a
 * query rather than a guess. It is deliberately NOT part of the content
 * fingerprint: the fingerprint hashes CONTENT, and mixing the two would put a
 * provider choice inside the schema.
 */
export const EMBEDDING_MODEL_ID = 'azure/text-embedding-3-small';

/** What the corpus is drawn from. Both are product-scoped, RLS-protected tables. */
export type EmbeddingSubjectType = 'ticket' | 'kb_article';

export const EMBEDDING_SUBJECT_TYPES: readonly EmbeddingSubjectType[] = ['ticket', 'kb_article'];

/**
 * One item of pending work, as Core hands it to the worker.
 *
 * NOTE WHAT IS ABSENT, and must stay absent: product_id, tenant id, reference,
 * raiser identity, status, assignee. The worker forwards only `text` to
 * Python, and Core re-derives the tenant from `subject_id` when the vector
 * comes back. The worker is a courier, not an authority — the same property
 * the ai.jobs path has.
 */
export interface EmbeddingWorkItem {
  subject_type: EmbeddingSubjectType;
  subject_id: string;
  /**
   * The canonical text, built by Postgres from the row itself.
   *
   * ⚠️ NEVER rebuilt in TypeScript. The canonical form is the generated
   * `embedding_content_sha` expression in migration 014, and a second
   * implementation of it would drift silently — re-embedding the entire corpus
   * on every cycle, billed each time, with nothing failing to signal it.
   */
  text: string;
  /** The value of `embedding_content_sha` at the moment Core read the row. */
  fingerprint: string;
}

/**
 * What the worker sends back for ONE item.
 *
 * `fingerprint` is echoed, not recomputed, and Core writes the vector only if
 * the row's fingerprint is STILL this value. That closes a real race: a ticket
 * edited while its embedding was in flight would otherwise be stamped current
 * while holding a vector of the previous text — a stale vector that looks
 * fresh is worse than a missing one, because nothing ever revisits it.
 */
export interface EmbeddingApplyItem {
  subject_type: EmbeddingSubjectType;
  subject_id: string;
  fingerprint: string;
  /** Exactly EMBEDDING_DIM finite numbers. Core validates before persisting. */
  vector: number[];
  model: string;
}

/**
 * A PERMANENT provider failure for one item, reported so Core can quarantine
 * it (migration 015).
 *
 * Sent in the same request as the successes rather than through a second
 * endpoint: they come from one cycle over one batch, and splitting them would
 * let a worker crash between the two calls apply the vectors while losing the
 * failures — leaving the failed rows to be retried forever, which is the exact
 * thing the quarantine exists to stop.
 */
export interface EmbeddingFailureItem {
  subject_type: EmbeddingSubjectType;
  subject_id: string;
  fingerprint: string;
  /** A stable code. NEVER provider prose, which can quote the input text. */
  code: string;
}

export interface EmbeddingApplyResponse {
  /** Rows actually written. Lower than the request when a row was edited mid-flight. */
  applied: number;
  /** Items rejected by validation or by the fingerprint guard, with a reason. */
  skipped: Array<{ subject_id: string; reason: string }>;
  /** Rows quarantined after a permanent provider failure. */
  quarantined: number;
}

export interface EmbeddingPendingResponse {
  items: EmbeddingWorkItem[];
}

/**
 * The AI service's output for `feature: "embedding"`.
 *
 * `dim` is returned alongside the vector rather than left implicit so a
 * provider or deployment swap that changes width is caught at the boundary,
 * by an assertion, instead of at the database by a constraint violation.
 */
export interface EmbeddingData {
  vector: number[];
  dim: number;
  model: string;
}

/**
 * How many items one worker cycle claims from Core.
 *
 * NOT a provider batch. Azure's embeddings endpoint does accept an array
 * `input`, and using it would have made a cycle one HTTP call instead of 16 —
 * but only by widening `ExecuteRequest.input` with a `texts` array, and that
 * contract's `additionalProperties: false` is a tested security property
 * rather than a formality. The connection cost batching would have saved is
 * already gone: the transport is pooled, so 16 calls share one TCP connection
 * and one TLS handshake. Concurrency inside the cycle recovers the wall-clock.
 *
 * Sized so a full backfill of the 120-item corpus is a handful of cycles, and
 * so a provider outage mid-cycle costs 16 items rather than everything.
 */
export const EMBEDDING_BATCH_SIZE = 16;

/**
 * Maximum characters of canonical text sent for one item.
 *
 * `text-embedding-3-small` accepts 8191 tokens. This bound is well inside it
 * and exists for a different reason: a 40k-character ticket produces a vector
 * dominated by whatever it rambles about, which is worse retrieval than
 * embedding its opening. Truncation is applied in SQL so the fingerprint and
 * the embedded text always describe the same string.
 */
export const EMBEDDING_MAX_CHARS = 8000;

/**
 * Rejects anything Postgres would accept as a vector but that would corrupt
 * ranking.
 *
 * NaN is the case that matters and the reason this is not just a length check:
 * pgvector stores NaN happily, every distance involving it is NaN, and NaN
 * sorts LAST under `ORDER BY ... ASC` — so a poisoned row does not crash a
 * query, it silently never appears. A corpus can rot one row at a time with
 * nothing failing anywhere.
 *
 * A zero vector is rejected for a related reason: cosine distance to it is
 * undefined (pgvector returns NaN), so it is the same failure wearing a
 * different mask.
 */
export function validateEmbeddingVector(
  value: unknown,
  dim: number = EMBEDDING_DIM,
): { ok: true; vector: number[] } | { ok: false; reason: string } {
  if (!Array.isArray(value)) return { ok: false, reason: 'vector is not an array' };
  if (value.length !== dim) {
    return { ok: false, reason: `expected ${dim} dimensions, got ${value.length}` };
  }

  let sumSquares = 0;
  for (let i = 0; i < value.length; i++) {
    const n = value[i];
    if (typeof n !== 'number') return { ok: false, reason: `dimension ${i} is not a number` };
    // Catches NaN, Infinity and -Infinity in one check.
    if (!Number.isFinite(n)) return { ok: false, reason: `dimension ${i} is not finite` };
    sumSquares += n * n;
  }
  if (sumSquares === 0) return { ok: false, reason: 'vector is all zeros' };

  return { ok: true, vector: value as number[] };
}

/**
 * pgvector's text input format: `[0.1,-0.2,...]`.
 *
 * Sent as a bound parameter cast with `$n::vector`, never interpolated.
 * Building the literal here rather than at the call site keeps that one
 * decision in one place.
 */
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`;
}
