import { randomUUID } from 'node:crypto';
import { requestSignatureHeader } from '@iris/shared/hmac';
import { config } from '../config.js';

/**
 * Core's ONE signed call into the AI service — Phase 12.
 *
 * Extracted when reranking became the second thing Core needed from Python.
 * Two call sites signing their own requests is how a canonical string drifts,
 * and a drifted signature fails in a way that looks like broken crypto rather
 * than like a bug — the repo's own signing helpers say exactly this, for
 * exactly this reason.
 *
 * ⚠️ NO RETRY LIVES HERE, and none may be added. Both callers are on a
 * synchronous path where a user is waiting, and both degrade gracefully; a
 * retry would double the worst case to hide a failure the caller already
 * handles. BullMQ remains the only retry owner in the platform.
 */

export type AiCallOutcome<T> =
  | { ok: true; value: T; latencyMs: number }
  | {
      ok: false;
      reason: 'timeout' | 'unavailable' | 'invalid' | 'not_configured';
      latencyMs: number;
      status?: number;
    };

/**
 * POST a signed `/v1/execute` request and return its `data` payload.
 *
 * NEVER THROWS. Every failure is a typed outcome, because on both call sites
 * the only correct response to "the provider is unhappy" is to carry on with
 * what Core already has — and a throw would make that each caller's problem to
 * remember.
 */
export async function callAiService<T>(
  args: {
    feature: string;
    requestId: string;
    input: Record<string, unknown>;
    timeoutMs: number;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<AiCallOutcome<T>> {
  const started = Date.now();

  if (!config.AI_SERVICE_URL || !config.AI_CORE_HMAC_SECRET) {
    // A deployment without the credential degrades rather than failing search.
    return { ok: false, reason: 'not_configured', latencyMs: 0 };
  }

  const path = '/v1/execute';
  /**
   * Serialise ONCE. These exact bytes are hashed into the signature and are the
   * exact bytes sent; serialising twice produces a body the AI service never
   * verified, and every request fails for reasons that look like a crypto bug.
   */
  const body = JSON.stringify({
    feature: args.feature,
    // The correlation id ONLY. Never the query, never a tenant identifier —
    // this value is echoed into the AI service's logs.
    request_id: args.requestId,
    input: args.input,
  });

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomUUID();

  let res: Response;
  try {
    res = await fetchImpl(`${config.AI_SERVICE_URL}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-iris-service-id': 'core',
        'x-iris-timestamp': timestamp,
        'x-iris-nonce': nonce,
        'x-iris-signature': requestSignatureHeader(config.AI_CORE_HMAC_SECRET, {
          method: 'POST',
          path,
          timestamp,
          nonce,
          body: Buffer.from(body, 'utf8'),
        }),
        'x-request-id': args.requestId,
      },
      body,
      signal: AbortSignal.timeout(args.timeoutMs),
    });
  } catch (err) {
    return {
      ok: false,
      reason: isAbort(err) ? 'timeout' : 'unavailable',
      latencyMs: Date.now() - started,
    };
  }

  const latencyMs = Date.now() - started;

  if (!res.ok) {
    /**
     * Every non-200 is `unavailable`, INCLUDING 429 and 5xx.
     *
     * Not because the distinction does not exist — the worker's pipeline acts
     * on it — but because on this path there is exactly one response to all of
     * them: carry on with what Core has and answer the user now. Encoding a
     * retryability signal nothing acts on would be a second retry owner
     * waiting to be written.
     */
    return { ok: false, reason: 'unavailable', latencyMs, status: res.status };
  }

  try {
    // The timeout is still live: `fetch` resolves on HEADERS, so a service that
    // answers 200 then stalls mid-body lands here as an AbortError.
    const parsed = (await res.json()) as { data?: unknown };
    return { ok: true, value: parsed.data as T, latencyMs: Date.now() - started };
  } catch (err) {
    return {
      ok: false,
      reason: isAbort(err) ? 'timeout' : 'invalid',
      latencyMs: Date.now() - started,
    };
  }
}

function isAbort(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const name = (err as { name?: unknown }).name;
  return name === 'TimeoutError' || name === 'AbortError';
}
