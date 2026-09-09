import { AI_FEATURES, type AIExecuteRequest, type AIResult } from '@iris/shared/types';
import { config } from './config.js';
import type { FetchLike } from './core-client.js';
import { PermanentJobError, TemporaryJobError, errorForStatus, isAbortError } from './errors.js';
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
    // committed long before this call. Both are temporary: BullMQ retries.
    throw new TemporaryJobError(
      isAbortError(err) ? 'ai_service_timeout' : 'ai_service_unreachable',
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
     *
     * ⚠️ THE CODE NOW COMES FROM THE AI SERVICE'S OWN ENVELOPE — finding G-3.
     *
     * The service already classifies precisely: `provider_content_filter`,
     * `provider_http_429`, `provider_not_configured`, `invalid_input`,
     * `malformed_ai_response`. All of it was being collapsed into
     * `ai_http_422`, which is why 264 of the 282 real failures in the
     * governance corpus said nothing more than "the AI service said no".
     *
     * ⚠️ TELEMETRY ONLY. The RETRY CLASS is still `errorForStatus(res.status,
     * …)` — decided by the HTTP status, exactly as before. A richer code
     * cannot change whether BullMQ retries, and BullMQ remains the sole retry
     * owner. Only the label travelling to `ai_execution.error_code` improves.
     */
    throw errorForStatus(res.status, providerCodeOf(text, res.status), text);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    /**
     * The timeout is still live here. `fetch` resolves on HEADERS, so a
     * service that answers 200 and then stalls mid-body lands in this catch
     * with a TimeoutError — indistinguishable from bad JSON by position alone.
     *
     * Classifying that as `malformed_ai_response` (permanent) dead-lettered a
     * merely slow service on attempt 1. A timeout is a dependency failure, so
     * it goes down the temporary path and BullMQ retries it.
     */
    if (isAbortError(err)) {
      throw new TemporaryJobError(
        'ai_service_timeout',
        `response body not received within ${config.AI_TIMEOUT_MS}ms`,
      );
    }
    throw new PermanentJobError(
      'malformed_ai_response',
      err instanceof Error ? err.message : 'invalid JSON',
    );
  }
  return parseAIResult(body);
}

/**
 * The AI service's own failure code, or a status-derived fallback.
 *
 * The service answers a failure with `{"error":{"kind","code","message"}}` —
 * `provider_content_filter`, `provider_http_429`, `provider_not_configured`,
 * `invalid_input`, `malformed_ai_response` and so on. That code is the most
 * specific thing anyone knows about the failure, and it was being thrown away
 * in favour of the HTTP status.
 *
 * ⚠️ NEVER THROWS, and never blocks the failure path. A body that is missing,
 * truncated, not JSON, or not the expected shape yields `ai_http_<status>` —
 * byte-identical to the old behaviour, so nothing that already depends on those
 * codes breaks.
 *
 * ⚠️ BOUNDED AND CHARACTER-RESTRICTED. The code becomes durable telemetry in
 * `ai_execution.error_code`, so a provider that echoes prompt fragments into a
 * `code` field cannot turn it into a content leak: anything that is not a short
 * machine token is rejected in favour of the fallback.
 */
export function providerCodeOf(body: string, status: number): string {
  const fallback = `ai_http_${status}`;
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown } };
    const code = parsed?.error?.code;
    // Machine tokens only: lower-case, digits, underscore, 1..64 chars.
    return typeof code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : fallback;
  } catch {
    return fallback;
  }
}
