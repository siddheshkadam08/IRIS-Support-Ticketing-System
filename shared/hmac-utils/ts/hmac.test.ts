import { describe, expect, it } from 'vitest';
import vectors from '../vectors.json' with { type: 'json' };
import { buildCanonicalString, sha256Hex } from './canonical.js';
import { requestSignatureHeader, signRequest, signWebhook, webhookSignatureHeader } from './sign.js';
import { safeEqualHex, verifyRequest, verifyWebhook } from './verify.js';

const R = vectors.request_v1;
const W = vectors.webhook_v1;

/**
 * These vectors are PUBLISHED to integrators in docs/api-contract.md §3.3.
 * If one of these tests fails, we have broken every integrator's signing code.
 * Fix the implementation, never the vector.
 */
describe('published request vector', () => {
  it('body hashes to the documented sha256', () => {
    expect(sha256Hex(R.body)).toBe(R.body_sha256);
  });

  it('body is the documented byte length (UTF-8, em dash included)', () => {
    expect(Buffer.byteLength(R.body, 'utf8')).toBe(R.body_bytes);
  });

  it('builds the documented canonical string', () => {
    const canonical = buildCanonicalString({
      method: R.method,
      path: R.path,
      timestamp: R.timestamp,
      nonce: R.nonce,
      body: R.body,
    });
    expect(canonical).toBe(R.canonical);
    expect(canonical.split('\n')).toHaveLength(6);
  });

  it('produces the documented signature', () => {
    expect(
      signRequest(R.client_secret, {
        method: R.method,
        path: R.path,
        timestamp: R.timestamp,
        nonce: R.nonce,
        body: R.body,
      }),
    ).toBe(R.signature);
  });

  it('header form is v1=<sig>', () => {
    expect(
      requestSignatureHeader(R.client_secret, {
        method: R.method,
        path: R.path,
        timestamp: R.timestamp,
        nonce: R.nonce,
        body: R.body,
      }),
    ).toBe(`v1=${R.signature}`);
  });
});

describe('published webhook vector', () => {
  it('produces the documented signature', () => {
    expect(signWebhook(W.webhook_secret, W.timestamp, W.body)).toBe(W.signature);
  });

  it('header form is t=<ts>,v1=<sig>', () => {
    expect(webhookSignatureHeader(W.webhook_secret, W.timestamp, W.body)).toBe(
      `t=${W.timestamp},v1=${W.signature}`,
    );
  });
});

describe('verification', () => {
  const parts = {
    method: R.method,
    path: R.path,
    timestamp: R.timestamp,
    nonce: R.nonce,
    body: R.body,
  };
  // Vectors use a fixed timestamp, so pin "now" rather than skewing the window.
  const now = R.timestamp;

  it('accepts a valid signature inside the window', () => {
    expect(verifyRequest(R.client_secret, parts, `v1=${R.signature}`, { now })).toEqual({
      ok: true,
    });
  });

  it('rejects a tampered body', () => {
    const tampered = { ...parts, body: R.body.replace('high', 'low') };
    expect(verifyRequest(R.client_secret, tampered, `v1=${R.signature}`, { now })).toEqual({
      ok: false,
      reason: 'signature_invalid',
    });
  });

  it('rejects the same signature replayed against a different path', () => {
    const moved = { ...parts, path: '/v1/tickets/tkt_123/comments' };
    expect(verifyRequest(R.client_secret, moved, `v1=${R.signature}`, { now })).toEqual({
      ok: false,
      reason: 'signature_invalid',
    });
  });

  it('rejects the same signature replayed with a different method', () => {
    const moved = { ...parts, method: 'DELETE' };
    expect(verifyRequest(R.client_secret, moved, `v1=${R.signature}`, { now })).toEqual({
      ok: false,
      reason: 'signature_invalid',
    });
  });

  it('rejects a stale timestamp', () => {
    expect(verifyRequest(R.client_secret, parts, `v1=${R.signature}`, { now: now + 301 })).toEqual({
      ok: false,
      reason: 'timestamp_out_of_window',
    });
  });

  it('rejects a wrong secret', () => {
    expect(verifyRequest('sk_test_wrong', parts, `v1=${R.signature}`, { now })).toEqual({
      ok: false,
      reason: 'signature_invalid',
    });
  });

  it('rejects a missing or malformed header', () => {
    expect(verifyRequest(R.client_secret, parts, undefined, { now })).toEqual({
      ok: false,
      reason: 'malformed_signature',
    });
    expect(verifyRequest(R.client_secret, parts, 'garbage', { now })).toEqual({
      ok: false,
      reason: 'malformed_signature',
    });
  });

  it('verifies a webhook the way an integrating product would', () => {
    const header = webhookSignatureHeader(W.webhook_secret, W.timestamp, W.body);
    expect(verifyWebhook(W.webhook_secret, W.body, header, { now: W.timestamp })).toEqual({
      ok: true,
    });
  });

  it('rejects a webhook whose raw body was re-serialised', () => {
    const header = webhookSignatureHeader(W.webhook_secret, W.timestamp, W.body);
    const reserialised = JSON.stringify(JSON.parse(W.body), null, 2);
    expect(verifyWebhook(W.webhook_secret, reserialised, header, { now: W.timestamp })).toEqual({
      ok: false,
      reason: 'signature_invalid',
    });
  });
});

describe('safeEqualHex', () => {
  it('is length-safe and value-correct', () => {
    expect(safeEqualHex('abc', 'abc')).toBe(true);
    expect(safeEqualHex('abc', 'abd')).toBe(false);
    expect(safeEqualHex('abc', 'abcd')).toBe(false);
    expect(safeEqualHex('', '')).toBe(true);
  });
});
