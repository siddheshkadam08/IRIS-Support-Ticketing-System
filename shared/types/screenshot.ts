/**
 * Screenshot AI contract — Phase 19 Step 2.
 *
 * ⚠️ AI OBSERVES. CORE DECIDES.
 *
 * Everything in this file is shaped by one rule: vision output is EVIDENCE, and
 * evidence is not a decision. There is no field here for priority, severity,
 * routing, assignment, status, SLA, resolution or a customer reply — not
 * "optional" ones, not nullable ones, none. A model that wanted to set a
 * ticket's severity has nowhere to write it, so the boundary is enforced by the
 * shape of the type rather than by a reviewer noticing.
 *
 * That is the same technique Phase 12 and 13 used to stop a model naming a
 * document Core did not supply: make the wrong thing unrepresentable instead of
 * merely invalid.
 *
 * ⚠️ NO NODE IMPORTS. Imported by the admin panel through the
 * `@iris/shared/screenshot` subpath, exactly as the KB lifecycle is, so that
 * `node:crypto` (via ids.ts in the types barrel) never reaches the browser
 * bundle.
 */

// ─────────────────────────────────────────────────────────────────────────
// What may be analysed
// ─────────────────────────────────────────────────────────────────────────

/**
 * ⚠️ NARROWER THAN THE UPLOAD ALLOWLIST, DELIBERATELY.
 *
 * `image/gif` is a valid attachment and is content-verified at upload, but it
 * is NOT analysed. An animation raises a question this phase does not answer —
 * which frame is the evidence? — and answering it silently by taking the first
 * frame would make the interpretation depend on something nobody chose. PDF is
 * absent for the same class of reason: it is a document that would need
 * rendering IRIS does not do.
 *
 * Anything not on this list is skipped as a PERMANENT, expected outcome, not a
 * failure: attaching a CSV to a ticket is normal, and it must not produce an
 * error anyone has to triage.
 */
export const SCREENSHOT_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type ScreenshotMimeType = (typeof SCREENSHOT_MIME_TYPES)[number];

export function isScreenshotMimeType(value: string): value is ScreenshotMimeType {
  return (SCREENSHOT_MIME_TYPES as readonly string[]).includes(value);
}

/**
 * ⚠️ THE VISION DISPATCH BOUND, WHICH IS NOT THE STORAGE BOUND.
 *
 * Phase 19 Step 1 set MAX_IMAGE_WIDTH/HEIGHT 20000 and 50 MP. Those are
 * SAFETY limits chosen against decompression bombs, and they run on every image
 * upload including ones no model will ever see, so they are deliberately loose
 * enough not to reject a real full-page capture.
 *
 * These are different limits for a different reason: cost and usefulness. A
 * vision model tiles an image and stops gaining signal past roughly 2000px on
 * the short side, so a 40 MP screenshot is billed as a large image and read as
 * a small one. Bytes are the operative bound because bytes are what crosses the
 * wire, inflate by 4/3 as base64, and land in the provider's request body.
 *
 *   4 MiB   comfortably holds a lossless 4K PNG screenshot (typically 1-3 MiB)
 *           and becomes ~5.3 MiB of base64 in the JSON body.
 *   12000   per axis, and 40 MP, are the secondary guard for the pathological
 *           case of a huge canvas that still compresses small.
 *
 * ⚠️ APPLIED IN CORE, BEFORE THE WORKER IS GIVEN THE BYTES. Rejecting at
 * dispatch rather than at the provider is what makes an oversized screenshot
 * cost nothing: no HTTP call, no tokens, no bill. It is also why the check
 * cannot live in Python — by then the payload has already been sent.
 */
export const SCREENSHOT_MAX_BYTES = 4 * 1024 * 1024;
export const SCREENSHOT_MAX_WIDTH = 12_000;
export const SCREENSHOT_MAX_HEIGHT = 12_000;
export const SCREENSHOT_MAX_PIXELS = 40_000_000;

// ─────────────────────────────────────────────────────────────────────────
// The structured output
// ─────────────────────────────────────────────────────────────────────────

/**
 * What kind of thing was seen.
 *
 * A CLOSED SET, and small on purpose. An open `type` string would let the model
 * invent a taxonomy, and a second taxonomy alongside the product's configured
 * categories is exactly what the Phase 19 audit ruled out: Screenshot AI
 * supplies evidence that the EXISTING classification can consume, and never a
 * competing category system.
 */
export const SCREENSHOT_OBSERVATION_TYPES = [
  'error_code',
  'error_message',
  'application',
  'ui_element',
  'other',
] as const;
export type ScreenshotObservationType = (typeof SCREENSHOT_OBSERVATION_TYPES)[number];

/**
 * Bounds. Every one of these is enforced by Core, not merely requested in a
 * prompt — the model is untrusted output, so "the schema said 10" is a hope and
 * a validator is a guarantee.
 *
 * They are small because the consumer is an agent glancing at a ticket, and
 * because an unbounded array is an unbounded row in `ai_execution.result`.
 */
export const SCREENSHOT_MAX_OBSERVATIONS = 10;
export const SCREENSHOT_MAX_OBSERVATION_CHARS = 200;
export const SCREENSHOT_MAX_HINT_CHARS = 60;
export const SCREENSHOT_MAX_CAUSES = 5;
export const SCREENSHOT_MAX_STEPS = 5;
export const SCREENSHOT_MAX_TEXT_CHARS = 300;

/**
 * A hard ceiling on the whole validated payload, checked after field
 * validation. The per-field bounds already imply a maximum, so this exists to
 * catch the case they do not: a future field added without a bound. Cheap, and
 * it fails loudly rather than growing `ai_execution.result` quietly.
 */
export const SCREENSHOT_MAX_RESULT_BYTES = 8 * 1024;

export interface ScreenshotObservation {
  type: ScreenshotObservationType;
  /** What was literally visible. Never an inference. */
  value: string;
}

/**
 * A HINT, and the name is load-bearing.
 *
 * These are free strings rather than the product's category enum, and that is
 * deliberate in both directions: the model must not be handed the taxonomy to
 * choose from (that is classification's job, and it re-validates against Core's
 * own vocabulary), and it must not be able to assert a category that looks
 * authoritative. A hint is something a human or a later classification pass can
 * weigh; it is not a label.
 */
export interface ScreenshotProblemHint {
  domain: string | null;
  category: string | null;
}

/**
 * ⚠️ NOTE WHAT IS ABSENT AND MUST STAY ABSENT: priority, severity, category
 * (as an authoritative field), assignee, team, routing, status, sla, resolution,
 * customer_message, action, auto_*. None of these has a field here, so vision
 * cannot express a decision even if a future prompt asked it to.
 */
export interface ScreenshotInterpretation {
  observations: ScreenshotObservation[];
  problem_hint: ScreenshotProblemHint;
  possible_causes: string[];
  suggested_next_steps: string[];
  /**
   * ⚠️ THE MODEL'S OWN REPORTED SIGNAL. NOT A CALIBRATED PROBABILITY.
   *
   * Phase 4 measured exactly this on classification: the model returned >=0.95
   * on almost every ticket, which is high self-reported confidence and says
   * nothing about whether the signal discriminates correct from incorrect.
   * Store it, show it labelled as what it is, and never render it as an
   * accuracy figure. See the UI rules in the admin page.
   */
  confidence: number;
}

/**
 * The keys Core will accept. Anything else is a rejection, not a silent drop.
 *
 * Exported so the validator and its tests share one definition: a field added
 * to the interface but not here would be stripped, and a field added here but
 * not validated would be persisted unchecked.
 */
export const SCREENSHOT_RESULT_KEYS = [
  'observations',
  'problem_hint',
  'possible_causes',
  'suggested_next_steps',
  'confidence',
] as const;

/**
 * Field names that would represent a DECISION rather than evidence.
 *
 * ⚠️ THIS IS A TRIPWIRE, NOT THE ENFORCEMENT. The enforcement is that the
 * accepted key set above is closed, so every one of these is already rejected
 * as an unexpected field. This list exists so that a rejection carrying one of
 * these names is reported distinctly: a model returning `severity` is not a
 * schema typo, it is the model trying to make a business decision, and that is
 * worth being able to see in the logs.
 */
export const SCREENSHOT_FORBIDDEN_KEYS = [
  'priority',
  'severity',
  'assignee',
  'assignee_id',
  'team',
  'routing',
  'route_to',
  'status',
  'sla',
  'resolution',
  'resolved',
  'customer_message',
  'reply',
  'comment',
  'action',
  'auto_resolve',
] as const;

// ─────────────────────────────────────────────────────────────────────────
// What Core stores and the UI reads
// ─────────────────────────────────────────────────────────────────────────

/**
 * One screenshot interpretation as the admin panel receives it.
 *
 * `attachment_id` is carried in the VALIDATED RESULT rather than in a new
 * `ai_execution` column. The Phase 19 audit called this out: the linkage
 * already exists through the event, a column would be a migration, and the id
 * is an opaque ULID that identifies no tenant. Core writes it from the event
 * payload it resolved itself; the model has no field in which to influence it.
 */
export interface ScreenshotResultDTO {
  execution_id: string;
  attachment_id: string | null;
  status: 'running' | 'succeeded' | 'failed';
  interpretation: ScreenshotInterpretation | null;
  error_code: string | null;
  model: string | null;
  provider: string | null;
  latency_ms: number | null;
  created_at: string;
  completed_at: string | null;
}
