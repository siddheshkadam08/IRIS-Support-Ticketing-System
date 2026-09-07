import { randomUUID } from 'node:crypto';
import { requestSignatureHeader } from '@iris/shared/hmac';

/**
 * Request signing for the worker's two outbound boundaries.
 *
 * One helper for both clients, so Core-facing and Python-facing requests
 * cannot drift into two subtly different signing schemes.
 *
 * WHY THE WORKER SIGNS AT ALL. Phase 1 authenticated with the platform-wide
 * INTERNAL_API_KEY — the same key the gateway holds, which core-service
 * accepts on every route. A compromised worker could therefore read any
 * tenant's tickets and reach the admin API as super_admin. The worker now
 * holds two narrow, directional secrets and no bearer token that works
 * anywhere else.
 *
 * The canonical string comes from shared/hmac-utils UNCHANGED. It is a
 * published integrator contract (docs/api-contract.md §3.3, vectors.json), so
 * reuse here is a compatibility requirement, not a convenience.
 */

export const SERVICE_ID = 'worker';

/**
 * Note the parameter: the body arrives ALREADY SERIALISED.
 *
 * That is the whole point of the signature. If this function took an object it
 * would serialise it a second time, and the caller would send bytes that were
 * never signed — key order and whitespace differ between serialisations, and
 * every request would fail verification for reasons that look like a crypto
 * bug. The API shape makes "serialise once, sign it, send it" the only
 * possible usage.
 */
export function signedHeaders(
  secret: string,
  method: string,
  path: string,
  serialisedBody: string,
): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = randomUUID();

  return {
    'x-iris-service-id': SERVICE_ID,
    'x-iris-timestamp': String(timestamp),
    'x-iris-nonce': nonce,
    // `v1=<64 lowercase hex>`; the secret itself never leaves this function.
    'x-iris-signature': requestSignatureHeader(secret, {
      method,
      path,
      timestamp,
      nonce,
      body: serialisedBody,
    }),
  };
}
