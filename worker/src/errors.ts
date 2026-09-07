import { UnrecoverableError } from 'bullmq';

/**
 * There is exactly ONE job-level retry owner in this system: BullMQ.
 *
 * Neither Core nor the Python service retries anything, so the only decision
 * the worker has to make is which BullMQ error to throw:
 *
 *   PermanentJobError  -> UnrecoverableError. BullMQ stops immediately.
 *   TemporaryJobError  -> a plain Error. BullMQ applies the backoff schedule.
 *
 * Getting this wrong in the retryable direction is the expensive mistake: a
 * 4xx retried five times just delays the alert while looking like a transient
 * blip. Getting it wrong the other way loses recoverable work.
 */

/** The same call, made again, returns the same answer. Do not retry. */
export class PermanentJobError extends UnrecoverableError {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'PermanentJobError';
    this.code = code;
  }
}

/** The same call might succeed later. Let BullMQ back off and retry. */
export class TemporaryJobError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'TemporaryJobError';
    this.code = code;
  }
}

/**
 * The two 4xx codes that are a statement about TIMING, not about the request.
 *
 *   408 Request Timeout    the server gave up waiting; the same request may land
 *   429 Too Many Requests  a rate limit, which is temporary by definition
 *
 * Everything else in the 4xx range says the request itself is wrong, and a
 * wrong request is wrong every time.
 *
 * These are not reachable from Core or the Python stub today, but they become
 * reachable the moment a real provider is wired in — and 429 is the single most
 * common transient failure an LLM provider produces. Classifying it as
 * permanent would dead-letter every job during a rate-limit window.
 *
 * NOTE (Phase 3 Step 3, deliberate): a 429 `Retry-After` header is IGNORED.
 * Honouring it would introduce a second authority over retry timing alongside
 * BullMQ. If it is ever honoured, the frozen constraint is
 * `effective Retry-After <= max backoff < reaper threshold`.
 */
const RETRYABLE_4XX = new Set([408, 429]);

/**
 * Map an HTTP status onto the retry decision. THE single classifier — both the
 * Core client and the AI client route through it so they cannot diverge.
 *
 *   408, 429  -> temporary (timing, not correctness)
 *   other 4xx -> permanent (a bad claim, unsupported feature, missing event,
 *                rejected signature: none of those heal on their own)
 *   5xx       -> temporary (the service is having a bad moment)
 */
export function errorForStatus(status: number, code: string, detail: string): Error {
  if (status >= 400 && status < 500 && !RETRYABLE_4XX.has(status)) {
    return new PermanentJobError(code, detail);
  }
  return new TemporaryJobError(code, detail);
}

export function isPermanent(err: unknown): boolean {
  return err instanceof PermanentJobError;
}
