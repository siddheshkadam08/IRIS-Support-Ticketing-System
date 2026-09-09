import { describe, expect, it, vi } from 'vitest';
import { executeAI, providerCodeOf } from './ai-client.js';
import { isPermanent } from './errors.js';

/**
 * The durable failure taxonomy — finding G-3.
 *
 * The AI service classifies failures precisely: `provider_content_filter`,
 * `provider_http_429`, `provider_not_configured`, `invalid_input`,
 * `malformed_ai_response`. All of it was collapsed into `ai_http_<status>` at
 * this boundary, which is why 264 of the 282 real failures in the governance
 * corpus said only "the AI service said no".
 *
 * The property under test:
 *
 *     runtime already knows the reason  ->  that reason reaches error_code
 *
 * ⚠️ AND THE RETRY CLASS IS UNCHANGED. Every case below asserts the
 * temporary/permanent decision as well, because a richer label must not become
 * a behaviour change. BullMQ remains the sole retry owner, deciding from the
 * HTTP status exactly as before.
 */

/** The AI service's real error envelope. */
const envelope = (code: string, kind: 'temporary' | 'permanent' = 'permanent') =>
  JSON.stringify({ error: { kind, code, message: 'provider said no' } });

function stub(status: number, body: string) {
  const impl = (async () =>
    new Response(body, { status })) as unknown as typeof fetch;
  return impl;
}

const request = {
  feature: 'classification' as const,
  request_id: 'req_tax',
  input: { subject: null, description: 'x' },
};

async function codeFor(status: number, body: string) {
  try {
    await executeAI(request as never, stub(status, body));
    throw new Error('expected a throw');
  } catch (err) {
    return {
      code: (err as { code?: string }).code,
      permanent: isPermanent(err),
    };
  }
}

describe('⚠️ the AI service’s own code survives to the durable record', () => {
  it.each([
    // code the service emits            status  expected retry class
    ['provider_content_filter', 422, true],
    ['provider_not_configured', 422, true],
    ['invalid_input', 422, true],
    ['malformed_ai_response', 422, true],
    ['unsupported_feature', 400, true],
  ] as const)('%s (HTTP %i) is preserved', async (code, status, permanent) => {
    const out = await codeFor(status, envelope(code));
    expect(out.code, 'the specific reason must reach error_code').toBe(code);
    expect(out.permanent, 'retry class must be unchanged').toBe(permanent);
  });

  it.each([
    ['provider_http_429', 429],
    ['provider_http_503', 503],
    ['provider_http_500', 500],
  ] as const)('%s (HTTP %i) is preserved AND stays retryable', async (code, status) => {
    const out = await codeFor(status, envelope(code, 'temporary'));
    expect(out.code).toBe(code);
    // ⚠️ 429 and 5xx must still be temporary — this is the regression that
    // would matter most, because it would dead-letter a rate-limited job.
    expect(out.permanent).toBe(false);
  });
});

describe('⚠️ the fallback is byte-identical to the old behaviour', () => {
  it.each([
    ['no body', ''],
    ['not JSON', 'Bad Gateway'],
    ['JSON without an error object', '{"detail":"nope"}'],
    ['error without a code', '{"error":{"kind":"permanent"}}'],
    ['a non-string code', '{"error":{"code":42}}'],
    ['null', 'null'],
  ])('falls back to ai_http_<status> given %s', async (_label, body) => {
    const out = await codeFor(422, body);
    expect(out.code).toBe('ai_http_422');
    expect(out.permanent).toBe(true);
  });

  it('keeps the existing code shape, so nothing depending on it breaks', () => {
    expect(providerCodeOf('', 422)).toBe('ai_http_422');
    expect(providerCodeOf('', 503)).toBe('ai_http_503');
  });
});

describe('⚠️ a hostile provider cannot use error_code as a content channel', () => {
  /**
   * The code becomes durable telemetry, so it is character-restricted rather
   * than trusted. A provider that echoed a prompt fragment into a `code` field
   * would otherwise write ticket content into the governance store.
   */
  it.each([
    ['a sentence', 'the customer said their password is hunter2'],
    ['upper case', 'PROVIDER_CONTENT_FILTER'],
    ['punctuation', 'provider.content-filter'],
    ['a leading digit', '4xx_error'],
    ['whitespace', 'provider content filter'],
    ['over-long', 'a'.repeat(65)],
    ['empty', ''],
  ])('rejects %s in favour of the fallback', (_label, code) => {
    expect(providerCodeOf(JSON.stringify({ error: { code } }), 422)).toBe('ai_http_422');
  });

  it('accepts a well-formed machine token at the boundary length', () => {
    expect(providerCodeOf(JSON.stringify({ error: { code: 'a' } }), 422)).toBe('a');
    const max = `a${'b'.repeat(63)}`;
    expect(providerCodeOf(JSON.stringify({ error: { code: max } }), 422)).toBe(max);
  });
});

describe('transport failures keep their existing codes', () => {
  it('an unreachable service is ai_service_unreachable and temporary', async () => {
    const impl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    try {
      await executeAI(request as never, impl);
      throw new Error('expected a throw');
    } catch (err) {
      expect((err as { code?: string }).code).toBe('ai_service_unreachable');
      expect(isPermanent(err)).toBe(false);
    }
  });

  it('a timeout is ai_service_timeout and temporary', async () => {
    const impl = (async () => {
      const e = new Error('aborted');
      e.name = 'TimeoutError';
      throw e;
    }) as unknown as typeof fetch;
    try {
      await executeAI(request as never, impl);
      throw new Error('expected a throw');
    } catch (err) {
      expect((err as { code?: string }).code).toBe('ai_service_timeout');
      expect(isPermanent(err)).toBe(false);
    }
  });
});

describe('⚠️ nothing here changes retry ownership', () => {
  it('the client never retries — one call per invocation', async () => {
    let calls = 0;
    const impl = (async () => {
      calls += 1;
      return new Response(envelope('provider_http_429', 'temporary'), { status: 429 });
    }) as unknown as typeof fetch;

    await expect(executeAI(request as never, impl)).rejects.toThrow();
    expect(calls, 'a retry here would be a second retry owner').toBe(1);
  });
});
