import { describe, expect, it, vi } from 'vitest';
import { EMBEDDING_DIM } from '@iris/shared/types';
import { runEmbeddingCycle } from './embedding-runner.js';

/**
 * The embedding cycle — Phase 10.
 *
 * These tests stub the TRANSPORT, not the logic: every request really goes
 * through `postToCore` and `executeAI`, so signing, timeout wiring, status-code
 * classification and JSON handling are all exercised. What is asserted is the
 * property that matters operationally:
 *
 *   NOTHING IS EVER MARKED DONE THAT WAS NOT PERSISTED.
 *
 * Every failure path must leave the affected rows pending, because "pending"
 * is the entire retry mechanism — there is no attempt counter, no backoff
 * state and no dead-letter queue. A cycle that silently dropped an item would
 * not retry it; it would lose it, permanently and quietly.
 */

const vector = () => Array.from({ length: EMBEDDING_DIM }, () => 0.01);

interface Call {
  url: string;
  body: unknown;
}

/**
 * A fetch double that routes on URL and records every request.
 *
 * `pending` and `apply` are Core; `/v1/execute` is the Python service. Both
 * real clients are used unchanged, which is why this is a transport stub and
 * not a mock of the functions under test.
 */
function stubFetch(opts: {
  pending?: unknown;
  execute?: (body: any) => { status: number; body: unknown };
  apply?: unknown;
  applyStatus?: number;
  pendingStatus?: number;
}) {
  const calls: Call[] = [];
  const impl = async (url: string, init: RequestInit): Promise<Response> => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });

    if (url.includes('/internal/embeddings/pending')) {
      const status = opts.pendingStatus ?? 200;
      return new Response(JSON.stringify(opts.pending ?? { items: [] }), { status });
    }
    if (url.includes('/internal/embeddings/apply')) {
      const status = opts.applyStatus ?? 200;
      return new Response(
        JSON.stringify(opts.apply ?? { applied: 0, skipped: [], quarantined: 0 }),
        { status },
      );
    }
    if (url.includes('/v1/execute')) {
      const r = opts.execute?.(body) ?? {
        status: 200,
        body: {
          feature: 'embedding',
          status: 'succeeded',
          data: { vector: vector(), dim: EMBEDDING_DIM, model: 'azure/text-embedding-3-small' },
        },
      };
      return new Response(JSON.stringify(r.body), { status: r.status });
    }
    throw new Error(`unexpected url ${url}`);
  };
  return { impl: impl as never, calls };
}

const item = (id: string, type: 'ticket' | 'kb_article' = 'ticket') => ({
  subject_type: type,
  subject_id: id,
  text: `text for ${id}`,
  fingerprint: 'a'.repeat(64),
});

describe('an empty corpus', () => {
  it('makes NO provider calls when nothing is pending', async () => {
    /**
     * The steady state. Once the backfill is done every cycle claims nothing,
     * so this is what the runner does all day — and it must cost nothing.
     */
    const { impl, calls } = stubFetch({ pending: { items: [] } });
    const r = await runEmbeddingCycle(impl);

    expect(r).toEqual({
      claimed: 0,
      applied: 0,
      quarantined: 0,
      skipped: 0,
      failedTemporarily: 0,
    });
    expect(calls.filter((c) => c.url.includes('/v1/execute'))).toHaveLength(0);
    expect(calls.filter((c) => c.url.includes('apply'))).toHaveLength(0);
  });
});

describe('the happy path', () => {
  it('embeds each item and persists them in ONE apply request', async () => {
    const { impl, calls } = stubFetch({
      pending: { items: [item('tkt_1'), item('tkt_2'), item('kb_1', 'kb_article')] },
      apply: { applied: 3, skipped: [], quarantined: 0 },
    });

    const r = await runEmbeddingCycle(impl);
    expect(r.claimed).toBe(3);
    expect(r.applied).toBe(3);

    expect(calls.filter((c) => c.url.includes('/v1/execute'))).toHaveLength(3);
    const applies = calls.filter((c) => c.url.includes('apply'));
    expect(applies, 'one request, not one per item').toHaveLength(1);
    expect((applies[0]!.body as any).items).toHaveLength(3);
  });

  it('sends the canonical text UNSPLIT, with a null subject', async () => {
    /**
     * The idempotency mechanism in one assertion.
     *
     * The fingerprint is computed in SQL over one string. Splitting that
     * string back into subject and description here would create a second
     * spelling of it, and any divergence would re-embed the whole corpus on
     * every cycle — billed each time, with nothing failing to signal it.
     */
    const { impl, calls } = stubFetch({ pending: { items: [item('tkt_1')] } });
    await runEmbeddingCycle(impl);

    const exec = calls.find((c) => c.url.includes('/v1/execute'))!.body as any;
    expect(exec.input.subject).toBeNull();
    expect(exec.input.description).toBe('text for tkt_1');
    expect(exec.feature).toBe('embedding');
  });

  it('echoes the fingerprint it was given rather than deriving one', async () => {
    const { impl, calls } = stubFetch({
      pending: { items: [item('tkt_1')] },
      apply: { applied: 1, skipped: [], quarantined: 0 },
    });
    await runEmbeddingCycle(impl);

    const applied = (calls.find((c) => c.url.includes('apply'))!.body as any).items[0];
    expect(applied.fingerprint).toBe('a'.repeat(64));
    expect(applied.subject_id).toBe('tkt_1');
  });

  it('NEVER sends a tenant identifier to the AI service', async () => {
    const { impl, calls } = stubFetch({ pending: { items: [item('tkt_1')] } });
    await runEmbeddingCycle(impl);

    const raw = JSON.stringify(calls.find((c) => c.url.includes('/v1/execute'))!.body);
    for (const forbidden of ['product_id', 'prod_', 'tenant', 'raiser']) {
      expect(raw).not.toContain(forbidden);
    }
  });
});

describe('failures leave rows pending — never lost', () => {
  it('does nothing at all when Core will not hand out work', async () => {
    const { impl, calls } = stubFetch({ pendingStatus: 503 });
    const r = await runEmbeddingCycle(impl);

    expect(r.claimed).toBe(0);
    expect(calls.filter((c) => c.url.includes('/v1/execute'))).toHaveLength(0);
  });

  it('does not throw when persistence fails — the rows stay pending', async () => {
    /**
     * The vectors are lost and the provider calls are already paid for. What
     * must NOT happen is a crash or a partial write: nothing was marked done,
     * so the next cycle re-claims exactly these rows.
     */
    const { impl } = stubFetch({
      pending: { items: [item('tkt_1'), item('tkt_2')] },
      applyStatus: 500,
    });

    const r = await runEmbeddingCycle(impl);
    expect(r.applied).toBe(0);
    expect(r.claimed).toBe(2);
  });

  it('reports a PERMANENT provider failure for quarantine, and keeps the rest', async () => {
    /**
     * A content-filter refusal will fail identically forever. Without the
     * quarantine it would be re-attempted every cycle, billing a call each
     * time — which is exactly what the platform's permanent/temporary split
     * exists to prevent.
     */
    const { impl, calls } = stubFetch({
      pending: { items: [item('tkt_ok'), item('tkt_bad')] },
      execute: (body) =>
        body.request_id.includes('tkt_bad')
          ? { status: 422, body: { error: { kind: 'permanent', code: 'provider_content_filter' } } }
          : {
              status: 200,
              body: {
                feature: 'embedding',
                status: 'succeeded',
                data: { vector: vector(), dim: EMBEDDING_DIM, model: 'azure/text-embedding-3-small' },
              },
            },
      apply: { applied: 1, skipped: [], quarantined: 1 },
    });

    const r = await runEmbeddingCycle(impl);

    const body = calls.find((c) => c.url.includes('apply'))!.body as any;
    expect(body.items).toHaveLength(1);
    expect(body.items[0].subject_id).toBe('tkt_ok');
    expect(body.failures).toHaveLength(1);
    expect(body.failures[0].subject_id).toBe('tkt_bad');
    expect(r.applied).toBe(1);
    expect(r.quarantined).toBe(1);
  });

  it('does NOT quarantine a temporary failure', async () => {
    /**
     * The distinction that matters. A 503 means "try later"; quarantining it
     * would suppress the row until someone edits its text, which could be
     * never.
     */
    const { impl, calls } = stubFetch({
      pending: { items: [item('tkt_1')] },
      execute: () => ({ status: 503, body: { error: { kind: 'temporary', code: 'busy' } } }),
    });

    const r = await runEmbeddingCycle(impl);
    expect(r.failedTemporarily).toBe(1);
    expect(r.quarantined).toBe(0);
    expect(
      calls.filter((c) => c.url.includes('apply')),
      'nothing to persist, so no apply call at all',
    ).toHaveLength(0);
  });

  it('drops a wrong-width vector rather than sending it to Core', async () => {
    /**
     * Defence in depth: Core validates too, and is the authority. Failing here
     * turns a would-be 400 from Core into a clear local warning — and stops a
     * bad vector travelling any further than it must.
     */
    const { impl, calls } = stubFetch({
      pending: { items: [item('tkt_1')] },
      execute: () => ({
        status: 200,
        body: {
          feature: 'embedding',
          status: 'succeeded',
          data: { vector: new Array(384).fill(0.1), dim: 384, model: 'azure/text-embedding-3-small' },
        },
      }),
    });

    const r = await runEmbeddingCycle(impl);
    expect(r.applied).toBe(0);
    expect(calls.filter((c) => c.url.includes('apply'))).toHaveLength(0);
  });

  it('survives a malformed pending response', async () => {
    const { impl } = stubFetch({ pending: { items: null } as never });
    await expect(runEmbeddingCycle(impl)).resolves.toBeDefined();
  });
});

describe('provider load is bounded', () => {
  it('never runs more than 4 provider calls at once', async () => {
    /**
     * Embedding is background maintenance and must never be the reason a
     * user-facing classification or summary job waits for a provider slot.
     * 16 simultaneous requests is also the burst pattern that produced the
     * Phase 5 timeout spiral.
     */
    let inFlight = 0;
    let peak = 0;
    const impl = (async (url: string, init: RequestInit): Promise<Response> => {
      if (url.includes('/v1/execute')) {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return new Response(
          JSON.stringify({
            feature: 'embedding',
            status: 'succeeded',
            data: { vector: vector(), dim: EMBEDDING_DIM, model: 'azure/text-embedding-3-small' },
          }),
          { status: 200 },
        );
      }
      if (url.includes('pending')) {
        return new Response(
          JSON.stringify({ items: Array.from({ length: 16 }, (_, i) => item(`tkt_${i}`)) }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ applied: 16, skipped: [], quarantined: 0 }), {
        status: 200,
      });
    }) as never;

    const r = await runEmbeddingCycle(impl);
    expect(r.applied).toBe(16);
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak, 'and it must actually use the concurrency it has').toBeGreaterThan(1);
  });
});
