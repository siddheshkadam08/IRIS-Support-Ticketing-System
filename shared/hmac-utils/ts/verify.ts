import { timingSafeEqual } from 'node:crypto';
import { type CanonicalParts } from './canonical.js';
import { signRequest, signWebhook } from './sign.js';

/** Default replay window, ±300s — docs/api-contract.md §3.2. */
export const TIMESTAMP_WINDOW_SECONDS = 300;

/**
 * Constant-time comparison. A `===` on a signature is a timing oracle, so this
 * is not optional styling — it is the reason the function exists.
 */
export function safeEqualHex(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export type VerifyFailure =
  | 'signature_invalid'
  | 'timestamp_out_of_window'
  | 'malformed_signature';

export type VerifyResult = { ok: true } | { ok: false; reason: VerifyFailure };

/** Strips an optional `v1=` prefix. */
export function parseRequestSignature(header: string | undefined): string | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (trimmed.startsWith('v1=')) return trimmed.slice(3);
  if (/^[a-f0-9]{64}$/i.test(trimmed)) return trimmed;
  return null;
}

/** Parses the Stripe-style `t=...,v1=...` webhook header. */
export function parseWebhookSignature(
  header: string | undefined,
): { timestamp: string; signature: string } | null {
  if (!header) return null;
  const parts = header.split(',').map((s) => s.trim());
  let timestamp: string | undefined;
  let signature: string | undefined;
  for (const part of parts) {
    const [k, v] = part.split('=', 2);
    if (k === 't') timestamp = v;
    if (k === 'v1') signature = v;
  }
  if (!timestamp || !signature) return null;
  return { timestamp, signature };
}

export function isTimestampFresh(
  timestamp: number | string,
  nowSeconds = Math.floor(Date.now() / 1000),
  windowSeconds = TIMESTAMP_WINDOW_SECONDS,
): boolean {
  const ts = typeof timestamp === 'string' ? Number(timestamp) : timestamp;
  if (!Number.isFinite(ts)) return false;
  return Math.abs(nowSeconds - ts) <= windowSeconds;
}

/**
 * Verify an inbound API request signature.
 * Nonce replay is checked separately by the caller (it needs Redis); this is
 * the pure, testable half.
 */
export function verifyRequest(
  secret: string,
  parts: CanonicalParts,
  signatureHeader: string | undefined,
  opts: { now?: number; windowSeconds?: number } = {},
): VerifyResult {
  const provided = parseRequestSignature(signatureHeader);
  if (!provided) return { ok: false, reason: 'malformed_signature' };
  if (!isTimestampFresh(parts.timestamp, opts.now, opts.windowSeconds)) {
    return { ok: false, reason: 'timestamp_out_of_window' };
  }
  const expected = signRequest(secret, parts);
  return safeEqualHex(expected, provided) ? { ok: true } : { ok: false, reason: 'signature_invalid' };
}

/**
 * Verify an inbound webhook (this is what an INTEGRATING PRODUCT runs).
 * Must be given the raw body bytes, before any JSON parsing — re-serialising
 * changes whitespace and key order and every signature then fails.
 */
export function verifyWebhook(
  secret: string,
  rawBody: string,
  signatureHeader: string | undefined,
  opts: { now?: number; windowSeconds?: number } = {},
): VerifyResult {
  const parsed = parseWebhookSignature(signatureHeader);
  if (!parsed) return { ok: false, reason: 'malformed_signature' };
  if (!isTimestampFresh(parsed.timestamp, opts.now, opts.windowSeconds)) {
    return { ok: false, reason: 'timestamp_out_of_window' };
  }
  const expected = signWebhook(secret, parsed.timestamp, rawBody);
  return safeEqualHex(expected, parsed.signature)
    ? { ok: true }
    : { ok: false, reason: 'signature_invalid' };
}
