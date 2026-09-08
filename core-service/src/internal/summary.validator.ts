import { SUMMARY_MAX_CHARS, SUMMARY_MIN_CHARS, type SummaryData } from '@iris/shared/types';

/**
 * Core's validation of AI summary output — Phase 5.
 *
 * Python already constrained the model with a one-field strict JSON schema and
 * validated the reply. This runs anyway, for the same reason the classification
 * validator does: Python is given its instructions by Core, so a stale,
 * misconfigured or compromised inference service produces output Python
 * happily accepts and Core must not. Model output is untrusted until a Core
 * validator accepts it — the Phase 1 rule, unchanged.
 *
 * What this validator CANNOT do is as important as what it does: it returns a
 * string and nothing else. There is no path from here to priority, severity,
 * category, routing, assignment or status, because the contract has no field
 * for any of them.
 *
 * The reference implementation does `.strip().strip('"')` and persists whatever
 * remains — no bound, no emptiness check, no way to distinguish a summary from
 * a refusal. This is that gap closed.
 */

export type SummaryValidation =
  | { ok: true; value: SummaryData }
  | { ok: false; code: string; message: string };

/**
 * Control characters have no business in a summary and would be rendered
 * literally in the admin UI. Newlines collapse to spaces rather than being
 * rejected: a model returning a two-line summary has followed the contract in
 * substance, and reformatting is not the same as fabricating.
 */
const isWhitespaceControl = (code: number): boolean =>
  code === 0x09 || code === 0x0a || code === 0x0d; // tab, newline, carriage return

/**
 * A control character that carries no layout meaning — NUL, bell, escape and
 * friends. Tab/newline/CR are deliberately NOT in this set: they are
 * whitespace, and DELETING them would join the words either side
 * ("failing.

About" -> "failing.About"). They are converted to spaces
 * instead, then collapsed with the rest of the whitespace.
 */
const isStrippableControl = (ch: string): boolean => {
  const code = ch.codePointAt(0) ?? 0;
  return (code < 0x20 && !isWhitespaceControl(code)) || code === 0x7f;
};

export function validateSummary(data: Record<string, unknown>): SummaryValidation {
  const reject = (message: string): SummaryValidation => ({
    ok: false,
    code: 'invalid_ai_output',
    message,
  });

  const raw = data.summary;
  if (typeof raw !== 'string') {
    return reject('summary must be a string');
  }

  // Strip control characters, collapse all whitespace runs (including
  // newlines) to single spaces, trim.
  const cleaned = [...raw]
    .filter((ch) => !isStrippableControl(ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();

  if (cleaned.length === 0) {
    return reject('summary must not be empty');
  }
  if (cleaned.length < SUMMARY_MIN_CHARS) {
    // A one-word reply is not a summary; it is usually a refusal or an echo.
    return reject(`summary is too short to be useful (${cleaned.length} chars)`);
  }

  /**
   * REJECT rather than truncate.
   *
   * Unlike classification's keywords — where dropping a bad tag protects the
   * rest of a valuable payload — the summary IS the whole payload, so
   * truncating protects nothing. And a summary cut mid-sentence is worse than
   * no summary: it reads as complete while silently omitting whatever followed
   * the cut, which is precisely the failure this feature must not produce.
   *
   * The prompt asks for ~40 words. Exceeding 600 characters means the model
   * disregarded the contract, which is the moment to stop trusting the output
   * rather than to tidy it up.
   */
  if (cleaned.length > SUMMARY_MAX_CHARS) {
    return reject(
      `summary exceeds ${SUMMARY_MAX_CHARS} characters (${cleaned.length}) — the model ignored the length contract`,
    );
  }

  return { ok: true, value: { summary: cleaned } };
}
