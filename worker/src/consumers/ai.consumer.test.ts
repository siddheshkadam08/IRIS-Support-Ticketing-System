import { describe, expect, it } from 'vitest';
import { UnrecoverableError } from 'bullmq';
import type { AIJob } from '@iris/shared/types';
import { handleAIJob } from './ai.consumer.js';
import { parseAIResult } from '../ai-client.js';
import { PermanentJobError, TemporaryJobError, errorForStatus } from '../errors.js';

/**
 * These tests stub the two HTTP TRANSPORTS and nothing else.
 *
 * That is deliberate: the transport is not the interesting part, but what the
 * worker DOES with each status code and each response shape is — it is the
 * whole of the retry contract, and getting it wrong either burns five attempts
 * on a permanent failure or drops recoverable work. So the real consumer, the
 * real clients and the real error classification all run here; only the socket
 * is replaced.
 */

const JOB: AIJob = {
  job_id: 'aij_TEST0001',
  event_id: 'evt_TEST0001',
  feature: 'noop',
  product_id: 'prod_carbon',
  ticket_id: 'tkt_TEST0001',
  correlation_id: 'req_TEST0001',
  requested_at: '2026-09-07T10:00:00.000Z',
  attempt: 1,
};

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

interface Call {
  url: string;
  body: unknown;
  headers: Record<string, string>;
}

/** A scripted Core: input response, then result response. Records every call. */
function coreStub(
  inputRes: () => Response | Promise<Response>,
  resultRes: () => Response | Promise<Response> = () =>
    json(200, {
      execution_id: 'aix_TEST0001',
      status: 'succeeded',
      applied: true,
      ticket_updated: false,
    }),
) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    calls.push({
      url,
      body: JSON.parse(String(init.body)),
      headers: init.headers as Record<string, string>,
    });
    return url.endsWith('/input') ? inputRes() : resultRes();
  };
  return { calls, fetchImpl };
}

function aiStub(res: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    calls.push({
      url,
      body: JSON.parse(String(init.body)),
      headers: init.headers as Record<string, string>,
    });
    return res();
  };
  return { calls, fetchImpl };
}

const READY_INPUT = {
  status: 'ready',
  feature: 'noop',
  correlation_id: 'req_TEST0001',
  ticket: {
    ticket_id: 'tkt_TEST0001',
    subject: 'Q3 export fails',
    description: 'Cannot export the Q3 report.',
  },
  taxonomy: { categories: [{ value: 'reports', label: 'Reports' }], severities: ['low', 'high'] },
  thresholds: { auto_route_p1: 0.8, auto_route_margin: 0.25, triage_floor: 0.5 },
};

const NOOP_OK = {
  feature: 'noop',
  status: 'succeeded',
  data: { ok: true, received_chars: 28 },
  provider: 'stub',
  model: 'stub-noop',
  model_version: '1',
};

// ─────────────────────────────────────────────────────────────────────────

describe('job envelope validation', () => {
  it('runs a valid job through input -> python -> result, in that order', async () => {
    const core = coreStub(() => json(200, READY_INPUT));
    const ai = aiStub(() => json(200, NOOP_OK));

    const outcome = await handleAIJob(JOB, {
      coreFetch: core.fetchImpl,
      aiFetch: ai.fetchImpl,
    });

    expect(outcome.outcome).toBe('submitted');
    expect(core.calls.map((c) => c.url.split('/').pop())).toEqual(['input', 'result']);
    expect(ai.calls).toHaveLength(1);
  });

  it('rejects a malformed job permanently, before any network call', async () => {
    const core = coreStub(() => json(200, READY_INPUT));
    const ai = aiStub(() => json(200, NOOP_OK));

    // A job with no event_id can never be processed, however many times it runs.
    const { event_id: _dropped, ...broken } = JOB;

    await expect(
      handleAIJob(broken, { coreFetch: core.fetchImpl, aiFetch: ai.fetchImpl }),
    ).rejects.toBeInstanceOf(UnrecoverableError);

    expect(core.calls, 'must not call Core with a job it cannot parse').toHaveLength(0);
    expect(ai.calls).toHaveLength(0);
  });

  it('rejects an unknown feature permanently', async () => {
    const core = coreStub(() => json(200, READY_INPUT));
    await expect(
      handleAIJob({ ...JOB, feature: 'telepathy' }, { coreFetch: core.fetchImpl }),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(core.calls).toHaveLength(0);
  });
});

describe('claims and the data boundary', () => {
  it('sends product and ticket as CLAIMS, never as bare identifiers', async () => {
    const core = coreStub(() => json(200, READY_INPUT));
    const ai = aiStub(() => json(200, NOOP_OK));
    await handleAIJob(JOB, { coreFetch: core.fetchImpl, aiFetch: ai.fetchImpl });

    const body = core.calls[0]!.body as Record<string, unknown>;
    expect(body.claimed_product_id).toBe('prod_carbon');
    expect(body.claimed_ticket_id).toBe('tkt_TEST0001');
    expect(body.product_id, 'a bare product_id would read as authoritative').toBeUndefined();
    expect(body.ticket_id).toBeUndefined();
  });

  it('does NOT forward the Core input response verbatim to Python', async () => {
    const core = coreStub(() => json(200, READY_INPUT));
    const ai = aiStub(() => json(200, NOOP_OK));
    await handleAIJob(JOB, { coreFetch: core.fetchImpl, aiFetch: ai.fetchImpl });

    const sent = ai.calls[0]!.body as { input: Record<string, unknown> };
    expect(Object.keys(sent).sort()).toEqual(['feature', 'input', 'request_id']);
    // ticket_id is in Core's response but has no business reaching Python.
    expect(sent.input.ticket_id).toBeUndefined();
    expect(sent.input.description).toBe('Cannot export the Q3 report.');
  });

  it('omits taxonomy and thresholds for a feature that cannot use them', async () => {
    const core = coreStub(() => json(200, READY_INPUT));
    const ai = aiStub(() => json(200, NOOP_OK));
    await handleAIJob(JOB, { coreFetch: core.fetchImpl, aiFetch: ai.fetchImpl });

    const sent = ai.calls[0]!.body as { input: Record<string, unknown> };
    expect(Object.keys(sent.input).sort()).toEqual(['description', 'subject']);
  });

  it('never puts a tenant identifier in the Python payload', async () => {
    const core = coreStub(() => json(200, READY_INPUT));
    const ai = aiStub(() => json(200, NOOP_OK));
    await handleAIJob(JOB, { coreFetch: core.fetchImpl, aiFetch: ai.fetchImpl });

    const serialised = JSON.stringify(ai.calls[0]!.body);
    expect(serialised).not.toContain('prod_carbon');
    expect(serialised).not.toContain('tkt_TEST0001');
  });

  it('authenticates to Core and to Python with a service signature', async () => {
    // Phase 2 converted this from a shared bearer key to per-request HMAC.
    // The original intent is preserved: both hops are authenticated, and one
    // correlation id threads the whole trace.
    const core = coreStub(() => json(200, READY_INPUT));
    const ai = aiStub(() => json(200, NOOP_OK));
    await handleAIJob(JOB, { coreFetch: core.fetchImpl, aiFetch: ai.fetchImpl });

    for (const call of [core.calls[0]!, ai.calls[0]!]) {
      expect(call.headers['x-iris-service-id']).toBe('worker');
      expect(call.headers['x-iris-signature']).toMatch(/^v1=[a-f0-9]{64}$/);
      expect(call.headers['x-iris-timestamp']).toMatch(/^\d{10}$/);
      expect(call.headers['x-iris-nonce']).toBeTruthy();
      // The platform-wide bearer key is gone from both hops.
      expect(call.headers['x-internal-key']).toBeUndefined();
    }

    // One id threads the whole trace.
    expect(core.calls[0]!.headers['x-request-id']).toBe('req_TEST0001');
    expect(ai.calls[0]!.headers['x-request-id']).toBe('req_TEST0001');
  });

  it('signs Core and Python with DIFFERENT secrets', async () => {
    // Same method, same body shape — but different secrets, so the signatures
    // must differ. If one secret were reused, leaking the Python-facing
    // credential would grant access to Core.
    const core = coreStub(() => json(200, READY_INPUT));
    const ai = aiStub(() => json(200, NOOP_OK));
    await handleAIJob(JOB, { coreFetch: core.fetchImpl, aiFetch: ai.fetchImpl });

    expect(core.calls[0]!.headers['x-iris-signature']).not.toBe(
      ai.calls[0]!.headers['x-iris-signature'],
    );
  });
});

describe('idempotency short-circuit', () => {
  it('stops successfully on already_applied WITHOUT calling the AI service', async () => {
    const core = coreStub(() =>
      json(200, {
        status: 'already_applied',
        feature: 'noop',
        correlation_id: 'req_TEST0001',
        execution_id: 'aix_PRIOR',
        execution_status: 'succeeded',
      }),
    );
    const ai = aiStub(() => json(200, NOOP_OK));

    const outcome = await handleAIJob(JOB, {
      coreFetch: core.fetchImpl,
      aiFetch: ai.fetchImpl,
    });

    expect(outcome).toEqual({ outcome: 'already_applied', execution_id: 'aix_PRIOR' });
    expect(ai.calls, 'a duplicate must cost zero model invocations').toHaveLength(0);
    expect(core.calls, 'and must not post a second result').toHaveLength(1);
  });
});

describe('retry classification — BullMQ is the only retry owner', () => {
  it('treats an unreachable Core as temporary', async () => {
    const core = {
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    };
    await expect(handleAIJob(JOB, { coreFetch: core.fetchImpl })).rejects.toBeInstanceOf(
      TemporaryJobError,
    );
  });

  it('treats a Core 5xx as temporary', async () => {
    const core = coreStub(() => json(503, { error: { code: 'service_unavailable' } }));
    const err = await handleAIJob(JOB, { coreFetch: core.fetchImpl }).catch((e) => e);
    expect(err).toBeInstanceOf(TemporaryJobError);
    expect(err).not.toBeInstanceOf(UnrecoverableError);
  });

  it('treats a Core 4xx as PERMANENT — a bad payload does not heal', async () => {
    const core = coreStub(() => json(400, { error: { code: 'invalid_request' } }));
    const err = await handleAIJob(JOB, { coreFetch: core.fetchImpl }).catch((e) => e);
    expect(err).toBeInstanceOf(UnrecoverableError);
    expect((err as PermanentJobError).code).toBe('invalid_request');
  });

  it('treats a missing event (404) as permanent', async () => {
    const core = coreStub(() => json(404, { error: { code: 'ticket_not_found' } }));
    await expect(handleAIJob(JOB, { coreFetch: core.fetchImpl })).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
  });

  it('treats a rejected internal key (401) as permanent', async () => {
    const core = coreStub(() => json(401, { error: { code: 'unauthenticated' } }));
    await expect(handleAIJob(JOB, { coreFetch: core.fetchImpl })).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
  });

  it('treats an unreachable AI service as temporary', async () => {
    const core = coreStub(() => json(200, READY_INPUT));
    const ai = {
      fetchImpl: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:5000');
      },
    };
    const err = await handleAIJob(JOB, {
      coreFetch: core.fetchImpl,
      aiFetch: ai.fetchImpl,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(TemporaryJobError);
    expect((err as TemporaryJobError).code).toBe('ai_service_unreachable');
  });

  it('treats AI 503 (models loading) as temporary', async () => {
    const core = coreStub(() => json(200, READY_INPUT));
    const ai = aiStub(() =>
      json(503, { error: { kind: 'temporary', code: 'models_loading', message: 'loading' } }),
    );
    await expect(
      handleAIJob(JOB, { coreFetch: core.fetchImpl, aiFetch: ai.fetchImpl }),
    ).rejects.toBeInstanceOf(TemporaryJobError);
  });

  it('treats an AI 422 as permanent', async () => {
    const core = coreStub(() => json(200, READY_INPUT));
    const ai = aiStub(() =>
      json(422, {
        error: { kind: 'permanent', code: 'unsupported_feature', message: 'nope' },
      }),
    );
    await expect(
      handleAIJob(JOB, { coreFetch: core.fetchImpl, aiFetch: ai.fetchImpl }),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('does not post a result when the AI call failed', async () => {
    const core = coreStub(() => json(200, READY_INPUT));
    const ai = aiStub(() => json(500, { error: {} }));
    await handleAIJob(JOB, { coreFetch: core.fetchImpl, aiFetch: ai.fetchImpl }).catch(
      () => undefined,
    );
    expect(core.calls.map((c) => c.url.split('/').pop())).toEqual(['input']);
  });

  it('maps status codes to the retry decision in one place', () => {
    expect(errorForStatus(400, 'c', 'd')).toBeInstanceOf(PermanentJobError);
    expect(errorForStatus(409, 'c', 'd')).toBeInstanceOf(PermanentJobError);
    expect(errorForStatus(500, 'c', 'd')).toBeInstanceOf(TemporaryJobError);
    expect(errorForStatus(502, 'c', 'd')).toBeInstanceOf(TemporaryJobError);
  });
});

describe('malformed AI responses are permanent', () => {
  const bad: Array<[string, unknown]> = [
    ['not an object', 'a string'],
    ['missing feature', { status: 'succeeded', data: {} }],
    ['unknown feature', { feature: 'telepathy', status: 'succeeded', data: {} }],
    ['bad status', { feature: 'noop', status: 'maybe', data: {} }],
    ['data is not an object', { feature: 'noop', status: 'succeeded', data: 42 }],
    ['data is an array', { feature: 'noop', status: 'succeeded', data: [] }],
    [
      'error.kind invalid',
      { feature: 'noop', status: 'failed', data: {}, error: { kind: 'sometimes' } },
    ],
  ];

  for (const [label, payload] of bad) {
    it(`rejects: ${label}`, () => {
      expect(() => parseAIResult(payload)).toThrow(PermanentJobError);
    });
  }

  it('a malformed body from the AI service fails the job permanently', async () => {
    const core = coreStub(() => json(200, READY_INPUT));
    const ai = aiStub(() => json(200, { feature: 'noop', status: 'succeeded' })); // no data
    const err = await handleAIJob(JOB, {
      coreFetch: core.fetchImpl,
      aiFetch: ai.fetchImpl,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(UnrecoverableError);
    expect((err as PermanentJobError).code).toBe('malformed_ai_response');
  });

  it('accepts a well-formed FAILED result and forwards it to Core', async () => {
    // Python declaring failure is not the same as Python being broken: the
    // execution outcome is still a fact Core must record.
    const core = coreStub(
      () => json(200, READY_INPUT),
      () =>
        json(200, {
          execution_id: 'aix_1',
          status: 'failed',
          applied: true,
          ticket_updated: false,
        }),
    );
    const ai = aiStub(() =>
      json(200, {
        feature: 'noop',
        status: 'failed',
        data: {},
        error: { kind: 'permanent', code: 'invalid_input', message: 'empty' },
      }),
    );
    const outcome = await handleAIJob(JOB, {
      coreFetch: core.fetchImpl,
      aiFetch: ai.fetchImpl,
    });
    expect(outcome).toEqual({
      outcome: 'submitted',
      result: { execution_id: 'aix_1', status: 'failed', applied: true, ticket_updated: false },
    });
  });
});

describe('attempt propagation', () => {
  it('sends BullMQ attempt number, not the one baked into the payload', async () => {
    const core = coreStub(() => json(200, READY_INPUT));
    const ai = aiStub(() => json(200, NOOP_OK));
    await handleAIJob(JOB, { attempt: 3, coreFetch: core.fetchImpl, aiFetch: ai.fetchImpl });
    expect((core.calls[0]!.body as { attempt: number }).attempt).toBe(3);
    expect((core.calls[1]!.body as { attempt: number }).attempt).toBe(3);
  });
});
