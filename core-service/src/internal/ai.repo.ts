import { newId } from '@iris/shared/types';
import type { Tx } from '../db/with-scope.js';

/**
 * SQL for ai_execution. Takes a `tx`, never opens its own — see
 * core-service/SKILLS.md section 2.
 *
 * This file is where Phase 1 idempotency actually lives. Both writes below are
 * conditional UPSERTs on the (event_id, feature) unique constraint, so a
 * duplicate delivery is resolved by the DATABASE inside a row lock rather than
 * by a read-then-write race in application code.
 */

export type AIExecutionStatus = 'running' | 'succeeded' | 'failed';

export interface AIExecutionRow {
  id: string;
  product_id: string;
  ticket_id: string;
  feature: string;
  event_id: string;
  job_id: string | null;
  correlation_id: string | null;
  status: AIExecutionStatus;
  attempt: number;
  provider: string | null;
  model: string | null;
  model_version: string | null;
  prompt_version: string | null;
  confidence: string | null;
  latency_ms: number | null;
  result: Record<string, unknown> | null;
  fallback_used: boolean;
  error_code: string | null;
  error_message: string | null;
  created_at: Date;
  completed_at: Date | null;
}

const COLUMNS = `id, product_id, ticket_id, feature, event_id, job_id, correlation_id,
                 status, attempt, provider, model, model_version, prompt_version,
                 confidence, latency_ms, result, fallback_used, error_code, error_message,
                 created_at, completed_at`;

export async function findExecution(
  tx: Tx,
  eventId: string,
  feature: string,
): Promise<AIExecutionRow | null> {
  const { rows } = await tx.query<AIExecutionRow>(
    `SELECT ${COLUMNS} FROM ai_execution WHERE event_id = $1 AND feature = $2`,
    [eventId, feature],
  );
  return rows[0] ?? null;
}

export async function listExecutionsForTicket(
  tx: Tx,
  ticketId: string,
): Promise<AIExecutionRow[]> {
  const { rows } = await tx.query<AIExecutionRow>(
    `SELECT ${COLUMNS} FROM ai_execution WHERE ticket_id = $1 ORDER BY created_at DESC`,
    [ticketId],
  );
  return rows;
}

/**
 * Claim the execution slot for (event_id, feature) at the start of a job.
 *
 * Returns the row as it stands AFTER the call. Two outcomes matter:
 *
 *   - status 'running'  -> this attempt owns the work, proceed.
 *   - status terminal   -> a previous attempt already finished. The caller
 *                          must NOT redo the work, and in particular must not
 *                          call the AI service again.
 *
 * DO UPDATE (rather than DO NOTHING) is what makes a retry visible: it bumps
 * `attempt` and re-stamps `job_id`, so "which attempt succeeded" — the first
 * debugging question — is answerable from the row itself. The WHERE guard
 * means a terminal row is never dragged back to 'running' by a late duplicate.
 */
export async function claimExecution(
  tx: Tx,
  args: {
    productId: string;
    ticketId: string;
    feature: string;
    eventId: string;
    jobId: string;
    correlationId: string;
    attempt: number;
  },
): Promise<AIExecutionRow> {
  const { rows } = await tx.query<AIExecutionRow>(
    `INSERT INTO ai_execution
       (id, product_id, ticket_id, feature, event_id, job_id, correlation_id, status, attempt)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'running',$8)
     ON CONFLICT (event_id, feature) DO UPDATE
        SET job_id  = EXCLUDED.job_id,
            attempt = GREATEST(ai_execution.attempt, EXCLUDED.attempt)
      WHERE ai_execution.status = 'running'
     RETURNING ${COLUMNS}`,
    [
      newId('aix'),
      args.productId,
      args.ticketId,
      args.feature,
      args.eventId,
      args.jobId,
      args.correlationId,
      args.attempt,
    ],
  );

  // A conflicting row whose status is terminal is filtered out by the WHERE
  // clause, so ON CONFLICT ... DO UPDATE returns nothing. That is not an
  // error — it is the duplicate signal. Read the existing row and hand it back.
  const claimed = rows[0];
  if (claimed) return claimed;

  const existing = await findExecution(tx, args.eventId, args.feature);
  if (!existing) {
    // Only reachable if the row vanished between statements, which cannot
    // happen inside one transaction. Fail loudly rather than silently.
    throw new Error(`ai_execution claim produced no row for ${args.eventId}/${args.feature}`);
  }
  return existing;
}

/**
 * Move a running execution to its terminal state.
 *
 * `WHERE status = 'running'` is the second half of the idempotency guarantee.
 * A duplicate result for an execution that already finished updates ZERO rows,
 * and the caller reports applied:false without writing an audit row or
 * touching the ticket.
 */
export async function completeExecution(
  tx: Tx,
  args: {
    eventId: string;
    feature: string;
    status: Exclude<AIExecutionStatus, 'running'>;
    provider: string | null;
    model: string | null;
    modelVersion: string | null;
    promptVersion: string | null;
    confidence: number | null;
    latencyMs: number | null;
    /** The VALIDATED result only. Never raw model output, never ticket text. */
    result: Record<string, unknown> | null;
    fallbackUsed: boolean;
    errorCode: string | null;
    errorMessage: string | null;
  },
): Promise<AIExecutionRow | null> {
  const { rows } = await tx.query<AIExecutionRow>(
    `UPDATE ai_execution
        SET status         = $3,
            provider       = $4,
            model          = $5,
            model_version  = $6,
            prompt_version = $7,
            confidence     = $8,
            latency_ms     = $9,
            result         = $10::jsonb,
            fallback_used  = $11,
            error_code     = $12,
            error_message  = $13,
            completed_at   = now()
      WHERE event_id = $1 AND feature = $2 AND status = 'running'
     RETURNING ${COLUMNS}`,
    [
      args.eventId,
      args.feature,
      args.status,
      args.provider,
      args.model,
      args.modelVersion,
      args.promptVersion,
      args.confidence,
      args.latencyMs,
      args.result === null ? null : JSON.stringify(args.result),
      args.fallbackUsed,
      args.errorCode,
      // Bounded: an error string is for humans, and an unbounded one from a
      // provider could carry a surprising amount of payload into the table.
      args.errorMessage === null ? null : args.errorMessage.slice(0, 500),
    ],
  );
  return rows[0] ?? null;
}
