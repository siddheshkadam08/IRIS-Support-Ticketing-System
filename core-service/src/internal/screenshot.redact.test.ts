import { describe, expect, it } from 'vitest';
import {
  REDACTION_PLACEHOLDER,
  REDACTION_RULE_NAMES,
  redactSecrets,
} from './screenshot.redact.js';
import { validateScreenshot } from './screenshot.validator.js';

/**
 * Deterministic credential redaction — Phase 19 Step 3, SEC-16 to SEC-25.
 *
 * ⚠️ EVERY SECRET IN THIS FILE IS SYNTHETIC. None is a real credential, none
 * was ever valid, and several are deliberately malformed past their
 * recognisable prefix. Testing a redactor with a live token would be the same
 * mistake the redactor exists to prevent.
 *
 * ⚠️ THE FALSE-POSITIVE TESTS MATTER AS MUCH AS THE POSITIVE ONES. An agent
 * shown "[REDACTED_SECRET]" where "ERR_QUOTA_EXCEEDED" should be has a worse
 * ticket, not a safer one — so the survival cases below are load-bearing, not
 * decoration.
 */

const held = (s: string) => redactSecrets(s).text;
const gone = (secret: string, text: string) => {
  const out = redactSecrets(text).text;
  return !out.includes(secret) && out.includes(REDACTION_PLACEHOLDER);
};

// ═══════════════════════════════════════════════════════════════════════
// SEC-16 to SEC-20 — what must not survive
// ═══════════════════════════════════════════════════════════════════════

describe('SEC-16 authorization values are redacted', () => {
  const token = 'AbCdEf1234567890GhIjKlMnOpQrStUv';

  it('redacts a full Authorization header line', () => {
    expect(gone(token, `Authorization: Bearer ${token}`)).toBe(true);
  });

  it('redacts a bare Bearer token', () => {
    expect(gone(token, `Bearer ${token}`)).toBe(true);
  });

  it('keeps the scheme, because that is the diagnostic part', () => {
    expect(held(`Authorization: Bearer ${token}`)).toBe(
      `Authorization: Bearer ${REDACTION_PLACEHOLDER}`,
    );
  });

  it('redacts Basic and Token schemes too', () => {
    expect(gone(token, `Basic ${token}`)).toBe(true);
    expect(gone(token, `Token ${token}`)).toBe(true);
  });

  it('is case-insensitive on the scheme', () => {
    expect(gone(token, `bearer ${token}`)).toBe(true);
  });
});

describe('SEC-17 JWT-shaped tokens are redacted', () => {
  // Synthetic: header/payload/signature shaped, never signed by anything.
  const jwt =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';

  it('redacts a bare JWT', () => {
    expect(gone(jwt, `Session token ${jwt} shown on screen`)).toBe(true);
  });

  it('redacts a JWT inside an Authorization header', () => {
    expect(gone(jwt, `Authorization: Bearer ${jwt}`)).toBe(true);
  });

  it('does not redact an ordinary dotted identifier', () => {
    expect(held('com.example.service.v2')).toBe('com.example.service.v2');
  });
});

describe('SEC-18 key=value credential assignments are redacted', () => {
  it.each([
    ['password', 'password=hunter2000secret'],
    ['passwd', 'passwd: s0meL0ngValue'],
    ['secret', 'secret=abcdef123456'],
    ['client_secret', 'client_secret=Zx9QwErTyUiOpAsDfGh'],
    ['api_key', 'api_key=abcd1234efgh5678'],
    ['apikey', 'apikey: Kj28sHqLm93Xn4Zp'],
    ['access_token', 'access_token=aaaabbbbccccdddd'],
    ['refresh_token', 'refresh_token=eeeeffffgggghhhh'],
    ['private_key', 'private_key=MIIBOgIBAAJBAK7'],
  ])('redacts the value after %s', (_key, text) => {
    const out = redactSecrets(text).text;
    expect(out).toContain(REDACTION_PLACEHOLDER);
    expect(out.toLowerCase()).toContain(_key.split('=')[0]!.toLowerCase());
  });

  it('keeps the key so the agent still knows what was on screen', () => {
    expect(held('api_key=abcd1234efgh5678')).toBe(`api_key=${REDACTION_PLACEHOLDER}`);
  });

  it('redacts a quoted value', () => {
    expect(gone('my long secret value', 'password="my long secret value"')).toBe(true);
  });

  /**
   * ⚠️ THE STATUS-WORD CASE. A screenshot of an auth error is full of these,
   * and redacting them would delete the message the feature exists to capture.
   */
  it.each([
    'token: expired',
    'password: required',
    'api_key: missing',
    'secret: invalid',
    'access_token: revoked',
    'credentials: rejected',
  ])('leaves %p alone', (text) => {
    expect(held(text)).toBe(text);
  });

  it('leaves a masked value alone', () => {
    expect(held('password: ****')).toBe('password: ****');
  });

  it('leaves prose that merely mentions a password', () => {
    const s = 'Enter your password and click Sign in.';
    expect(held(s)).toBe(s);
  });
});

describe('SEC-19 private-key material is redacted', () => {
  const pem =
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAx7Vn9kQ2bLp\nQm4Zr8Tn2Wc5Yd1Hf3Jk6Lm9Np0Qr\n-----END RSA PRIVATE KEY-----';

  it('redacts a whole PEM block', () => {
    expect(gone('MIIEowIBAAKCAQEAx7Vn9kQ2bLp', pem)).toBe(true);
  });

  it('redacts an EC and a generic block too', () => {
    expect(gone('MIIEowIBAAKCAQ', '-----BEGIN EC PRIVATE KEY-----\nMIIEowIBAAKCAQ\n-----END EC PRIVATE KEY-----')).toBe(true);
    expect(gone('MIIEowIBAAKCAQ', '-----BEGIN PRIVATE KEY-----\nMIIEowIBAAKCAQ\n-----END PRIVATE KEY-----')).toBe(true);
  });

  /**
   * A screenshot usually cuts a key off. A half-captured private key is no less
   * a private key, so the block is removed to the end of the field.
   */
  it('redacts a block a screenshot truncated before END', () => {
    const cut = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAx7Vn9kQ2bLpQm4Z';
    expect(gone('MIIEowIBAAKCAQEAx7Vn9kQ2bLpQm4Z', cut)).toBe(true);
  });
});

describe('SEC-20 documented high-entropy and vendor formats are redacted', () => {
  /**
   * ⚠️ THE BODIES ARE DELIBERATELY ZEROS, NOT RANDOM-LOOKING STRINGS.
   *
   * The redaction rules key on the PREFIX and the LENGTH, never on entropy, so
   * a zero-filled body exercises them exactly as a realistic one would. What it
   * does not do is resemble a live credential.
   *
   * That matters beyond taste. An earlier version used realistic-looking
   * bodies, and GitHub push protection refused the commit — correctly, because
   * a scanner cannot tell a synthetic Slack token from a real one, and neither
   * can a human skimming a diff. A test fixture that has to be explained to a
   * secret scanner is a fixture that will be explained to a reviewer too.
   *
   * If a rule ever gains an entropy requirement, these fixtures must change
   * with it — and the failure will say so.
   */
  it.each([
    ['AWS access key id', 'AKIA0000000000000000'],
    ['GitHub token', 'ghp_0000000000000000000000000000000000'],
    ['Slack token', 'xoxb-000000000000-000000000000'],
    ['Stripe test key', 'sk_test_0000000000000000'],
    ['Google API key', 'AIza00000000000000000000000000000000000'],
    ['OpenAI-style key', 'sk-0000000000000000'],
  ])('redacts a synthetic %s', (_label, secret) => {
    expect(gone(secret, `Config shows ${secret} in the field.`)).toBe(true);
  });

  /**
   * The last-resort rule: 40+ characters mixing upper, lower and digits. The
   * variety requirement is the entire safety margin — see the note on the rule.
   */
  it('redacts a long opaque mixed-case token', () => {
    const blob = 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5bC7dE9fG';
    expect(blob.length).toBeGreaterThanOrEqual(40);
    expect(gone(blob, `Value ${blob} appears in the panel.`)).toBe(true);
  });

  it('does NOT redact a long single-case string (no entropy variety)', () => {
    const word = 'a'.repeat(60);
    expect(held(`Value ${word} here`)).toContain(word);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// SEC-21 and SEC-22 — what must survive
// ═══════════════════════════════════════════════════════════════════════

describe('SEC-21 ordinary error codes are never redacted', () => {
  it.each([
    'ERR_QUOTA_EXCEEDED',
    'ERR_QUOTA_EXCEEDED: monthly export limit reached (50 of 50 used).',
    'HTTP 500 Internal Server Error',
    'ORA-01017: invalid username/password',
    'E_ACCESS_DENIED',
    'SQLSTATE[23505]: unique_violation',
    'Error 0x80070005',
  ])('leaves %p intact', (text) => {
    expect(held(text)).toBe(text);
  });

  /** The exact string the live E2E depends on. */
  it('leaves the live fixture error code exactly as observed', () => {
    const s = 'ERR_QUOTA_EXCEEDED: monthly export limit reached (50 of 50 used).';
    expect(redactSecrets(s)).toEqual({ text: s, redactions: 0 });
  });
});

describe('SEC-22 identifiers and ordinary technical text are never redacted', () => {
  it.each([
    ['a UUID', '550e8400-e29b-41d4-a716-446655440000'],
    ['an uppercase UUID', '550E8400-E29B-41D4-A716-446655440000'],
    ['an IRIS ticket id', 'tkt_01M23R9VTQJXMM9TN0NN3C3E4H'],
    ['an IRIS attachment id', 'att_01M23REJX6JBFGK1S393XM78K8'],
    ['an IRIS execution id', 'aix_01M23REKTS44W1QK3JW9D0VJ8Y'],
    ['a ticket reference', 'CARB-9185'],
    ['a sha256 digest', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['a normal URL', 'https://reports.example.com/exports/2026/q3?page=2'],
    ['a date', '2026-09-10T00:26:26.000Z'],
    ['a version', 'v2.14.3-rc1'],
    ['a numeric value', '50 of 50 used'],
    ['an email address', 'support.agent@example.com'],
    ['a file path', 'C:\\Users\\Public\\Documents\\export.csv'],
    ['a class name', 'com.example.reporting.ExportServiceImpl'],
  ])('leaves %s intact', (_label, text) => {
    expect(redactSecrets(text)).toEqual({ text, redactions: 0 });
  });

  /** The whole observed live payload must round-trip unchanged. */
  it('leaves a realistic screenshot interpretation completely untouched', () => {
    const real = [
      'Export failed',
      'ERR_QUOTA_EXCEEDED: monthly export limit reached (50 of 50 used).',
      'Carbon Reporting',
      'Retry export',
      "Recent exports list shows 'Failed' for '2026-09-10 Q3 full disclosure'.",
      'Monthly export quota has been fully used (50 of 50 exports).',
      'Contact administrator to raise the plan quota.',
    ];
    for (const line of real) expect(redactSecrets(line)).toEqual({ text: line, redactions: 0 });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// The redactor as a component
// ═══════════════════════════════════════════════════════════════════════

describe('the redactor is deterministic and side-effect free', () => {
  const sample = 'Authorization: Bearer AbCdEf1234567890GhIjKlMnOpQrStUv';

  it('is idempotent — redacting twice changes nothing further', () => {
    const once = redactSecrets(sample).text;
    expect(redactSecrets(once).text).toBe(once);
  });

  it('gives the same answer every time', () => {
    expect(redactSecrets(sample)).toEqual(redactSecrets(sample));
  });

  /**
   * ⚠️ THE GLOBAL-REGEX TRAP. These are /g patterns held in a module-level
   * array; a shared `lastIndex` across calls makes a redactor start skipping
   * matches on every second invocation. Ten identical calls prove it does not.
   */
  it('does not degrade across repeated calls (shared lastIndex)', () => {
    for (let i = 0; i < 10; i++) {
      expect(redactSecrets(sample).text).toBe(`Authorization: Bearer ${REDACTION_PLACEHOLDER}`);
    }
  });

  it('counts redactions without revealing them', () => {
    const r = redactSecrets('api_key=abcd1234efgh5678 and Bearer AbCdEf1234567890GhIjKl');
    expect(r.redactions).toBe(2);
    expect(JSON.stringify(r)).not.toContain('abcd1234efgh5678');
  });

  it('handles empty and whitespace input', () => {
    expect(redactSecrets('')).toEqual({ text: '', redactions: 0 });
    expect(redactSecrets('   ')).toEqual({ text: '   ', redactions: 0 });
  });

  it('pins the documented rule set', () => {
    expect(REDACTION_RULE_NAMES).toEqual([
      'pem_private_key',
      'jwt',
      'aws_access_key_id',
      'github_token',
      'slack_token',
      'stripe_key',
      'google_api_key',
      'prefixed_api_key',
      'authorization_value',
      'secret_assignment',
      'high_entropy_token',
    ]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// SEC-23 — nothing unsanitized survives validation
// ═══════════════════════════════════════════════════════════════════════

describe('SEC-23 the validated result is sanitized on every string field', () => {
  const SECRET = 'AbCdEf1234567890GhIjKlMnOpQrStUv';
  const JWT =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r';

  /**
   * ⚠️ ALL FIVE PERSISTED STRING FIELDS AT ONCE. They share one code path
   * (`cleanString`), and this is the test that proves the sharing rather than
   * assuming it.
   */
  it('redacts observations, hint, causes and steps together', () => {
    const r = validateScreenshot({
      observations: [
        { type: 'error_message', value: `Authorization: Bearer ${SECRET}` },
        { type: 'other', value: `Session ${JWT}` },
      ],
      problem_hint: { domain: `api_key=${SECRET}`, category: `Bearer ${SECRET}` },
      possible_causes: [`The header showed Bearer ${SECRET}`],
      suggested_next_steps: [`Rotate api_key=${SECRET}`],
      confidence: 0.5,
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const serialized = JSON.stringify(r.value);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(JWT);
    expect(serialized).toContain(REDACTION_PLACEHOLDER);

    // Field by field, so a future refactor that misses one is caught here.
    expect(r.value.observations[0]!.value).not.toContain(SECRET);
    expect(r.value.observations[1]!.value).not.toContain(JWT);
    expect(r.value.problem_hint.domain).not.toContain(SECRET);
    expect(r.value.problem_hint.category).not.toContain(SECRET);
    expect(r.value.possible_causes[0]).not.toContain(SECRET);
    expect(r.value.suggested_next_steps[0]).not.toContain(SECRET);
  });

  it('a value that is nothing but a secret becomes the placeholder, not a rejection', () => {
    const r = validateScreenshot({
      observations: [{ type: 'other', value: `Bearer ${SECRET}` }],
      problem_hint: { domain: null, category: null },
      possible_causes: [],
      suggested_next_steps: [],
      confidence: 0.1,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.observations[0]!.value).toBe(`Bearer ${REDACTION_PLACEHOLDER}`);
  });

  /**
   * ⚠️ THE BOUND IS ENFORCED AFTER REDACTION. The placeholder is longer than
   * some secrets it replaces, so a value near the limit could otherwise be
   * pushed past it and stored oversized.
   */
  it('enforces the length bound on the redacted text, not the original', () => {
    // 195 chars of filler + a short secret: under 200 before, over after.
    const filler = 'x'.repeat(190);
    const r = validateScreenshot({
      observations: [{ type: 'other', value: `${filler} Bearer ABCdef123456` }],
      problem_hint: { domain: null, category: null },
      possible_causes: [],
      suggested_next_steps: [],
      confidence: 0.1,
    });
    // Either it fits after redaction, or it is rejected — but it is never
    // stored longer than the declared maximum.
    if (r.ok) expect(r.value.observations[0]!.value.length).toBeLessThanOrEqual(200);
    else expect(r.code).toBe('invalid_ai_output');
  });

  /**
   * ⚠️ REDACTION DOES NOT SOFTEN THE SCHEMA. Step 2's boundary still rejects
   * unexpected and decision fields; sanitization runs on values, never on the
   * shape.
   */
  it('still rejects a decision field, redaction notwithstanding', () => {
    const r = validateScreenshot({
      observations: [{ type: 'other', value: `Bearer ${SECRET}` }],
      problem_hint: { domain: null, category: null },
      possible_causes: [],
      suggested_next_steps: [],
      confidence: 0.5,
      severity: 'critical',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('screenshot_decision_field');
  });

  it('still rejects an unexpected field', () => {
    const r = validateScreenshot({
      observations: [],
      problem_hint: { domain: null, category: null },
      possible_causes: [],
      suggested_next_steps: [],
      confidence: 0.5,
      notes: 'extra',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid_ai_output');
  });

  it('leaves a clean interpretation byte-identical', () => {
    const clean = {
      observations: [{ type: 'error_code', value: 'ERR_QUOTA_EXCEEDED' }],
      problem_hint: { domain: 'reports', category: 'export' },
      possible_causes: ['The account exceeded its export quota.'],
      suggested_next_steps: ['Check the quota on the billing screen.'],
      confidence: 0.55,
    };
    const r = validateScreenshot(structuredClone(clean));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(clean);
  });
});
