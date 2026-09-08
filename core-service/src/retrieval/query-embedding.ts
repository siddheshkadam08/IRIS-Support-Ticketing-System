import { randomUUID } from 'node:crypto';
import { requestSignatureHeader } from '@iris/shared/hmac';
import { EMBEDDING_DIM, validateEmbeddingVector } from '@iris/shared/types';
import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Core's query-embedding client — Phase 11.
 *
 * ⚠️ THIS IS A NEW TRUST EDGE, AND IT NEEDED A DECISION RATHER THAN A DEFAULT.
 *
 * Phase 10 deliberately kept the worker as the only process talking to both
 * Core and Python, because embedding was BACKGROUND work and the worker already
 * held both credentials. Hybrid retrieval is different in kind: a user is
 * waiting on an HTTP request, and the worker is not on that path at all.
 *
 * The alternatives were considered and rejected:
 *
 *   - give the worker an HTTP server and proxy through it. That puts a queue
 *     consumer on the synchronous request path and makes it a new availability
 *     dependency for search. Strictly worse.
 *   - let Core reuse AI_SERVICE_HMAC_SECRET. That is the worker's Python-facing
 *     credential; sharing it means leaking either one grants the other's access,
 *     and undoes exactly the separation Phase 2 exists to create.
 *   - skip the query embedding and ship lexical-only "hybrid". Not hybrid.
 *
 * So Core gets its OWN directional secret and its own service id. Three
 * secrets, each valid in one direction, none of which is a superset of another:
 *
 *     worker -> Core     AI_WORKER_HMAC_SECRET
 *     worker -> Python   AI_SERVICE_HMAC_SECRET
 *     Core   -> Python   AI_CORE_HMAC_SECRET      (new)
 *
 * No new service, queue, database, cache or retry owner. One new credential and
 * one new allowed caller in the AI service's closed allowlist.
 *
 * ⚠️ NO RETRY LIVES HERE. A user is waiting; a retry would double the worst
 * case to hide a failure the caller already degrades gracefully around. The
 * fallback IS the error handling — see hybrid.service.ts.
 */

export type QueryEmbeddingOutcome =
  | { ok: true; vector: number[]; latencyMs: number }
  | { ok: false; reason: 'timeout' | 'unavailable' | 'invalid' | 'not_configured'; latencyMs: number };

/**
 * Embed one search query.
 *
 * NEVER THROWS. Every failure is a typed outcome, because the only correct
 * response to "the embedding provider is unhappy" on this path is to rank with
 * the two lexical strategies and carry on — and a throw would make that the
 * caller's problem to remember.
 */
export async function embedQuery(
  query: string,
  requestId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<QueryEmbeddingOutcome> {
  const started = Date.now();

  if (!config.AI_SERVICE_URL || !config.AI_CORE_HMAC_SECRET) {
    // A deployment without the credential runs lexical-only rather than failing
    // search outright. Reported so it is visible, not silently degraded.
    return { ok: false, reason: 'not_configured', latencyMs: 0 };
  }

  const path = '/v1/execute';
  /**
   * Serialise ONCE. These exact bytes are hashed into the signature and are the
   * exact bytes sent; serialising twice produces a body the AI service never
   * verified, and every request fails for reasons that look like a crypto bug.
   */
  const body = JSON.stringify({
    feature: 'embedding',
    // The correlation id only. NOT the query, NOT a tenant identifier — the
    // request_id is echoed into the AI service's logs, and the query is user
    // text that may carry anything.
    request_id: requestId,
    input: { subject: null, description: query },
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
        'x-request-id': requestId,
      },
      body,
      signal: AbortSignal.timeout(config.AI_QUERY_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = isAbort(err);
    return { ok: false, reason: timedOut ? 'timeout' : 'unavailable', latencyMs: Date.now() - started };
  }

  const latencyMs = Date.now() - started;

  if (!res.ok) {
    /**
     * Every non-200 is `unavailable` here, INCLUDING 429 and 5xx.
     *
     * Not because the distinction does not exist — it does, and the worker's
     * pipeline acts on it — but because on this path there is exactly one
     * response to all of them: fall back to lexical and answer the user now.
     * Encoding a retryability signal nothing acts on would be a second retry
     * owner waiting to be written.
     */
    logger.warn({ status: res.status, request_id: requestId }, 'query embedding rejected');
    return { ok: false, reason: 'unavailable', latencyMs };
  }

  let parsed: { data?: { vector?: unknown } };
  try {
    // The timeout is still live: `fetch` resolves on HEADERS, so a service that
    // answers 200 then stalls mid-body lands here as an AbortError.
    parsed = (await res.json()) as { data?: { vector?: unknown } };
  } catch (err) {
    return {
      ok: false,
      reason: isAbort(err) ? 'timeout' : 'invalid',
      latencyMs: Date.now() - started,
    };
  }

  /**
   * Validated with the SAME function that guards persistence in Phase 10 —
   * finite, correct width, non-zero. A query vector is not stored, but a NaN in
   * one makes every distance NaN, and NaN sorts LAST under ASC: the search
   * would return the corpus in an arbitrary order and report no error at all.
   */
  const check = validateEmbeddingVector(parsed.data?.vector, EMBEDDING_DIM);
  if (!check.ok) {
    logger.warn({ request_id: requestId, reason: check.reason }, 'query embedding rejected');
    return { ok: false, reason: 'invalid', latencyMs };
  }

  return { ok: true, vector: check.vector, latencyMs };
}

function isAbort(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const name = (err as { name?: unknown }).name;
  return name === 'TimeoutError' || name === 'AbortError';
}
