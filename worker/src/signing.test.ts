import { describe, expect, it } from 'vitest';
import { verifyRequest } from '@iris/shared/hmac';
import { SERVICE_ID, signedHeaders } from './signing.js';
import { config } from './config.js';

/**
 * Worker-side signing.
 *
 * Every test here verifies with the SAME `verifyRequest` Core uses, so a
 * divergence between signer and verifier fails in this file rather than
 * becoming a two-hour mystery at an integration boundary.
 */

const SECRET = 'test_secret_for_worker_signing_0123456789';
const PATH = '/internal/ai/jobs/evt_TEST/input';
const BODY = JSON.stringify({ job_id: 'aij_1', feature: 'noop' });

const verify = (
  h: Record<string, string>,
  opts: { method?: string; path?: string; body?: string; secret?: string } = {},
) =>
  verifyRequest(
    opts.secret ?? SECRET,
    {
      method: opts.method ?? 'POST',
      path: opts.path ?? PATH,
      timestamp: h['x-iris-timestamp']!,
      nonce: h['x-iris-nonce']!,
      body: opts.body ?? BODY,
    },
    h['x-iris-signature'],
  );

describe('header construction', () => {
  it('emits exactly the four authentication headers', () => {
    const h = signedHeaders(SECRET, 'POST', PATH, BODY);
    expect(Object.keys(h).sort()).toEqual([
      'x-iris-nonce',
      'x-iris-service-id',
      'x-iris-signature',
      'x-iris-timestamp',
    ]);
  });

  it('identifies the service as `worker`', () => {
    expect(signedHeaders(SECRET, 'POST', PATH, BODY)['x-iris-service-id']).toBe('worker');
    expect(SERVICE_ID).toBe('worker');
  });

  it('uses a current unix-seconds timestamp', () => {
    const now = Math.floor(Date.now() / 1000);
    const ts = Number(signedHeaders(SECRET, 'POST', PATH, BODY)['x-iris-timestamp']);
    expect(Number.isInteger(ts)).toBe(true);
    // Seconds, not milliseconds — a ms value would be ~1000x out of window.
    expect(Math.abs(ts - now)).toBeLessThanOrEqual(2);
  });

  it('uses a UUID nonce', () => {
    const nonce = signedHeaders(SECRET, 'POST', PATH, BODY)['x-iris-nonce']!;
    expect(nonce).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('generates a fresh nonce on every call — otherwise every retry is a replay', () => {
    const seen = new Set(
      Array.from({ length: 50 }, () => signedHeaders(SECRET, 'POST', PATH, BODY)['x-iris-nonce']),
    );
    expect(seen.size).toBe(50);
  });

  it('emits the v1=<64 hex> signature form', () => {
    expect(signedHeaders(SECRET, 'POST', PATH, BODY)['x-iris-signature']).toMatch(
      /^v1=[a-f0-9]{64}$/,
    );
  });

  it('never leaks the secret into the headers', () => {
    const serialised = JSON.stringify(signedHeaders(SECRET, 'POST', PATH, BODY));
    expect(serialised).not.toContain(SECRET);
  });
});

describe('signatures verify against the shared verifier', () => {
  it('a signed request verifies', () => {
    expect(verify(signedHeaders(SECRET, 'POST', PATH, BODY)).ok).toBe(true);
  });

  it('an empty body verifies — sha256("") is well defined', () => {
    const h = signedHeaders(SECRET, 'GET', '/internal/ai/health', '');
    expect(
      verify(h, { method: 'GET', path: '/internal/ai/health', body: '' }).ok,
    ).toBe(true);
  });

  it('a body with non-ASCII characters verifies (UTF-8 bytes, not chars)', () => {
    const body = JSON.stringify({ note: 'Rapport trimestriel — échec ✅' });
    expect(verify(signedHeaders(SECRET, 'POST', PATH, body), { body }).ok).toBe(true);
  });
});

describe('the signature binds method, path and body', () => {
  it('a different body produces a different signature', () => {
    const a = signedHeaders(SECRET, 'POST', PATH, BODY);
    const b = signedHeaders(SECRET, 'POST', PATH, `${BODY} `);
    expect(a['x-iris-signature']).not.toBe(b['x-iris-signature']);
  });

  it('a different path produces a different signature', () => {
    const a = signedHeaders(SECRET, 'POST', PATH, BODY);
    const b = signedHeaders(SECRET, 'POST', PATH.replace('input', 'result'), BODY);
    expect(a['x-iris-signature']).not.toBe(b['x-iris-signature']);
  });

  it('a different method produces a different signature', () => {
    const a = signedHeaders(SECRET, 'POST', PATH, BODY);
    const b = signedHeaders(SECRET, 'PUT', PATH, BODY);
    expect(a['x-iris-signature']).not.toBe(b['x-iris-signature']);
  });

  it('a signature for one path does NOT verify against another', () => {
    const h = signedHeaders(SECRET, 'POST', PATH, BODY);
    expect(verify(h, { path: PATH.replace('input', 'result') }).ok).toBe(false);
  });

  it('a signature does NOT verify against a modified body', () => {
    const h = signedHeaders(SECRET, 'POST', PATH, BODY);
    expect(verify(h, { body: BODY.replace('noop', 'summary') }).ok).toBe(false);
  });

  it('a signature does NOT verify under a different secret', () => {
    const h = signedHeaders(SECRET, 'POST', PATH, BODY);
    expect(verify(h, { secret: 'a-different-secret-entirely' }).ok).toBe(false);
  });

  it('a signature does NOT verify against a different method', () => {
    const h = signedHeaders(SECRET, 'POST', PATH, BODY);
    expect(verify(h, { method: 'GET' }).ok).toBe(false);
  });
});

describe('serialise once, sign it, send it', () => {
  it('takes an already-serialised body, so the caller cannot send unsigned bytes', () => {
    // The API shape is the guarantee: signedHeaders never serialises, so the
    // string it signs is necessarily the string the caller has in hand to send.
    const serialised = JSON.stringify({ b: 2, a: 1 });
    const h = signedHeaders(SECRET, 'POST', PATH, serialised);
    expect(verify(h, { body: serialised }).ok).toBe(true);

    // A re-serialisation with different key order is a DIFFERENT body and must
    // not verify — which is exactly the bug this API shape prevents.
    const reordered = JSON.stringify({ a: 1, b: 2 });
    expect(reordered).not.toBe(serialised);
    expect(verify(h, { body: reordered }).ok).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Phase 2 acceptance criterion
// ─────────────────────────────────────────────────────────────────────────

describe('the worker holds no platform-wide credential', () => {
  it('INTERNAL_API_KEY is absent from the resolved worker config', () => {
    // The Phase 1 defect in one assertion. INTERNAL_API_KEY is the gateway's
    // credential and core-service accepts it on EVERY route; holding it let a
    // compromised worker read any tenant's tickets and reach the admin API as
    // super_admin. Verified live before the fix.
    expect(config).not.toHaveProperty('INTERNAL_API_KEY');
  });

  it('AI_SERVICE_KEY (the old bearer token) is gone too', () => {
    expect(config).not.toHaveProperty('AI_SERVICE_KEY');
  });

  it('holds exactly the two narrow HMAC secrets it needs', () => {
    expect(config).toHaveProperty('AI_WORKER_HMAC_SECRET');
    expect(config).toHaveProperty('AI_SERVICE_HMAC_SECRET');
    // Separate values: leaking the Python-facing secret must not grant Core access.
    expect(config.AI_WORKER_HMAC_SECRET).not.toBe(config.AI_SERVICE_HMAC_SECRET);
  });

  it('holds no database credential either (Phase 1 invariant, still true)', () => {
    for (const key of Object.keys(config)) {
      expect(key).not.toMatch(/DATABASE_URL/);
    }
  });
});
