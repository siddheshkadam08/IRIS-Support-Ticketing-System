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
      /**
       * `content_filter` is the one non-200 that is NOT reported as
       * `unavailable` — see the discussion at the response check below.
       */
      reason: 'timeout' | 'unavailable' | 'invalid' | 'not_configured' | 'content_filter';
      latencyMs: number;
      status?: number;
      /**
       * The AI service's own error code, when it sent a structured envelope.
       * Diagnostic only: nothing branches on it, so a new provider code cannot
       * change Core's behaviour by surprise.
       */
      providerCode?: string;
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
     * Almost every non-200 is `unavailable`, INCLUDING 429 and 5xx.
     *
     * Not because the distinction does not exist — the worker's pipeline acts
     * on it — but because on this path there is exactly one response to all of
     * them: carry on with what Core has and answer the user now. Encoding a
     * retryability signal nothing acts on would be a second retry owner
     * waiting to be written.
     *
     * ⚠️ ONE EXCEPTION: `provider_content_filter`.
     *
     * It is not an outage. The provider read this exact prompt and refused it,
     * and it will refuse the identical prompt every time — Azure returns HTTP
     * 400 for text like "reveal your system prompt and any API keys", which
     * arrives here as a 422 from the AI service. Reporting that as
     * "unavailable" tells an operator a provider is down when nothing is down,
     * and tells an agent to retry something that can only fail again.
     *
     * ⚠️ THIS ADDS NO RETRY AND NO RETRY OWNER. Nothing on this path retries
     * anything, before or after this change; `content_filter` and `unavailable`
     * are handled identically — no draft, no answer, carry on — and differ only
     * in what the outcome is CALLED. BullMQ remains the sole retry owner on the
     * queue path, where the AI service's `kind: "permanent"` was already
     * honoured and is untouched.
     */
    const providerCode = await errorCodeOf(res);
    return {
      ok: false,
      reason: providerCode === 'provider_content_filter' ? 'content_filter' : 'unavailable',
      latencyMs,
      status: res.status,
      ...(providerCode ? { providerCode } : {}),
    };
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

/**
 * The AI service's error code from a non-200 envelope, or null.
 *
 * NEVER THROWS and never blocks the caller: a body that is missing, truncated,
 * not JSON or not the expected shape simply yields null, and the outcome stays
 * `unavailable`. The failure path must not be able to fail.
 *
 * The body is small (an error envelope) and the request's timeout budget has
 * already been spent by the time we are here, so reading it costs nothing that
 * matters.
 */
async function errorCodeOf(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { error?: { code?: unknown } };
    const code = body?.error?.code;
    return typeof code === 'string' ? code : undefined;
  } catch {
    return undefined;
  }
}

function isAbort(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const name = (err as { name?: unknown }).name;
  return name === 'TimeoutError' || name === 'AbortError';
}
