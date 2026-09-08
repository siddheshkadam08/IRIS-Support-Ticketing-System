/**
 * Hybrid retrieval contracts — Phase 11.
 *
 * Three retrieval strategies over one corpus, fused into one ranking:
 *
 *     FTS      lexical, stemmed, weighted title > body   (existing, reused)
 *     trigram  character-level, survives typos           (existing, reused)
 *     vector   semantic, Phase 10 embeddings             (existing, reused)
 *
 * ⚠️ RETRIEVAL RANKS. IT DOES NOT DECIDE. Nothing here can change a ticket's
 * priority, severity, status, assignment, routing or authorization — it has no
 * field for any of them and writes nothing. It orders rows the caller was
 * already allowed to see.
 */

/**
 * The two corpora, kept DISTINCT in the result rather than flattened.
 *
 * A KB article is an answer someone wrote deliberately; a resolved ticket is a
 * record that someone else hit this and what happened. They are both useful and
 * they are not interchangeable, so `source_type` survives ranking and the
 * widget can present them differently — which it already does.
 */
export type RetrievalSource = 'kb_article' | 'resolved_ticket';

/** Which strategies contributed, and where they placed the row. */
export interface RetrievalSignals {
  /** 1-based rank within that strategy's own candidate list; absent if it did not match. */
  fts?: number;
  trigram?: number;
  vector?: number;
  /** Raw cosine similarity in [0,1], for explainability. Never the vector itself. */
  similarity?: number;
  /** True when this row was found by exact identifier lookup rather than ranked. */
  exact?: boolean;
}

export interface RetrievalHit {
  source_type: RetrievalSource;
  source_id: string;
  title: string;
  snippet: string;
  /** Normalised fusion score in [0,1]. See fuseRankings(). */
  hybrid_score: number;
  signals: RetrievalSignals;
}

// ─────────────────────────────────────────────────────────────────────────
// Query normalisation
// ─────────────────────────────────────────────────────────────────────────

/**
 * Hard bound on the query text.
 *
 * Protects three different things at once: a `tsquery` built from a very long
 * string is expensive to plan, a trigram scan over one is expensive to run, and
 * an embedding request for one costs real money. 400 characters is far more
 * than any real support question and far less than any of those hurt.
 */
export const QUERY_MAX_CHARS = 400;

/** Below this there is not enough signal to retrieve on; the caller gets nothing. */
export const QUERY_MIN_CHARS = 2;

/**
 * Deterministic query normalisation.
 *
 * ⚠️ NO LOWERCASING. Postgres `to_tsvector`/`websearch_to_tsquery` and
 * `similarity()` already fold case themselves, and the embedding model is
 * case-aware in ways that carry meaning ("IT" vs "it"). Lowercasing here would
 * be a second, redundant transformation that only makes the query different
 * from the text it is compared against.
 *
 * ⚠️ NO QUERY REWRITING, NO EXPANSION, NO LLM. Deliberately out of scope: they
 * make retrieval non-deterministic and unexplainable, and Phase 11 needs both.
 */
export function normalizeQuery(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  // Collapse every whitespace run — including newlines and tabs — then trim.
  // Collapse-then-trim, matching the Phase 10 canonical form: `trim()` alone
  // would leave interior runs and a lone newline would survive as content.
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  return collapsed.slice(0, QUERY_MAX_CHARS);
}

export function isSearchableQuery(normalized: string): boolean {
  return normalized.length >= QUERY_MIN_CHARS;
}

/**
 * Does this query look like a ticket reference?
 *
 * Matches the shape `ticket.reference` actually has — a product prefix, a
 * hyphen and digits (CARB-5147) — anchored, so it cannot fire on prose. Used
 * only to decide whether an exact lookup is worth ONE extra indexed query; the
 * lookup itself is parameterised and its result is verified, so a false
 * positive costs a fast miss and nothing else.
 */
const REFERENCE_RE = /^[A-Za-z][A-Za-z0-9]{1,11}-\d{1,10}$/;

export function looksLikeReference(normalized: string): boolean {
  return REFERENCE_RE.test(normalized);
}

// ─────────────────────────────────────────────────────────────────────────
// Candidate limits
// ─────────────────────────────────────────────────────────────────────────

/**
 * Candidates each strategy may contribute, per source type.
 *
 * Chosen against the MEASURED corpus, not copied from a paper: one product owns
 * 12 published articles and ~12 resolved tickets with a resolution. A limit of
 * 25 therefore cannot truncate a single tenant's corpus today — recall is
 * complete and the limit exists purely so it stays bounded as the corpus grows.
 *
 * Picking 100 or 500 here would have been indistinguishable in behaviour and
 * would have hidden the fact that nobody had measured.
 */
export const CANDIDATES_PER_STRATEGY = 25;

/** Hard ceiling on what any caller can ask for. */
export const MAX_RESULTS = 20;

/**
 * ⚠️ THE FLOOR THAT PRESERVES "no plausible answer" — the single most
 * behaviour-critical constant in Phase 11.
 *
 * Lexical retrieval has a natural floor: `search_tsv @@ query` matches nothing
 * for an off-topic question, so `ask()` returns no answers and the widget
 * offers the ticket form instead. Vector retrieval has NO such property —
 * `ORDER BY embedding <=> q LIMIT k` always returns k rows, however irrelevant.
 * Adding it without a floor would turn every unanswerable question into a
 * confident-looking answer and suppress the ticket form: a silent regression in
 * business behaviour that no test of "does search work" would catch.
 *
 * `[LIVE]` Measured on the real corpus (scripts/retrieval-calibrate.ts), top-1
 * cosine similarity:
 *
 *     relevant questions      0.425 .. 0.513
 *     irrelevant questions    0.084 .. 0.217     (plausible English, not gibberish)
 *
 * A clean 0.208 gap. 0.30 sits above every irrelevant observation with margin
 * while staying well below every relevant one.
 *
 * ⚠️ WHAT IT COSTS, MEASURED RATHER THAN ASSUMED. The Phase 11 evaluation
 * found the one case where this floor loses a genuinely correct answer: the
 * query "we hired someone new last week" matches "Adding a new user to your
 * organisation" at similarity 0.2344 — below the floor, so it is excluded and
 * that query returns nothing.
 *
 * The floor was NOT lowered to recover it. The highest irrelevant observation
 * is 0.217, so a floor at 0.22 would carry a margin of 0.003 against a
 * population measured from 12 samples: that is not a floor, it is a coin flip,
 * and losing it means unanswerable questions start returning confident answers
 * instead of the ticket form.
 *
 * The exchange is therefore explicit: 1 missed answer in 24 labelled queries,
 * against reliably correct behaviour on questions the corpus cannot answer.
 * A relative floor (keep rows within X of the top similarity) would plausibly
 * get both and is recorded as deferred work rather than guessed at here.
 */
export const VECTOR_SIMILARITY_FLOOR = 0.3;

/**
 * Trigram floor — RAISED from the 0.15 the existing `searchArticles` uses, on
 * evidence rather than taste.
 *
 * ⚠️ 0.15 ADMITS FALSE POSITIVES, and end-to-end testing caught one: the query
 * "how do I renew my passport at the embassy" scored 0.1930 against "How to
 * reset your password" — `passport` and `password` share most of their
 * trigrams — and surfaced a password-reset article as the answer to a question
 * about travel documents.
 *
 * `[LIVE]` Measured over 12 typo queries and 12 plausible-but-unanswerable
 * questions against the real corpus, max `similarity(title, query)`:
 *
 *     typo queries          min 0.2222   p50 0.3149   max 0.4688
 *     irrelevant queries    min 0.0588   p50 0.1285   max 0.1930
 *
 * 0.20 sits in the 0.029 gap: below every typo (margin 0.022) and above every
 * irrelevant one (margin 0.007). It leans toward the typo side deliberately —
 * a missed typo is a failed search, while a false positive is a mildly odd
 * suggestion that still has to win on rank.
 *
 * ⚠️ THE MARGIN ON THE IRRELEVANT SIDE IS THIN, and honestly so: 24 samples
 * cannot establish more than "these populations separate here". Trigram is the
 * lowest-weighted strategy for exactly this reason.
 *
 * `searchArticles` keeps its own 0.15 — that endpoint is a KB browse/filter
 * surface with different behaviour, and changing it is not this phase's job.
 */
export const TRIGRAM_SIMILARITY_FLOOR = 0.2;

// ─────────────────────────────────────────────────────────────────────────
// Fusion
// ─────────────────────────────────────────────────────────────────────────

export type StrategyName = 'fts' | 'trigram' | 'vector';

/**
 * Strategy weights. They sum to 1, which is what makes the normalised score
 * land in [0,1].
 *
 * ⚠️ WHY THESE NUMBERS. Phase 10 measured, on 20 paraphrase queries against
 * this corpus: vector Top-1 90%, lexical Top-1 15%. But those queries were
 * written with deliberately little lexical overlap, so they measure the
 * paraphrase case only — on an exact keyword or a product term, FTS is the
 * precise signal and vector is the vague one. Neither dominates in general, so
 * they are weighted equally and trigram, which exists to recover typos rather
 * than to rank, gets half.
 *
 * These are a starting point validated against the Phase 11 evaluation set, not
 * a tuned optimum. Tuning them on 20-odd hand-labelled queries would be
 * overfitting with extra steps.
 */
export const STRATEGY_WEIGHTS: Readonly<Record<StrategyName, number>> = {
  fts: 0.4,
  vector: 0.4,
  trigram: 0.2,
};

/**
 * The RRF damping constant.
 *
 * ⚠️ NOT 60. The value from the original RRF paper is tuned for TREC runs of
 * thousands of documents, where the difference between rank 1 and rank 40 must
 * stay small. Our candidate lists hold at most 25 rows, and at K=60 the whole
 * list compresses into 1/61 .. 1/85 — a 28% spread across the entire ranking,
 * which is not enough to separate a perfect hit from a marginal one.
 *
 * K=10 keeps RRF's essential property (rank matters, raw scale does not) while
 * spreading the same 25 positions over 1/11 .. 1/35, a factor of three. Chosen
 * against the list length that actually exists here.
 */
export const RRF_K = 10;

/**
 * Weighted Reciprocal Rank Fusion, normalised to [0,1].
 *
 *     score(d) = Σ_s  w_s / (K + rank_s(d))          for strategies that ranked d
 *     normalised = score(d) / Σ_s w_s / (K + 1)
 *
 * so a row ranked first by EVERY strategy scores exactly 1.0, and a row ranked
 * first by one strategy alone scores that strategy's weight.
 *
 * ⚠️ WHY RANK FUSION AND NOT SCORE FUSION. The three signals are not
 * commensurable and cannot be made so by arithmetic:
 *
 *   ts_rank              unbounded, typically 0.01 .. 0.5, corpus-dependent
 *   trigram similarity   [0,1], but measures character overlap, not relevance
 *   cosine similarity    [0,1], but 0.4 is already a STRONG semantic match
 *
 * `[LIVE]` The existing `searchArticles` demonstrates the failure directly: it
 * adds `ts_rank * 4 + similarity(title, q)` and produces 4.5073 for a good
 * lexical match and 0.2903 for a typo match — a 15x spread driven by scale
 * rather than by relevance. Min-max normalising per query would fix the scale
 * but introduce a worse problem: with one candidate the max IS the min, so
 * every single-hit query would score either 0 or 1 depending on which end you
 * pick, and scores would stop being comparable BETWEEN queries — which is
 * exactly what `min_score` needs them to be.
 *
 * Rank fusion sidesteps all of it. It needs no per-query statistics, it is
 * unaffected by any strategy's scale, a missing strategy simply contributes
 * nothing, and the result is identical for identical input. Its known cost is
 * that it discards magnitude — which is why the similarity FLOOR, not the
 * score, is what keeps irrelevant rows out.
 *
 * @param ranked one entry per strategy: candidate keys in that strategy's order
 */
export function fuseRankings(
  ranked: Partial<Record<StrategyName, readonly string[]>>,
  weights: Readonly<Record<StrategyName, number>> = STRATEGY_WEIGHTS,
  k: number = RRF_K,
): Map<string, { score: number; ranks: Partial<Record<StrategyName, number>> }> {
  const out = new Map<string, { score: number; ranks: Partial<Record<StrategyName, number>> }>();

  // The denominator uses EVERY declared strategy weight, not just the ones that
  // returned candidates. If a failed strategy shrank the denominator, the same
  // row would score higher during an outage than in normal operation — scores
  // would silently stop being comparable across requests, and `min_score` would
  // mean something different depending on whether Azure was up.
  let maxPossible = 0;
  for (const w of Object.values(weights)) maxPossible += w / (k + 1);

  for (const [strategy, keys] of Object.entries(ranked) as Array<
    [StrategyName, readonly string[] | undefined]
  >) {
    if (!keys) continue;
    const weight = weights[strategy] ?? 0;
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]!;
      const rank = i + 1;
      const entry = out.get(key) ?? { score: 0, ranks: {} };
      // A strategy may not list the same key twice; if it does, the first
      // (better) rank is the one that counts.
      if (entry.ranks[strategy] === undefined) {
        entry.ranks[strategy] = rank;
        entry.score += weight / (k + rank);
      }
      out.set(key, entry);
    }
  }

  if (maxPossible > 0) {
    for (const entry of out.values()) entry.score = entry.score / maxPossible;
  }
  return out;
}

/**
 * The composite identity a candidate is deduplicated on.
 *
 * `source_type + source_id`, never the title or the body. The corpus contains
 * the same 12 article titles in all four products with byte-identical text —
 * deduplicating on text would collapse four tenants' rows into one and hand
 * whichever survived to whoever asked. Deduplicating on id cannot.
 */
export function candidateKey(sourceType: RetrievalSource, sourceId: string): string {
  return `${sourceType}:${sourceId}`;
}

export function parseCandidateKey(key: string): { sourceType: RetrievalSource; sourceId: string } {
  const cut = key.indexOf(':');
  return {
    sourceType: key.slice(0, cut) as RetrievalSource,
    sourceId: key.slice(cut + 1),
  };
}

/**
 * Total, deterministic ordering.
 *
 * Score alone is NOT a total order: identical text in two products produces
 * identical vectors and identical lexical ranks, so ties are guaranteed here
 * rather than hypothetical. Without a tiebreak the same query would return the
 * same rows in a different order on different runs, which makes pagination
 * incoherent and every ranking test flaky. Falling back to the key gives one
 * fixed answer.
 */
export function compareHits(a: RetrievalHit, b: RetrievalHit): number {
  if (b.hybrid_score !== a.hybrid_score) return b.hybrid_score - a.hybrid_score;
  const ka = candidateKey(a.source_type, a.source_id);
  const kb = candidateKey(b.source_type, b.source_id);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}
