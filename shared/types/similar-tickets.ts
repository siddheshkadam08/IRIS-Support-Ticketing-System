/**
 * Similar Tickets — Phase 14.
 *
 * Answers one question for a support user looking at a ticket:
 *
 *     "Have we seen this before, and what happened?"
 *
 * ⚠️ SIMILAR TICKETS ARE HISTORICAL EXAMPLES, NOT AUTHORITATIVE
 * RECOMMENDATIONS. And similarity does not imply that the historical ticket's
 * resolution is correct for the current one — two tickets can read alike and
 * have entirely different causes.
 *
 * ⚠️ IT DECIDES NOTHING. This is a read-only lookup. It cannot change priority,
 * severity, status, assignment, SLA, access or send anything to a customer, and
 * it writes no row of any kind. "AI predicts/extracts. IRIS decides" holds
 * trivially here, because there is no decision to make.
 *
 * ⚠️ NOT RAG. RAG answers a question from knowledge articles and cites them.
 * This surfaces past tickets as examples for a human to read. They stay
 * separate pipelines: a similar ticket may later become Copilot evidence, but
 * nothing here turns one into a generated answer.
 */

/**
 * One historical ticket, as the support user sees it.
 *
 * ⚠️ NOTE WHAT IS ABSENT: the internal ticket id, product_id,
 * product_tenant_id, raiser identity, assignee id, and any internal comment.
 * `reference` is the human-facing handle the UI already shows everywhere else,
 * so nothing new about identity is exposed.
 */
export interface SimilarTicket {
  /** The human-facing handle, e.g. CARB-1011. Never the internal id. */
  reference: string;
  title: string;
  status: 'resolved' | 'closed';
  /**
   * Cosine similarity between the two ticket embeddings, in [0,1].
   *
   * ⚠️ READ IT WITHIN A RESULT SET, NOT ACROSS QUERIES. It is the raw retrieval
   * score from Phase 10's embeddings — uncalibrated, and not a probability that
   * the two tickets share a cause.
   *
   * `[LIVE]` It IS reliably monotonic in relevance: 0.98 for the same issue,
   * 0.52–0.67 for a paraphrase, 0.47 for the same category, 0.36 for merely
   * similar wording, 0.20 for unrelated. But the absolute value depends on how
   * much boilerplate two texts share, so a 0.52 here can outrank a 0.65 there.
   * Compare results to each other, not to a remembered number.
   */
  similarity: number;
  /**
   * The last PUBLIC support reply, if there is one.
   *
   * Internal comments are never included — `is_internal` rows are "never
   * leaves the platform" by the schema's own comment, and a note written for
   * one ticket's handler is not context for another's.
   *
   * Null is a normal, meaningful value: the ticket was resolved without a
   * recorded public reply. It is still useful ("we have seen this"), so it is
   * surfaced rather than filtered out.
   */
  resolution: string | null;
  resolved_at: string | null;
  /**
   * Who handled this historical ticket — added in Phase 16.
   *
   * ⚠️ THE ONE INTERNAL IDENTIFIER THIS DTO CARRIES, and it is deliberate.
   * Suggested Assignees needs to know which eligible person resolved each
   * similar ticket; recomputing that with a second retrieval path would mean
   * two copies of the historical-corpus predicate, which is exactly what
   * Phases 11-15 avoided.
   *
   * It is safe on this surface: `/admin/api/tickets/:id/similar` is admin-only
   * and its callers can already enumerate these users through
   * `listUsers()`. `similar.integration.test.ts` permits this field by name and
   * still rejects ticket ids, product ids, tenant ids and raiser references.
   *
   * ⚠️ NOT rendered by the Similar Tickets UI, which shows references and
   * resolutions. Naming the handler of another customer's ticket in a support
   * panel is a different disclosure from using it to rank candidates.
   *
   * Null when the historical ticket was resolved with no assignee recorded —
   * common in this corpus, and simply means it contributes no attribution.
   */
  assignee_id: string | null;
}

export interface SimilarTicketsResponse {
  items: SimilarTicket[];
  /** Bounded, non-sensitive diagnostics. Never query, ticket or resolution text. */
  diagnostics: {
    /** Historical tickets eligible in this product, before ranking. */
    corpus: number;
    returned: number;
    embed_ms: number | null;
    retrieval_ms: number;
    rerank_ms: number | null;
    outcome: SimilarTicketsOutcome;
  };
}

export type SimilarTicketsOutcome =
  | 'ok'
  | 'no_corpus'
  | 'no_query_text'
  | 'embedding_unavailable';

/**
 * How many historical tickets are returned.
 *
 * Five fits the ticket-detail sidebar without scrolling, and one product's
 * entire historical corpus is currently 12–13 tickets, so a larger number would
 * simply return the whole history sorted by a score that stops meaning
 * anything past the first few.
 */
export const SIMILAR_TICKETS_LIMIT = 5;

/** Hard ceiling on what any caller may ask for. */
export const SIMILAR_TICKETS_MAX_LIMIT = 20;

/**
 * Characters of resolution text surfaced per result.
 *
 * The panel is a summary, not a transcript: enough to see what happened, and
 * the reference is right there to open the full ticket.
 */
export const SIMILAR_RESOLUTION_CHARS = 400;

/**
 * ⚠️ THERE IS DELIBERATELY NO SIMILARITY FLOOR, and that is a measured
 * decision rather than an omission.
 *
 * TWO MEASUREMENTS, and the second corrects the first.
 *
 * `[LIVE]` Comparing SEEDED tickets to each other — all 147 top-3 neighbour
 * pairs:
 *
 *     same subject (identical text)   n=16    all exactly 1.0000
 *     different subject               n=131   0.1828 .. 0.8053
 *
 * That looks like a clean threshold at ~0.9 and is misleading. Every seeded
 * description ends in the same formulaic tail, so unrelated pairs are inflated
 * to ~0.65 by shared boilerplate and "true matches" are simply duplicates.
 *
 * `[LIVE]` Comparing REALISTIC queries against that corpus — the Phase 14
 * evaluation, whose tickets are written normally:
 *
 *     exact same issue                 0.9848, 0.9770
 *     paraphrase                       0.6655, 0.5356, 0.5198
 *     same category, different issue   0.4720
 *     superficially similar wording    0.3599
 *     unrelated                        0.1969
 *
 * A clean monotonic gradient, and a very different picture: a genuine
 * paraphrase match scores 0.52 — BELOW the 0.65 that unrelated seeded pairs
 * reach. Any absolute floor calibrated on one of these measurements is wrong
 * for the other, because the score depends on how much boilerplate the two
 * texts happen to share.
 *
 * So the score is EXPOSED and the ranking returned unfiltered. It is reliably
 * MONOTONIC in relevance within a result set, which is what a reader needs; it
 * is not comparable across queries, which is what a threshold would require.
 * A support user seeing "20% match" can judge it. A hidden threshold cannot be
 * seen, and would have suppressed the 0.52 paraphrase above.
 */
export const SIMILAR_TICKETS_FLOOR = null;
