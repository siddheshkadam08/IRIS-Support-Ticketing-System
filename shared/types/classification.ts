/**
 * AI ticket classification — Phase 4.
 *
 * THE ONE RULE THIS FILE EXISTS TO ENCODE:
 *
 *   AI predicts/extracts. IRIS decides.
 *
 * Everything in `ClassificationData` is a SIGNAL the model extracted from the
 * ticket text. Nothing in it is a business decision. `priority`, `severity` and
 * the routing band are computed by `classification.rules.ts` in Core, from
 * these signals plus the product's own configuration — never asked of the
 * model, never accepted from it.
 *
 * The 18 fields below are the frozen Phase 4 Step 2 set. The reference
 * implementation emits 31; the 13 that are absent are absent because nothing in
 * IRIS consumes them, not because they were forgotten:
 *
 *   product, product_disagreement  Core already knows the product authoritatively,
 *                                  from the outbox row. Asking the model to
 *                                  re-derive an identity we hold is inventing a
 *                                  disagreement we would then have to resolve.
 *   environment                    Not read by the priority engine or anything else.
 *   module, customer_project,      Free text, so not enum-constrainable, and no
 *   market_regulator               consumer.
 *   subject                        Content mutation. "An AI failure leaves the
 *                                  ticket unchanged" would stop being true.
 *   recommendation                 Requires a SECOND provider call.
 *   attachment_context,            Deferred capabilities (see §22/§23 of the
 *   kb_evidence_used               design freeze).
 */

import type { Severity } from './ticket.js';

// ─────────────────────────────────────────────────────────────────────────
// What the model returns  (Python -> worker -> Core, inside AIResult.data)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Factors the model EXTRACTS from the ticket text. Deliberately factual rather
 * than evaluative: "is the system down?" is answerable from the text, "how
 * urgent is this?" is a judgement IRIS reserves for itself.
 */
export interface PriorityFactors {
  security_or_data_loss: boolean;
  /** Completely unavailable — NOT merely slow or degraded. */
  system_down: boolean;
  /**
   * Estimated hours until a stated hard deadline, or null when the text
   * mentions none. null contributes ZERO urgency — an absent deadline is not
   * an imminent one, and treating null as "unknown, assume soon" would let
   * every vague ticket inflate its own priority.
   */
  hours_until_deadline: number | null;
  /** A SPECIFIC named regulator/filing. Generic domain jargon does not count. */
  regulatory_impact: boolean;
  workaround_available: boolean;
  cosmetic_only: boolean;
  /** The model's confidence in the factor extraction above, 0..1. */
  priority_factor_confidence: number;
}

/**
 * The complete, validated classification payload — `AIResult.data` once Core's
 * validator has accepted it. Every field here has a named consumer.
 */
export interface ClassificationData {
  // ── Signals: enum-constrained against the product's taxonomy ────────────
  category: string;
  issue_type: string;
  impact: string;

  // ── Confidence ─────────────────────────────────────────────────────────
  category_confidence: number;
  /**
   * Runner-up for CATEGORY ONLY, because category is the only field the
   * routing band reads. A runner-up on a field nothing routes on would be
   * tokens spent to produce a number no code looks at.
   */
  category_runner_up: string | null;
  category_runner_up_confidence: number | null;
  issue_type_confidence: number;
  impact_confidence: number;

  // ── Priority factors ───────────────────────────────────────────────────
  priority_factors: PriorityFactors;

  // ── Narrative ──────────────────────────────────────────────────────────
  /** Tone plus a short grounded reason, e.g. "Frustrated (a hard deadline is at risk)". */
  sentiment: string;
  /** 0-8 normalised tags. Core normalises; the model is not trusted to. */
  keywords_tags: string[];
  /** Why the model chose these values — for a human reviewer, not for code. */
  rationale: string;
}

// ─────────────────────────────────────────────────────────────────────────
// What Core decides  (never asked of the model)
// ─────────────────────────────────────────────────────────────────────────

/** IRIS priority tiers. Match the reference's Priority, NOT its P1-P4 Severity. */
export const PRIORITIES = ['Critical', 'High', 'Normal', 'Low'] as const;
export type Priority = (typeof PRIORITIES)[number];

export type RoutingDecision = 'auto_route' | 'soft_route_ai_uncertain' | 'manual_triage';

/**
 * ⚠️ THE NAMING TRAP, resolved once, here.
 *
 * The reference has BOTH a `Priority` (Critical/High/Normal/Low) and a
 * `Severity` (P1-P4), where its Severity is a pure restatement of its Priority
 * through a lookup table. IRIS has only `ticket.severity`
 * (low/medium/high/critical), and semantically that IS the reference's
 * Priority — the urgency tier itself, not a derivative of it.
 *
 * So this maps Priority -> IRIS severity. Mapping by FIELD NAME instead would
 * import P1-P4 into a column whose CHECK constraint cannot hold it, and would
 * store the same fact twice under a name meaning something else.
 */
export const PRIORITY_TO_SEVERITY: Readonly<Record<Priority, Severity>> = {
  Critical: 'critical',
  High: 'high',
  Normal: 'medium',
  Low: 'low',
};

/** The deterministic engine's output — reproducible for identical input. */
export interface ClassificationDecision {
  priority: Priority;
  severity: Severity;
  /**
   * Human-readable derivation, e.g.
   *   "weighted_score=85 (baseline=+15, system_down=+20, impact=+30, ...)"
   * or a short-circuit name like "security_or_data_loss".
   *
   * Persisted so "why did this ticket become Critical?" is answerable by
   * reading one string, rather than by re-deriving the score by hand from raw
   * factors and a threshold table months later.
   */
  score_breakdown: string;
  /** null when a short-circuit fired before any scoring happened. */
  score: number | null;
  routing_decision: RoutingDecision;
  /** category_confidence - runner_up_confidence; == p1 when there is no runner-up. */
  margin: number;
  /** min() across the four classified confidences. Weakest link, never an average. */
  composite_confidence: number;
}

// ─────────────────────────────────────────────────────────────────────────
// Taxonomy
// ─────────────────────────────────────────────────────────────────────────

/**
 * Platform defaults, used when a product configures none of its own.
 *
 * They exist so an unconfigured product still classifies rather than failing
 * every job — but they are deliberately GENERIC. Classification quality is a
 * function of taxonomy quality, so a product that cares should configure its
 * own vocabulary in product.config.
 */
export const DEFAULT_ISSUE_TYPES: readonly string[] = [
  'Bug',
  'Question',
  'Feature Request',
  'Improvement',
  'Incident',
  'Information',
  'Task',
];

/**
 * ORDER IS LOAD-BEARING: narrowest blast radius first. The priority engine
 * scores by POSITION (index 0 -> +0, 1 -> +20, 2 -> +30), so that a product
 * renaming its tiers does not silently re-weight them.
 */
export const DEFAULT_IMPACTS: readonly string[] = [
  'Single User',
  'Multiple Users',
  'Entire Customer',
];

/** Empty by default: no product's categories are known to be core a priori. */
export const DEFAULT_CORE_CATEGORIES: readonly string[] = [];

/**
 * Issue types that short-circuit to Low priority regardless of any other
 * factor. A question is not an outage however loudly it is asked.
 */
export const INFORMATIONAL_ISSUE_TYPES: readonly string[] = ['Information', 'Question'];
export const ENHANCEMENT_ISSUE_TYPES: readonly string[] = ['Feature Request', 'Improvement'];

// ─────────────────────────────────────────────────────────────────────────
// Keyword rules — Core is authoritative, the model is not
// ─────────────────────────────────────────────────────────────────────────

export const KEYWORD_MAX_COUNT = 8;
export const KEYWORD_MAX_LENGTH = 40;
/** Must start alphanumeric; then lowercase alphanumerics, space, underscore, hyphen. */
export const KEYWORD_PATTERN = /^[a-z0-9][a-z0-9 _-]*$/;

// ─────────────────────────────────────────────────────────────────────────
// Scoring configuration
// ─────────────────────────────────────────────────────────────────────────

export interface DeadlineBand {
  /** Applies when hours_until_deadline <= max_hours. */
  max_hours: number;
  score: number;
}

/**
 * The weights, frozen in Step 2 and ported from the reference's
 * `priority_scoring` block.
 *
 * A CONSTANT, not product configuration: these numbers were tuned together
 * against a worked-examples table, and letting one be changed in isolation
 * would break the relationships between them. If they ever become tunable it
 * should be as a whole, versioned block.
 */
export interface PriorityScoringConfig {
  baseline: number;
  system_down_bonus: number;
  /** ADDITIVE, on top of system_down_bonus, and only when both hold. */
  core_category_system_down_bonus: number;
  /** Indexed by position in the product's `impacts` list. */
  impact_by_index: readonly number[];
  regulatory_bonus: number;
  /** SUBTRACTED. A workaround softens urgency; it does not cancel it. */
  workaround_penalty: number;
  deadline_bands: readonly DeadlineBand[];
  critical_threshold: number;
  high_threshold: number;
  normal_threshold: number;
}

export const DEFAULT_SCORING: PriorityScoringConfig = {
  baseline: 15,
  system_down_bonus: 20,
  core_category_system_down_bonus: 15,
  impact_by_index: [0, 20, 30],
  regulatory_bonus: 15,
  workaround_penalty: 15,
  deadline_bands: [
    { max_hours: 2, score: 45 },
    { max_hours: 8, score: 35 },
    { max_hours: 24, score: 25 },
    { max_hours: 72, score: 15 },
    { max_hours: 168, score: 5 },
  ],
  critical_threshold: 70,
  high_threshold: 40,
  normal_threshold: 15,
};
