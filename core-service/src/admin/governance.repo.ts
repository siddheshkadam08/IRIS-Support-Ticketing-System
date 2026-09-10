import {
  GOVERNANCE_CORPUS_SQL,
  GOVERNANCE_FEATURES,
  TEST_ARTIFACT_ERROR_CODES,
  CONFIDENCE_BUCKET_COUNT,
} from '@iris/shared/types';
import type { Tx } from '../db/with-scope.js';

/**
 * Phase 17 — the ONE canonical governance population pipeline.
 *
 * ⚠️ THIS FILE EXISTS SO THAT DENOMINATORS CANNOT DRIFT.
 *
 * The design review found the first draft using "governance corpus" to mean two
 * different sets, and only one metric out of fifteen mentioning that replays
 * were excluded. Written the obvious way — each metric with its own WHERE
 * clause — that class of bug is invisible: every number looks right on its own
 * and only the arithmetic between them is wrong.
 *
 * So the population is declared exactly once, as a CTE chain, and every metric
 * below is a SELECT over one of its layers. A metric physically cannot read
 * `ai_execution` directly, because the query text it lives in does not mention
 * the table.
 *
 *   scoped_executions   L1   window + RLS + caller filters
 *   governance_corpus   L2   L1 AND the approved corpus rule
 *   flagged             L2   + replay/queue attributes from the outbox
 *   headline_population L3   L2 AND NOT replay   ← every headline metric
 *   replay_population   L3'  L2 AND replay
 *
 * ⚠️ THE OUTBOX JOIN IS A LEFT JOIN, AND THAT IS NOT A STYLE CHOICE. Live data
 * holds 4 corpus executions and 1,870 executions overall with no matching
 * `event_outbox` row at all. An INNER JOIN would have removed them from every
 * headline figure silently — no error, no warning, just numbers slightly too
 * small forever. A missing outbox row means "not a replay", never "not
 * counted", and `queue_delay` is the only metric allowed to drop those rows.
 */

// ─────────────────────────────────────────────────────────────────────────
// Parameters
// ─────────────────────────────────────────────────────────────────────────

export interface GovernanceQueryParams {
  /** Inclusive. */
  from: Date;
  /** EXCLUSIVE — half-open, so adjacent windows never double-count a row. */
  to: Date;
  productId: string | null;
  feature: string | null;
  provider: string | null;
  model: string | null;
  promptVersion: string | null;
}

const params = (p: GovernanceQueryParams): unknown[] => [
  p.from,
  p.to,
  p.productId,
  p.feature,
  p.provider,
  p.model,
  p.promptVersion,
];

/**
 * A SQL list literal built from a COMPILE-TIME constant.
 *
 * Safe because the only callers pass `GOVERNANCE_FEATURES` and
 * `TEST_ARTIFACT_ERROR_CODES`, which are `as const` arrays in shared types and
 * never touch a request. Every value that does come from a request is a bind
 * parameter — see `params()` above.
 */
const literalList = (xs: readonly string[]): string => xs.map((x) => `'${x}'`).join(',');

// ─────────────────────────────────────────────────────────────────────────
// The pipeline
// ─────────────────────────────────────────────────────────────────────────

/**
 * ⚠️ Do not put a backtick in the SQL below — it terminates this template
 * literal and produces a runtime error a long way from here.
 *
 * The projection is a column list rather than `e.*` on purpose: `result` is a
 * large jsonb the governance surface must never return, and materialising it
 * five times over would cost far more than the rest of the query. The one thing
 * read out of it — the routing decision — is extracted here as a scalar.
 */
const POPULATION_CTE = `
WITH scoped_executions AS MATERIALIZED (
  -- L1. RLS has already added the product predicate; this adds the window and
  -- the caller's own filters. Half-open [from, to) in UTC.
  SELECT e.id, e.product_id, e.feature, e.event_id, e.status, e.attempt,
         e.provider, e.model, e.model_version, e.prompt_version,
         e.confidence, e.latency_ms, e.fallback_used, e.error_code,
         e.created_at, e.completed_at,
         e.result->'decision'->>'routing_decision' AS routing_decision
    FROM ai_execution e
   WHERE e.created_at >= $1
     AND e.created_at <  $2
     AND ($3::text IS NULL OR e.product_id     = $3)
     AND ($4::text IS NULL OR e.feature        = $4)
     AND ($5::text IS NULL OR e.provider       = $5)
     AND ($6::text IS NULL OR e.model          = $6)
     AND ($7::text IS NULL OR e.prompt_version = $7)
),
governance_corpus AS MATERIALIZED (
  -- L2. The approved corpus rule, stated once in shared types and pasted
  -- nowhere. It assumes the alias 'e', which is why the alias is kept here.
  SELECT e.* FROM scoped_executions e
   WHERE ${GOVERNANCE_CORPUS_SQL}
),
flagged AS MATERIALIZED (
  -- L2 plus the two attributes the outbox contributes. LEFT JOIN: see the file
  -- header. A row with no outbox event keeps is_replay = false and a NULL
  -- enqueued_at, and stays in the population.
  SELECT c.*,
         COALESCE(o.payload ? 'replay_of', false) AS is_replay,
         o.created_at                             AS enqueued_at
    FROM governance_corpus c
    LEFT JOIN event_outbox o ON o.event_id = c.event_id
),
headline_population AS MATERIALIZED (
  SELECT * FROM flagged WHERE NOT is_replay
),
replay_population AS MATERIALIZED (
  SELECT * FROM flagged WHERE is_replay
)`;

/** Percentiles over an expression, in milliseconds, from a declared population. */
const percentiles = (source: string, expr: string, predicate: string) => `
  (SELECT json_build_object(
            'n',   count(*)::int,
            'p50', percentile_disc(0.50) WITHIN GROUP (ORDER BY ${expr}),
            'p95', percentile_disc(0.95) WITHIN GROUP (ORDER BY ${expr}),
            'p99', percentile_disc(0.99) WITHIN GROUP (ORDER BY ${expr}))
     FROM ${source} WHERE ${predicate})`;

/**
 * Every metric, one round trip, one scan of the population.
 *
 * Each sub-select names the layer it stands on in its own FROM clause, so the
 * population of a metric is readable at the point the metric is computed and
 * can be checked by eye against the contract in shared types.
 */
const METRICS_SQL = `${POPULATION_CTE}
SELECT
  -- ── M12: the population panel. Every count obeys window, scope and filters.
  (SELECT count(*)::int FROM scoped_executions)   AS scoped_n,
  (SELECT count(*)::int FROM governance_corpus)   AS corpus_n,
  (SELECT count(*)::int FROM headline_population) AS headline_n,
  (SELECT count(*)::int FROM replay_population)   AS replay_n,
  (SELECT COALESCE(json_agg(json_build_object('reason', reason, 'n', n) ORDER BY n DESC), '[]'::json)
     FROM (SELECT CASE
                    WHEN e.feature <> ALL (ARRAY[${literalList(GOVERNANCE_FEATURES)}])
                      THEN 'feature_not_governed'
                    ELSE 'test_artifact'
                  END AS reason,
                  count(*)::int AS n
             FROM scoped_executions e
             -- the complement of the corpus rule, over L1
            WHERE NOT (e.feature = ANY (ARRAY[${literalList(GOVERNANCE_FEATURES)}])
                       AND (e.error_code IS NULL
                            OR e.error_code <> ALL (ARRAY[${literalList(TEST_ARTIFACT_ERROR_CODES)}])))
            GROUP BY 1) x) AS excluded,

  -- ── M1, M2, M15: counts over L3. Success is an outcome, never correctness.
  (SELECT json_build_object(
            'n',         count(*)::int,
            'succeeded', count(*) FILTER (WHERE status = 'succeeded')::int,
            'failed',    count(*) FILTER (WHERE status = 'failed')::int,
            'running',   count(*) FILTER (WHERE status = 'running')::int,
            'fallback',  count(*) FILTER (WHERE fallback_used)::int)
     FROM headline_population) AS executions,

  -- ── by feature, same layer.
  --       with_confidence is carried so the UI can say "this feature does not
  --       produce a confidence" from evidence rather than from a hardcoded
  --       assumption that only classification does.
  (SELECT COALESCE(json_agg(json_build_object(
            'feature', feature, 'n', n, 'succeeded', s, 'failed', f, 'running', r,
            'with_confidence', wc) ORDER BY n DESC), '[]'::json)
     FROM (SELECT feature,
                  count(*)::int AS n,
                  count(*) FILTER (WHERE status = 'succeeded')::int AS s,
                  count(*) FILTER (WHERE status = 'failed')::int    AS f,
                  count(*) FILTER (WHERE status = 'running')::int   AS r,
                  count(*) FILTER (WHERE confidence IS NOT NULL)::int AS wc
             FROM headline_population GROUP BY feature) x) AS by_feature,

  -- ── M4: time inside the provider call. Failed rows carry no latency, so they
  --       are excluded and the smaller n is published rather than hidden.
  ${percentiles('headline_population', 'latency_ms', "status = 'succeeded' AND latency_ms IS NOT NULL")}
    AS provider_latency,

  -- ── M5: wall clock, retries and backoff INCLUDED. Never averaged with M4.
  ${percentiles(
    'headline_population',
    'EXTRACT(EPOCH FROM (completed_at - created_at)) * 1000',
    'completed_at IS NOT NULL',
  )} AS wall_clock,

  -- ── M6: outbox row to execution start. The one metric a missing outbox row
  --       is allowed to drop — it stays in L3 and simply cannot contribute here.
  ${percentiles(
    'headline_population',
    'EXTRACT(EPOCH FROM (created_at - enqueued_at)) * 1000',
    'enqueued_at IS NOT NULL',
  )} AS queue_delay,

  -- ── M7: attempts. Reported, never explained — only the terminal reason
  --       survives on the row, so no per-attempt cause can be claimed.
  (SELECT COALESCE(json_agg(json_build_object('attempt', attempt, 'n', n) ORDER BY attempt), '[]'::json)
     FROM (SELECT attempt, count(*)::int AS n FROM headline_population GROUP BY attempt) x) AS attempts,

  -- ── M8: failures by raw code. The category is mapped in TypeScript, from the
  --       single shared map, so it cannot disagree with the one tests use.
  (SELECT COALESCE(json_agg(json_build_object('error_code', error_code, 'n', n) ORDER BY n DESC), '[]'::json)
     FROM (SELECT error_code, count(*)::int AS n
             FROM headline_population WHERE status = 'failed' GROUP BY error_code) x) AS failures,

  -- ── M9: confidence. width_bucket returns 1..10 inside the range and 11 for
  --       exactly 1.0, so the last bucket is closed rather than an 11th opening.
  (SELECT COALESCE(json_agg(json_build_object('bucket', bucket, 'n', n) ORDER BY bucket), '[]'::json)
     FROM (SELECT LEAST(width_bucket(confidence, 0, 1, ${CONFIDENCE_BUCKET_COUNT}), ${CONFIDENCE_BUCKET_COUNT}) - 1 AS bucket,
                  count(*)::int AS n
             FROM headline_population WHERE confidence IS NOT NULL GROUP BY 1) x) AS confidence,
  (SELECT count(*)::int FROM headline_population WHERE confidence IS NOT NULL) AS confidence_n,

  -- ── M10: what IRIS decided from the model's numbers. Not model output.
  (SELECT COALESCE(json_agg(json_build_object('key', routing_decision, 'n', n) ORDER BY n DESC), '[]'::json)
     FROM (SELECT routing_decision, count(*)::int AS n
             FROM headline_population
            WHERE feature = 'classification' AND routing_decision IS NOT NULL
            GROUP BY routing_decision) x) AS routing,
  (SELECT count(*)::int FROM headline_population
    WHERE feature = 'classification' AND routing_decision IS NOT NULL) AS routing_n,

  -- ── M11: what actually ran. NULLs are surfaced as NULL and labelled in the
  --       UI; a fabricated historical version would be worse than "not recorded".
  (SELECT COALESCE(json_agg(json_build_object(
            'provider', provider, 'model', model, 'model_version', model_version,
            'prompt_version', prompt_version, 'n', n) ORDER BY n DESC), '[]'::json)
     FROM (SELECT provider, model, model_version, prompt_version, count(*)::int AS n
             FROM headline_population
            GROUP BY provider, model, model_version, prompt_version) x) AS inventory,

  -- ── M14: replays, from L3' — the layer the headline numbers exclude.
  (SELECT COALESCE(json_agg(json_build_object(
            'feature', feature, 'original_error_code', error_code, 'n', n) ORDER BY n DESC), '[]'::json)
     FROM (SELECT feature, error_code, count(*)::int AS n
             FROM replay_population GROUP BY feature, error_code) x) AS replays,

  -- ── by product. For a super_admin this is the platform breakdown; for a
  --       scoped caller it is their own tenants and nothing else.
  (SELECT COALESCE(json_agg(json_build_object(
            'product_id', product_id, 'n', n, 'succeeded', s, 'failed', f) ORDER BY n DESC), '[]'::json)
     FROM (SELECT product_id, count(*)::int AS n,
                  count(*) FILTER (WHERE status = 'succeeded')::int AS s,
                  count(*) FILTER (WHERE status = 'failed')::int    AS f
             FROM headline_population GROUP BY product_id) x) AS by_product
`;

// ─────────────────────────────────────────────────────────────────────────
// Row shapes
// ─────────────────────────────────────────────────────────────────────────

interface PercentileRow {
  n: number;
  p50: string | number | null;
  p95: string | number | null;
  p99: string | number | null;
}

export interface GovernanceMetricsRow {
  scoped_n: number;
  corpus_n: number;
  headline_n: number;
  replay_n: number;
  excluded: Array<{ reason: string; n: number }>;
  executions: { n: number; succeeded: number; failed: number; running: number; fallback: number };
  by_feature: Array<{
    feature: string;
    n: number;
    succeeded: number;
    failed: number;
    running: number;
    with_confidence: number;
  }>;
  provider_latency: PercentileRow;
  wall_clock: PercentileRow;
  queue_delay: PercentileRow;
  attempts: Array<{ attempt: number; n: number }>;
  failures: Array<{ error_code: string | null; n: number }>;
  confidence: Array<{ bucket: number; n: number }>;
  confidence_n: number;
  routing: Array<{ key: string; n: number }>;
  routing_n: number;
  inventory: Array<{
    provider: string | null;
    model: string | null;
    model_version: string | null;
    prompt_version: string | null;
    n: number;
  }>;
  replays: Array<{ feature: string; original_error_code: string | null; n: number }>;
  by_product: Array<{ product_id: string; n: number; succeeded: number; failed: number }>;
}

export async function fetchGovernanceMetrics(
  tx: Tx,
  p: GovernanceQueryParams,
): Promise<GovernanceMetricsRow> {
  const { rows } = await tx.query<GovernanceMetricsRow>(METRICS_SQL, params(p));
  // A single-row aggregate always returns exactly one row, even over an empty
  // population — the counts are simply zero and the arrays empty.
  return rows[0]!;
}

// ─────────────────────────────────────────────────────────────────────────
// M13 — Copilot. A DIFFERENT SOURCE AND A DIFFERENT DENOMINATOR.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Copilot writes no `ai_execution` row: it is synchronous, has no outbox event
 * and persists no draft. Its audit entry is the only durable record that it
 * ran, so this reads `audit_event` and stands entirely outside the L1–L3'
 * pipeline above. The two are never added together — a Copilot invocation and a
 * classification execution are not the same kind of thing, and one number
 * covering both would mean nothing.
 *
 * ⚠️ The numeric guard is deliberate. These values are cast out of jsonb, and a
 * single malformed audit row would otherwise abort the whole governance query
 * with a cast error. A row that cannot be read as a number is skipped and its
 * absence shows in the metric's own n.
 */
const NUMERIC_GUARD = String.raw`~ '^[0-9]+(\.[0-9]+)?$'`;

const copilotPercentiles = (field: string) => `
  (SELECT json_build_object(
            'n',   count(*)::int,
            'p50', percentile_disc(0.50) WITHIN GROUP (ORDER BY (after->>'${field}')::numeric),
            'p95', percentile_disc(0.95) WITHIN GROUP (ORDER BY (after->>'${field}')::numeric),
            'p99', percentile_disc(0.99) WITHIN GROUP (ORDER BY (after->>'${field}')::numeric))
     FROM copilot WHERE after->>'${field}' ${NUMERIC_GUARD})`;

const COPILOT_SQL = `
WITH copilot AS MATERIALIZED (
  SELECT a.after, a.product_id
    FROM audit_event a
   WHERE a.action = 'ai.copilot_drafted'
     AND a.occurred_at >= $1
     AND a.occurred_at <  $2
     AND ($3::text IS NULL OR a.product_id = $3)
)
SELECT
  (SELECT count(*)::int FROM copilot) AS invocations,
  (SELECT COALESCE(json_agg(json_build_object('key', k, 'n', n) ORDER BY n DESC), '[]'::json)
     FROM (SELECT after->>'outcome' AS k, count(*)::int AS n FROM copilot GROUP BY 1) x) AS outcomes,
  ${copilotPercentiles('total_ms')}      AS total_ms,
  ${copilotPercentiles('generation_ms')} AS generation_ms,
  ${copilotPercentiles('retrieval_ms')}  AS retrieval_ms,
  (SELECT COALESCE(json_agg(json_build_object('model', m, 'prompt_version', pv, 'n', n) ORDER BY n DESC), '[]'::json)
     FROM (SELECT after->>'model' AS m, after->>'prompt_version' AS pv, count(*)::int AS n
             FROM copilot GROUP BY 1, 2) x) AS inventory
`;

export interface CopilotMetricsRow {
  invocations: number;
  outcomes: Array<{ key: string | null; n: number }>;
  total_ms: PercentileRow;
  generation_ms: PercentileRow;
  retrieval_ms: PercentileRow;
  inventory: Array<{ model: string | null; prompt_version: string | null; n: number }>;
}

export async function fetchCopilotMetrics(
  tx: Tx,
  p: Pick<GovernanceQueryParams, 'from' | 'to' | 'productId'>,
): Promise<CopilotMetricsRow> {
  const { rows } = await tx.query<CopilotMetricsRow>(COPILOT_SQL, [p.from, p.to, p.productId]);
  return rows[0]!;
}

// ─────────────────────────────────────────────────────────────────────────
// Phase 21 — Human classification corrections. A THIRD SOURCE.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Corrections write no `ai_execution` row — Phase 20 changes the ticket and
 * writes one audit row, nothing else. So this stands beside the Copilot query,
 * outside the L1–L3' pipeline, for the same reason: there is no execution to
 * put in a population. A correction and an execution are not the same kind of
 * thing and are never summed.
 *
 * ⚠️ `IS DISTINCT FROM`, NOT `<>`. An unclassified ticket has NULL category and
 * NULL severity, and `NULL <> 'billing'` is NULL, not true — which would drop
 * from `category_changes` exactly the corrections that set a value where none
 * existed. Those are the most consequential corrections there are.
 *
 * ⚠️ `overridden_text = 'true'`, NOT a boolean cast. Same lesson the Copilot
 * numeric guard already learned: these values come out of jsonb, and a single
 * malformed audit row would abort the entire governance response with a cast
 * error. A value that does not read as 'true' is simply not counted, and the
 * loss is visible because `events` still includes the row.
 *
 * ⚠️ `prior_source` IS GROUPED, NOT ENUMERATED. A sixth classification source
 * added later shows up here on its own instead of silently vanishing from a
 * hardcoded list.
 *
 * The action and entity_type are compile-time literals; every request-derived
 * value is a bind parameter, exactly as above.
 */
const CORRECTIONS_SQL = `
WITH corrections AS MATERIALIZED (
  SELECT a.entity_id, a.before, a.after
    FROM audit_event a
   WHERE a.action      = 'ticket.classification_corrected'
     AND a.entity_type = 'ticket'
     AND a.occurred_at >= $1
     AND a.occurred_at <  $2
     AND ($3::text IS NULL OR a.product_id = $3)
),
fields AS (
  SELECT entity_id,
         before->>'category'              AS before_category,
         after ->>'category'              AS after_category,
         before->>'severity'              AS before_severity,
         after ->>'severity'              AS after_severity,
         before->>'classification_source' AS prior_source,
         after ->>'derived_severity'      AS derived_severity,
         after ->>'severity_overridden'   AS overridden_text
    FROM corrections
)
SELECT
  (SELECT count(*)::int FROM fields) AS events,
  (SELECT count(DISTINCT entity_id)::int
     FROM fields
    WHERE entity_id IS NOT NULL) AS tickets,
  (SELECT count(*)::int
     FROM (
       SELECT entity_id
         FROM fields
        WHERE entity_id IS NOT NULL
        GROUP BY entity_id
       HAVING count(*) > 1
     ) x) AS tickets_corrected_more_than_once,
  (SELECT count(*)::int
     FROM fields
    WHERE entity_id IS NULL) AS events_without_ticket,
  (SELECT count(*)::int
     FROM fields
    WHERE before_category IS DISTINCT FROM after_category) AS category_changes,
  (SELECT count(*)::int
     FROM fields
    WHERE before_severity IS DISTINCT FROM after_severity) AS severity_changes,
  (SELECT count(*)::int
     FROM fields
    WHERE overridden_text = 'true') AS severity_overrides,
  (SELECT count(*)::int
     FROM fields
    WHERE derived_severity IS NOT NULL) AS override_eligible,
  (SELECT COALESCE(
      json_agg(
        json_build_object('key', k, 'n', n)
        ORDER BY n DESC
      ),
      '[]'::json
    )
     FROM (
       SELECT COALESCE(prior_source, 'not recorded') AS k,
              count(*)::int AS n
         FROM fields
        GROUP BY 1
     ) x) AS prior_source
`;

export interface CorrectionMetricsRow {
  events: number;
  tickets: number;
  tickets_corrected_more_than_once: number;
  events_without_ticket: number;
  category_changes: number;
  severity_changes: number;
  severity_overrides: number;
  override_eligible: number;
  prior_source: Array<{ key: string; n: number }>;
}

/** The zero row, for the case where the feature filter excludes classification. */
export const EMPTY_CORRECTION_METRICS: CorrectionMetricsRow = {
  events: 0,
  tickets: 0,
  tickets_corrected_more_than_once: 0,
  events_without_ticket: 0,
  category_changes: 0,
  severity_changes: 0,
  severity_overrides: 0,
  override_eligible: 0,
  prior_source: [],
};

export async function fetchCorrectionMetrics(
  tx: Tx,
  p: Pick<GovernanceQueryParams, 'from' | 'to' | 'productId'>,
): Promise<CorrectionMetricsRow> {
  const { rows } = await tx.query<CorrectionMetricsRow>(CORRECTIONS_SQL, [
    p.from,
    p.to,
    p.productId,
  ]);
  return rows[0]!;
}

/** Exposed for the performance test, which runs EXPLAIN over the real pipeline. */
export const GOVERNANCE_METRICS_SQL = METRICS_SQL;
export const GOVERNANCE_CORRECTIONS_SQL = CORRECTIONS_SQL;
export const GOVERNANCE_POPULATION_CTE = POPULATION_CTE;
export const governanceQueryParams = params;
