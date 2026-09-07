import { createHash } from 'node:crypto';

/**
 * Canonical request string — docs/api-contract.md §3.1.
 *
 *   v1 \n METHOD \n PATH_WITH_QUERY \n TIMESTAMP \n NONCE \n sha256_hex(RAW_BODY)
 *
 * Two deliberate properties:
 *  - We hash the body rather than signing it directly, so large uploads stream
 *    and body encoding never matters.
 *  - Method and path are INSIDE the signature, so a captured request cannot be
 *    replayed against a different endpoint.
 */
export const SIGNATURE_VERSION = 'v1';

export function sha256Hex(body: string | Buffer): string {
  return createHash('sha256')
    .update(typeof body === 'string' ? Buffer.from(body, 'utf8') : body)
    .digest('hex');
}

export interface CanonicalParts {
  method: string;
  path: string;
  timestamp: number | string;
  nonce: string;
  body?: string | Buffer;
}

export function buildCanonicalString(p: CanonicalParts): string {
  return [
    SIGNATURE_VERSION,
    p.method.toUpperCase(),
    p.path,
    String(p.timestamp),
    p.nonce,
    sha256Hex(p.body ?? ''),
  ].join('\n');
}

/** Webhook signing is Stripe-style — `{timestamp}.{raw_body}` — §6.3. */
export function buildWebhookPayload(timestamp: number | string, rawBody: string): string {
  return `${timestamp}.${rawBody}`;
}
