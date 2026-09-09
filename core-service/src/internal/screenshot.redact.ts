/**
 * Deterministic credential redaction for screenshot output — Phase 19 Step 3.
 *
 * ⚠️ WHY THIS EXISTS WHEN THE PROMPT ALREADY FORBIDS TRANSCRIBING SECRETS.
 *
 * It does, and that control stays. But a prompt is an instruction to a model,
 * and `ai_execution.result` is durable storage an agent's browser reads. The
 * Step 2 report listed exactly this as a limitation: "secret redaction is a
 * prompt-level control, not an enforced one". Persistence must not depend on
 * the model having followed its instructions, because the one time it does not
 * is the time the credential is written down permanently.
 *
 * So this runs AFTER schema validation and BEFORE persistence, and it is
 * mechanical: no model, no heuristic about intent, just a fixed pattern set.
 *
 * ⚠️ THIS IS NOT A GENERAL-PURPOSE SECRET DETECTOR, AND MUST NOT BECOME ONE.
 *
 * A detector that tries to catch everything catches error codes, identifiers
 * and ordinary prose, and an agent reading "[REDACTED_SECRET]" where
 * "ERR_QUOTA_EXCEEDED" should be has been given a worse ticket, not a safer
 * one. Every pattern below is either a documented credential format or a shape
 * with no plausible innocent reading. When in doubt, the value is kept.
 *
 * ⚠️ WHY IT IS SEPARATE FROM `sanitiseErrorMessage` (ai.service.ts).
 *
 * That function shares three of these patterns and is deliberately left alone:
 * it is bound to error-message semantics — a 240-character truncation and a
 * null-on-empty return — which are wrong for a bounded interpretation field,
 * and it belongs to a surface no API exposes. This one is broader (JWTs,
 * private-key blocks, key=value assignments, vendor formats), returns the
 * cleaned string unchanged in length policy, and guards a surface an agent
 * reads. The overlap is three regexes; unifying them would mean changing the
 * behaviour of every other feature's error path to serve this one.
 *
 * ⚠️ NOTHING HERE LOGS, THROWS, OR RETURNS THE ORIGINAL VALUE. A detector that
 * reported what it found would move the secret from a column into a log line.
 */

/** The single placeholder. Deterministic, so tests and readers agree. */
export const REDACTION_PLACEHOLDER = '[REDACTED_SECRET]';

/**
 * Assignment keys whose VALUE is redacted when one follows.
 *
 * The key itself is kept, so "api_key=[REDACTED_SECRET]" still tells an agent
 * what was on the screen. Note `token` is included but is the loosest of these,
 * which is why the value rules below are conservative.
 */
const SECRET_KEYS =
  'password|passwd|pwd|client[_-]?secret|secret|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|auth[_-]?token|session[_-]?token|private[_-]?key|credentials?|token';

/**
 * Words that follow a secret key but are plainly not secrets.
 *
 * `token: expired` and `password: required` are status messages, and a
 * screenshot of an error dialog is full of them. Redacting those would destroy
 * the very text the feature exists to capture.
 */
const NON_SECRET_VALUES = new Set([
  'expired', 'invalid', 'missing', 'required', 'null', 'none', 'empty',
  'unknown', 'error', 'failed', 'rejected', 'revoked', 'unset', 'blank',
  'incorrect', 'mismatch', 'unauthorized', 'forbidden', 'expiring',
]);

/**
 * The pattern set, applied in order. Most specific first, so a private key
 * block is removed whole before its base64 body could be matched piecemeal.
 *
 * DOCUMENTED SUPPORTED PATTERNS:
 *
 *   1. PEM private-key blocks, including a block truncated by a screenshot
 *   2. JWT-shaped tokens (three base64url segments beginning `eyJ`)
 *   3. Vendor key formats: AWS, GitHub, Slack, Stripe, Google, OpenAI-style
 *   4. `Bearer` / `Basic` authorization values
 *   5. `key=value` and `key: value` for the keys listed above
 *   6. A long opaque token that mixes upper, lower and digits (>= 40 chars)
 *
 * DELIBERATELY NOT MATCHED: error codes, UUIDs, ULIDs and IRIS ids, hex
 * digests, URLs, dates, numbers, and ordinary technical identifiers. Each has a
 * test asserting it survives.
 */
interface Rule {
  readonly name: string;
  readonly pattern: RegExp;
  readonly replace: (match: string, ...groups: string[]) => string;
}

const RULES: readonly Rule[] = [
  /**
   * A PEM block. The non-greedy body plus an optional END means a key that a
   * screenshot cut off mid-way is still removed to the end of the field —
   * a half-captured private key is no less a private key.
   */
  {
    name: 'pem_private_key',
    pattern: /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END[A-Z ]*PRIVATE KEY-----|$)/gi,
    replace: () => REDACTION_PLACEHOLDER,
  },

  /**
   * JWT. `eyJ` is base64url for `{"`, so a three-segment token starting that
   * way is a JSON Web Token and essentially nothing else. Segment minimums stop
   * it matching ordinary dotted words.
   */
  {
    name: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replace: () => REDACTION_PLACEHOLDER,
  },

  // Vendor formats. Each is a published, fixed shape with no innocent reading.
  { name: 'aws_access_key_id', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: () => REDACTION_PLACEHOLDER },
  { name: 'github_token', pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, replace: () => REDACTION_PLACEHOLDER },
  { name: 'slack_token', pattern: /\bxox[baprse]-[A-Za-z0-9-]{10,}\b/g, replace: () => REDACTION_PLACEHOLDER },
  { name: 'stripe_key', pattern: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g, replace: () => REDACTION_PLACEHOLDER },
  { name: 'google_api_key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, replace: () => REDACTION_PLACEHOLDER },
  {
    name: 'prefixed_api_key',
    // sk-…, pk-…, rk-… — the same shape sanitiseErrorMessage already guards.
    pattern: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g,
    replace: () => REDACTION_PLACEHOLDER,
  },

  /**
   * An authorization value. The SCHEME IS KEPT — "Bearer [REDACTED_SECRET]"
   * still tells an agent the screen showed an auth header, which is often the
   * diagnostically useful part.
   */
  {
    name: 'authorization_value',
    pattern: /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    replace: (_m, scheme: string) => `${scheme} ${REDACTION_PLACEHOLDER}`,
  },

  /**
   * `key=value` / `key: value`.
   *
   * The value must be at least 6 characters and must not be a status word, so
   * `token: expired` and `password: ****` are left intact. Quoted values are
   * matched whole so a quoted secret containing spaces is caught.
   */
  {
    name: 'secret_assignment',
    pattern: new RegExp(
      `\\b(${SECRET_KEYS})(\\s*[:=]\\s*)("[^"]{6,}"|'[^']{6,}'|[^\\s"',;]{6,})`,
      'gi',
    ),
    replace: (match: string, key: string, sep: string, value: string) => {
      const bare = value.replace(/^["']|["']$/g, '').toLowerCase();
      // A status word is not a credential; keep the diagnostic.
      if (NON_SECRET_VALUES.has(bare)) return match;
      return `${key}${sep}${REDACTION_PLACEHOLDER}`;
    },
  },

  /**
   * A long opaque token, and the LAST resort.
   *
   * ⚠️ THE VARIETY REQUIREMENT IS THE WHOLE SAFETY MARGIN, and it is inherited
   * from `sanitiseErrorMessage`, where a version without it was caught turning
   * a 240-character diagnostic into "[redacted]". Requiring lower AND upper AND
   * a digit, at 40+ characters, excludes by construction:
   *
   *   ERR_QUOTA_EXCEEDED         no lowercase, and far too short
   *   a UUID                     36 chars, lowercase hex only
   *   tkt_/att_/aix_ ULID ids    30 chars
   *   a sha256 digest            64 chars but single-case hex
   *   any English word or path   no digit, or broken by / and .
   *
   * 40 rather than 32 is deliberate: IRIS prefixed ULIDs are 30 characters, and
   * a threshold close to a real identifier length is a threshold that will
   * eventually clip one.
   */
  {
    name: 'high_entropy_token',
    pattern:
      /\b(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{40,}\b/g,
    replace: () => REDACTION_PLACEHOLDER,
  },
];

export interface RedactionResult {
  text: string;
  /** How many rules fired. Never which values, and never the values. */
  redactions: number;
}

/**
 * Redact recognizable credential material from one string.
 *
 * Pure, deterministic and side-effect free. It never logs, never throws and
 * never returns the original secret — the caller receives the cleaned text and
 * a count, and the count is the only thing safe to report anywhere.
 */
export function redactSecrets(input: string): RedactionResult {
  let text = input;
  let redactions = 0;

  for (const rule of RULES) {
    // A fresh lastIndex each pass: these are /g regexes held in a module-level
    // array, and a shared lastIndex across calls is how a global regex starts
    // silently skipping matches on every second invocation.
    rule.pattern.lastIndex = 0;
    text = text.replace(rule.pattern, (...args) => {
      const groups = args.slice(1, -2) as string[];
      const replacement = rule.replace(args[0] as string, ...groups);
      // A rule may decline (the status-word case), which is not a redaction.
      if (replacement !== args[0]) redactions++;
      return replacement;
    });
  }

  return { text, redactions };
}

/** The rule names, for documentation and for the test that pins the set. */
export const REDACTION_RULE_NAMES: readonly string[] = RULES.map((r) => r.name);
