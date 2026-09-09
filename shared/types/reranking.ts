/**
 * Reranking contracts — Phase 12.
 *
 * Phase 11 finds plausible candidates. Reranking decides which of THOSE is most
 * relevant to the question actually asked. It reorders; it never retrieves.
 *
 * ⚠️ THE MODEL RANKS ORDINALS, NOT IDENTIFIERS. This is the central security
 * decision of the phase and it is structural, not a validation rule.
 *
 * Core numbers its own candidates 1..N and sends only `{ordinal, kind, title,
 * excerpt}`. No source_id, no product_id, no reference, no tenant identifier
 * ever crosses the boundary. The model returns integers, and Core maps them
 * back through its own list.
 *
 * So a compromised or hostile model CANNOT name a document that was not
 * supplied — there is no field in which to name one. Compare the obvious
 * alternative, sending real ids and validating what comes back: that works, but
 * it depends on the validation being right forever. This depends on the output
 * alphabet being 1..N.
 *
 * Everything a fabricated id could have done, an out-of-range ordinal does
 * instead: it is dropped, and the candidate keeps its Phase 11 position.
 */

/** What a candidate looks like on the wire. Deliberately four fields. */
export interface RerankCandidate {
  /** 1-based position in CORE's list. The only handle the model is given. */
  ordinal: number;
  /**
   * `article` or `ticket`. Not tenant data — it is the KIND of evidence, and a
   * curated article answers a question differently from a resolved ticket, so
   * withholding it would make the ranking task harder for no security gain.
   */
  kind: 'article' | 'ticket';
  title: string;
  excerpt: string;
}

/** What the model returns: an ordering over the ordinals it was given. */
export interface RerankingData {
  ranking: number[];
}

/**
 * How many candidates are reranked.
 *
 * `[LIVE]` Measured against the real deployment before anything was built:
 *
 *     n=5    p50 1742ms   p95 2149ms   323 input tokens
 *     n=10   p50 1715ms   p95 1938ms   505 input tokens
 *     n=15   p50 1586ms   p95 2061ms
 *
 * ⚠️ LATENCY IS FLAT IN CANDIDATE COUNT. It is dominated by this deployment's
 * ~1.6s baseline for any chat call, not by input size — Phase 5 measured the
 * same floor (12 concurrent minimal calls, p50 1547ms). That matters because it
 * means the usual lever for a slow reranker, "send fewer candidates", buys
 * nothing here. Cutting to 5 measured SLOWER than 10, within noise.
 *
 * So the bound is set by what is useful rather than by what is affordable: 10
 * is more than a deflection widget shows (4) and more than one tenant's corpus
 * usually returns, while staying far inside the model's ability to hold a list
 * in order.
 */
export const RERANK_MAX_CANDIDATES = 10;

/** Nothing to reorder below this; skip the provider call entirely. */
export const RERANK_MIN_CANDIDATES = 2;

/** Chars of excerpt per candidate. Bounds the prompt and the cost. */
export const RERANK_EXCERPT_CHARS = 240;

export const RERANKING_PROMPT_VERSION = 'reranking-v1';

/**
 * Why a returned ranking was not usable. Every value means the same thing to
 * the caller — keep Phase 11 order — but they are counted separately so a
 * degradation is diagnosable without turning on debug logging.
 */
export type RerankOutcome =
  | 'reranked'
  | 'skipped_disabled'
  | 'skipped_too_few'
  | 'provider_timeout'
  | 'provider_unavailable'
  /**
   * ⚠️ The provider read this exact prompt and REFUSED it — Azure's content
   * management policy, arriving as HTTP 400 upstream. Distinct from
   * `provider_unavailable` because nothing is down and a retry can only fail
   * again: an operator chasing an outage here would find none, and a caller
   * treating it as transient would be wrong. Nothing retries either one.
   */
  | 'provider_refused'
  | 'malformed'
  | 'not_configured';

/**
 * Apply a model ranking to Core's candidate list.
 *
 * PURE, so the rules below are testable without a provider. Every one of them
 * exists because the model can and does violate the naive assumption:
 *
 *   PARTIAL RANKINGS ARE NORMAL. `[LIVE]` asked to rank 10 candidates, the real
 *   deployment returned `[1, 3, 6, 2]` — four of them. Unranked candidates are
 *   NOT dropped; they keep their Phase 11 relative order and follow the ranked
 *   ones. Dropping them would let a lazy model silently shrink the result set.
 *
 *   OUT-OF-RANGE ORDINALS ARE DROPPED. `0`, `11`, `-1` and `999` name nothing.
 *   This is where a fabricated identifier would have arrived, and it arrives as
 *   a number that indexes nothing.
 *
 *   DUPLICATES KEEP THEIR FIRST OCCURRENCE. `[2, 2, 1]` is `[2, 1]`. A repeated
 *   ordinal must not duplicate a result.
 *
 * @param order the raw `ranking` array from the model
 * @param count how many candidates were sent (ordinals are 1..count)
 * @returns 0-based indexes into Core's candidate list, every index exactly once
 */
export function applyRanking(order: readonly unknown[], count: number): number[] {
  const seen = new Set<number>();
  const out: number[] = [];

  for (const raw of order) {
    if (typeof raw !== 'number' || !Number.isInteger(raw)) continue;
    if (raw < 1 || raw > count) continue;
    const index = raw - 1;
    if (seen.has(index)) continue;
    seen.add(index);
    out.push(index);
  }

  // Everything the model did not rank, in its original Phase 11 order.
  for (let i = 0; i < count; i++) if (!seen.has(i)) out.push(i);

  return out;
}

/**
 * Is a model response structurally usable?
 *
 * Deliberately permissive about CONTENT and strict about SHAPE: a partial or
 * duplicated ranking is handled by `applyRanking`, but a response that is not
 * an array of numbers at all means the provider returned something this code
 * has no business interpreting.
 */
export function isUsableRanking(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'number');
}
