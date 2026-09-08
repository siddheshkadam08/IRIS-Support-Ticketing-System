import type {
  AIThresholds,
  AITaxonomy,
  ClassificationData,
  ClassificationDecision,
  PriorityFactors,
} from '@iris/shared/types';
import { decide, normaliseKeywords } from './classification.rules.js';

/**
 * Core's INDEPENDENT validation of classification output — Phase 4.
 *
 * WHY THIS EXISTS WHEN PYTHON ALREADY VALIDATED.
 *
 * Python constrains the model with a JSON-Schema enum and validates the reply
 * with Pydantic. Both are real and both help. Neither is a security property,
 * because Python is *given* its taxonomy by Core — a stale copy, a
 * misconfigured deployment or a compromised inference service all produce
 * output that Python happily accepts and Core must not.
 *
 * Core holds the authoritative product config, so Core gets the last word. The
 * rule from Phase 1 is unchanged: model output is untrusted until a Core
 * validator accepts it.
 *
 * This module is also where the untrusted payload becomes a DECISION, by
 * calling the deterministic engine. Python is never allowed to do that.
 */

export interface ValidationContext {
  taxonomy: AITaxonomy;
  thresholds: AIThresholds;
  /** Core-only: feeds the priority engine, never sent to Python. */
  coreCategories: readonly string[];
}

export type ClassificationValidation =
  | { ok: true; value: ClassificationData; decision: ClassificationDecision }
  | { ok: false; code: string; message: string };

const SENTIMENT_MAX = 300;
const RATIONALE_MAX = 1000;

const asString = (v: unknown): string | null =>
  typeof v === 'string' && v.length > 0 ? v : null;

/** A confidence is a finite number in [0,1]. Anything else is not a confidence. */
const asUnit = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v : null;

const asBool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

export function validateClassification(
  data: Record<string, unknown>,
  ctx: ValidationContext,
): ClassificationValidation {
  const reject = (message: string): ClassificationValidation => ({
    ok: false,
    code: 'invalid_ai_output',
    message,
  });

  // ── Enum membership, against CORE's taxonomy ───────────────────────────
  const category = asString(data.category);
  const issue_type = asString(data.issue_type);
  const impact = asString(data.impact);
  if (!category || !issue_type || !impact) {
    return reject('category, issue_type and impact are required non-empty strings');
  }

  const allowedCategories = ctx.taxonomy.categories.map((c) => c.value);
  if (!allowedCategories.includes(category)) {
    return reject(`category '${category}' is not in this product's taxonomy`);
  }
  if (!ctx.taxonomy.issue_types.includes(issue_type)) {
    return reject(`issue_type '${issue_type}' is not in this product's taxonomy`);
  }
  if (!ctx.taxonomy.impacts.includes(impact)) {
    return reject(`impact '${impact}' is not in this product's taxonomy`);
  }

  // ── Confidence ─────────────────────────────────────────────────────────
  const category_confidence = asUnit(data.category_confidence);
  const issue_type_confidence = asUnit(data.issue_type_confidence);
  const impact_confidence = asUnit(data.impact_confidence);
  if (
    category_confidence === null ||
    issue_type_confidence === null ||
    impact_confidence === null
  ) {
    return reject('category, issue_type and impact confidences must be numbers in [0,1]');
  }

  /**
   * The runner-up must be a REAL category. It feeds the margin, and the margin
   * decides whether a ticket auto-routes — so an unchecked runner-up is a
   * direct path from model output to an automation decision.
   */
  let category_runner_up: string | null = null;
  if (data.category_runner_up !== null && data.category_runner_up !== undefined) {
    const value = asString(data.category_runner_up);
    if (!value || !allowedCategories.includes(value)) {
      return reject('category_runner_up must be null or a category from the taxonomy');
    }
    category_runner_up = value;
  }

  let category_runner_up_confidence: number | null = null;
  if (
    data.category_runner_up_confidence !== null &&
    data.category_runner_up_confidence !== undefined
  ) {
    const value = asUnit(data.category_runner_up_confidence);
    if (value === null) {
      return reject('category_runner_up_confidence must be null or a number in [0,1]');
    }
    category_runner_up_confidence = value;
  }

  // A confidence with no value attached cannot form a margin. Dropping it
  // means computeMargin() correctly reports maximal separation rather than
  // subtracting a number that refers to nothing.
  if (category_runner_up === null) category_runner_up_confidence = null;

  // ── Priority factors ───────────────────────────────────────────────────
  const raw = data.priority_factors;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return reject('priority_factors must be an object');
  }
  const f = raw as Record<string, unknown>;

  const security_or_data_loss = asBool(f.security_or_data_loss);
  const system_down = asBool(f.system_down);
  const regulatory_impact = asBool(f.regulatory_impact);
  const workaround_available = asBool(f.workaround_available);
  const cosmetic_only = asBool(f.cosmetic_only);
  const priority_factor_confidence = asUnit(f.priority_factor_confidence);

  if (
    security_or_data_loss === null ||
    system_down === null ||
    regulatory_impact === null ||
    workaround_available === null ||
    cosmetic_only === null ||
    priority_factor_confidence === null
  ) {
    return reject(
      'priority_factors must carry five booleans and priority_factor_confidence in [0,1]',
    );
  }

  /**
   * null is a legitimate answer — no deadline was mentioned — and contributes
   * zero urgency. A negative or non-finite number is NOT legitimate and would
   * corrupt the deadline band lookup, so it is rejected rather than coerced.
   */
  let hours_until_deadline: number | null = null;
  if (f.hours_until_deadline !== null && f.hours_until_deadline !== undefined) {
    const h = f.hours_until_deadline;
    if (typeof h !== 'number' || !Number.isFinite(h) || h < 0) {
      return reject('hours_until_deadline must be null or a non-negative finite number');
    }
    hours_until_deadline = h;
  }

  const factors: PriorityFactors = {
    security_or_data_loss,
    system_down,
    hours_until_deadline,
    regulatory_impact,
    workaround_available,
    cosmetic_only,
    priority_factor_confidence,
  };

  // ── Narrative: bounded, never rejected ─────────────────────────────────
  //
  // These fields explain the classification; they do not drive it. Truncating
  // is right where rejecting would be disproportionate — losing a long
  // rationale is a cosmetic loss, losing the classification is not.
  const sentiment =
    typeof data.sentiment === 'string' ? data.sentiment.trim().slice(0, SENTIMENT_MAX) : '';
  const rationale =
    typeof data.rationale === 'string' ? data.rationale.trim().slice(0, RATIONALE_MAX) : '';
  const keywords_tags = normaliseKeywords(data.keywords_tags);

  // ── The decision, computed by Core ─────────────────────────────────────
  const decision = decide({
    category,
    category_confidence,
    category_runner_up_confidence,
    issue_type,
    issue_type_confidence,
    impact,
    impact_confidence,
    factors,
    impacts: ctx.taxonomy.impacts,
    core_categories: ctx.coreCategories,
    thresholds: ctx.thresholds,
  });

  const value: ClassificationData = {
    category,
    issue_type,
    impact,
    category_confidence,
    category_runner_up,
    category_runner_up_confidence,
    issue_type_confidence,
    impact_confidence,
    priority_factors: factors,
    sentiment,
    keywords_tags,
    rationale,
  };

  return { ok: true, value, decision };
}
