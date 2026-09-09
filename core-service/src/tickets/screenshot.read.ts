import type { ScreenshotInterpretation, ScreenshotResultDTO } from '@iris/shared/types';
import type { Tx } from '../db/with-scope.js';

/**
 * Screenshot interpretations for one ticket — Phase 19 Step 2.
 *
 * READ-ONLY, and it is the only path by which a screenshot result reaches a
 * human. It writes nothing, mutates nothing and triggers nothing: opening a
 * ticket must not cause a model call, an execution, or a change to any row.
 *
 * ⚠️ THE PROJECTION IS A WHITELIST, NOT `SELECT *`.
 *
 * `ai_execution` also holds `error_message`, which is bounded but derived from
 * an upstream string, and `job_id`/`event_id`/`correlation_id`, which are
 * operational identifiers an agent has no use for. The AI operations screen
 * already excludes `error_message` for exactly this reason
 * (admin/ai-ops.routes.ts), and this surface is more exposed, not less: it is
 * the ticket page every agent opens. `error_code` is the machine-readable cause
 * and is enough to tell an agent why nothing is shown.
 *
 * ⚠️ NO IMAGE, NO BASE64, NO BLOB KEY, AND NOTHING TO STRIP.
 *
 * That is not a filter applied here — it is that none of them was ever written.
 * `ai_execution.result` holds the VALIDATED interpretation and nothing else, the
 * image never reaches Core's result path, and `blob_key` never leaves
 * `resolveScreenshotImage`. This function could not leak an image if it tried.
 */

/** The subset of `ai_execution` this surface reads. */
interface ScreenshotExecutionRow {
  id: string;
  status: 'running' | 'succeeded' | 'failed';
  result: Record<string, unknown> | null;
  error_code: string | null;
  model: string | null;
  provider: string | null;
  latency_ms: number | null;
  created_at: Date;
  completed_at: Date | null;
}

/**
 * Split the stored result back into the interpretation and the attachment id.
 *
 * Core stamped `screenshot_attachment_id` onto the validated value at result
 * time, so it sits alongside the model's fields in one JSONB column rather than
 * in a new `ai_execution` column — the Phase 19 audit's conclusion, since the
 * linkage already exists through the event and a column would be a migration.
 *
 * Read defensively. `result` is jsonb written by an earlier version of this
 * code, and a row from before the stamping existed is a real possibility that
 * should render as an interpretation with no attachment rather than as a crash.
 */
function splitResult(result: Record<string, unknown> | null): {
  attachmentId: string | null;
  interpretation: ScreenshotInterpretation | null;
} {
  if (!result) return { attachmentId: null, interpretation: null };

  const { screenshot_attachment_id: attachmentId, ...rest } = result;
  const hasShape =
    Array.isArray(rest.observations) &&
    Array.isArray(rest.possible_causes) &&
    Array.isArray(rest.suggested_next_steps) &&
    typeof rest.confidence === 'number';

  return {
    attachmentId: typeof attachmentId === 'string' ? attachmentId : null,
    // The value was validated by `validateScreenshot` before it was stored, so
    // this cast is over data Core itself accepted — not over model output.
    interpretation: hasShape ? (rest as unknown as ScreenshotInterpretation) : null,
  };
}

export async function screenshotResultsForTicket(
  tx: Tx,
  ticketId: string,
): Promise<ScreenshotResultDTO[]> {
  /**
   * `feature = 'screenshot'` is in the statement rather than filtered after:
   * a ticket accumulates classification, summary and noop executions too, and
   * fetching them to discard them would put other features' results — including
   * classification's stored DECISION — into memory on a request that has no
   * business holding them.
   *
   * RLS constrains `ai_execution` to the caller's products before this runs.
   */
  const { rows } = await tx.query<ScreenshotExecutionRow>(
    `SELECT id, status, result, error_code, model, provider, latency_ms,
            created_at, completed_at
       FROM ai_execution
      WHERE ticket_id = $1 AND feature = 'screenshot'
      ORDER BY created_at ASC`,
    [ticketId],
  );

  return rows.map((r) => {
    const { attachmentId, interpretation } = splitResult(r.result);
    return {
      execution_id: r.id,
      attachment_id: attachmentId,
      status: r.status,
      interpretation,
      error_code: r.error_code,
      model: r.model,
      provider: r.provider,
      latency_ms: r.latency_ms === null ? null : Number(r.latency_ms),
      created_at: r.created_at.toISOString(),
      completed_at: r.completed_at ? r.completed_at.toISOString() : null,
    } satisfies ScreenshotResultDTO;
  });
}
