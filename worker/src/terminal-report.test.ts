import { describe, expect, it } from 'vitest';
import { AI_RETRY_ATTEMPTS, type AIJob } from '@iris/shared/types';
import {
  RETRIES_EXHAUSTED,
  buildTerminalResult,
  reportTerminalFailure,
  shouldReportTerminal,
  type TerminalJobView,
} from './terminal-report.js';
import { PermanentJobError, TemporaryJobError } from './errors.js';

/**
 * Terminal failure reporting.
 *
 * Two properties matter most here and both are asserted directly:
 *
 *   1. Attempts 1-5 must NOT report. Reporting early would close an execution
 *      that BullMQ is about to retry, and the retry would then find it
 *      terminal.
 *   2. The reporter must never throw. It runs inside a BullMQ event listener
 *      that is not awaited, so an escaping rejection is an unhandled rejection
 *      and Node aborts the process.
 */

const JOB_DATA: AIJob = {
  job_id: 'aij_TEST',
  event_id: 'evt_TEST',
  feature: 'noop',
  product_id: 'prod_carbon',
  ticket_id: 'tkt_TEST',
  correlation_id: 'req_TEST',
  requested_at: '2026-09-07T10:00:00.000Z',
  attempt: 1,
};

const jobAt = (attemptsMade: number, attempts = AI_RETRY_ATTEMPTS): TerminalJobView => ({
  data: JOB_DATA,
  attemptsMade,
  opts: { attempts },
});

const temporary = () => new TemporaryJobError('ai_service_unreachable', 'fetch failed');
const permanent = () => new PermanentJobError('malformed_ai_response', 'data is not an object');

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const OK = { execution_id: 'aix_1', status: 'failed', applied: true, ticket_updated: false };
const DUP = { execution_id: 'aix_1', status: 'failed', applied: false, ticket_updated: false };

/** Records every call so "exactly one report" can be asserted. */
function coreStub(res: () => Response | Promise<Response>) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return res();
  };
  return { calls, fetchImpl };
}

// ─────────────────────────────────────────────────────────────────────────

describe('detection: temporary failures before exhaustion', () => {
  it.each([1, 2, 3, 4, 5])('attempt %i does NOT report', (attemptsMade) => {
    expect(shouldReportTerminal(jobAt(attemptsMade), temporary())).toBe(false);
  });

  it('attempt 6 DOES report — the final attempt, not a phantom 7th', () => {
    expect(shouldReportTerminal(jobAt(6), temporary())).toBe(true);
  });

  it('uses the job\'s own attempts, not the shared default', () => {
    // A job enqueued under an older policy must still terminate correctly.
    expect(shouldReportTerminal(jobAt(3, 3), temporary())).toBe(true);
    expect(shouldReportTerminal(jobAt(2, 3), temporary())).toBe(false);
  });

  it('falls back to the shared default when opts.attempts is absent', () => {
    const noOpts: TerminalJobView = { data: JOB_DATA, attemptsMade: 6 };
    expect(shouldReportTerminal(noOpts, temporary())).toBe(true);
    expect(shouldReportTerminal({ data: JOB_DATA, attemptsMade: 5 }, temporary())).toBe(false);
  });
});

describe('detection: permanent failures', () => {
  it('reports on attempt 1 — BullMQ has already stopped', () => {
    expect(shouldReportTerminal(jobAt(1), permanent())).toBe(true);
  });

  it.each([1, 2, 3, 6])('reports regardless of attempt (%i)', (attemptsMade) => {
    expect(shouldReportTerminal(jobAt(attemptsMade), permanent())).toBe(true);
  });

  it('returns false when there is no job', () => {
    expect(shouldReportTerminal(undefined, permanent())).toBe(false);
  });
});

describe('payload matches the existing AI result contract', () => {
  it('builds a valid exhaustion report', () => {
    const body = buildTerminalResult(jobAt(6), temporary());

    expect(Object.keys(body).sort()).toEqual([
      'attempt',
      'claimed_product_id',
      'claimed_ticket_id',
      'correlation_id',
      'feature',
      'job_id',
      'result',
    ]);
    expect(body.attempt).toBe(6);
    expect(body.job_id).toBe('aij_TEST');
    expect(body.feature).toBe('noop');
    expect(body.correlation_id).toBe('req_TEST');
    expect(body.claimed_product_id).toBe('prod_carbon');
    expect(body.claimed_ticket_id).toBe('tkt_TEST');

    expect(body.result.status).toBe('failed');
    expect(body.result.feature).toBe('noop');
    // Required by the existing zod schema; there is no model output to carry.
    expect(body.result.data).toEqual({});
    expect(body.result.error?.code).toBe(RETRIES_EXHAUSTED);
    // The underlying cause was temporary even though we stopped trying.
    expect(body.result.error?.kind).toBe('temporary');
  });

  it('uses the permanent error code, not retries_exhausted', () => {
    const body = buildTerminalResult(jobAt(1), permanent());
    expect(body.result.error?.code).toBe('malformed_ai_response');
    expect(body.result.error?.kind).toBe('permanent');
    expect(body.attempt).toBe(1);
  });

  it('falls back to a stable code for an error carrying none', () => {
    const body = buildTerminalResult(jobAt(6), new Error('boom'));
    expect(body.result.error?.code).toBe(RETRIES_EXHAUSTED);
    expect(body.result.error?.message).toContain('unknown_error');
  });
});

describe('error message safety', () => {
  const SECRET_BODY =
    'sensitive ticket content: customer said his password is hunter2 and the invoice is 4111111111111111';

  it('never persists the raw upstream body', () => {
    const err = new TemporaryJobError('ai_http_500', SECRET_BODY);
    const body = buildTerminalResult(jobAt(6), err);
    const serialised = JSON.stringify(body);

    expect(serialised).not.toContain('sensitive ticket content');
    expect(serialised).not.toContain('hunter2');
    expect(serialised).not.toContain('4111111111111111');
  });

  it('carries the machine code, which is what diagnosis needs', () => {
    const err = new TemporaryJobError('provider_timeout', SECRET_BODY);
    expect(buildTerminalResult(jobAt(6), err).result.error?.message).toBe(
      '6 attempts exhausted: provider_timeout',
    );
  });

  it('permanent failures get a short safe message too', () => {
    const err = new PermanentJobError('invalid_job', SECRET_BODY);
    expect(buildTerminalResult(jobAt(1), err).result.error?.message).toBe(
      'permanent failure: invalid_job',
    );
  });

  it('stays comfortably inside the 500-char column bound', () => {
    const err = new TemporaryJobError('x'.repeat(400), 'y'.repeat(5000));
    const msg = buildTerminalResult(jobAt(6), err).result.error!.message;
    expect(msg.length).toBeLessThan(500);
  });
});

describe('reporting sends exactly one request', () => {
  it('posts once to the RESULT endpoint on exhaustion', async () => {
    const core = coreStub(() => json(200, OK));
    const outcome = await reportTerminalFailure(jobAt(6), temporary(), core.fetchImpl);

    expect(outcome.outcome).toBe('applied');
    expect(core.calls).toHaveLength(1);
    expect(core.calls[0]!.url).toContain('/internal/ai/jobs/evt_TEST/result');
    // No new endpoint was invented.
    expect(core.calls[0]!.url).not.toContain('/failure');
  });

  it('sends NOTHING for attempts 1-5', async () => {
    const core = coreStub(() => json(200, OK));
    for (const attempt of [1, 2, 3, 4, 5]) {
      const outcome = await reportTerminalFailure(jobAt(attempt), temporary(), core.fetchImpl);
      expect(outcome.outcome).toBe('skipped');
    }
    expect(core.calls, 'a premature report would close a live execution').toHaveLength(0);
  });

  it('reports a duplicate as a no-op, not a failure', async () => {
    const core = coreStub(() => json(200, DUP));
    const outcome = await reportTerminalFailure(jobAt(6), temporary(), core.fetchImpl);
    expect(outcome.outcome).toBe('duplicate');
  });
});

describe('the reporter never throws and never retries', () => {
  it('returns report_failed on a Core 5xx — and posts exactly once', async () => {
    const core = coreStub(() => json(503, { error: { code: 'service_unavailable' } }));
    const outcome = await reportTerminalFailure(jobAt(6), temporary(), core.fetchImpl);

    expect(outcome.outcome).toBe('report_failed');
    expect(core.calls, 'NO retry — Step 5 reaper is the backstop').toHaveLength(1);
  });

  it('returns report_failed when Core is unreachable', async () => {
    const fetchImpl = async () => {
      throw new Error('ECONNREFUSED');
    };
    const outcome = await reportTerminalFailure(jobAt(6), temporary(), fetchImpl);
    expect(outcome.outcome).toBe('report_failed');
  });

  it('treats a 404 as "nothing to close", not an error', async () => {
    // Every attempt died before /input claimed a row, so no execution exists.
    const core = coreStub(() => json(404, { error: { code: 'ticket_not_found' } }));
    const outcome = await reportTerminalFailure(jobAt(6), temporary(), core.fetchImpl);
    expect(outcome.outcome).toBe('nothing_to_close');
  });

  it('does not throw on a rejected signature (401)', async () => {
    const core = coreStub(() => json(401, { error: { code: 'unauthenticated' } }));
    await expect(
      reportTerminalFailure(jobAt(6), temporary(), core.fetchImpl),
    ).resolves.toMatchObject({ outcome: 'report_failed' });
  });

  it.each([
    ['5xx', () => json(500, {})],
    ['4xx', () => json(400, { error: { code: 'invalid_request' } })],
    ['garbage body', () => new Response('<html>nope', { status: 502 })],
  ])('never rejects for: %s', async (_label, res) => {
    const core = coreStub(res);
    await expect(
      reportTerminalFailure(jobAt(6), temporary(), core.fetchImpl),
    ).resolves.toBeDefined();
  });

  it('survives a transport that throws a non-Error', async () => {
    const fetchImpl = async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'a string, not an Error';
    };
    await expect(
      reportTerminalFailure(jobAt(6), temporary(), fetchImpl as never),
    ).resolves.toMatchObject({ outcome: 'report_failed' });
  });
});

describe('async-handler safety regression', () => {
  it('a rejecting Core client produces NO unhandled rejection', async () => {
    /**
     * The specific hazard: BullMQ does not await event listeners, so a
     * rejection escaping the reporter would abort the Node process. This
     * asserts on the real process-level signal rather than trusting the
     * try/catch by inspection.
     */
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown) => seen.push(reason);
    process.on('unhandledRejection', onUnhandled);

    try {
      const fetchImpl = async () => {
        throw new Error('core exploded');
      };
      // Fire it the same way index.ts does — floating, not awaited.
      void reportTerminalFailure(jobAt(6), temporary(), fetchImpl);
      // Let the microtask queue and one macrotask turn drain.
      await new Promise((r) => setTimeout(r, 50));
      expect(seen, 'an escaping rejection would crash the worker').toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('success and skip paths are equally safe', async () => {
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown) => seen.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const core = coreStub(() => json(200, OK));
      void reportTerminalFailure(jobAt(6), temporary(), core.fetchImpl);
      void reportTerminalFailure(jobAt(2), temporary(), core.fetchImpl);
      void reportTerminalFailure(undefined, temporary(), core.fetchImpl);
      await new Promise((r) => setTimeout(r, 50));
      expect(seen).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
