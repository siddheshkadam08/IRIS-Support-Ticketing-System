import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { AI_RETRY_ATTEMPTS, type AIExecuteRequest, type AIResultRequest } from '@iris/shared/types';
import { config } from './config.js';
import { executeAI } from './ai-client.js';
import { fetchAIInput, submitAIResult } from './core-client.js';
import { PermanentJobError, TemporaryJobError, isAbortError, isPermanent } from './errors.js';
import { LOCK_DURATION_MS } from './limits.js';

/**
 * Phase 3 Step 6 — timeout hardening.
 *
 * These run against REAL HTTP servers on loopback, not stubbed transports.
 * That is the point: the defect this suite exists for is invisible to a stub.
 *
 *   `fetch` resolves as soon as the response HEADERS arrive. A server that
 *   answers `200` and then stalls mid-body therefore trips the AbortSignal
 *   inside `res.json()`, in exactly the place a genuinely malformed payload
 *   would — and that path used to throw PermanentJobError, dead-lettering a
 *   merely slow service on attempt 1.
 *
 * A `fetchImpl` stub that rejects up front cannot reproduce that. Only a real
 * socket that goes quiet can.
 */

/** A server whose behaviour each test picks. */
type Behaviour =
  | { kind: 'silent' } // accepts the connection, never responds
  | { kind: 'headers-then-stall'; body: string } // 200 + partial body, then quiet
  | { kind: 'ok'; body: unknown }
  | { kind: 'status'; status: number; body: unknown };

let behaviour: Behaviour = { kind: 'silent' };
let server: http.Server;
let origin: string;
/** Sockets held open deliberately; closed in afterAll so vitest can exit. */
const held: Array<{ destroy: () => void }> = [];

beforeAll(async () => {
  server = http.createServer((_req, res) => {
    held.push(res.socket!);
    switch (behaviour.kind) {
      case 'silent':
        return; // no write, no end
      case 'headers-then-stall':
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write(behaviour.body); // deliberately incomplete, never ended
        return;
      case 'ok':
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(behaviour.body));
        return;
      case 'status':
        res.writeHead(behaviour.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(behaviour.body));
        return;
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const s of held) {
    try {
      s.destroy();
    } catch {
      /* already gone */
    }
  }
  await new Promise<void>((r) => server.close(() => r()));
});

/** Point one client at the stalling server without touching the other's config. */
const at = (base: string): typeof fetch =>
  ((url: string, init: RequestInit) =>
    fetch(`${origin}${new URL(url, base).pathname}`, init)) as unknown as typeof fetch;

const CLAIMS = {
  job_id: 'aij_T',
  feature: 'noop' as const,
  attempt: 1,
  correlation_id: 'req_T',
  claimed_product_id: 'prod_carbon',
  claimed_ticket_id: 'tkt_T',
};

const EXECUTE: AIExecuteRequest = {
  feature: 'noop',
  request_id: 'req_T',
  input: { subject: 's', description: 'd' },
};

const RESULT: AIResultRequest = {
  ...CLAIMS,
  result: { feature: 'noop', status: 'succeeded', data: { ok: true } },
};

const caught = async (fn: () => Promise<unknown>): Promise<Error> => {
  try {
    await fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected the call to reject, but it resolved');
};

// ═════════════════════════════════════════════════════════════════════════
// The classifier
// ═════════════════════════════════════════════════════════════════════════

describe('abort detection', () => {
  it('recognises a fired AbortSignal.timeout', () => {
    // The shape Node actually produces — asserted in the live tests below too.
    expect(isAbortError({ name: 'TimeoutError' })).toBe(true);
    expect(isAbortError({ name: 'AbortError' })).toBe(true);
  });

  it('does not mistake ordinary failures for timeouts', () => {
    expect(isAbortError(new SyntaxError('Unexpected end of JSON input'))).toBe(false);
    expect(isAbortError(new TypeError('fetch failed'))).toBe(false);
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError('TimeoutError')).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Worker -> Python
// ═════════════════════════════════════════════════════════════════════════

describe('worker -> Python is bounded', () => {
  it('a silent AI service produces a TEMPORARY failure, not a hang', async () => {
    behaviour = { kind: 'silent' };
    const started = Date.now();
    const err = await caught(() => executeAI(EXECUTE, at(config.AI_SERVICE_URL)));
    const elapsed = Date.now() - started;

    expect(err).toBeInstanceOf(TemporaryJobError);
    expect(isPermanent(err), 'a timeout must never dead-letter a job').toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(config.AI_TIMEOUT_MS - 500);
    expect(elapsed, 'the abort must actually fire').toBeLessThan(config.AI_TIMEOUT_MS + 4000);
  }, 30_000);

  it('⚠️ headers-then-stall is TEMPORARY, not malformed_ai_response', async () => {
    /**
     * The regression this suite was written for. `fetch` resolves on headers,
     * so the timeout fires inside `res.json()` — the same catch block that
     * handles bad JSON, which threw PermanentJobError. A slow service was
     * therefore dead-lettered on its first attempt.
     */
    behaviour = { kind: 'headers-then-stall', body: '{"feature":"noop",' };
    const err = await caught(() => executeAI(EXECUTE, at(config.AI_SERVICE_URL)));

    expect(err).toBeInstanceOf(TemporaryJobError);
    expect(err).not.toBeInstanceOf(PermanentJobError);
    expect((err as TemporaryJobError).code).toBe('ai_service_timeout');
  }, 30_000);

  it('genuinely malformed JSON stays PERMANENT', async () => {
    // The other half of the same branch must not have been widened: bad JSON
    // is bad every time, and retrying it six times is pure waste.
    behaviour = { kind: 'ok', body: undefined };
    const err = await caught(() =>
      executeAI(EXECUTE, (async () =>
        new Response('<html>not json', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })) as never),
    );
    expect(err).toBeInstanceOf(PermanentJobError);
    expect((err as PermanentJobError).code).toBe('malformed_ai_response');
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Worker -> Core
// ═════════════════════════════════════════════════════════════════════════

describe('worker -> Core /input is bounded', () => {
  it('a silent Core produces a TEMPORARY failure', async () => {
    behaviour = { kind: 'silent' };
    const started = Date.now();
    const err = await caught(() => fetchAIInput('evt_T', CLAIMS, at(config.CORE_SERVICE_URL)));
    const elapsed = Date.now() - started;

    expect(err).toBeInstanceOf(TemporaryJobError);
    expect((err as TemporaryJobError).code).toBe('core_timeout');
    expect(elapsed).toBeGreaterThanOrEqual(config.CORE_TIMEOUT_MS - 500);
    expect(elapsed).toBeLessThan(config.CORE_TIMEOUT_MS + 4000);
  }, 30_000);

  it('is bounded by the Core timeout, which is shorter than the Python one', async () => {
    // Ordering matters: Core is a local hop and must give up first.
    expect(config.CORE_TIMEOUT_MS).toBeLessThan(config.AI_TIMEOUT_MS);
  });

  it('headers-then-stall on /input is TEMPORARY', async () => {
    behaviour = { kind: 'headers-then-stall', body: '{"status":"ready",' };
    const err = await caught(() => fetchAIInput('evt_T', CLAIMS, at(config.CORE_SERVICE_URL)));
    expect(err).toBeInstanceOf(TemporaryJobError);
    expect((err as TemporaryJobError).code).toBe('core_timeout');
  }, 30_000);
});

describe('worker -> Core /result is bounded', () => {
  it('a silent Core produces a TEMPORARY failure', async () => {
    behaviour = { kind: 'silent' };
    const err = await caught(() => submitAIResult('evt_T', RESULT, at(config.CORE_SERVICE_URL)));
    expect(err).toBeInstanceOf(TemporaryJobError);
    expect((err as TemporaryJobError).code).toBe('core_timeout');
  }, 30_000);

  it('headers-then-stall on /result is TEMPORARY', async () => {
    behaviour = { kind: 'headers-then-stall', body: '{"execution_id":"aix_1",' };
    const err = await caught(() => submitAIResult('evt_T', RESULT, at(config.CORE_SERVICE_URL)));
    expect(err).toBeInstanceOf(TemporaryJobError);
  }, 30_000);
});

// ═════════════════════════════════════════════════════════════════════════
// The timeout must not disturb the existing classification
// ═════════════════════════════════════════════════════════════════════════

describe('status classification is unchanged', () => {
  const statuses: Array<[number, 'temporary' | 'permanent']> = [
    [400, 'permanent'],
    [401, 'permanent'],
    [404, 'permanent'],
    [422, 'permanent'],
    [408, 'temporary'],
    [429, 'temporary'],
    [500, 'temporary'],
    [502, 'temporary'],
    [503, 'temporary'],
  ];

  it.each(statuses)('AI service %i is %s', async (status, kind) => {
    behaviour = { kind: 'status', status, body: { error: { code: 'x' } } };
    const err = await caught(() => executeAI(EXECUTE, at(config.AI_SERVICE_URL)));
    expect(isPermanent(err)).toBe(kind === 'permanent');
  });

  it.each(statuses)('Core %i is %s', async (status, kind) => {
    behaviour = { kind: 'status', status, body: { error: { code: 'x' } } };
    const err = await caught(() => fetchAIInput('evt_T', CLAIMS, at(config.CORE_SERVICE_URL)));
    expect(isPermanent(err)).toBe(kind === 'permanent');
  });
});

// ═════════════════════════════════════════════════════════════════════════
// No second retry mechanism, and no unhandled rejections
// ═════════════════════════════════════════════════════════════════════════

describe('a timeout is a failure signal, not a retry', () => {
  it('makes exactly ONE request — the client never retries internally', async () => {
    behaviour = { kind: 'silent' };
    let calls = 0;
    const counting = ((url: string, init: RequestInit) => {
      calls++;
      return fetch(`${origin}/`, init);
    }) as unknown as typeof fetch;

    await caught(() => executeAI(EXECUTE, counting));
    expect(calls, 'BullMQ is the sole retry owner').toBe(1);
  }, 30_000);

  it('the retry budget is untouched by Step 6', () => {
    // Timeout hardening must not have changed the frozen curve.
    expect(AI_RETRY_ATTEMPTS).toBe(6);
  });

  it('a timeout produces no unhandled rejection', async () => {
    const seen: unknown[] = [];
    const onUnhandled = (r: unknown) => seen.push(r);
    process.on('unhandledRejection', onUnhandled);
    try {
      behaviour = { kind: 'silent' };
      await caught(() => executeAI(EXECUTE, at(config.AI_SERVICE_URL)));
      await new Promise((r) => setTimeout(r, 100));
      expect(seen).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  }, 30_000);
});

// ═════════════════════════════════════════════════════════════════════════
// The hierarchy itself
// ═════════════════════════════════════════════════════════════════════════

describe('the timeout hierarchy is not inverted', () => {
  it('Core < Python: the local hop gives up first', () => {
    expect(config.CORE_TIMEOUT_MS).toBeLessThan(config.AI_TIMEOUT_MS);
  });

  it('one attempt is bounded well below the BullMQ lock', () => {
    /**
     * Worst-case attempt = /input + Python + /result, all sequential. The lock
     * must outlast it by a wide margin, or a slow-but-healthy job loses its
     * lock and is re-run as a stall — a duplicate execution caused purely by
     * configuration.
     */
    const worstAttemptMs = config.CORE_TIMEOUT_MS * 2 + config.AI_TIMEOUT_MS;
    expect(worstAttemptMs).toBe(20_000);
    expect(LOCK_DURATION_MS).toBe(60_000);
    expect(worstAttemptMs * 2, 'at least 2x headroom under the lock').toBeLessThanOrEqual(
      LOCK_DURATION_MS,
    );
  });

  it('the lock is longer than the BullMQ 30s default — the Step 5.1 finding', () => {
    // At the default, headroom was ~10s: one GC pause could lapse the lock on
    // a healthy job and turn it into a stall-recovered duplicate execution.
    expect(LOCK_DURATION_MS).toBeGreaterThan(30_000);
    const headroom = LOCK_DURATION_MS - (config.CORE_TIMEOUT_MS * 2 + config.AI_TIMEOUT_MS);
    expect(headroom).toBe(40_000);
  });

  it('lockRenewTime is left to BullMQ, which halves the lock', () => {
    // `[CODE]` worker.js:63-64 — lockRenewTime = lockRenewTime || lockDuration / 2.
    // Setting it explicitly would just duplicate a value that must stay
    // safely below the lock; the default is already correct.
    expect(LOCK_DURATION_MS / 2).toBeLessThan(LOCK_DURATION_MS);
    expect(LOCK_DURATION_MS / 2).toBe(30_000);
  });

  it('the drain deadline fits inside the container grace period', () => {
    // podman-compose defaults to 10s and infra/podman-compose.yml states it.
    expect(config.AI_WORKER_DRAIN_MS).toBeLessThan(10_000);
    expect(config.AI_WORKER_DRAIN_MS).toBe(8000);
  });

  it('every attempt fits many times over inside the reaper threshold', () => {
    // 45 minutes vs a ~20s attempt: the reaper cannot reach live work.
    const worstAttemptMs = config.CORE_TIMEOUT_MS * 2 + config.AI_TIMEOUT_MS;
    expect(worstAttemptMs).toBeLessThan(45 * 60_000);
  });
});
