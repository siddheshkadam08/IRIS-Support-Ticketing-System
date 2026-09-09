import { describe, expect, it } from 'vitest';
import { ERROR_MESSAGE_MAX_CHARS, sanitiseErrorMessage } from './ai.service.js';

/**
 * `ai_execution.error_message` hardening — finding G-13.
 *
 * The field is about to become a Phase 17 governance surface, and its content
 * does not originate in IRIS: the worker forwards up to 500 characters of the
 * AI service's response body, which can carry a provider message quoting the
 * prompt it refused. The schema permits 2,000. Observed maximum today is 78.
 *
 * ⚠️ THIS IS SURFACE REDUCTION, NOT CONTENT DETECTION. There is no reliable way
 * to recognise a customer's own words inside a provider string, and a filter
 * that pretended to would repeat the keyword-matching mistake Phase 15 measured
 * failing. The real control is that no API exposes this field.
 */

describe('bounding', () => {
  it('leaves a normal message untouched', () => {
    const m = "category 'CATEGORY_THAT_DOES_NOT_EXIST' is not in this product's taxonomy";
    expect(sanitiseErrorMessage(m)).toBe(m);
  });

  it('⚠️ truncates anything longer than the bound, with a visible marker', () => {
    const out = sanitiseErrorMessage('x'.repeat(2000))!;
    expect(out.length).toBe(ERROR_MESSAGE_MAX_CHARS);
    expect(out.endsWith('…'), 'truncation must be visible, not silent').toBe(true);
  });

  it('accepts exactly the bound without truncating', () => {
    const exact = 'y'.repeat(ERROR_MESSAGE_MAX_CHARS);
    expect(sanitiseErrorMessage(exact)).toBe(exact);
  });

  it('keeps the bound generous enough for real diagnostics', () => {
    // The longest message the platform has ever produced is 78 characters.
    // A bound that clipped those would trade a privacy gain for an operational
    // loss, which is not the deal.
    expect(ERROR_MESSAGE_MAX_CHARS).toBeGreaterThan(78 * 2);
  });
});

describe('⚠️ credential redaction', () => {
  it.each([
    ['an OpenAI-style key', 'auth failed for sk-abcdefghijklmnop1234'],
    ['a publishable key', 'bad pk-livekey1234567890'],
    ['a bearer token', 'rejected: Bearer eyJhbGciOiJIUzI1NiJ9.abcdefgh'],
    ['a long opaque token', `token ${'A1b2C3d4'.repeat(6)} was rejected`],
  ])('redacts %s', (_label, input) => {
    const out = sanitiseErrorMessage(input)!;
    expect(out).toContain('[redacted]');
    expect(out).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
    expect(out).not.toMatch(/eyJhbGciOiJIUzI1NiJ9\.[A-Za-z0-9]+/);
  });

  it('does not shred ordinary words that merely look technical', () => {
    const m = 'provider returned HTTP 400 for deployment gpt-4.1';
    expect(sanitiseErrorMessage(m)).toBe(m);
  });
});

describe('normalisation', () => {
  it('strips control characters that would corrupt a log line or a table', () => {
    const dirty = `line one${String.fromCharCode(0)}\nline two\ttabbed`;
    const out = sanitiseErrorMessage(dirty)!;
    expect(out).toBe('line one line two tabbed');
    expect([...out].every((ch) => (ch.codePointAt(0) ?? 0) >= 0x20)).toBe(true);
  });

  it('collapses whitespace runs and trims', () => {
    expect(sanitiseErrorMessage('   too    many   spaces   ')).toBe('too many spaces');
  });

  it('maps null and whitespace-only to null rather than an empty string', () => {
    expect(sanitiseErrorMessage(null)).toBeNull();
    expect(sanitiseErrorMessage('    ')).toBeNull();
    expect(sanitiseErrorMessage('\n\t ')).toBeNull();
  });
});

describe('⚠️ what it deliberately does NOT do', () => {
  it('does not attempt to detect ticket content', () => {
    /**
     * A provider message that quotes the customer survives, and that is the
     * honest position: no filter can reliably tell a customer's words from a
     * provider's. The control is that the field is stored, never exposed —
     * asserted at the API level, not here.
     */
    const quoting = 'content filter triggered on: my password is hunter2';
    expect(sanitiseErrorMessage(quoting)).toBe(quoting);
  });

  it('is deterministic', () => {
    const m = 'the same input twice';
    expect(sanitiseErrorMessage(m)).toBe(sanitiseErrorMessage(m));
  });
});
