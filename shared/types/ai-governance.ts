/**
 * The governance corpus — which AI executions may be measured.
 *
 * Pre-Phase-17 hardening, findings G-5 and G-6.
 *
 * ⚠️ WITHOUT THIS RULE, EVERY GOVERNANCE NUMBER IS WRONG.
 *
 * `ai_execution` holds 12,787 rows, and two thirds of them are not AI. 8,492
 * are `noop` — a stub feature whose whole purpose is fault injection for the
 * Phase 3 reliability tests, deliberately failing about 40% of the time. Another
 * 1,586 carry error codes written only by test files. A naive "AI success rate"
 * over that table reports the test suite:
 *
 *     naive over everything     53% success        meaningless
 *     governance corpus         classification 99.2%, summary 86.3%
 *
 * The rule is therefore part of the contract rather than a WHERE clause someone
 * remembers to paste, and `GOVERNANCE_CORPUS_SQL` is the single place it lives.
 *
 * ⚠️ THIS IS NOT A SECURITY BOUNDARY. Product isolation is RLS plus the
 * product predicate, exactly as before; this only decides what counts as a
 * measurable execution. It must always be combined with, never substituted for,
 * the scoping every other query already does.
 */

/**
 * Features whose executions are real AI work.
 *
 * ⚠️ `noop` IS EXCLUDED, and it is the single most important exclusion here. It
 * is the Phase 1 stub: no provider, no model, no prompt, and an injected
 * failure rate. Live counts — 8,492 executions, 5,069 of them "failed" — would
 * dominate every rate in the platform if admitted.
 *
 * Derived from `SUPPORTED_AI_FEATURES` minus the stub, not hand-maintained: a
 * future queue feature is measurable the moment it is supported.
 */
export const GOVERNANCE_FEATURES = ['classification', 'summary'] as const;
export type GovernanceFeature = (typeof GOVERNANCE_FEATURES)[number];

/**
 * Error codes written ONLY by test files, never by production code.
 *
 * Traced, not assumed:
 *
 *   test_cleanup        core-service/src/admin/ai-ops.test.ts:207
 *                       core-service/src/events/ai-reaper.test.ts:158
 *   legacy_test_debris  historical fixture marker; no production writer
 *
 * ⚠️ `abandoned` IS DELIBERATELY ABSENT FROM THIS LIST.
 *
 * It looked like test data — 1,486 rows — but it is written by the real reaper
 * at `core-service/src/events/ai-reaper.ts:369`, and tests merely write it too.
 * It is MIXED, and blanket-excluding it would delete the one signal that says
 * an execution was stranded and had to be closed by the reaper. Once `noop` is
 * excluded only 12 `abandoned` rows remain, and every one carries the reaper's
 * own message. Real operational outcomes stay in.
 *
 * The same reasoning keeps `retries_exhausted`: BullMQ giving up is a genuine
 * failure, not an artefact.
 */
export const TEST_ARTIFACT_ERROR_CODES = ['test_cleanup', 'legacy_test_debris'] as const;

/**
 * The corpus predicate, for use inside a scoped query.
 *
 * ⚠️ USE IT AS A PREDICATE, NOT AS A FILTER APPLIED AFTERWARDS — the rule every
 * phase since 11 has followed. It carries no parameters, so it composes with
 * the caller's own product scoping without renumbering placeholders.
 *
 * Assumes the table is aliased `e`, matching the existing `ai_execution`
 * queries in `ai-ops.routes.ts`.
 */
export const GOVERNANCE_CORPUS_SQL = `
      e.feature = ANY (ARRAY['${GOVERNANCE_FEATURES.join("','")}'])
  AND (e.error_code IS NULL
       OR e.error_code <> ALL (ARRAY['${TEST_ARTIFACT_ERROR_CODES.join("','")}']))`;

/**
 * The same rule in TypeScript, for tests and for anything already holding rows.
 *
 * Kept beside the SQL on purpose: two copies of a rule that can disagree is
 * worse than one, and a test that asserts they agree is cheap.
 */
export function isGovernanceExecution(row: {
  feature: string;
  error_code: string | null;
}): boolean {
  if (!(GOVERNANCE_FEATURES as readonly string[]).includes(row.feature)) return false;
  if (row.error_code === null) return true;
  return !(TEST_ARTIFACT_ERROR_CODES as readonly string[]).includes(row.error_code);
}

/**
 * ⚠️ WHAT THE CORPUS STILL CANNOT TELL YOU, and Phase 17 must say out loud.
 *
 * Filtering the population makes rates honest. It does not create signals that
 * were never captured:
 *
 *   - COST. No token counts exist anywhere — `AIResult` has no usage fields and
 *     the provider's `usage` object is discarded. Cost is not derivable and
 *     must not be estimated.
 *   - ACCURACY. There is no labelled ground truth. A classification that was
 *     never corrected is not a classification that was right.
 *
 *     ⚠️ PHASE 20 CHANGED HALF OF THIS SENTENCE AND NOT THE OTHER HALF.
 *     Until Phase 20 no endpoint could change a ticket's category, so no
 *     correction existed to count. One does now — `ticket.classification_-
 *     corrected` — and Phase 21 counts it. What is still absent is the
 *     DENOMINATOR: a correction and the classification it replaced fall in
 *     different windows, and a corrected ticket's `classification_source`
 *     becomes 'human', so it leaves any denominator built from the ticket
 *     table exactly as the numerator grows. `human_correction_rate` therefore
 *     stays on this list. Counting corrections is measurable; expressing them
 *     as a rate against AI output is not.
 *   - CONFIDENCE AS CORRECTNESS. `confidence` is the model's own uncalibrated
 *     signal. It is comparable across executions of the same feature and says
 *     nothing about whether an answer was correct.
 *   - PER-ATTEMPT FAILURE. One row per (event_id, feature), updated in place.
 *     `attempt` says how many tries; only the terminal reason survives.
 */
export const GOVERNANCE_UNMEASURABLE = [
  'cost',
  'token_usage',
  'accuracy',
  'human_correction_rate',
  'per_attempt_failure_reason',
] as const;

// ═════════════════════════════════════════════════════════════════════════
// Phase 17 — the governance read model
// ═════════════════════════════════════════════════════════════════════════

/**
 * The version of the MEANING of these numbers, not of the code that renders
 * them.
 *
 * Bump it when the corpus rule, a population definition, a metric formula, a
 * metric's population, the failure mapping, confidence semantics, the sample
 * threshold, the replay predicate or the prohibited-claim policy changes —
 * anything that makes today's figure incomparable with yesterday's. Never bump
 * it for layout, colour, copy or ordering; a version that changes on a CSS
 * tweak stops meaning anything.
 */
export const AI_GOVERNANCE_VERSION = 'ai-governance-v1';

/**
 * ⚠️ THE CENTRAL RULE OF PHASE 17: A METRIC IS A FORMULA PLUS A POPULATION.
 *
 * The first draft of this design used "governance corpus" for two different
 * sets — what is measurable, and what the headline numbers are actually
 * computed over — and the two are not the same set. Naming the layers, and
 * making every metric declare which one it stands on, is what stops
 * denominators drifting apart between one number and the next.
 *
 *   scoped    L1   everything the caller may see, in this window, after filters
 *   corpus    L2   L1 minus what is not real AI work (GOVERNANCE_CORPUS_SQL)
 *   headline  L3   L2 minus replays  ← EVERY HEADLINE METRIC STANDS HERE
 *   replay    L3'  L2 keeping only replays
 *
 * And the identity that must hold, asserted by test against live data:
 *
 *   L1 = L2 + excluded_by_corpus_rule
 *   L2 = L3 + L3'
 */
export const POPULATION_LAYERS = ['scoped', 'corpus', 'headline', 'replay'] as const;
export type PopulationLayer = (typeof POPULATION_LAYERS)[number];

/**
 * A metric's declared population: a layer, optionally narrowed.
 *
 * A narrowing is written `headline+succeeded+latency`. It says the metric still
 * stands on L3 and merely drops rows that cannot contribute — a latency
 * percentile cannot use a row that has no latency. Every narrowed metric
 * publishes its own smaller `n`, so a reader watches the denominator shrink
 * instead of having to assume it did.
 */
export type MetricPopulation = string;

/**
 * Below this many observations a rate is suppressed and only counts are shown.
 *
 * ⚠️ A PRESENTATION CONVENTION, NOT A POWER CALCULATION. Under 30 observations
 * one event moves a percentage by more than three points, so the count carries
 * more information than the rate does. It reuses the threshold Phase 14 already
 * chose for sparse corpora rather than inventing a second number that would
 * then have to be kept in step with it.
 */
export const MIN_SAMPLE_FOR_RATE = 30;

/**
 * How much evidence a rate stands on — Phase 21.
 *
 * ⚠️ `rate_suppressed: boolean` CANNOT SAY WHICH KIND OF NOTHING THIS IS, and
 * the difference matters more than the rate does. "No corrections happened" and
 * "corrections happened but too few to express as a share" are different facts
 * about the platform, and collapsing them into one flag pushes the reader
 * toward the wrong one — usually toward reading an absent percentage as zero.
 *
 *   none          0 eligible observations. There is nothing to divide.
 *   insufficient  1..MIN_SAMPLE_FOR_RATE-1. A share exists but is not worth
 *                 reading; the count is published instead.
 *   sufficient    >= MIN_SAMPLE_FOR_RATE. The share is published.
 *
 * The rate is `null` in BOTH withheld states and never 0. A zero percent is a
 * measurement; an absent percentage is an admission.
 */
export const SAMPLE_STATES = ['none', 'insufficient', 'sufficient'] as const;
export type SampleState = (typeof SAMPLE_STATES)[number];

/** The single place the three states are decided, so no caller can disagree. */
export function sampleStateOf(denominator: number): SampleState {
  if (denominator <= 0) return 'none';
  return denominator < MIN_SAMPLE_FOR_RATE ? 'insufficient' : 'sufficient';
}

/** Maximum queryable span. A year plus a day, so a leap year still fits. */
export const MAX_GOVERNANCE_WINDOW_DAYS = 366;
export const DEFAULT_GOVERNANCE_WINDOW_DAYS = 30;

// ── Failure taxonomy ─────────────────────────────────────────────────────

/**
 * Operator-readable failure categories.
 *
 * BOTH the category and the raw `error_code` are reported. The category is what
 * an operator can act on; the code is what an engineer needs. Showing only the
 * category would hide which of several codes fired; showing only the code would
 * make the panel unreadable to the person it is for.
 */
export const FAILURE_CATEGORIES = [
  'provider_refused_content',
  'provider_rate_limited',
  'provider_error',
  'timeout',
  'provider_unreachable',
  'output_rejected_by_iris',
  'bad_request',
  'retries_exhausted',
  'stranded',
  'unclassified',
] as const;
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

export const FAILURE_CATEGORY_LABEL: Record<FailureCategory, string> = {
  provider_refused_content: 'Provider refused content',
  provider_rate_limited: 'Provider rate limited',
  provider_error: 'Provider error',
  timeout: 'Timeout',
  provider_unreachable: 'Provider unreachable',
  output_rejected_by_iris: 'Output rejected by IRIS',
  bad_request: 'Bad request',
  retries_exhausted: 'Retries exhausted',
  stranded: 'Stranded',
  unclassified: 'Unclassified',
};

const FAILURE_EXACT: Record<string, FailureCategory> = {
  provider_content_filter: 'provider_refused_content',
  provider_http_429: 'provider_rate_limited',
  ai_service_timeout: 'timeout',
  ai_service_unreachable: 'provider_unreachable',
  provider_not_configured: 'provider_unreachable',
  invalid_ai_output: 'output_rejected_by_iris',
  malformed_ai_response: 'output_rejected_by_iris',
  invalid_input: 'bad_request',
  unsupported_feature: 'bad_request',
  retries_exhausted: 'retries_exhausted',
  abandoned: 'stranded',
};

/** A 5xx from either hop is a provider error. Nothing else is inferred. */
const FAILURE_PATTERNS: ReadonlyArray<readonly [RegExp, FailureCategory]> = [
  [/^(?:provider|ai)_http_5\d\d$/, 'provider_error'],
];

/**
 * ⚠️ AN UNKNOWN CODE FALLS INTO `unclassified` AND KEEPS ITS RAW CODE.
 *
 * A map that swallowed codes it did not recognise would hide precisely the new
 * failure mode someone needs to see. Today 264 of the 282 corpus failures are
 * `ai_http_422` — the pre-G-3 collapse of everything the AI service refused —
 * and they land here, visibly, rather than being guessed into a category the
 * data does not support.
 */
export function failureCategoryOf(errorCode: string | null): FailureCategory {
  if (!errorCode) return 'unclassified';
  const exact = FAILURE_EXACT[errorCode];
  if (exact) return exact;
  for (const [pattern, category] of FAILURE_PATTERNS) {
    if (pattern.test(errorCode)) return category;
  }
  return 'unclassified';
}

// ── Confidence presentation ──────────────────────────────────────────────

/** Ten equal buckets across [0,1]. 1.0 belongs to the last bucket, not an 11th. */
export const CONFIDENCE_BUCKET_COUNT = 10;

export function confidenceBucketLabel(index: number): string {
  const lo = index / CONFIDENCE_BUCKET_COUNT;
  const hi = (index + 1) / CONFIDENCE_BUCKET_COUNT;
  return `${lo.toFixed(1)}–${hi.toFixed(1)}`;
}

/**
 * ⚠️ THE SENTENCE THAT MUST ACCOMPANY EVERY CONFIDENCE FIGURE.
 *
 * `confidence` is the weakest link of four numbers the model reported about
 * itself. Nothing has ever checked those numbers against an outcome, because
 * IRIS holds no ground truth to check them against.
 */
export const CONFIDENCE_DISCLAIMER =
  'Uncalibrated model signal — not a probability that the output is correct.';

export const OPERATIONAL_COUNTS_DISCLAIMER =
  'These are operational counts. They do not measure whether the AI was right — ' +
  'IRIS has no ground truth to check against.';

export const NO_ACCURACY_DISCLAIMER =
  'No accuracy metric exists — IRIS has no ground truth to check against.';

export const COPILOT_DISCLAIMER =
  'Copilot drafts are ephemeral by design. What an agent did with a draft is not recorded.';

/**
 * ⚠️ THE SENTENCE THAT MUST ACCOMPANY EVERY CORRECTION FIGURE — Phase 21.
 *
 * A correction is evidence that a human made a decision. It is NOT evidence
 * that the AI was wrong: a reviewer may be applying product knowledge the model
 * never had, reclassifying after the customer clarified, or simply disagreeing.
 * The audit trail records the change, not its justification, so a count here
 * labelled an error rate would assert something nobody measured.
 */
export const CORRECTION_DISCLAIMER =
  'A correction records that an authorized human changed the classification. ' +
  'It does not establish that the AI was wrong.';

// ── Vocabulary policy ────────────────────────────────────────────────────

/**
 * ⚠️ PROHIBITED POSITIVE CLAIMS — and note carefully what this list is NOT.
 *
 * The first version of this rule said "these strings must not appear on the
 * page", and it contradicted itself immediately: the required disclaimer above
 * contains the word "correct", and the sentence denying an accuracy metric
 * contains the word "accuracy". A blanket string scan would have failed on the
 * very copy that makes the page honest, and the natural way to make such a test
 * pass is to delete the disclaimer — the exact opposite of the intent.
 *
 * So the rule targets USE, not characters. These terms may not appear as:
 *
 *   an API response key, an enum value, a metric name,
 *   a heading, a KPI label, a column header, a chart or axis title
 *
 * — anywhere a term ASSERTS a property of the AI. They may appear freely inside
 * an element marked `data-governance-disclaimer`, which by construction denies
 * the property rather than claiming it.
 */
export const PROHIBITED_CLAIM_TERMS = [
  'accuracy',
  'accurate',
  'precision',
  'recall',
  'f1',
  'calibrated',
  'correctness',
  'quality_score',
  'quality score',
  'reliability',
  'confidence_pct',
] as const;

/** The attribute marking an element as denying a claim rather than making one. */
export const DISCLAIMER_ATTRIBUTE = 'data-governance-disclaimer';

/**
 * Does this label assert something the data cannot support?
 *
 * Used against API keys, enum values and UI labels — never against disclaimer
 * prose, which the rule above exempts.
 *
 * ⚠️ A TERM PRECEDED BY A LETTER IS A DIFFERENT WORD, AND OFTEN THE OPPOSITE
 * ONE. `uncalibrated` is the honest label for the confidence signal and
 * `inaccurate` denies precisely what `accurate` would claim; a naive substring
 * match flags both, which is the same denial-mistaken-for-a-claim error that
 * made the first version of this rule contradict its own required copy — only
 * at the level of a token rather than an element. So the match requires the
 * term to begin a word.
 *
 * It deliberately does NOT require the term to END one: `calibrated_confidence`
 * and `quality_score_v2` are claims, and a trailing boundary would let both
 * through.
 */
export function assertsProhibitedClaim(label: string): boolean {
  return PROHIBITED_CLAIM_TERMS.some((term) =>
    new RegExp(`(?<![A-Za-z])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(label),
  );
}

// ── Response DTOs ────────────────────────────────────────────────────────

export interface GovernanceWindow {
  from: string;
  to: string;
  days: number;
}

export interface GovernanceFilters {
  product_id: string | null;
  feature: string | null;
  provider: string | null;
  model: string | null;
  prompt_version: string | null;
}

/** The honesty panel: the arithmetic behind every other number on the page. */
export interface PopulationPanel {
  /** L1 — everything visible in this window, after filters. */
  scoped: number;
  excluded_from_corpus: Array<{ reason: string; n: number }>;
  /** L2 — measurable AI work. */
  corpus: number;
  /** L3' — operator re-runs, reported separately. */
  replays: number;
  /** L3 — the denominator of every headline metric. */
  headline: number;
  /** L1 = L2 + excluded, and L2 = L3 + L3'. Computed, never assumed. */
  identity_holds: boolean;
}

export interface Percentiles {
  population: MetricPopulation;
  n: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

export interface CountRow {
  key: string;
  n: number;
}

export interface GovernanceResponse {
  window: GovernanceWindow;
  filters: GovernanceFilters;
  population: PopulationPanel;

  executions: {
    population: MetricPopulation;
    n: number;
    succeeded: number;
    failed: number;
    running: number;
    /** Null when suppressed. NEVER 0 standing in for "not enough data". */
    success_rate: number | null;
    success_rate_n: number;
    rate_suppressed: boolean;
  };

  by_feature: {
    population: MetricPopulation;
    rows: Array<{
      feature: string;
      n: number;
      succeeded: number;
      failed: number;
      running: number;
      /** How many rows carried a confidence. Zero is a fact about the feature. */
      with_confidence: number;
    }>;
  };

  latency: {
    /** Time inside the provider call. NOT what a user waits. */
    provider: Percentiles;
    /** created_at → completed_at, retries and backoff included. */
    wall_clock: Percentiles;
    /** Outbox row → execution start. */
    queue_delay: Percentiles;
  };

  attempts: {
    population: MetricPopulation;
    n: number;
    rows: Array<{ attempt: number; n: number }>;
  };

  failures: {
    population: MetricPopulation;
    n: number;
    rows: Array<{ category: FailureCategory; label: string; error_code: string | null; n: number }>;
  };

  confidence: {
    population: MetricPopulation;
    n: number;
    /** ⚠️ Always rendered with CONFIDENCE_DISCLAIMER beside it. */
    signal: 'uncalibrated';
    buckets: Array<{ bucket: number; label: string; n: number }>;
    features_without_confidence: string[];
  };

  routing: {
    population: MetricPopulation;
    n: number;
    /** ⚠️ Decided by Core from thresholds. Not model output. */
    decided_by: 'iris_core';
    rows: CountRow[];
  };

  inventory: {
    population: MetricPopulation;
    n: number;
    rows: Array<{
      provider: string | null;
      model: string | null;
      model_version: string | null;
      prompt_version: string | null;
      n: number;
    }>;
  };

  /** ⚠️ A DIFFERENT SOURCE AND A DIFFERENT DENOMINATOR. Never summed with the above. */
  copilot: {
    source: 'audit_event';
    population: 'copilot_invocations';
    invocations: number;
    outcomes: CountRow[];
    total_ms: Percentiles;
    generation_ms: Percentiles;
    retrieval_ms: Percentiles;
    inventory: Array<{ model: string | null; prompt_version: string | null; n: number }>;
  };

  /**
   * Phase 21 — human classification corrections.
   *
   * ⚠️ A THIRD SOURCE, A THIRD DENOMINATOR. Like `copilot` this comes from
   * `audit_event` and stands outside the L1–L3' execution pipeline entirely.
   * A correction is not an execution and must never be added to one.
   *
   * ⚠️ NEITHER IS IT AN ERROR COUNT. See CORRECTION_DISCLAIMER. The only rate
   * published here compares a human's stored severity against IRIS's own
   * deterministic engine, never against the AI.
   */
  corrections: {
    source: 'audit_event';
    population: MetricPopulation;
    /**
     * False when the feature filter names something other than classification.
     * Corrections exist only for classification, so under any other filter the
     * counts below are NOT REPORTED rather than reported as zero — a zero would
     * read as "no corrections happened", which is a different claim.
     */
    applies_to_filter: boolean;
    /** Correction DECISIONS. One per audited correction, never one per field. */
    events: number;
    /** Distinct tickets behind those decisions. Always <= events. */
    tickets: number;
    tickets_corrected_more_than_once: number;
    /** Defensive. Should be 0; a non-zero means `tickets` is undercounting. */
    events_without_ticket: number;
    category_changes: number;
    severity_changes: number;
    /** Reviewer stored a severity the priority engine did not derive. */
    severity_overrides: number;
    /** Corrections where the engine ran at all — the override denominator. */
    override_eligible: number;
    /** ⚠️ Null when withheld. NEVER 0 standing in for "not enough data". */
    severity_override_rate: number | null;
    sample: SampleState;
    /** The classification source each correction replaced. Grouped, not enumerated. */
    prior_source: CountRow[];
  };

  replays: {
    population: MetricPopulation;
    n: number;
    rows: Array<{ feature: string; original_error_code: string | null; n: number }>;
  };

  /** ⚠️ occurrences, never a rate. One event among thousands is not a percentage. */
  fallback: { population: MetricPopulation; occurrences: number };

  by_product: {
    population: MetricPopulation;
    rows: Array<{ product_id: string; n: number; succeeded: number; failed: number }>;
  };

  caveats: string[];
  unmeasurable: readonly string[];
  meta: { governance_version: string; generated_at: string; query_ms: number };
}
