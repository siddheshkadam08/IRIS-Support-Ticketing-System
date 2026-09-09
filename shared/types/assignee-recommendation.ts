/**
 * Suggested Assignees — Phase 16.
 *
 * Given a ticket, suggest the people who could take it, with the evidence
 * behind each.
 *
 * ⚠️ THIS IS NOT AN AI FEATURE, and the wording matters because the word would
 * mislead. There is no model, no embedding of its own, no prompt, no Python
 * call, no score and no weights. It is three counts and a total order over
 * them, computed in SQL and compared in TypeScript. The Phase 10 embeddings are
 * reached only transitively, through the Phase 14 retrieval this reuses.
 *
 * ⚠️ IT SUGGESTS. IT DOES NOT ASSIGN.
 *
 * The endpoint is a GET that writes nothing — no ticket change, no comment, no
 * audit event, no outbox event. Assignment remains `POST
 * /admin/api/tickets/:id/assign`, written in Phase 1, which independently
 * re-validates caller scope, tenant, role and the state machine. A suggestion
 * confers no authorization whatsoever.
 *
 * ⚠️ AND IT DOES NOT MEASURE PEOPLE.
 *
 *     V1 produces evidence-based suggestions, not measured agent performance
 *     rankings.
 *
 * The corpus is 54 resolved tickets platform-wide, about two per candidate per
 * category. Every rate-shaped signal a performance ranking would need —
 * success rate, reopen rate, customer rating, resolution speed — was measured
 * and excluded: ratings contain only 4s and 5s, no reopen or reassignment has
 * ever been recorded, and `support_user.availability` is a default nobody
 * writes. Ordering therefore uses counts and says how thin they are, rather
 * than computing a number that would look like a judgement about a colleague.
 */

/** Bumped when eligibility, ordering, the category cap, the thresholds or K change. */
export const ASSIGNEE_RECOMMENDATION_VERSION = 'assignee-recommendation-v1';

/**
 * Roles that may be SUGGESTED.
 *
 * ⚠️ RECOMMENDATION ELIGIBILITY IS NARROWER THAN ASSIGNMENT AUTHORIZATION, and
 * deliberately so. The assign endpoint also admits `super_admin` through an
 * `OR u.role = 'super_admin'` branch, because a platform operator must be able
 * to act anywhere. That does not make them a sensible suggestion: a super_admin
 * holds no `support_user_scope` rows at all (migration 007 states this
 * explicitly), and none has ever been assigned a ticket in this platform.
 *
 * The INNER JOIN on `support_user_scope` therefore excludes them structurally,
 * and this list is the second, readable statement of the same rule.
 *
 * `product_admin` and `manager` are INCLUDED on evidence, not by assumption:
 * of the 54 historical tickets, 30 were handled by agents and 24 by product
 * admins. Excluding them would discard nearly half the evidence the platform
 * has.
 */
export const SUGGESTIBLE_ROLES = ['agent', 'product_admin', 'manager'] as const;
export type SuggestibleRole = (typeof SUGGESTIBLE_ROLES)[number];

/** Roles that may REQUEST suggestions. An agent may only assign themselves. */
export const SUGGESTION_VIEWER_ROLES = ['manager', 'product_admin', 'super_admin'] as const;

/**
 * Ordering cap on category experience.
 *
 * Above five, more history stops distinguishing candidates and starts letting
 * whoever has been here longest win by volume. The raw count is still reported;
 * only the ordering saturates.
 */
export const CATEGORY_EXPERIENCE_CAP = 5;

/**
 * Below this many historical tickets in the product, every response carries a
 * sparse-evidence caveat.
 *
 * ⚠️ Thirty is a readability threshold, not a statistical one — there is no
 * power calculation behind it and none is claimed. Every product currently
 * holds 12-18, so the caveat fires everywhere today. That is the intended
 * behaviour, not a misconfiguration.
 */
export const MIN_CORPUS_FOR_SPARSE_CAVEAT = 30;

/**
 * How much history a candidate has with this category.
 *
 * ⚠️ THE VOCABULARY IS PART OF THE CONTRACT. "Expertise", "specialist" and
 * "best" are absent at every level, including the top one: two tickets is not
 * expertise, and neither is six. These words describe the EVIDENCE, and the
 * strongest available claim is that some of it exists.
 */
export type CategoryExperienceLabel =
  | 'no relevant history'
  | 'limited history'
  | 'some relevant history'
  | 'meaningful historical evidence';

export function categoryExperienceLabel(count: number): CategoryExperienceLabel {
  if (!Number.isFinite(count) || count <= 0) return 'no relevant history';
  if (count <= 2) return 'limited history';
  if (count <= 5) return 'some relevant history';
  return 'meaningful historical evidence';
}

/**
 * How strong the evidence for a suggestion is.
 *
 * ⚠️ NOT A CONFIDENCE, and never rendered as a percentage. There is no
 * calibration behind it and a percentage would imply one. It describes the
 * EVIDENCE, not the person: "strong evidence" means several similar tickets
 * point at this candidate, not that they are a strong candidate.
 */
export type EvidenceStrength = 'strong' | 'moderate' | 'limited' | 'none';

/**
 * @param similarHits      how many of the K most similar historical tickets this candidate handled
 * @param categoryCount    RAW category count, uncapped — the cap is for ordering only
 */
export function evidenceStrength(similarHits: number, categoryCount: number): EvidenceStrength {
  const f1 = Number.isFinite(similarHits) ? Math.max(0, similarHits) : 0;
  const f2 = Number.isFinite(categoryCount) ? Math.max(0, categoryCount) : 0;

  if (f1 >= 3 || (f1 >= 2 && f2 >= 3)) return 'strong';
  if (f1 >= 1 || f2 >= 3) return 'moderate';
  if (f1 === 0 && f2 >= 1) return 'limited';
  return 'none';
}

/** One historical ticket supporting a suggestion. The Phase 14 evidence shape. */
export interface SuggestionEvidence {
  /** The human-facing handle, e.g. CARB-1011. Never an internal ticket id. */
  reference: string;
  title: string;
  similarity: number;
  resolved_at: string | null;
}

/**
 * The three factors. Counts, not scores.
 *
 * ⚠️ NOTE WHAT IS ABSENT: success rate, customer rating, resolution speed,
 * first-response speed, reopen rate, escalation rate, skill match, availability,
 * team fit, issue-type experience, recency. Each was measured during the Phase
 * 16 audit and excluded because the data cannot support it. See §44J.
 */
export interface SuggestionFactors {
  similar_tickets: {
    /** How many of the K most similar historical tickets this candidate handled. */
    count: number;
    /** Highest similarity among those, for tie-breaking and display. Null when count is 0. */
    best_similarity: number | null;
    label: string;
  };
  category_experience: {
    /** RAW count. The ordering cap is applied separately and is not shown. */
    count: number;
    label: CategoryExperienceLabel;
    /** The ticket's category, or null when it has none. */
    category: string | null;
  };
  active_tickets: {
    count: number;
    /**
     * ⚠️ ALWAYS "all products". The workload query has no product predicate —
     * a person's real load is their whole load — so the label prevents a
     * manager reading a cross-product number as an in-product one.
     */
    scope: 'all products';
    label: string;
  };
}

export interface AssigneeSuggestion {
  /** 1-based position in the returned order. Not a score. */
  rank: number;
  support_user_id: string;
  display_name: string;
  role: SuggestibleRole;
  evidence_strength: EvidenceStrength;
  /** One line an agent can read without expanding the factors. */
  summary: string;
  factors: SuggestionFactors;
  /** Historical tickets behind `similar_tickets`. Empty when there are none. */
  evidence: SuggestionEvidence[];
}

export type SuggestedAssigneesOutcome =
  | 'ok'
  | 'no_candidates'
  | 'no_evidence'
  /** Retrieval was unavailable; ordering fell back to category and workload. */
  | 'similar_unavailable';

export interface SuggestedAssigneesResponse {
  suggestions: AssigneeSuggestion[];
  /**
   * Response-level honesty. Sparse corpus, missing category, absent retrieval —
   * all surfaced here rather than left for the reader to infer from small
   * numbers.
   */
  caveats: string[];
  /** Bounded, non-sensitive. Never ticket text, evidence titles or display names. */
  diagnostics: {
    eligible_candidates: number;
    suggestions_returned: number;
    similar_hits: number;
    /** The Phase 14 outcome verbatim, so a degraded run is visible. */
    similar_outcome: string;
    historical_corpus: number;
    embed_ms: number | null;
    total_ms: number;
    algorithm_version: string;
    outcome: SuggestedAssigneesOutcome;
  };
}

/** What the comparator needs. A candidate reduced to its three counts. */
export interface RankableCandidate {
  support_user_id: string;
  similar_hits: number;
  best_similarity: number | null;
  category_count: number;
  active_ticket_count: number;
}

/**
 * The total order over candidates.
 *
 * ⚠️ NO SCORE AND NO WEIGHTS, deliberately. Three factors, two of which have
 * about two observations per candidate, cannot justify coefficients; a number
 * like 0.73 would be arithmetic dressed as measurement. Lexicographic
 * precedence is fully ordered, needs no weights to defend, and explains itself
 * in one sentence: more similar-ticket evidence wins.
 *
 *   1. similar-ticket hits      DESC   the strongest evidence
 *   2. best similarity          DESC   breaks equal counts by evidence quality
 *   3. category experience      DESC   capped, so volume cannot dominate
 *   4. active tickets           ASC    a tiebreak, never an override
 *   5. support_user_id          ASC    total, so ordering is stable
 *
 * Workload sits BELOW both evidence factors, so an overloaded candidate with
 * real evidence still ranks above an idle one without any. Step 5 is unique,
 * so repeated identical requests return an identical order.
 */
export function compareCandidates(a: RankableCandidate, b: RankableCandidate): number {
  if (a.similar_hits !== b.similar_hits) return b.similar_hits - a.similar_hits;

  const aSim = a.best_similarity ?? -1;
  const bSim = b.best_similarity ?? -1;
  if (aSim !== bSim) return bSim - aSim;

  const aCat = Math.min(a.category_count, CATEGORY_EXPERIENCE_CAP);
  const bCat = Math.min(b.category_count, CATEGORY_EXPERIENCE_CAP);
  if (aCat !== bCat) return bCat - aCat;

  if (a.active_ticket_count !== b.active_ticket_count) {
    return a.active_ticket_count - b.active_ticket_count;
  }

  return a.support_user_id < b.support_user_id ? -1 : a.support_user_id > b.support_user_id ? 1 : 0;
}

/** The one-line "why suggested", assembled from the factors that are non-zero. */
export function suggestionSummary(args: {
  similarHits: number;
  categoryCount: number;
  category: string | null;
}): string {
  const parts: string[] = [];

  if (args.similarHits > 0) {
    parts.push(
      `${args.similarHits} similar resolved ticket${args.similarHits === 1 ? '' : 's'}`,
    );
  }
  if (args.categoryCount > 0 && args.category) {
    parts.push(`${categoryExperienceLabel(args.categoryCount)} in ${args.category}`);
  }
  // ⚠️ Never invent a reason. A candidate with no evidence says so plainly
  // rather than being described by their workload, which is not a reason to
  // give someone a ticket.
  if (parts.length === 0) return 'No relevant historical evidence for this ticket';

  return parts.join('; ');
}
