import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError } from '@iris/shared/types';
import { TIMESTAMP_WINDOW_SECONDS, verifyRequest } from '@iris/shared/hmac';
import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Service-to-service authentication for /internal/*.
 *
 * WHY THIS EXISTS. Phase 1 authenticated the worker with the platform-wide
 * INTERNAL_API_KEY — the same key the gateway uses, which core-service accepts
 * on EVERY route. Since resolveCaller and resolveAdminCaller trust
 * x-iris-product-id / x-iris-role / x-iris-support-user-id as plain headers, a
 * compromised worker could read any tenant's tickets and reach the admin API
 * as super_admin. That was verified against a running stack, not theorised.
 *
 * The fix is SEPARATION first, signatures second: the worker now holds a
 * credential that is valid on /internal/ai/* and nowhere else.
 *
 * WHAT THIS ANSWERS: "did this come from a trusted service, unmodified,
 * recently, and not before?"
 *
 * WHAT IT DOES NOT ANSWER: "may this service touch THIS ticket?" That remains
 * Core's, via event lookup, claim verification, product scope and RLS. A
 * perfectly signed request claiming another tenant is still rejected
 * downstream — see phase2.security.test.ts.
 *
 * The canonical string, header semantics and signature format are reused from
 * shared/hmac-utils EXACTLY. They are a published integrator contract
 * (docs/api-contract.md §3.3, vectors.json); changing them would be a breaking
 * change, not a refactor.
 */

declare module 'fastify' {
  interface FastifyRequest {
    /** Exact bytes as received. Set by the scoped parser; HMAC hashes THIS. */
    rawBody?: Buffer;
    /** Set only after a signature verifies. Logging/diagnostics — never authorization. */
    serviceId?: string;
  }
}

/**
 * The complete set of callers allowed to reach /internal/*.
 *
 * A closed map, not a lookup that falls back to "some secret": an unknown
 * service id is a 401, so adding a service is a deliberate code change.
 */
export type ServiceId = 'worker';

function secretFor(serviceId: string): string | null {
  switch (serviceId) {
    case 'worker':
      return config.AI_WORKER_HMAC_SECRET;
    default:
      return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Replay cache
// ─────────────────────────────────────────────────────────────────────────

/**
 * In-memory nonce cache, mirroring the gateway's existing rememberNonce.
 *
 * Sufficient because core-service runs as ONE process on the VPS, and because
 * it is defence in depth rather than the primary control: a replayed AI result
 * is already absorbed by UNIQUE(event_id, feature) in Postgres, and a replayed
 * input re-claims a running execution harmlessly. Correctness lives in the
 * database; this bounds the HTTP request itself.
 *
 * If Core is ever replicated, REDIS_URL is already in config and this becomes
 * a SET NX EX 600. Deliberately not pre-built.
 */
const NONCE_TTL_MS = 600_000;
const seenNonces = new Map<string, number>();

/** Exposed for tests that need a clean cache; not used by the running server. */
export function resetNonceCache(): void {
  seenNonces.clear();
}

function rememberNonce(nonce: string): boolean {
  const now = Date.now();
  for (const [k, expiry] of seenNonces) if (expiry < now) seenNonces.delete(k);
  if (seenNonces.has(nonce)) return false;
  seenNonces.set(nonce, now + NONCE_TTL_MS);
  return true;
}

// ─────────────────────────────────────────────────────────────────────────
// Failure handling
// ─────────────────────────────────────────────────────────────────────────

/**
 * Security failures are LOGGED, never audited.
 *
 * audit_event is for attributed business facts about a tenant's data. Writing a
 * row per failed signature would let an unauthenticated caller grow the audit
 * table at will — a denial-of-service dressed as diligence. This matches the
 * gateway, which logs HMAC failures rather than auditing them.
 *
 * Logged: service id, method, path, reason, request id.
 * Never logged: the signature, the secret, the body, any ticket content.
 */
function reject(
  req: FastifyRequest,
  code: 'unauthenticated' | 'signature_invalid' | 'timestamp_out_of_window' | 'nonce_replayed',
  reason: string,
): never {
  logger.warn(
    {
      service_id: str(req.headers['x-iris-service-id']) ?? null,
      method: req.method,
      path: req.url,
      reason,
      requestId: req.id as string,
    },
    'internal service authentication failed',
  );
  throw new AppError(code, 'Service authentication failed.');
}

function str(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

const SIGNATURE_RE = /^v1=[a-f0-9]{64}$/i;
const NONCE_RE = /^[A-Za-z0-9._:-]{8,200}$/;

// ─────────────────────────────────────────────────────────────────────────
// The hooks
// ─────────────────────────────────────────────────────────────────────────

/**
 * Registers authentication for the enclosing plugin scope.
 *
 * Split across two hooks on purpose:
 *
 *   onRequest  — everything checkable WITHOUT the body. A request with garbage
 *                headers is rejected before Core parses a single byte.
 *   preHandler — signature verification, which needs the raw body, and only
 *                then the nonce.
 *
 * The nonce is recorded only AFTER the signature verifies, so an attacker
 * cannot poison the cache with guessed values and lock out the real worker.
 */
export function registerServiceAuth(app: FastifyInstance): void {
  app.addHook('onRequest', async (req) => {
    const serviceId = str(req.headers['x-iris-service-id']);
    if (!serviceId) reject(req, 'unauthenticated', 'missing_service_id');
    if (!secretFor(serviceId)) reject(req, 'unauthenticated', 'unknown_service_id');

    const timestamp = str(req.headers['x-iris-timestamp']);
    if (!timestamp) reject(req, 'timestamp_out_of_window', 'missing_timestamp');
    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || !Number.isInteger(ts)) {
      reject(req, 'timestamp_out_of_window', 'malformed_timestamp');
    }
    // Symmetric window: rejects both stale captures and clocks set forward.
    const skew = Math.abs(Math.floor(Date.now() / 1000) - ts);
    if (skew > TIMESTAMP_WINDOW_SECONDS) {
      reject(req, 'timestamp_out_of_window', 'timestamp_out_of_window');
    }

    const nonce = str(req.headers['x-iris-nonce']);
    if (!nonce) reject(req, 'signature_invalid', 'missing_nonce');
    if (!NONCE_RE.test(nonce)) reject(req, 'signature_invalid', 'malformed_nonce');

    const signature = str(req.headers['x-iris-signature']);
    if (!signature) reject(req, 'signature_invalid', 'missing_signature');
    if (!SIGNATURE_RE.test(signature)) reject(req, 'signature_invalid', 'malformed_signature');
  });

  app.addHook('preHandler', async (req) => {
    const serviceId = str(req.headers['x-iris-service-id'])!;
    const secret = secretFor(serviceId)!;
    const timestamp = str(req.headers['x-iris-timestamp'])!;
    const nonce = str(req.headers['x-iris-nonce'])!;
    const signature = str(req.headers['x-iris-signature'])!;

    /**
     * THE RAW BYTES, never a re-serialisation.
     *
     * JSON.parse followed by JSON.stringify changes whitespace and key order,
     * and every signature then fails — the single most common HMAC integration
     * bug. The scoped parser in internal.routes.ts keeps the original buffer
     * precisely so this line can use it.
     */
    const body = req.rawBody ?? Buffer.alloc(0);

    // req.url is the path WITH query, exactly as the canonical string requires
    // and exactly what the gateway already passes for product requests.
    const result = verifyRequest(
      secret,
      { method: req.method, path: req.url, timestamp, nonce, body },
      signature,
    );

    if (!result.ok) {
      const code =
        result.reason === 'timestamp_out_of_window'
          ? 'timestamp_out_of_window'
          : 'signature_invalid';
      reject(req, code, result.reason);
    }

    // Only now: a nonce burned by an unverified request would be a free
    // denial-of-service against the real worker.
    if (!rememberNonce(nonce)) reject(req, 'nonce_replayed', 'nonce_replayed');

    req.serviceId = serviceId;
  });
}
