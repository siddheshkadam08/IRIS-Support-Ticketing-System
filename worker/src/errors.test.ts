import { describe, expect, it } from 'vitest';
import { UnrecoverableError } from 'bullmq';
import { PermanentJobError, TemporaryJobError, errorForStatus, isPermanent } from './errors.js';

/**
 * Retry classification.
 *
 * Getting this wrong in the retryable direction burns five attempts on a
 * failure that will never heal, delaying the alert. Getting it wrong the other
 * way dead-letters recoverable work — which is precisely what happened to 429
 * before Phase 3 Step 3.
 */

const temporary = (status: number) => errorForStatus(status, 'c', 'd');

describe('4xx — timing vs correctness', () => {
  it.each([408, 429])('%i is TEMPORARY — it is about timing, not the request', (status) => {
    const err = temporary(status);
    expect(err, `HTTP ${status}`).toBeInstanceOf(TemporaryJobError);
    expect(err).not.toBeInstanceOf(UnrecoverableError);
  });

  it('429 specifically — the most common transient LLM provider failure', () => {
    // Before Step 3 this was classified permanent, so a rate-limit window
    // would have dead-lettered every job instead of waiting it out.
    expect(temporary(429)).toBeInstanceOf(TemporaryJobError);
  });

  it.each([400, 401, 403, 404, 409, 422])('%i is PERMANENT', (status) => {
    const err = temporary(status);
    expect(err, `HTTP ${status}`).toBeInstanceOf(PermanentJobError);
    expect(err).toBeInstanceOf(UnrecoverableError);
  });

  it.each([
    [400, 'malformed / schema failure'],
    [401, 'invalid HMAC or unknown service'],
    [403, 'forbidden'],
    [404, 'unknown or invalid event'],
    [409, 'conflict'],
    [422, 'unsupported feature / invalid input'],
  ])('%i (%s) stops immediately', (status) => {
    expect(isPermanent(temporary(status))).toBe(true);
  });

  it('covers the whole 4xx range without accidental holes', () => {
    for (let status = 400; status < 500; status++) {
      const expectPermanent = status !== 408 && status !== 429;
      expect(isPermanent(temporary(status)), `HTTP ${status}`).toBe(expectPermanent);
    }
  });
});

describe('5xx is always temporary', () => {
  it.each([500, 502, 503, 504])('%i is TEMPORARY', (status) => {
    const err = temporary(status);
    expect(err, `HTTP ${status}`).toBeInstanceOf(TemporaryJobError);
    expect(isPermanent(err)).toBe(false);
  });

  it('503 covers "models loading" from the AI service', () => {
    expect(temporary(503)).toBeInstanceOf(TemporaryJobError);
  });
});

describe('BullMQ terminates only on UnrecoverableError', () => {
  it('PermanentJobError IS an UnrecoverableError', () => {
    // BullMQ's check is `err instanceof UnrecoverableError || err.name ===
    // 'UnrecoverableError'`. We override `name` to 'PermanentJobError' for
    // readable logs, so the instanceof branch is what has to hold.
    const err = new PermanentJobError('invalid_job', 'no event_id');
    expect(err).toBeInstanceOf(UnrecoverableError);
    expect(err.name).toBe('PermanentJobError');
  });

  it('TemporaryJobError is NOT an UnrecoverableError', () => {
    const err = new TemporaryJobError('ai_service_unreachable', 'ECONNREFUSED');
    expect(err).not.toBeInstanceOf(UnrecoverableError);
    expect(err).toBeInstanceOf(Error);
  });

  it.each([408, 429, 500, 502, 503, 504])(
    '%i must NOT become UnrecoverableError',
    (status) => {
      expect(temporary(status)).not.toBeInstanceOf(UnrecoverableError);
    },
  );

  it('carries a machine-readable code and never loses the detail', () => {
    const err = errorForStatus(503, 'ai_http_503', 'models loading') as TemporaryJobError;
    expect(err.code).toBe('ai_http_503');
    expect(err.message).toContain('models loading');
  });
});

describe('non-HTTP failures', () => {
  it('network / connection failures are temporary', () => {
    for (const code of ['core_unreachable', 'ai_service_unreachable']) {
      expect(new TemporaryJobError(code, 'ECONNREFUSED')).not.toBeInstanceOf(UnrecoverableError);
    }
  });

  it('a timeout is temporary', () => {
    expect(new TemporaryJobError('ai_service_unreachable', 'The operation was aborted'))
      .not.toBeInstanceOf(UnrecoverableError);
  });

  it('malformed AI response is permanent — identical call, identical garbage', () => {
    expect(isPermanent(new PermanentJobError('malformed_ai_response', 'data is not an object')))
      .toBe(true);
  });

  it('an invalid job envelope is permanent', () => {
    expect(isPermanent(new PermanentJobError('invalid_job', 'missing event_id'))).toBe(true);
  });

  it('isPermanent is false for a plain Error — unknown failures retry', () => {
    // Fail-safe direction: an unclassified error should be retried rather than
    // silently dead-lettered.
    expect(isPermanent(new Error('something unexpected'))).toBe(false);
    expect(isPermanent(undefined)).toBe(false);
  });
});
