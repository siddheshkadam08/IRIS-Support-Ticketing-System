import { AI_FEATURES, type AIExecuteRequest, type AIResult } from '@iris/shared/types';
import { config } from './config.js';
import type { FetchLike } from './core-client.js';
import { PermanentJobError, TemporaryJobError, errorForStatus } from './errors.js';
import { signedHeaders } from './signing.js';

/**
 * The worker's only contact with the AI service.
 *
 * Two responsibilities, both about trust boundaries:
 *
 *   1. Bound the call. Inference is the slowest thing in the pipeline and a
 *      hung request would hold a worker slot indefinitely.
 *   2. Check the SHAPE of what comes back before it is passed on. Core will
 *      validate the CONTENT; the worker validates that it is an AIResult at
 *      all, so a garbage response fails fast here instead of becoming a
 *      confusing 400 from Core.
 *
 * This file contains no prompts, no model names and no provider logic. Those
 * belong to the Python service.
 */

/**
 * Structural validation only.
 *
 * Deliberately NOT a semantic check: whether `data` makes sense for the
 * feature is Core's decision, made by the per-feature validator. Doing it
 * here too would put the same rule in two places and let them disagree.
 */
export function parseAIResult(value: unknown): AIResult {
  if (typeof value !== 'object' || value === null) {
    throw new PermanentJobError('malformed_ai_response', 'response is not an object');
  }
  const r = value as Record<string, unknown>;

  if (typeof r.feature !== 'string' || !(AI_FEATURES as readonly string[]).includes(r.feature)) {
    throw new PermanentJobError('malformed_ai_response', 'missing or unknown feature');
  }
  if (r.status !== 'succeeded' && r.status !== 'failed') {
    throw new PermanentJobError('malformed_ai_response', 'status must be succeeded or failed');
  }
  if (typeof r.data !== 'object' || r.data === null || Array.isArray(r.data)) {
    throw new PermanentJobError('malformed_ai_response', 'data must be an object');
  }
  if (r.error != null) {
    const e = r.error as Record<string, unknown>;
    if (e.kind !== 'temporary' && e.kind !== 'permanent') {
      throw new PermanentJobError('malformed_ai_response', 'error.kind is invalid');
    }
  }
  return value as AIResult;
}

/**
 * In:  AIExecuteRequest — subject, description, taxonomy, thresholds, a
 *      correlation id. No tenant identifier, no secret, no ticket metadata.
 * Out: a structurally valid AIResult.
 *
 * Failure handling: a 5xx or 503 (models loading) is temporary and BullMQ
 * retries; a 4xx means the request itself was wrong and retrying is pointless.
 */
export async function executeAI(
  request: AIExecuteRequest,
  fetchImpl: FetchLike = fetch,
): Promise<AIResult> {
  const path = '/v1/execute';
  // Serialise once: signed bytes === transmitted bytes. See core-client.ts.
  const serialised = JSON.stringify(request);

  let res: Response;
  try {
    res = await fetchImpl(`${config.AI_SERVICE_URL}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // A DIFFERENT secret from the Core-facing one, on purpose: leaking the
        // Python-facing credential must not grant access to Core.
        ...signedHeaders(config.AI_SERVICE_HMAC_SECRET, 'POST', path, serialised),
        'x-request-id': request.request_id,
      },
      body: serialised,
      signal: AbortSignal.timeout(config.AI_TIMEOUT_MS),
    });
  } catch (err) {
    // Unreachable or timed out. The ticket is unaffected either way — it was
    // committed long before this call.
    throw new TemporaryJobError(
      'ai_service_unreachable',
      err instanceof Error ? err.message : String(err),
    );
  }

  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 500);
    /**
     * One classifier for both boundaries (see errors.ts). Previously this
     * branch made its own 5xx/4xx decision, which meant a provider 429 or 408
     * from the AI service would have been treated as permanent and
     * dead-lettered. 503 "models loading" is covered by the 5xx rule.
     */
    throw errorForStatus(res.status, `ai_http_${res.status}`, text);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    throw new PermanentJobError(
      'malformed_ai_response',
      err instanceof Error ? err.message : 'invalid JSON',
    );
  }
  return parseAIResult(body);
}
