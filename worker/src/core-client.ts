import type {
  AIInputRequest,
  AIInputResponse,
  AIResultRequest,
  AIResultResponse,
} from '@iris/shared/types';
import { config } from './config.js';
import { TemporaryJobError, errorForStatus } from './errors.js';
import { signedHeaders } from './signing.js';

/**
 * Typed access to the two Core internal endpoints.
 *
 * The 4xx/5xx retry distinction lives HERE and nowhere else, so it cannot
 * drift between the two call sites. Every call is bounded by a timeout: one
 * hung request must not hold a worker slot forever.
 *
 * `fetchImpl` is injectable so tests can exercise the real status-code
 * handling without a network — the classification logic is the thing worth
 * testing, and stubbing the transport is how you reach it.
 */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

async function post<T>(
  path: string,
  body: unknown,
  correlationId: string,
  fetchImpl: FetchLike = fetch,
): Promise<T> {
  const url = `${config.CORE_SERVICE_URL}${path}`;

  /**
   * Serialise ONCE. These exact bytes are hashed into the signature and are
   * the exact bytes sent. Serialising twice would produce a body Core never
   * verified — key order and whitespace differ between calls — and every
   * request would fail for reasons that look like a crypto bug.
   */
  const serialised = JSON.stringify(body);

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Phase 2: an HMAC signature over (method, path, timestamp, nonce,
        // sha256(body)) — scoped to /internal/ai/* by the secret Core uses to
        // verify it. Replaces the platform-wide INTERNAL_API_KEY, which also
        // opened /v1/* and /admin/api/*.
        ...signedHeaders(config.AI_WORKER_HMAC_SECRET, 'POST', path, serialised),
        // Correlation only, deliberately OUTSIDE the signature: the
        // authoritative correlation id comes from Core's own outbox row.
        'x-request-id': correlationId,
      },
      body: serialised,
      signal: AbortSignal.timeout(config.CORE_TIMEOUT_MS),
    });
  } catch (err) {
    // Connection refused, DNS, timeout. Core may simply be restarting.
    throw new TemporaryJobError(
      'core_unreachable',
      err instanceof Error ? err.message : String(err),
    );
  }

  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 500);
    let code = `core_http_${res.status}`;
    try {
      const parsed = JSON.parse(text) as { error?: { code?: string } };
      if (parsed.error?.code) code = parsed.error.code;
    } catch {
      /* not an error envelope; the status alone is enough to decide */
    }
    throw errorForStatus(res.status, code, text);
  }

  return (await res.json()) as T;
}

/**
 * Ask Core for authorized AI input.
 *
 * In: the worker's claims about the job it holds.
 * Out: either the minimal AI input, or `already_applied` when a previous
 *      attempt already finished — in which case the caller must stop without
 *      calling the AI service.
 */
export function fetchAIInput(
  eventId: string,
  claims: AIInputRequest,
  fetchImpl?: FetchLike,
): Promise<AIInputResponse> {
  return post<AIInputResponse>(
    `/internal/ai/jobs/${encodeURIComponent(eventId)}/input`,
    claims,
    claims.correlation_id,
    fetchImpl,
  );
}

/**
 * Hand the result back to Core, which validates it and decides what — if
 * anything — happens to the ticket. The worker never applies anything itself.
 */
export function submitAIResult(
  eventId: string,
  body: AIResultRequest,
  fetchImpl?: FetchLike,
): Promise<AIResultResponse> {
  return post<AIResultResponse>(
    `/internal/ai/jobs/${encodeURIComponent(eventId)}/result`,
    body,
    body.correlation_id,
    fetchImpl,
  );
}
