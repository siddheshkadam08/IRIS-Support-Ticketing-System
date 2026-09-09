import {
  SCREENSHOT_FORBIDDEN_KEYS,
  SCREENSHOT_MAX_CAUSES,
  SCREENSHOT_MAX_HINT_CHARS,
  SCREENSHOT_MAX_OBSERVATIONS,
  SCREENSHOT_MAX_OBSERVATION_CHARS,
  SCREENSHOT_MAX_RESULT_BYTES,
  SCREENSHOT_MAX_STEPS,
  SCREENSHOT_MAX_TEXT_CHARS,
  SCREENSHOT_OBSERVATION_TYPES,
  SCREENSHOT_RESULT_KEYS,
  type ScreenshotInterpretation,
  type ScreenshotObservation,
} from '@iris/shared/types';
import { redactSecrets } from './screenshot.redact.js';

/**
 * Screenshot output validation — Phase 19 Step 2.
 *
 * ⚠️ PYTHON ACCEPTING A PAYLOAD HAS NEVER BEEN A SECURITY PROPERTY.
 *
 * The AI service already validates against its own Pydantic model and the
 * provider already validated against a strict JSON schema. Neither is trusted
 * here, for the same reason `validateClassification` re-checks every enum
 * against Core's taxonomy: those checks run on the other side of a boundary
 * this service does not control, and the value that reaches `ai_execution.result`
 * is the value Core accepted, not the value someone else approved.
 *
 * ⚠️ THE KEY SET IS CLOSED, AND THAT IS THE DECISION BOUNDARY.
 *
 * An unexpected key is a REJECTION, never a silent drop. That is what makes
 * "vision cannot mutate a ticket" structural rather than aspirational: there is
 * no field named `severity` to honour, and a payload containing one does not
 * get quietly stripped and stored — it fails, loudly, with a code that says a
 * decision field was attempted.
 *
 * Stripping would have been the friendlier choice and it is the wrong one. A
 * model that starts returning `priority` is a model whose prompt or version
 * changed, and the only way anyone finds out is if it breaks.
 */

export type ScreenshotValidation =
  | { ok: true; value: ScreenshotInterpretation }
  | { ok: false; code: string; message: string };

const fail = (message: string, code = 'invalid_ai_output'): ScreenshotValidation => ({
  ok: false,
  code,
  message,
});

/**
 * A bounded, non-empty, single-line string.
 *
 * Control characters are STRIPPED rather than the string rejected: a model that
 * wrapped a sentence has not made an error, and this text is rendered into an
 * agent's browser, where a stray control byte is at best noise.
 *
 * ⚠️ THE CLASS IS SPELLED WITH ESCAPES, NEVER WITH LITERAL BYTES. Writing the
 * range as actual control characters works and is unreadable, unreviewable and
 * one careless reformat away from changing meaning. The near-miss spelling
 * `[ -]` is worse still: it is a range across printable punctuation that
 * silently deletes `!"#$%&'()*+,-` from every error message it touches, which no
 * assertion on "non-empty and short enough" would catch.
 *
 * The length bound is applied AFTER collapsing, so whitespace can neither
 * smuggle a string past a limit nor fail one that should pass.
 */
function cleanString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const flat = value
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  /**
   * ⚠️ Phase 19 Step 3 — REDACTION HAPPENS HERE, AND HERE ONLY.
   *
   * Every string that can reach `ai_execution.result` passes through this
   * function: `observations[].value`, `problem_hint.domain`,
   * `problem_hint.category`, and both `possible_causes[]` and
   * `suggested_next_steps[]` through validateStringArray. One call site means
   * a field added later cannot forget it — the alternative, five call sites,
   * is five chances to miss one.
   *
   * ⚠️ ORDER: COLLAPSE, THEN REDACT, THEN BOUND.
   *
   * Collapsing first is what lets a multi-line PEM block match a single-line
   * pattern. Bounding LAST means the limit is enforced on the text actually
   * stored, so a redaction that LENGTHENS a string (the placeholder is 17
   * characters) can never push a stored value past its declared maximum.
   *
   * The count is discarded rather than logged. A detector that reported what
   * it found would move the secret out of a column and into a log line.
   */
  const redacted = redactSecrets(flat).text;

  if (redacted.length === 0 || redacted.length > max) return null;
  return redacted;
}

function validateStringArray(
  value: unknown,
  field: string,
  maxItems: number,
  maxChars: number,
): { ok: true; value: string[] } | { ok: false; message: string } {
  if (!Array.isArray(value)) return { ok: false, message: `${field} must be an array` };
  if (value.length > maxItems) {
    return { ok: false, message: `${field} must contain at most ${maxItems} entries` };
  }
  const out: string[] = [];
  for (const entry of value) {
    const clean = cleanString(entry, maxChars);
    if (clean === null) {
      return {
        ok: false,
        message: `${field} entries must be non-empty strings of at most ${maxChars} characters`,
      };
    }
    out.push(clean);
  }
  return { ok: true, value: out };
}

export function validateScreenshot(data: Record<string, unknown>): ScreenshotValidation {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return fail('screenshot result must be an object');
  }

  /**
   * ⚠️ THE CLOSED KEY CHECK RUNS FIRST, BEFORE ANY FIELD IS READ.
   *
   * A payload carrying a decision field is refused on that basis alone, so a
   * malformed `observations` array can never mask the more interesting fact
   * that the model also tried to set a severity.
   */
  const keys = Object.keys(data);
  const unexpected = keys.filter((k) => !(SCREENSHOT_RESULT_KEYS as readonly string[]).includes(k));
  if (unexpected.length > 0) {
    const decisionFields = unexpected.filter((k) =>
      (SCREENSHOT_FORBIDDEN_KEYS as readonly string[]).includes(k.toLowerCase()),
    );
    if (decisionFields.length > 0) {
      /**
       * A DISTINCT CODE. This is not a schema slip; it is the model reaching
       * for authority the architecture does not give it, and it should be
       * greppable in `ai_execution.error_code` as its own thing.
       */
      return fail(
        `screenshot output attempted decision field(s): ${decisionFields.join(', ')}`,
        'screenshot_decision_field',
      );
    }
    return fail(`screenshot output has unexpected field(s): ${unexpected.join(', ')}`);
  }

  for (const required of SCREENSHOT_RESULT_KEYS) {
    if (!(required in data)) return fail(`screenshot output is missing ${required}`);
  }

  // ── observations ──────────────────────────────────────────────────────
  if (!Array.isArray(data.observations)) return fail('observations must be an array');
  if (data.observations.length > SCREENSHOT_MAX_OBSERVATIONS) {
    return fail(`observations must contain at most ${SCREENSHOT_MAX_OBSERVATIONS} entries`);
  }

  const observations: ScreenshotObservation[] = [];
  for (const raw of data.observations) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return fail('each observation must be an object');
    }
    const entry = raw as Record<string, unknown>;
    const extra = Object.keys(entry).filter((k) => k !== 'type' && k !== 'value');
    if (extra.length > 0) return fail(`observation has unexpected field(s): ${extra.join(', ')}`);

    if (!(SCREENSHOT_OBSERVATION_TYPES as readonly string[]).includes(entry.type as string)) {
      // A type outside the closed set would be a taxonomy the model invented.
      return fail(
        `observation.type must be one of: ${SCREENSHOT_OBSERVATION_TYPES.join(', ')}`,
      );
    }
    const value = cleanString(entry.value, SCREENSHOT_MAX_OBSERVATION_CHARS);
    if (value === null) {
      return fail(
        `observation.value must be a non-empty string of at most ${SCREENSHOT_MAX_OBSERVATION_CHARS} characters`,
      );
    }
    observations.push({ type: entry.type as ScreenshotObservation['type'], value });
  }

  // ── problem_hint ──────────────────────────────────────────────────────
  const hintRaw = data.problem_hint;
  if (hintRaw === null || typeof hintRaw !== 'object' || Array.isArray(hintRaw)) {
    return fail('problem_hint must be an object');
  }
  const hint = hintRaw as Record<string, unknown>;
  const hintExtra = Object.keys(hint).filter((k) => k !== 'domain' && k !== 'category');
  if (hintExtra.length > 0) return fail(`problem_hint has unexpected field(s): ${hintExtra.join(', ')}`);

  /**
   * Both are nullable and BOTH NULL IS A VALID, USEFUL ANSWER. A screenshot
   * that shows nothing recognisable should say so; forcing a guess is how a
   * hint becomes noise an agent learns to ignore.
   */
  const readHint = (v: unknown): string | null | undefined => {
    if (v === null || v === undefined) return null;
    return cleanString(v, SCREENSHOT_MAX_HINT_CHARS) ?? undefined;
  };
  const domain = readHint(hint.domain);
  const category = readHint(hint.category);
  if (domain === undefined || category === undefined) {
    return fail(
      `problem_hint.domain and problem_hint.category must be null or strings of at most ${SCREENSHOT_MAX_HINT_CHARS} characters`,
    );
  }

  // ── causes and steps ──────────────────────────────────────────────────
  const causes = validateStringArray(
    data.possible_causes,
    'possible_causes',
    SCREENSHOT_MAX_CAUSES,
    SCREENSHOT_MAX_TEXT_CHARS,
  );
  if (!causes.ok) return fail(causes.message);

  const steps = validateStringArray(
    data.suggested_next_steps,
    'suggested_next_steps',
    SCREENSHOT_MAX_STEPS,
    SCREENSHOT_MAX_TEXT_CHARS,
  );
  if (!steps.ok) return fail(steps.message);

  // ── confidence ────────────────────────────────────────────────────────
  /**
   * Range-checked, and nothing more is claimed about it. It is the model's
   * self-reported signal; Phase 4 measured that such a signal can sit above
   * 0.95 on nearly everything and still not discriminate. NaN is rejected
   * explicitly — it is a number by typeof, survives JSON round-trips as null
   * or a string in some encoders, and compares false against every bound, so
   * an unguarded `>= 0 && <= 1` silently lets it through the wrong way.
   */
  const confidence = data.confidence;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) {
    return fail('confidence must be a finite number');
  }
  if (confidence < 0 || confidence > 1) return fail('confidence must be between 0 and 1');

  const value: ScreenshotInterpretation = {
    observations,
    problem_hint: { domain, category },
    possible_causes: causes.value,
    suggested_next_steps: steps.value,
    confidence,
  };

  /**
   * The size ceiling, checked on the ACCEPTED value rather than the input.
   * Per-field bounds already imply a maximum today; this catches the case they
   * would not — a field added later without one — before it grows every
   * `ai_execution.result` row.
   */
  const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (bytes > SCREENSHOT_MAX_RESULT_BYTES) {
    return fail(`screenshot result is ${bytes} bytes, over the ${SCREENSHOT_MAX_RESULT_BYTES} limit`);
  }

  return { ok: true, value };
}
