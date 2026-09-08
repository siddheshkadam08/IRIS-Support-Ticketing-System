import { afterEach, describe, expect, it, vi } from 'vitest';
import { RAG_EXCERPT_CHARS, RAG_MAX_EVIDENCE, type RetrievalHit } from '@iris/shared/types';
import { config } from '../config.js';
import { generateGroundedAnswer } from './rag.client.js';

/**
 * The grounded-answer client — Phase 13.
 *
 * Stubs the TRANSPORT, not the logic, so every test exercises the real signing,
 * the real timeout wiring, the real status-code handling and the real
 * fail-closed validation. Two properties are asserted throughout:
 *
 *   GENERATION FAILING NEVER MAKES RETRIEVAL UNAVAILABLE. Every failure path
 *   returns no answer and an outcome saying why; the caller still has its hits.
 *
 *   AN UNVERIFIABLE CITATION DISCARDS THE WHOLE ANSWER. Not the citation — the
 *   answer. Provenance that cannot be checked is the thing grounding exists to
 *   prevent.
 */

const hit = (
  id: string,
  title = 'How to reset your password',
  snippet = 'Use the Forgot password link on the sign-in page.',
): RetrievalHit => ({
  source_type: 'kb_article',
  source_id: id,
  title,
  snippet,
  hybrid_score: 0.5,
  signals: {},
});

const A = 'kb_01M1KHKJTZCAWC6E5ERXNN3VNS';
const B = 'kb_01M1KHKJV3GCARXGRM16PBVB7J';
const C = 'tkt_01M1KHKJVV84AV8G4DSB64NMB1';
const HITS = [hit(A), hit(B), hit(C)];

const ANSWER = 'Use the Forgot password link on the sign-in page to reset your password.';

function stub(response: { status: number; body?: unknown; delayMs?: number; throws?: unknown }) {
  const calls: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      headers: init.headers as Record<string, string>,
    });
    if (response.throws) throw response.throws;
    if (response.delayMs) {
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, response.delayMs);
        init.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          const e = new Error('aborted');
          e.name = 'TimeoutError';
          reject(e);
        });
      });
    }
    return new Response(JSON.stringify(response.body ?? {}), { status: response.status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const ok = (answer: unknown, citations: unknown) => ({
  status: 200,
  body: { feature: 'rag', status: 'succeeded', data: { answer, citations } },
});

const enabled = () => {
  vi.spyOn(config, 'RAG_ENABLED', 'get').mockReturnValue(true as never);
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('when RAG is disabled', () => {
  it('makes NO provider call and returns no answer', async () => {
    vi.spyOn(config, 'RAG_ENABLED', 'get').mockReturnValue(false as never);
    const { impl, calls } = stub(ok(ANSWER, [1]));
    const r = await generateGroundedAnswer('q', HITS, 'req', impl);

    expect(r.outcome).toBe('skipped_disabled');
    expect(r.grounded).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('skips when there is no evidence at all', async () => {
    enabled();
    const { impl, calls } = stub(ok(ANSWER, []));
    const r = await generateGroundedAnswer('q', [], 'req', impl);
    expect(r.outcome).toBe('skipped_no_evidence');
    expect(calls, 'nothing to ground in — do not pay for a provider call').toHaveLength(0);
  });
});

describe('the request', () => {
  it('sends numbered evidence and NEVER an identifier', async () => {
    enabled();
    const { impl, calls } = stub(ok(ANSWER, [1]));
    await generateGroundedAnswer('how do I sign in', HITS, 'req-123', impl);

    const sent = calls[0]!.body;
    expect(sent.feature).toBe('rag');
    expect(sent.input.evidence.map((e: any) => e.source_number)).toEqual([1, 2, 3]);

    // ⚠️ The structural guarantee: no id, no tenant, anywhere in the payload.
    const raw = JSON.stringify(sent);
    for (const forbidden of ['source_id', 'product_id', 'prod_', 'tenant', 'raiser', A, B, C]) {
      expect(raw).not.toContain(forbidden);
    }
  });

  it('carries the source type, which is evidence kind and not tenant data', async () => {
    enabled();
    const mixed = [hit(A), { ...hit(B), source_type: 'resolved_ticket' as const }];
    const { impl, calls } = stub(ok(ANSWER, [1]));
    await generateGroundedAnswer('q', mixed, 'req', impl);
    expect(calls[0]!.body.input.evidence.map((e: any) => e.source_type)).toEqual([
      'kb_article',
      'resolved_ticket',
    ]);
  });

  it('bounds each excerpt and the evidence window', async () => {
    enabled();
    const many = Array.from({ length: 12 }, (_, i) => hit(`id${i}`, 'T', 'x'.repeat(5000)));
    const { impl, calls } = stub(ok(ANSWER, [1]));
    const r = await generateGroundedAnswer('q', many, 'req', impl);

    expect(calls[0]!.body.input.evidence).toHaveLength(RAG_MAX_EVIDENCE);
    expect(calls[0]!.body.input.evidence[0].excerpt).toHaveLength(RAG_EXCERPT_CHARS);
    expect(r.evidenceCount).toBe(RAG_MAX_EVIDENCE);
  });

  it('sends the correlation id, not the question', async () => {
    enabled();
    const { impl, calls } = stub(ok(ANSWER, [1]));
    await generateGroundedAnswer('a very distinctive question', HITS, 'req-abc', impl);
    expect(calls[0]!.body.request_id).toBe('req-abc');
    expect(calls[0]!.headers['x-iris-service-id']).toBe('core');
    expect(calls[0]!.headers['x-iris-signature']).toMatch(/^v1=[a-f0-9]{64}$/);
  });
});

describe('a grounded answer', () => {
  it('is returned with its citations', async () => {
    enabled();
    const { impl } = stub(ok(ANSWER, [1, 3]));
    const r = await generateGroundedAnswer('q', HITS, 'req', impl);

    expect(r.outcome).toBe('grounded');
    expect(r.grounded?.answer).toBe(ANSWER);
    expect(r.grounded?.cited).toEqual([1, 3]);
    expect(r.grounded?.insufficient).toBe(false);
    expect(r.citationCount).toBe(2);
  });

  it('reports insufficient evidence as its own outcome, not a failure', async () => {
    enabled();
    const { impl } = stub(ok('I do not have enough information in the available sources.', []));
    const r = await generateGroundedAnswer('q', HITS, 'req', impl);

    expect(r.outcome).toBe('insufficient_evidence');
    expect(r.grounded?.insufficient).toBe(true);
    expect(r.grounded?.cited).toEqual([]);
  });
});

describe('⚠️ citation forgery — the whole answer is discarded', () => {
  it.each([
    ['out of range', [999]],
    ['valid plus forged', [1, 999]],
    ['zero', [0]],
    ['negative', [-1]],
    ['duplicated', [1, 1]],
    ['a database id', ['kb_01FAKE']],
    ['a URL', ['https://internal.example/1']],
    ['null', [null]],
    ['an object', [{ source_id: 'x' }]],
  ])('rejects %s', async (_label, citations) => {
    enabled();
    const { impl } = stub(ok(ANSWER, citations));
    const r = await generateGroundedAnswer('q', HITS, 'req', impl);

    expect(r.outcome).toBe('invalid_citation');
    expect(r.grounded, 'the answer must not survive its citations').toBeUndefined();
  });

  it('rejects a citation past a SHORTENED evidence window', async () => {
    // Only 2 hits, so 3 is out of range even though it is a plausible number.
    enabled();
    const { impl } = stub(ok(ANSWER, [3]));
    const r = await generateGroundedAnswer('q', HITS.slice(0, 2), 'req', impl);
    expect(r.outcome).toBe('invalid_citation');
  });
});

describe('⚠️ the failure matrix — retrieval survives every one', () => {
  it.each([
    ['429', { status: 429 }, 'provider_unavailable'],
    ['500', { status: 500 }, 'provider_unavailable'],
    ['503', { status: 503 }, 'provider_unavailable'],
    ['422', { status: 422 }, 'provider_unavailable'],
    ['401', { status: 401 }, 'provider_unavailable'],
  ] as const)('HTTP %s -> %s', async (_l, response, expected) => {
    enabled();
    const { impl } = stub(response);
    const r = await generateGroundedAnswer('q', HITS, 'req', impl);
    expect(r.outcome).toBe(expected);
    expect(r.grounded).toBeUndefined();
  });

  it('a network failure returns no answer and does not throw', async () => {
    enabled();
    const { impl } = stub({ status: 0, throws: new TypeError('fetch failed') });
    const r = await generateGroundedAnswer('q', HITS, 'req', impl);
    expect(r.outcome).toBe('provider_unavailable');
  });

  it('a TIMEOUT is bounded by the configured budget', async () => {
    enabled();
    vi.spyOn(config, 'RAG_TIMEOUT_MS', 'get').mockReturnValue(60 as never);
    const { impl } = stub({ status: 200, delayMs: 5000, body: ok(ANSWER, [1]).body });

    const t0 = Date.now();
    const r = await generateGroundedAnswer('q', HITS, 'req', impl);
    const elapsed = Date.now() - t0;

    expect(r.outcome).toBe('provider_timeout');
    expect(elapsed, 'the user must not wait for the abandoned call').toBeLessThan(2000);
  });

  it('malformed JSON returns no answer', async () => {
    enabled();
    const impl = (async () => new Response('{not json', { status: 200 })) as unknown as typeof fetch;
    const r = await generateGroundedAnswer('q', HITS, 'req', impl);
    expect(r.outcome).toBe('malformed');
  });

  it.each([
    ['a missing answer', { citations: [1] }],
    ['an empty answer', { answer: '', citations: [1] }],
    ['a one-word answer', { answer: 'Yes', citations: [1] }],
    ['a non-string answer', { answer: 42, citations: [1] }],
    ['a missing citations field', { answer: ANSWER }],
    ['a string citations field', { answer: ANSWER, citations: '1,2' }],
  ])('%s is rejected as malformed', async (_l, data) => {
    enabled();
    const { impl } = stub({
      status: 200,
      body: { feature: 'rag', status: 'succeeded', data },
    });
    const r = await generateGroundedAnswer('q', HITS, 'req', impl);
    expect(['malformed', 'invalid_citation']).toContain(r.outcome);
    expect(r.grounded).toBeUndefined();
  });

  it('an over-long answer is rejected rather than truncated', async () => {
    enabled();
    const { impl } = stub(ok('x'.repeat(5000), [1]));
    const r = await generateGroundedAnswer('q', HITS, 'req', impl);
    expect(r.outcome).toBe('malformed');
    expect(r.grounded).toBeUndefined();
  });

  it('NEVER throws, whatever comes back', async () => {
    enabled();
    const responses: Array<{ status: number; body?: unknown; throws?: unknown }> = [
      ok(ANSWER, [1]),
      ok(ANSWER, [99]),
      ok(null, null),
      { status: 500 },
      { status: 200, body: { data: null } },
      { status: 200, body: {} },
      { status: 0, throws: new Error('boom') },
    ];
    for (const response of responses) {
      const { impl } = stub(response);
      await expect(generateGroundedAnswer('q', HITS, 'req', impl)).resolves.toBeDefined();
    }
  });
});
