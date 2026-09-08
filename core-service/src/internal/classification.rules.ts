import {
  DEFAULT_SCORING,
  ENHANCEMENT_ISSUE_TYPES,
  INFORMATIONAL_ISSUE_TYPES,
  KEYWORD_MAX_COUNT,
  KEYWORD_MAX_LENGTH,
  KEYWORD_PATTERN,
  PRIORITY_TO_SEVERITY,
  type AIThresholds,
  type ClassificationDecision,
  type Priority,
  type PriorityFactors,
  type PriorityScoringConfig,
  type RoutingDecision,
} from '@iris/shared/types';

/**
 * The deterministic half of classification — Phase 4.
 *
 * This file is where "IRIS decides" actually happens. The model supplies
 * factual signals; every business decision below is computed here, in Core,
 * from those signals plus the product's own configuration.
 *
 * PURE FUNCTIONS ONLY. No database, no HTTP, no clock, no randomness. That is
 * not stylistic: it means every decision is reproducible from its inputs, so a
 * disputed priority months later can be re-derived exactly rather than argued
 * about. It is also what lets the whole engine be tested without a provider,
 * which matters more than usual here — the provider is the one part of Phase 4
 * that cannot be exercised offline.
 *
 * It deliberately lives in Core rather than the Python service. Python is a
 * stateless inference service; giving it the scoring engine would make the
 * business rules a property of the AI deployment instead of the platform.
 */

// ─────────────────────────────────────────────────────────────────────────
// Keywords
// ─────────────────────────────────────────────────────────────────────────

/**
 * Normalise model-supplied tags. CORE IS AUTHORITATIVE — the prompt asks for
 * 3-6 lowercase tags, and that request is worth making, but a request is not
 * an enforcement mechanism.
 *
 * Deliberately LOSSY rather than strict: a bad tag is dropped, an over-long
 * list is truncated, and neither fails the classification. Rejecting an
 * otherwise-perfect classification because the model produced a seventh
 * keyword with a comma in it would be letting the least important field veto
 * the most important ones.
 */
export function normaliseKeywords(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];

  const seen = new Set<string>();
  const out: string[] = [];

  for (const item of raw) {
    if (typeof item !== 'string') continue;

    // Lowercase, trim, collapse internal whitespace runs to a single space.
    const cleaned = item.toLowerCase().trim().replace(/\s+/g, ' ');
    if (cleaned.length === 0 || cleaned.length > KEYWORD_MAX_LENGTH) continue;
    if (!KEYWORD_PATTERN.test(cleaned)) continue;

    // Dedupe AFTER normalising, so "Login" and "login " collapse to one entry,
    // preserving first-seen order.
    if (seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);

    if (out.length === KEYWORD_MAX_COUNT) break; // truncate, never fail
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Confidence
// ─────────────────────────────────────────────────────────────────────────

/**
 * How clearly the top category beat its runner-up.
 *
 * No runner-up means MAXIMAL separation, so margin == p1 — the model had
 * nothing close enough to a second guess to name. Treating a missing runner-up
 * as margin 0 would push every unambiguous ticket into manual triage, which is
 * exactly backwards.
 */
export function computeMargin(p1: number, p2: number | null | undefined): number {
  if (p2 === null || p2 === undefined) return p1;
  return p1 - p2;
}

/**
 * The weakest link across the four classified confidences.
 *
 * MIN, never an average. An average lets a confident category hide an
 * essentially-guessed impact, and impact feeds the priority score — so the
 * ticket would present as trustworthy precisely where it is not.
 *
 * Four terms, not the reference's six: `product` and `environment` are not part
 * of the frozen contract, so including them would be arithmetic over fields
 * that do not exist.
 */
export function compositeConfidence(args: {
  category_confidence: number;
  issue_type_confidence: number;
  impact_confidence: number;
  priority_factor_confidence: number;
}): number {
  return Math.min(
    args.category_confidence,
    args.issue_type_confidence,
    args.impact_confidence,
    args.priority_factor_confidence,
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Priority
// ─────────────────────────────────────────────────────────────────────────

export interface PriorityInput {
  factors: PriorityFactors;
  issue_type: string;
  category: string;
  /** The product's impacts list — scoring is by POSITION, not by label. */
  impacts: readonly string[];
  impact: string;
  core_categories: readonly string[];
  scoring?: PriorityScoringConfig;
}

export interface PriorityResult {
  priority: Priority;
  /** null when a short-circuit fired before scoring. */
  score: number | null;
  breakdown: string;
}

function deadlineScore(hours: number | null, bands: PriorityScoringConfig['deadline_bands']): number {
  // null is NOT urgency. An unstated deadline is not an imminent one.
  if (hours === null) return 0;
  if (!Number.isFinite(hours) || hours < 0) return 0;

  // Ascending, so the narrowest band that contains the value wins.
  for (const band of [...bands].sort((a, b) => a.max_hours - b.max_hours)) {
    if (hours <= band.max_hours) return band.score;
  }
  return 0; // further out than the widest band contributes nothing
}

/**
 * Priority from extracted factors. The single most consequential function in
 * Phase 4, and the one the model is deliberately not allowed anywhere near.
 *
 * SHORT-CIRCUITS FIRST, in a fixed order — they are absolute, not weights, and
 * the order IS the conflict-resolution rule. `security_or_data_loss` outranks
 * `cosmetic_only`, so a model that somehow sets both yields Critical rather
 * than an argument.
 */
export function determinePriority(input: PriorityInput): PriorityResult {
  const cfg = input.scoring ?? DEFAULT_SCORING;
  const f = input.factors;

  // 1. Security or data loss trumps everything else, always.
  if (f.security_or_data_loss) {
    return { priority: 'Critical', score: null, breakdown: 'security_or_data_loss' };
  }
  // 2-3. A question or a feature request is not an incident, however it is worded.
  if (INFORMATIONAL_ISSUE_TYPES.includes(input.issue_type)) {
    return { priority: 'Low', score: null, breakdown: 'informational_or_question' };
  }
  if (ENHANCEMENT_ISSUE_TYPES.includes(input.issue_type)) {
    return { priority: 'Low', score: null, breakdown: 'enhancement_or_feature_request' };
  }
  // 4. Purely visual, zero functional effect.
  if (f.cosmetic_only) {
    return { priority: 'Low', score: null, breakdown: 'cosmetic_only' };
  }

  const parts: Array<[string, number]> = [['baseline', cfg.baseline]];

  if (f.system_down) {
    parts.push(['system_down', cfg.system_down_bonus]);
    // Additive, and only when BOTH hold: a core workflow being completely down
    // is worse than either fact alone.
    if (input.core_categories.includes(input.category)) {
      parts.push(['core_category_system_down', cfg.core_category_system_down_bonus]);
    }
  }

  /**
   * Impact scores by POSITION in the product's own list, not by label.
   * A product renaming "Entire Customer" to "Whole Tenant" must not silently
   * re-weight it, and a product with a two-tier scale must not crash.
   */
  const impactIndex = input.impacts.indexOf(input.impact);
  if (impactIndex > 0) {
    const weight = cfg.impact_by_index[Math.min(impactIndex, cfg.impact_by_index.length - 1)] ?? 0;
    if (weight !== 0) parts.push([`impact_${impactIndex}`, weight]);
  }

  const deadline = deadlineScore(f.hours_until_deadline, cfg.deadline_bands);
  if (deadline !== 0) parts.push(['deadline_urgency', deadline]);

  if (f.regulatory_impact) parts.push(['regulatory_impact', cfg.regulatory_bonus]);

  // A penalty, not a hard cancel: a workaround makes an outage survivable, not fine.
  if (f.workaround_available) parts.push(['workaround_penalty', -cfg.workaround_penalty]);

  const score = parts.reduce((sum, [, v]) => sum + v, 0);

  const priority: Priority =
    score >= cfg.critical_threshold
      ? 'Critical'
      : score >= cfg.high_threshold
        ? 'High'
        : score >= cfg.normal_threshold
          ? 'Normal'
          : 'Low';

  const breakdown = `weighted_score=${score} (${parts
    .map(([name, v]) => `${name}=${v >= 0 ? '+' : ''}${v}`)
    .join(', ')})`;

  return { priority, score, breakdown };
}

// ─────────────────────────────────────────────────────────────────────────
// Routing
// ─────────────────────────────────────────────────────────────────────────

/**
 * The confidence-gated routing band.
 *
 * Driven by CATEGORY confidence and margin — category is the field that
 * decides where a ticket goes, so it is the field that must be trusted before
 * anything is automated.
 *
 * The middle band is a deliberate catch-all rather than a literal range: a
 * ticket with p1 = 0.95 but margin = 0.02 is confident-but-nearly-tied, and
 * must not auto-route either.
 */
export function determineRouting(
  p1: number,
  margin: number,
  thresholds: AIThresholds,
): RoutingDecision {
  if (p1 < thresholds.triage_floor) return 'manual_triage';
  if (p1 >= thresholds.auto_route_p1 && margin >= thresholds.auto_route_margin) {
    return 'auto_route';
  }
  return 'soft_route_ai_uncertain';
}

/**
 * Routing band -> the existing `classification_source` CHECK values.
 *
 * Only `auto_route` earns 'ai_auto'. Both uncertain bands collapse to
 * 'ai_uncertain' because the column has no third value and inventing one would
 * need a migration to say something the routing decision already records in
 * `ai_execution.result`.
 */
export function classificationSourceFor(routing: RoutingDecision): 'ai_auto' | 'ai_uncertain' {
  return routing === 'auto_route' ? 'ai_auto' : 'ai_uncertain';
}

// ─────────────────────────────────────────────────────────────────────────
// The whole decision
// ─────────────────────────────────────────────────────────────────────────

export interface DecideInput {
  category: string;
  category_confidence: number;
  category_runner_up_confidence: number | null;
  issue_type: string;
  issue_type_confidence: number;
  impact: string;
  impact_confidence: number;
  factors: PriorityFactors;
  impacts: readonly string[];
  core_categories: readonly string[];
  thresholds: AIThresholds;
  scoring?: PriorityScoringConfig;
}

/**
 * Signals in, decisions out. One call, fully deterministic, no I/O.
 *
 * The ORDER matters and mirrors the frozen design: priority is computed first,
 * severity is a lookup ON priority (never on impact/environment), and routing
 * is independent of both because it measures confidence rather than urgency.
 */
export function decide(input: DecideInput): ClassificationDecision {
  const { priority, score, breakdown } = determinePriority({
    factors: input.factors,
    issue_type: input.issue_type,
    category: input.category,
    impacts: input.impacts,
    impact: input.impact,
    core_categories: input.core_categories,
    scoring: input.scoring,
  });

  const margin = computeMargin(input.category_confidence, input.category_runner_up_confidence);

  return {
    priority,
    severity: PRIORITY_TO_SEVERITY[priority],
    score,
    score_breakdown: breakdown,
    routing_decision: determineRouting(input.category_confidence, margin, input.thresholds),
    margin,
    composite_confidence: compositeConfidence({
      category_confidence: input.category_confidence,
      issue_type_confidence: input.issue_type_confidence,
      impact_confidence: input.impact_confidence,
      priority_factor_confidence: input.factors.priority_factor_confidence,
    }),
  };
}
