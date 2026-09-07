import {
  AI_RETRY_ATTEMPTS,
  type AIJob,
  type AIResultRequest,
  type AIResultResponse,
} from '@iris/shared/types';
import { submitAIResult, type FetchLike } from './core-client.js';
import { PermanentJobError, isPermanent } from './errors.js';
import { logger } from './logger.js';

/**
 * Terminal failure reporting — Phase 3 Step 4.
 *
 * THE GAP THIS CLOSES. When a job dies, BullMQ knows and Postgres does not:
 * `submitAIResult` is only reached on the happy path, so a job that exhausts
 * its retries or fails permanently leaves `ai_execution` at `running` forever.
 * The Phase 3 audit found 13 such rows, the oldest stuck for 1h54m.
 *
 * WHAT THIS IS NOT. It is not a retry mechanism. It reports once and stops.
 * If Core is unreachable the row stays `running` and the Step 5 reaper
 * reconciles it — a second delay authority beside BullMQ is exactly what the
 * architecture forbids.
 *
 * It adds no endpoint and no contract: a terminal failure is just a failed
 * result the worker happens to author, sent through the same signed client,
 * to the same endpoint, with the same idempotency guard.
 */

/** Deliberately distinct from any Python-reported code, so the cause is legible in SQL. */
export const RETRIES_EXHAUSTED = 'retries_exhausted';

/** The minimum a BullMQ job must expose for a terminal decision. */
export interface TerminalJobView {
  data: AIJob;
  attemptsMade: number;
  opts?: { attempts?: number };
}

/**
 * Should this failure be reported to Core as terminal?
 *
 * Pure. No HTTP, no database, no Redis, no timers.
 *
 * Two independent reasons a job is dead:
 *
 *   permanent  BullMQ already stopped — UnrecoverableError short-circuits its
 *              retry test regardless of how many attempts remain.
 *   exhausted  no attempts left.
 *
 * `attemptsMade` is ALREADY INCREMENTED in the 'failed' event (it is 0-based
 * in the processor), so the final attempt reports `attemptsMade === attempts`
 * and there is no phantom attempt 7. Verified live in Step 3.
 */
export function shouldReportTerminal(job: TerminalJobView | undefined, err: unknown): boolean {
  if (!job) return false;
  if (isPermanent(err)) return true;

  const attempts = job.opts?.attempts ?? AI_RETRY_ATTEMPTS;
  return job.attemptsMade >= attempts;
}

/**
 * A short, safe message. NEVER the raw error text.
 *
 * `err.message` is `${code}: ${detail}` where `detail` is up to 500 bytes of a
 * raw upstream response body. Today those are error envelopes, but a real
 * provider could echo prompt or ticket content — and this string is persisted
 * to `ai_execution.error_message`. Only the machine code crosses; the full
 * detail stays in the structured log, where redaction already applies.
 */
function safeMessage(err: unknown, exhausted: boolean, attempts: number): string {
  const code = errorCodeOf(err);
  return exhausted ? `${attempts} attempts exhausted: ${code}` : `permanent failure: ${code}`;
}

/** The machine code if the error carries one, else a stable placeholder. */
function errorCodeOf(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.length > 0 ? code : 'unknown_error';
}

/**
 * Build the terminal result using the EXISTING AI result contract.
 *
 * `data: {}` because the schema requires the field and there is no model
 * output to carry. Core does not run the feature validator when
 * `status === 'failed'`, so an empty object is correct rather than a
 * placeholder.
 *
 * `error.kind` describes the UNDERLYING cause (a temporary failure that ran
 * out of road is still temporary); `error.code` says why we stopped. Core
 * reads only `code` and `message`.
 */
export function buildTerminalResult(job: TerminalJobView, err: unknown): AIResultRequest {
  const permanent = isPermanent(err);
  const attempts = job.opts?.attempts ?? AI_RETRY_ATTEMPTS;
  const exhausted = !permanent && job.attemptsMade >= attempts;

  return {
    job_id: job.data.job_id,
    feature: job.data.feature,
    attempt: job.attemptsMade,
    correlation_id: job.data.correlation_id,
    // Claims, not authority: Core verifies both against its own outbox row.
    claimed_product_id: job.data.product_id,
    claimed_ticket_id: job.data.ticket_id,
    result: {
      feature: job.data.feature,
      status: 'failed',
      data: {},
      error: {
        kind: permanent ? 'permanent' : 'temporary',
        code: permanent ? errorCodeOf(err) : RETRIES_EXHAUSTED,
        message: safeMessage(err, exhausted, attempts),
      },
    },
  };
}

export type TerminalOutcome =
  | { outcome: 'skipped' }
  | { outcome: 'applied'; result: AIResultResponse }
  | { outcome: 'duplicate'; result: AIResultResponse }
  | { outcome: 'nothing_to_close' }
  | { outcome: 'report_failed'; code: string };

/**
 * Report a terminal failure to Core, once.
 *
 * NEVER THROWS. It is called from a BullMQ event listener, and BullMQ does not
 * await listeners — an escaping rejection would be an unhandled rejection,
 * which Node aborts the process on by default. Every path returns an outcome.
 *
 * NEVER RETRIES. One attempt. If Core is down the execution stays `running`
 * and Step 5 reconciles it.
 */
export async function reportTerminalFailure(
  job: TerminalJobView | undefined,
  err: unknown,
  fetchImpl?: FetchLike,
): Promise<TerminalOutcome> {
  if (!shouldReportTerminal(job, err)) return { outcome: 'skipped' };

  const view = job!;
  const log = logger.child({
    event_id: view.data.event_id,
    job_id: view.data.job_id,
    feature: view.data.feature,
    request_id: view.data.correlation_id,
    attempt: view.attemptsMade,
  });

  try {
    const body = buildTerminalResult(view, err);
    const result = await submitAIResult(view.data.event_id, body, fetchImpl);

    if (!result.applied) {
      // The execution was already terminal — a duplicate report, or a result
      // that beat us. Expected, not an error.
      log.info(
        { execution_id: result.execution_id, status: result.status },
        'terminal failure already recorded — no change',
      );
      return { outcome: 'duplicate', result };
    }

    log.warn(
      { execution_id: result.execution_id, error_code: body.result.error?.code },
      'AI execution closed as failed',
    );
    return { outcome: 'applied', result };
  } catch (reportErr) {
    const code = errorCodeOf(reportErr);

    /**
     * 404 means Core has no ai_execution row for this event — every attempt
     * died before /input ever claimed one. There is nothing to close and
     * nothing is stuck, so this is a normal terminal condition, not a fault.
     * Verified live during the Step 4 design freeze.
     */
    if (reportErr instanceof PermanentJobError && code === 'ticket_not_found') {
      log.info('no AI execution to close — job never claimed one');
      return { outcome: 'nothing_to_close' };
    }

    /**
     * Anything else — Core 5xx, unreachable, timeout, a rejected signature.
     * Log and STOP. Deliberately no retry, no re-enqueue, no timer: the
     * execution stays `running` and the Step 5 reaper is the backstop.
     */
    log.error(
      { report_error: code, will_retry: false },
      'terminal failure report did not reach Core — execution left running for the reaper',
    );
    return { outcome: 'report_failed', code };
  }
}
