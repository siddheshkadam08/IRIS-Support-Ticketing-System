import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from '../config.js';
import { callAiService } from './ai-call.js';

/**
 * Core's one signed call into the AI service — the error taxonomy.
 *
 * Pre-Phase-16 hardening. The audit found every non-200 collapsing to
 * `unavailable`, which reported Azure's content-management REFUSAL as a
 * provider OUTAGE:
 *
 *   provider read this exact prompt and declined it  ->  "provider unavailable"
 *
 * An operator paged by that finds nothing down, and an agent told "unavailable"
 * retries something that can only fail again. These tests pin the distinction.
 *
 * ⚠️ AND THEY PIN WHAT DID NOT CHANGE. Every case below asserts the provider was
 * called EXACTLY ONCE. The fix renames an outcome; it must not become a retry.
 * BullMQ remains the only retry owner in the platform.
 */

/** A fetch double that records every call and returns a scripted response. */
function stub(response: { status: number; body?: unknown; throws?: unknown }) {
  const calls: Array<{ url: string }> = [];
  const impl = (async (url: string) => {
    calls.push({ url });
    if (response.throws) throw response.throws;
    return new Response(
      response.body === undefined ? '' : JSON.stringify(response.body),
      { status: response.status },
    );
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const call = (impl: typeof fetch) =>
  callAiService<unknown>(
    { feature: 'copilot', requestId: 'req_t', input: { subject: null, description: 'x' }, timeoutMs: 2000 },
    impl,
  );

/** The AI service's real error envelope for a permanent feature failure. */
const errorEnvelope = (code: string) => ({
  error: { kind: 'permanent', code, message: 'provider returned HTTP 400: …' },
});

function configured() {
  vi.spyOn(config, 'AI_SERVICE_URL', 'get').mockReturnValue('http://ai.test' as never);
  vi.spyOn(config, 'AI_CORE_HMAC_SECRET', 'get').mockReturnValue('test_secret_0123456789abcdef' as never);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('⚠️ a provider REFUSAL is not a provider OUTAGE', () => {
  it('maps provider_content_filter to content_filter, not unavailable', async () => {
    configured();
    const { impl, calls } = stub({ status: 422, body: errorEnvelope('provider_content_filter') });
    const out = await call(impl);

    expect(out.ok).toBe(false);
    expect(!out.ok && out.reason).toBe('content_filter');
    expect(!out.ok && out.providerCode).toBe('provider_content_filter');
    expect(!out.ok && out.status).toBe(422);
    // ⚠️ The whole point: renaming an outcome must not add an attempt.
    expect(calls, 'a refusal must not be retried').toHaveLength(1);
  });

  it('still reports every OTHER non-200 as unavailable', async () => {
    for (const [status, code] of [
      [429, 'provider_http_429'],
      [502, 'provider_http_502'],
      [503, 'provider_http_503'],
      [400, 'provider_http_400'],
      [401, 'unauthenticated'],
    ] as const) {
      configured();
      const { impl, calls } = stub({ status, body: errorEnvelope(code) });
      const out = await call(impl);

      expect(!out.ok && out.reason, `HTTP ${status}`).toBe('unavailable');
      // The code is carried for diagnosis even when the reason is unchanged.
      expect(!out.ok && out.providerCode).toBe(code);
      expect(calls).toHaveLength(1);
      vi.restoreAllMocks();
    }
  });
});

describe('the error body is parsed DEFENSIVELY — the failure path cannot fail', () => {
  it.each([
    ['no body at all', { status: 500 } as const],
    ['a non-JSON body', { status: 500, body: undefined } as const],
  ])('falls back to unavailable given %s', async (_label, response) => {
    configured();
    const { impl, calls } = stub(response);
    const out = await call(impl);
    expect(!out.ok && out.reason).toBe('unavailable');
    expect(!out.ok && out.providerCode).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it.each([
    ['an envelope with no code', { error: {} }],
    ['a non-string code', { error: { code: 42 } }],
    ['a bare string body', 'nope'],
    ['an array', [1, 2, 3]],
    ['null', null],
  ])('falls back to unavailable given %s', async (_label, body) => {
    configured();
    const { impl } = stub({ status: 500, body });
    const out = await call(impl);
    expect(!out.ok && out.reason).toBe('unavailable');
  });

  it('is not fooled by a content-filter code on a SUCCESSFUL response', async () => {
    // A 200 is a 200: the body is the result, not an error envelope.
    configured();
    const { impl } = stub({ status: 200, body: { data: { draft: 'x', citations: [] } } });
    const out = await call(impl);
    expect(out.ok).toBe(true);
  });
});

describe('the transport failures are unchanged', () => {
  it('reports an abort as timeout', async () => {
    configured();
    const err = new Error('aborted');
    err.name = 'TimeoutError';
    const { impl, calls } = stub({ status: 0, throws: err });
    const out = await call(impl);
    expect(!out.ok && out.reason).toBe('timeout');
    expect(calls).toHaveLength(1);
  });

  it('reports an unreachable service as unavailable', async () => {
    configured();
    const { impl } = stub({ status: 0, throws: new Error('ECONNREFUSED') });
    const out = await call(impl);
    expect(!out.ok && out.reason).toBe('unavailable');
  });

  it('reports a missing credential as not_configured WITHOUT calling out', async () => {
    vi.spyOn(config, 'AI_SERVICE_URL', 'get').mockReturnValue('' as never);
    const { impl, calls } = stub({ status: 200 });
    const out = await call(impl);
    expect(!out.ok && out.reason).toBe('not_configured');
    expect(calls, 'no credential means no request').toHaveLength(0);
  });

  it('reports an unparseable SUCCESS body as invalid', async () => {
    configured();
    const impl = (async () => new Response('{ not json', { status: 200 })) as unknown as typeof fetch;
    const out = await call(impl);
    expect(!out.ok && out.reason).toBe('invalid');
  });
});
