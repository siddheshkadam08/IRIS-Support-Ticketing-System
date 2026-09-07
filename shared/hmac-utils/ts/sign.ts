import { createHmac } from 'node:crypto';
import { buildCanonicalString, buildWebhookPayload, type CanonicalParts } from './canonical.js';

/**
 * Sign an outbound API request. Used by the gateway's own tests and by any
 * integrating product's server. Never reimplement this elsewhere — a
 * divergence between signer and verifier should be a failing test, not a
 * two-hour mystery at 2am.
 */
export function signRequest(secret: string, parts: CanonicalParts): string {
  return createHmac('sha256', secret).update(buildCanonicalString(parts), 'utf8').digest('hex');
}

/** Sign an outbound webhook body (platform → product). */
export function signWebhook(secret: string, timestamp: number | string, rawBody: string): string {
  return createHmac('sha256', secret)
    .update(buildWebhookPayload(timestamp, rawBody), 'utf8')
    .digest('hex');
}

/** The `X-IRIS-Signature` header value for a request. */
export function requestSignatureHeader(secret: string, parts: CanonicalParts): string {
  return `v1=${signRequest(secret, parts)}`;
}

/** The `X-IRIS-Signature` header value for a webhook. */
export function webhookSignatureHeader(
  secret: string,
  timestamp: number | string,
  rawBody: string,
): string {
  return `t=${timestamp},v1=${signWebhook(secret, timestamp, rawBody)}`;
}
