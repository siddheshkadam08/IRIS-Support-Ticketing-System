import { afterEach, describe, expect, it, vi } from 'vitest';
import { RERANK_EXCERPT_CHARS, type RetrievalHit } from '@iris/shared/types';
import { config } from '../config.js';
import { rerank } from './rerank.client.js';

/**
 * The reranking client — Phase 12.
 *
 * Stubs the TRANSPORT, not the logic, so every test exercises the real signing,
 * the real timeout wiring, the real status-code handling and the real
 * `applyRanking` mapping. What is asserted throughout is one property:
 *
 *   RERANKING CAN COST LATENCY. IT CANNOT COST CORRECTNESS.
 *
 * Every failure path returns the input order, unchanged, with an outcome saying
 * why. There is no input — from the provider or from the network — that makes
 * the result worse than Phase 11.
 */

/**
 * ⚠️ TITLES DELIBERATELY DO NOT CONTAIN THE ID. An earlier fixture used
 * `Title ${id}`, which made the leak assertion below fail against the test's
 * own data rather than against the code — a useful reminder that a substring
 * search for a secret finds the fixture as readily as the defect.
 */
const hit = (id: string, title = 'How to reset your password', snippet = 'Use the Forgot password link.'): RetrievalHit => ({
  source_type: 'kb_article',
  source_id: id,
  title,
  snippet,
  hybrid_score: 0.5,
  signals: {},
});

/**
 * Realistic ULID-shaped ids. An earlier version used 'a'/'b'/'c', which made
 * the leak assertion below a false positive against the test's own titles —
 * worth keeping in mind whenever a security check is a substring search.
 */
const A = 'kb_01M1KHKJTZCAWC6E5ERXNN3VNS';
const B = 'kb_01M1KHKJV3GCARXGRM16PBVB7J';
const C = 'tkt_01M1KHKJVV84AV8G4DSB64NMB1';
const HITS = [hit(A), hit(B), hit(C)];
const ids = (hits: RetrievalHit[]) => hits.map((h) => h.source_id);

/** A fetch double that records the request and returns a scripted response. */
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
      // Honour the caller's AbortSignal so timeout behaviour is real.
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

const ok = (ranking: unknown) => ({
  status: 200,
  body: { feature: 'reranking', status: 'succeeded', data: { ranking } },
});

const enabled = () => {
  vi.spyOn(config, 'RERANKING_ENABLED', 'get').mockReturnValue(true as never);
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('when reranking is disabled', () => {
  it('makes NO provider call and keeps the order', async () => {
    vi.spyOn(config, 'RERANKING_ENABLED', 'get').mockReturnValue(false as never);
    const { impl, calls } = stub(ok([3, 2, 1]));
    const r = await rerank('q', HITS, 'req', impl);

    expect(r.outcome).toBe('skipped_disabled');
    expect(ids(r.hits)).toEqual([A, B, C]);
    expect(calls).toHaveLength(0);
  });
});

describe('short-circuits that must not cost a provider call', () => {
  it('skips a single candidate — there is nothing to reorder', async () => {
    enabled();
    const { impl, calls } = stub(ok([1]));
    const r = await rerank('q', [hit(A)], 'req', impl);

    expect(r.outcome).toBe('skipped_too_few');
    expect(calls, 'a ~1.7s call to confirm the only possible answer').toHaveLength(0);
  });

  it('skips an empty candidate list', async () => {
    enabled();
    const { impl, calls } = stub(ok([]));
    const r = await rerank('q', [], 'req', impl);
    expect(r.hits).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe('the request', () => {
  it('sends ordinals and NEVER an identifier', async () => {
    enabled();
    const { impl, calls } = stub(ok([1, 2, 3]));
    await rerank('how do I sign in', HITS, 'req-123', impl);

    const sent = calls[0]!.body;
    expect(sent.feature).toBe('reranking');
    expect(sent.input.candidates.map((c: any) => c.ordinal)).toEqual([1, 2, 3]);

    // ⚠️ The structural guarantee: no id, no tenant, anywhere in the payload.
    const raw = JSON.stringify(sent);
    for (const forbidden of ['source_id', 'product_id', 'prod_', 'tenant', 'raiser']) {
      expect(raw).not.toContain(forbidden);
    }
    // The ids themselves must not appear either.
    for (const id of ids(HITS)) expect(sent.input.candidates.some((c: any) => JSON.stringify(c).includes(id))).toBe(false);
  });

  it('maps source_type to an evidence kind, not a tenant label', async () => {
    enabled();
    const mixed = [hit(A), { ...hit(B), source_type: 'resolved_ticket' as const }];
    const { impl, calls } = stub(ok([1, 2]));
    await rerank('q', mixed, 'req', impl);
    expect(calls[0]!.body.input.candidates.map((c: any) => c.kind)).toEqual(['article', 'ticket']);
  });

  it('bounds each excerpt', async () => {
    enabled();
    const long = [hit(A, 'Long article', 'x'.repeat(5000)), hit(B)];
    const { impl, calls } = stub(ok([1, 2]));
    await rerank('q', long, 'req', impl);
    expect(calls[0]!.body.input.candidates[0].excerpt).toHaveLength(RERANK_EXCERPT_CHARS);
  });

  it('sends the correlation id, not the query, as request_id', async () => {
    enabled();
    const { impl, calls } = stub(ok([1, 2, 3]));
    await rerank('a very distinctive question', HITS, 'req-abc', impl);
    expect(calls[0]!.body.request_id).toBe('req-abc');
    expect(calls[0]!.headers['x-iris-service-id']).toBe('core');
    expect(calls[0]!.headers['x-iris-signature']).toMatch(/^v1=[a-f0-9]{64}$/);
  });

  it('caps the window and leaves the tail in Phase 11 order', async () => {
    enabled();
    const many = Array.from({ length: 14 }, (_, i) => hit(`id${i}`));
    const { impl, calls } = stub(ok([2, 1]));
    const r = await rerank('q', many, 'req', impl);

    expect(calls[0]!.body.input.candidates).toHaveLength(10);
    expect(r.candidateCount).toBe(10);
    // The four beyond the window keep their positions.
    expect(ids(r.hits).slice(10)).toEqual(['id10', 'id11', 'id12', 'id13']);
    expect(r.hits).toHaveLength(14);
  });
});

describe('applying a ranking', () => {
  it('reorders on a clean response', async () => {
    enabled();
    const { impl } = stub(ok([3, 1, 2]));
    const r = await rerank('q', HITS, 'req', impl);
    expect(r.outcome).toBe('reranked');
    expect(ids(r.hits)).toEqual([C, A, B]);
  });

  it('appends what the model omitted', async () => {
    enabled();
    const { impl } = stub(ok([3]));
    const r = await rerank('q', HITS, 'req', impl);
    expect(ids(r.hits)).toEqual([C, A, B]);
  });

  it('drops fabricated ORDINALS and keeps every real row', async () => {
    /**
     * The realistic fabrication vector. The strict JSON schema declares
     * `items: {type: integer}`, so a conforming provider can only ever return
     * numbers — and a number that indexes nothing is where an invented
     * identifier arrives.
     */
    enabled();
    const { impl } = stub(ok([99, 0, -1, 2]));
    const r = await rerank('q', HITS, 'req', impl);
    expect(r.outcome).toBe('reranked');
    expect(ids(r.hits)).toEqual([B, A, C]);
  });

  it('rejects a MIXED-TYPE array outright rather than salvaging it', async () => {
    /**
     * A response containing a string is off-contract entirely — strict
     * structured output cannot produce one — so the whole response is
     * distrusted rather than partially applied. `applyRanking` would cope
     * either way (asserted in shared/types/reranking.test.ts); this is the
     * outer guard, and it keeps "the model is not following the schema" from
     * being silently laundered into a partial ordering.
     */
    enabled();
    const { impl } = stub(ok([2, 'kb_01FAKE', 1]));
    const r = await rerank('q', HITS, 'req', impl);
    expect(r.outcome).toBe('malformed');
    expect(ids(r.hits)).toEqual([A, B, C]);
  });
});

describe('⚠️ the failure matrix — every case keeps Phase 11 ordering', () => {
  it.each([
    ['429', { status: 429 }, 'provider_unavailable'],
    ['500', { status: 500 }, 'provider_unavailable'],
    ['503', { status: 503 }, 'provider_unavailable'],
    ['401', { status: 401 }, 'provider_unavailable'],
    ['422', { status: 422 }, 'provider_unavailable'],
  ] as const)('HTTP %s -> %s', async (_label, response, expected) => {
    enabled();
    const { impl } = stub(response);
    const r = await rerank('q', HITS, 'req', impl);
    expect(r.outcome).toBe(expected);
    expect(ids(r.hits)).toEqual([A, B, C]);
  });

  it('a network failure keeps the order', async () => {
    enabled();
    const { impl } = stub({ status: 0, throws: new TypeError('fetch failed') });
    const r = await rerank('q', HITS, 'req', impl);
    expect(r.outcome).toBe('provider_unavailable');
    expect(ids(r.hits)).toEqual([A, B, C]);
  });

  it('a TIMEOUT keeps the order and is bounded by the configured budget', async () => {
    enabled();
    vi.spyOn(config, 'RERANK_TIMEOUT_MS', 'get').mockReturnValue(60 as never);
    const { impl } = stub({ status: 200, delayMs: 5000, body: ok([1]).body });

    const t0 = Date.now();
    const r = await rerank('q', HITS, 'req', impl);
    const elapsed = Date.now() - t0;

    expect(r.outcome).toBe('provider_timeout');
    expect(ids(r.hits)).toEqual([A, B, C]);
    expect(elapsed, 'the user must not wait for the abandoned call').toBeLessThan(2000);
  });

  it('malformed JSON keeps the order', async () => {
    enabled();
    const impl = (async () =>
      new Response('{not json', { status: 200 })) as unknown as typeof fetch;
    const r = await rerank('q', HITS, 'req', impl);
    expect(r.outcome).toBe('malformed');
    expect(ids(r.hits)).toEqual([A, B, C]);
  });

  it.each([
    ['a missing ranking', {}],
    ['a null ranking', { ranking: null }],
    ['a string ranking', { ranking: 'a,b,c' }],
    ['an object ranking', { ranking: { first: 1 } }],
    ['a ranking of ids', { ranking: ['kb_01A', 'kb_01B'] }],
  ])('%s keeps the order', async (_label, data) => {
    enabled();
    const { impl } = stub({
      status: 200,
      body: { feature: 'reranking', status: 'succeeded', data },
    });
    const r = await rerank('q', HITS, 'req', impl);
    expect(r.outcome).toBe('malformed');
    expect(ids(r.hits)).toEqual([A, B, C]);
  });

  it('an empty ranking array is APPLIED, not treated as malformed', async () => {
    // `[]` is a well-formed "no opinion". Phase 11 order survives either way,
    // but the outcome must not be mislabelled as a provider fault.
    enabled();
    const { impl } = stub(ok([]));
    const r = await rerank('q', HITS, 'req', impl);
    expect(r.outcome).toBe('reranked');
    expect(ids(r.hits)).toEqual([A, B, C]);
  });

  it('never adds, removes or duplicates a row, whatever comes back', async () => {
    enabled();
    const responses: unknown[] = [
      [1, 1, 1],
      [3, 3, 2, 2, 1, 1],
      [99, 98, 97],
      [],
      ['a', 'b'],
      [null, undefined, {}],
      Array.from({ length: 500 }, () => 1),
    ];
    for (const ranking of responses) {
      const { impl } = stub(ok(ranking));
      const r = await rerank('q', HITS, 'req', impl);
      expect(new Set(ids(r.hits))).toEqual(new Set([A, B, C]));
      expect(r.hits).toHaveLength(3);
    }
  });
});
