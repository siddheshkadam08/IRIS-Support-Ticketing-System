import {
  AI_GOVERNANCE_VERSION,
  CONFIDENCE_BUCKET_COUNT,
  CONFIDENCE_DISCLAIMER,
  COPILOT_DISCLAIMER,
  CORRECTION_DISCLAIMER,
  DEFAULT_GOVERNANCE_WINDOW_DAYS,
  FAILURE_CATEGORY_LABEL,
  GOVERNANCE_FEATURES,
  GOVERNANCE_UNMEASURABLE,
  MAX_GOVERNANCE_WINDOW_DAYS,
  MIN_SAMPLE_FOR_RATE,
  NO_ACCURACY_DISCLAIMER,
  OPERATIONAL_COUNTS_DISCLAIMER,
  confidenceBucketLabel,
  failureCategoryOf,
  sampleStateOf,
  AppError,
} from '@iris/shared/types';
import type { GovernanceResponse, Percentiles, SampleState } from '@iris/shared/types';
import type { Tx } from '../db/with-scope.js';
import {
  EMPTY_CORRECTION_METRICS,
  fetchCopilotMetrics,
  fetchCorrectionMetrics,
  fetchGovernanceMetrics,
  type GovernanceQueryParams,
} from './governance.repo.js';

/**
 * Phase 17 — assembling the governance read model.
 *
 * The repo decides the POPULATION; this file decides how it is PRESENTED. The
 * split matters: everything that could make a number mean something other than
 * what it measures lives here — rate suppression, the failure map, the caveats
 * — and none of it can change a denominator, because denominators are already
 * fixed by the CTE chain before this code sees a row.
 *
 * ⚠️ THE RULE THIS FILE ENFORCES: report what happened, never what it means.
 */

// ─────────────────────────────────────────────────────────────────────────
// Window
// ─────────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

export interface WindowInput {
  from?: string;
  to?: string;
}

/**
 * Resolve the requested window, half-open `[from, to)` in UTC.
 *
 * Half-open is not a detail: with an inclusive upper bound a row created at
 * exactly midnight belongs to two adjacent days, and every month-over-month
 * comparison is quietly wrong by however many rows landed on a boundary.
 */
export function resolveWindow(input: WindowInput): { from: Date; to: Date; days: number } {
  const to = input.to ? new Date(input.to) : new Date();
  const from = input.from
    ? new Date(input.from)
    : new Date(to.getTime() - DEFAULT_GOVERNANCE_WINDOW_DAYS * DAY_MS);

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new AppError('invalid_request', 'from and to must be ISO-8601 timestamps.');
  }
  if (from.getTime() >= to.getTime()) {
    throw new AppError('invalid_request', 'from must be strictly before to.');
  }
  const days = (to.getTime() - from.getTime()) / DAY_MS;
  if (days > MAX_GOVERNANCE_WINDOW_DAYS) {
    throw new AppError(
      'invalid_request',
      `The window may not exceed ${MAX_GOVERNANCE_WINDOW_DAYS} days.`,
    );
  }
  return { from, to, days: Math.round(days * 100) / 100 };
}

/**
 * ⚠️ A feature outside the governed set is a 400, NOT an empty result.
 *
 * `feature=noop` is the case that matters. Returning an empty page for it would
 * read as "no noop executions happened", when in truth there are 8,656 of them
 * and the governance corpus deliberately refuses to measure them. Saying so is
 * the honest answer; a zero is a lie by omission.
 *
 * The operational list endpoint keeps its unrestricted filter — that is a
 * diagnostic tool, and an operator debugging the stub must still be able to
 * find it.
 */
export function assertGovernedFeature(feature: string | undefined): string | null {
  if (feature === undefined) return null;
  if (!(GOVERNANCE_FEATURES as readonly string[]).includes(feature)) {
    throw new AppError(
      'invalid_request',
      `Governance measures ${GOVERNANCE_FEATURES.join(' and ')} only. ` +
        `"${feature}" is outside the governance corpus and has no governance figures.`,
    );
  }
  return feature;
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

const num = (v: string | number | null): number | null => {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Whole milliseconds. Sub-millisecond precision on a percentile is noise. */
const roundMs = (v: string | number | null): number | null => {
  const n = num(v);
  return n === null ? null : Math.round(n);
};

const percentiles = (
  population: string,
  row: { n: number; p50: string | number | null; p95: string | number | null; p99: string | number | null },
): Percentiles => ({
  population,
  n: row.n,
  p50: roundMs(row.p50),
  p95: roundMs(row.p95),
  p99: roundMs(row.p99),
});

// ─────────────────────────────────────────────────────────────────────────
// Assembly
// ─────────────────────────────────────────────────────────────────────────

export interface GovernanceRequest extends GovernanceQueryParams {
  days: number;
}

export async function buildGovernanceReport(
  tx: Tx,
  req: GovernanceRequest,
): Promise<GovernanceResponse> {
  const started = Date.now();
  const m = await fetchGovernanceMetrics(tx, req);
  const c = await fetchCopilotMetrics(tx, req);

  /**
   * Phase 21. Corrections exist for classification and nothing else, so a
   * filter naming another feature makes this panel INAPPLICABLE rather than
   * empty. The query is skipped entirely — running it and then zeroing the
   * result would spend a round trip to produce a number the response is about
   * to disown.
   */
  const correctionsApply = req.feature === null || req.feature === 'classification';
  const r = correctionsApply
    ? await fetchCorrectionMetrics(tx, req)
    : EMPTY_CORRECTION_METRICS;

  const queryMs = Date.now() - started;

  // ── The identity. COMPUTED, never assumed.
  //
  // If this is ever false something has changed underneath the pipeline — a new
  // exclusion reason, a race, a bug — and the page must say so rather than
  // present figures whose denominators no longer add up.
  const excludedTotal = m.excluded.reduce((sum, e) => sum + e.n, 0);
  const identityHolds =
    m.scoped_n === m.corpus_n + excludedTotal && m.corpus_n === m.headline_n + m.replay_n;

  // ── M3. Suppressed rather than manufactured.
  const rateDenominator = m.executions.succeeded + m.executions.failed;
  const rateSuppressed = rateDenominator < MIN_SAMPLE_FOR_RATE;
  const successRate = rateSuppressed
    ? null
    : Math.round((m.executions.succeeded / rateDenominator) * 10_000) / 10_000;

  const providerLatency = percentiles('headline+succeeded+latency', m.provider_latency);
  const wallClock = percentiles('headline+completed', m.wall_clock);
  const queueDelay = percentiles('headline+enqueued', m.queue_delay);

  const featuresWithoutConfidence = m.by_feature
    .filter((f) => f.with_confidence === 0)
    .map((f) => f.feature);

  /**
   * Phase 21 — the ONLY rate this panel publishes, and it is deliberately not
   * about the AI.
   *
   * NUMERATOR    corrections where the reviewer stored a severity the priority
   *              engine did not derive.
   * DENOMINATOR  corrections where the engine RAN at all.
   *
   * ⚠️ THE DENOMINATOR IS NOT `events`. A correction on a ticket with no stored
   * AI factors carries `reason: 'no_ai_factors'` and no derived severity: there
   * was nothing to override, so it belongs on neither side. Dividing by every
   * correction would shrink the share by however many such tickets exist, which
   * is a property of the corpus rather than of reviewers.
   *
   * The numerator is a strict subset of the denominator, both drawn from the
   * same rows in the same window — which is exactly what an AI correction rate
   * could not offer, and why one is not published. See GOVERNANCE_UNMEASURABLE.
   */
  const overrideSample: SampleState = correctionsApply
    ? sampleStateOf(r.override_eligible)
    : 'none';
  const severityOverrideRate =
    overrideSample === 'sufficient'
      ? Math.round((r.severity_overrides / r.override_eligible) * 10_000) / 10_000
      : null;

  const response: GovernanceResponse = {
    window: { from: req.from.toISOString(), to: req.to.toISOString(), days: req.days },
    filters: {
      product_id: req.productId,
      feature: req.feature,
      provider: req.provider,
      model: req.model,
      prompt_version: req.promptVersion,
    },

    population: {
      scoped: m.scoped_n,
      excluded_from_corpus: m.excluded,
      corpus: m.corpus_n,
      replays: m.replay_n,
      headline: m.headline_n,
      identity_holds: identityHolds,
    },

    executions: {
      population: 'headline',
      n: m.executions.n,
      succeeded: m.executions.succeeded,
      failed: m.executions.failed,
      running: m.executions.running,
      success_rate: successRate,
      success_rate_n: rateDenominator,
      rate_suppressed: rateSuppressed,
    },

    by_feature: { population: 'headline', rows: m.by_feature },

    latency: { provider: providerLatency, wall_clock: wallClock, queue_delay: queueDelay },

    attempts: { population: 'headline', n: m.headline_n, rows: m.attempts },

    failures: {
      population: 'headline+failed',
      n: m.executions.failed,
      // The category comes from the single shared map, so the API, the UI and
      // the tests cannot disagree about what a code means. An unrecognised code
      // keeps its raw value and lands in `unclassified`, visibly.
      rows: m.failures.map((f) => {
        const category = failureCategoryOf(f.error_code);
        return { category, label: FAILURE_CATEGORY_LABEL[category], error_code: f.error_code, n: f.n };
      }),
    },

    confidence: {
      population: 'headline+confidence',
      n: m.confidence_n,
      signal: 'uncalibrated',
      // Every bucket is present, including empty ones: a histogram with gaps
      // silently rescales and misleads about the shape of the distribution.
      buckets: Array.from({ length: CONFIDENCE_BUCKET_COUNT }, (_, i) => ({
        bucket: i,
        label: confidenceBucketLabel(i),
        n: m.confidence.find((b) => b.bucket === i)?.n ?? 0,
      })),
      features_without_confidence: featuresWithoutConfidence,
    },

    routing: {
      population: 'headline+classification+decision',
      n: m.routing_n,
      decided_by: 'iris_core',
      rows: m.routing,
    },

    inventory: { population: 'headline', n: m.headline_n, rows: m.inventory },

    copilot: {
      source: 'audit_event',
      population: 'copilot_invocations',
      invocations: c.invocations,
      outcomes: c.outcomes.map((o) => ({ key: o.key ?? 'not recorded', n: o.n })),
      total_ms: percentiles('copilot_invocations+total_ms', c.total_ms),
      generation_ms: percentiles('copilot_invocations+generation_ms', c.generation_ms),
      retrieval_ms: percentiles('copilot_invocations+retrieval_ms', c.retrieval_ms),
      inventory: c.inventory,
    },

    corrections: {
      source: 'audit_event',
      population: correctionsApply ? 'corrections' : 'corrections+filtered_out',
      applies_to_filter: correctionsApply,
      events: r.events,
      tickets: r.tickets,
      tickets_corrected_more_than_once: r.tickets_corrected_more_than_once,
      events_without_ticket: r.events_without_ticket,
      category_changes: r.category_changes,
      severity_changes: r.severity_changes,
      severity_overrides: r.severity_overrides,
      override_eligible: r.override_eligible,
      severity_override_rate: severityOverrideRate,
      sample: overrideSample,
      prior_source: r.prior_source,
    },

    replays: { population: 'replay', n: m.replay_n, rows: m.replays },

    fallback: { population: 'headline', occurrences: m.executions.fallback },

    by_product: { population: 'headline', rows: m.by_product },

    caveats: buildCaveats({
      headline: m.headline_n,
      replays: m.replay_n,
      confidenceN: m.confidence_n,
      featuresWithoutConfidence,
      queueDelayN: queueDelay.n,
      wallClockN: wallClock.n,
      fallback: m.executions.fallback,
      rateSuppressed,
      rateDenominator,
      copilotInvocations: c.invocations,
      copilotTimed: c.total_ms.n,
      identityHolds,
      correctionsApply,
      correctionEvents: r.events,
      correctionTickets: r.tickets,
      correctionRepeats: r.tickets_corrected_more_than_once,
      correctionsWithoutTicket: r.events_without_ticket,
      overrideEligible: r.override_eligible,
      overrideSample,
    }),
    unmeasurable: GOVERNANCE_UNMEASURABLE,
    meta: {
      governance_version: AI_GOVERNANCE_VERSION,
      generated_at: new Date().toISOString(),
      query_ms: queryMs,
    },
  };

  return response;
}

// ─────────────────────────────────────────────────────────────────────────
// Caveats
// ─────────────────────────────────────────────────────────────────────────

interface CaveatInput {
  headline: number;
  replays: number;
  confidenceN: number;
  featuresWithoutConfidence: string[];
  queueDelayN: number;
  wallClockN: number;
  fallback: number;
  rateSuppressed: boolean;
  rateDenominator: number;
  copilotInvocations: number;
  copilotTimed: number;
  identityHolds: boolean;
  correctionsApply: boolean;
  correctionEvents: number;
  correctionTickets: number;
  correctionRepeats: number;
  correctionsWithoutTicket: number;
  overrideEligible: number;
  overrideSample: SampleState;
}

/**
 * The caveats are generated from what the data actually is, not written once and
 * left to rot. A caveat that appears when it does not apply teaches people to
 * skip the caveats.
 */
function buildCaveats(i: CaveatInput): string[] {
  const out: string[] = [OPERATIONAL_COUNTS_DISCLAIMER, NO_ACCURACY_DISCLAIMER];

  if (!i.identityHolds) {
    out.push(
      'THE POPULATION ARITHMETIC DOES NOT ADD UP. Treat every figure on this page ' +
        'as unverified and report this — it means the population layers disagree.',
    );
  }

  /**
   * ⚠️ CORRECTION CAVEATS ARE EMITTED BEFORE THE EMPTY-EXECUTION RETURN BELOW.
   *
   * A window can hold corrections and no executions at all — a reviewer
   * correcting last month's tickets today produces exactly that. Putting these
   * after the early return would silently drop every correction caveat from the
   * one window where the panel is the only thing on the page.
   */
  out.push(...correctionCaveats(i));

  if (i.headline === 0) {
    out.push('No AI executions in this window, so there is nothing to report.');
    return out;
  }

  out.push(
    'Executions are not tickets. One ticket can produce a classification and a ' +
      'summary execution, so these counts exceed the number of tickets involved.',
  );
  out.push(
    'A succeeded execution means the pipeline completed and IRIS accepted the ' +
      'output. It does not mean the output was right.',
  );

  if (i.confidenceN > 0) out.push(CONFIDENCE_DISCLAIMER);
  if (i.featuresWithoutConfidence.length > 0) {
    out.push(
      `${i.featuresWithoutConfidence.join(' and ')} does not produce a confidence, ` +
        'so it is absent from that histogram rather than scoring zero.',
    );
  }

  if (i.rateSuppressed) {
    out.push(
      `The success rate is withheld: ${i.rateDenominator} completed executions is ` +
        `below the ${MIN_SAMPLE_FOR_RATE} needed for a percentage to be worth reading.`,
    );
  }

  out.push(
    'Provider latency, wall-clock duration and queue delay measure three different ' +
      'things and must not be compared or combined.',
  );
  if (i.wallClockN > 0) {
    out.push(
      'Wall-clock duration spans creation to completion, so it includes retry ' +
        'backoff and, for stranded executions, the delay until the reaper closed them.',
    );
  }
  if (i.queueDelayN < i.headline) {
    out.push(
      `Queue delay covers ${i.queueDelayN} of ${i.headline} executions: the rest have ` +
        'no matching outbox event. They remain in every other figure on this page.',
    );
  }

  out.push(
    'Attempt counts say how many tries an execution took. Only the terminal reason ' +
      'is stored, so why an individual attempt failed is not recoverable.',
  );
  out.push('Routing decisions are made by IRIS from thresholds, not chosen by the model.');

  if (i.fallback > 0) {
    out.push(
      `Fallback is reported as ${i.fallback} occurrence${i.fallback === 1 ? '' : 's'}, ` +
        'not a rate — too few to express as a percentage.',
    );
  }

  if (i.replays > 0) {
    out.push(
      `${i.replays} replayed execution${i.replays === 1 ? ' is' : 's are'} excluded from ` +
        'the figures above and reported separately, so re-run work is not counted twice.',
    );
  }

  if (i.copilotInvocations > 0) {
    out.push(COPILOT_DISCLAIMER);
    out.push(
      'Copilot is counted from the audit trail, a different source with a different ' +
        'denominator. Its invocations are never added to execution counts.',
    );
    if (i.copilotTimed < i.copilotInvocations) {
      out.push(
        `Copilot timings exist for ${i.copilotTimed} of ${i.copilotInvocations} ` +
          'invocations — the earlier ones were recorded before timings were captured.',
      );
    }
  }

  return out;
}

/**
 * Phase 21 — what the correction counts do and do not say.
 *
 * ⚠️ EVERY SENTENCE HERE IS NEUTRAL BY CONSTRUCTION. A correction is a human
 * decision, not a verdict on the model, and copy that drifted into "the AI got
 * N wrong" would assert something the audit trail cannot support.
 */
function correctionCaveats(i: CaveatInput): string[] {
  const out: string[] = [];

  if (!i.correctionsApply) {
    out.push(
      'Human classification corrections are not reported under this feature filter. ' +
        'Corrections exist for classification only, so the panel is withheld rather ' +
        'than shown as zero.',
    );
    return out;
  }

  out.push(CORRECTION_DISCLAIMER);

  if (i.correctionEvents === 0) {
    out.push(
      'No classification corrections were recorded in this window. That is a count ' +
        'of zero events, not a finding about the AI.',
    );
    return out;
  }

  if (i.correctionEvents !== i.correctionTickets) {
    out.push(
      `${i.correctionEvents} corrections were made across ${i.correctionTickets} ` +
        `ticket${i.correctionTickets === 1 ? '' : 's'}; ` +
        `${i.correctionRepeats} ticket${i.correctionRepeats === 1 ? ' was' : 's were'} ` +
        'corrected more than once. Correction counts and ticket counts are never ' +
        'interchangeable.',
    );
  }

  out.push(
    'One correction can change both the category and the severity, so those two ' +
      'counts overlap and do not sum to the number of corrections.',
  );

  if (i.overrideSample === 'none') {
    out.push(
      'No correction in this window had a derived severity to override — the ' +
        'priority engine needs stored AI factors to run — so no override share ' +
        'can be formed.',
    );
  } else if (i.overrideSample === 'insufficient') {
    out.push(
      `The severity override share is withheld: ${i.overrideEligible} eligible ` +
        `correction${i.overrideEligible === 1 ? '' : 's'} is below the ` +
        `${MIN_SAMPLE_FOR_RATE} needed for a percentage to be worth reading. ` +
        'The count is shown instead.',
    );
  } else {
    out.push(
      'The severity override share compares a reviewer against the deterministic ' +
        'priority engine, not against the AI. Its denominator counts only ' +
        'corrections where that engine produced a severity.',
    );
  }

  if (i.correctionsWithoutTicket > 0) {
    out.push(
      `${i.correctionsWithoutTicket} correction event${i.correctionsWithoutTicket === 1 ? ' carries' : 's carry'} ` +
        'no ticket reference, so the ticket count above is lower than the events ' +
        'they belong to. Report this — every correction should name its ticket.',
    );
  }

  return out;
}
