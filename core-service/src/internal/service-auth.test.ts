import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { requestSignatureHeader, signRequest } from '@iris/shared/hmac';
import { newId } from '@iris/shared/types';
import { buildServer } from '../server.js';
import { config } from '../config.js';
import { closePool } from '../db/pool.js';
import { withSystemScope } from '../db/with-scope.js';

/**
 * Service authentication for /internal/*, exercised through the REAL server.
 *
 * These go through app.inject rather than calling the hook directly, because
 * the thing worth testing is the whole path — scoped parser, hook ordering,
 * raw bytes, error mapping — not a function in isolation. A unit test of
 * verifyRequest would prove only that shared/hmac-utils works, which its own
 * 42 tests already do.
 *
 * Every test uses a fresh UUID nonce except the deliberate replay case, since
 * the nonce cache is process-wide by design.
 */

const PRODUCT = 'prod_carbon';
const SECRET = () => config.AI_WORKER_HMAC_SECRET;

let app: Awaited<ReturnType<typeof buildServer>>;
let eventId: string;
let ticketId: string;

interface SignOpts {
  method?: string;
  path?: string;
  body?: string;
  secret?: string;
  timestamp?: number | string;
  nonce?: string;
  serviceId?: string | null;
  /** Signature header override, for malformed-header cases. */
  signature?: string | null;
}

/**
 * Builds headers, signing whatever it is told to sign. Every tamper test works
 * by signing one thing and sending another.
 */
function headers(opts: SignOpts = {}): Record<string, string> {
  const method = opts.method ?? 'POST';
  const path = opts.path ?? inputPath();
  const body = opts.body ?? '';
  const timestamp = opts.timestamp ?? Math.floor(Date.now() / 1000);
  const nonce = opts.nonce ?? randomUUID();
  const secret = opts.secret ?? SECRET();

  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.serviceId !== null) h['x-iris-service-id'] = opts.serviceId ?? 'worker';
  h['x-iris-timestamp'] = String(timestamp);
  h['x-iris-nonce'] = nonce;
  if (opts.signature !== null) {
    h['x-iris-signature'] =
      opts.signature ?? requestSignatureHeader(secret, { method, path, timestamp, nonce, body });
  }
  return h;
}

const inputPath = () => `/internal/ai/jobs/${eventId}/input`;

const claimsBody = () =>
  JSON.stringify({
    job_id: newId('aij'),
    feature: 'noop',
    attempt: 1,
    correlation_id: 'req_svcauth',
    claimed_product_id: PRODUCT,
    claimed_ticket_id: ticketId,
  });

/** Sends exactly `body` as bytes, with headers built by the caller. */
const send = (h: Record<string, string>, body: string, path = inputPath(), method = 'POST') =>
  app.inject({ method: method as 'POST', url: path, headers: h, payload: body });

beforeAll(async () => {
  app = await buildServer();
  await app.ready();

  const res = await app.inject({
    method: 'POST',
    url: '/v1/tickets',
    headers: {
      'x-internal-key': config.INTERNAL_API_KEY,
      'content-type': 'application/json',
      'x-iris-product-id': PRODUCT,
      'x-iris-role': 'product',
      'x-iris-tenant-id': 'tenant_svcauth',
    },
    payload: { subject: 'svcauth', description: 'service auth fixture' },
  });
  ticketId = res.json().id;
  eventId = await withSystemScope('test', async (tx) => {
    const { rows } = await tx.query<{ event_id: string }>(
      `SELECT event_id FROM event_outbox WHERE aggregate_id = $1 AND event_type = 'ticket.created'`,
      [ticketId],
    );
    return rows[0]!.event_id;
  });
});

afterAll(async () => {
  await app.close();
  await closePool();
});

// ─────────────────────────────────────────────────────────────────────────

describe('valid signature', () => {
  it('accepts a correctly signed request', async () => {
    const body = claimsBody();
    const res = await send(headers({ body }), body);
    expect(res.statusCode, res.body).toBe(200);
  });
});

describe('signature tampering', () => {
  it('rejects a wrong secret', async () => {
    const body = claimsBody();
    const res = await send(headers({ body, secret: 'a-completely-different-secret' }), body);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('signature_invalid');
  });

  it('rejects a tampered body — sign one payload, send another', async () => {
    const signed = claimsBody();
    const sent = claimsBody(); // different job_id ⇒ different bytes
    const res = await send(headers({ body: signed }), sent);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('signature_invalid');
  });

  it('rejects a single flipped byte in the body', async () => {
    const body = claimsBody();
    const res = await send(headers({ body }), body.replace('noop', 'noOp'));
    expect(res.statusCode).toBe(401);
  });

  it('rejects a tampered path — a signature is bound to its endpoint', async () => {
    const body = claimsBody();
    const h = headers({ body, path: inputPath() });
    const res = await send(h, body, `/internal/ai/jobs/${eventId}/result`);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('signature_invalid');
  });

  it('rejects a tampered method', async () => {
    const h = headers({ body: '', method: 'GET' });
    const res = await send(h, '', inputPath(), 'POST');
    expect(res.statusCode).toBe(401);
  });

  it('rejects a tampered timestamp — signed value differs from the header', async () => {
    const body = claimsBody();
    const now = Math.floor(Date.now() / 1000);
    const nonce = randomUUID();
    const h = headers({ body, timestamp: now, nonce });
    h['x-iris-timestamp'] = String(now - 5); // inside the window, but not what was signed
    const res = await send(h, body);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('signature_invalid');
  });

  it('rejects a tampered nonce', async () => {
    const body = claimsBody();
    const h = headers({ body });
    h['x-iris-nonce'] = randomUUID();
    const res = await send(h, body);
    expect(res.statusCode).toBe(401);
  });

  it('rejects a truncated signature', async () => {
    const body = claimsBody();
    const h = headers({ body });
    h['x-iris-signature'] = h['x-iris-signature']!.slice(0, -2);
    const res = await send(h, body);
    expect(res.statusCode).toBe(401);
  });
});

describe('missing and malformed headers', () => {
  const cases: Array<[string, () => Record<string, string>, string]> = [
    ['missing service id', () => headers({ serviceId: null }), 'unauthenticated'],
    ['unknown service id', () => headers({ serviceId: 'gateway' }), 'unauthenticated'],
    ['empty service id', () => headers({ serviceId: '' }), 'unauthenticated'],
    [
      'missing timestamp',
      () => {
        const h = headers();
        delete h['x-iris-timestamp'];
        return h;
      },
      'timestamp_out_of_window',
    ],
    [
      'malformed timestamp',
      () => {
        const h = headers();
        h['x-iris-timestamp'] = 'not-a-number';
        return h;
      },
      'timestamp_out_of_window',
    ],
    [
      'missing nonce',
      () => {
        const h = headers();
        delete h['x-iris-nonce'];
        return h;
      },
      'signature_invalid',
    ],
    [
      'malformed nonce',
      () => {
        const h = headers();
        h['x-iris-nonce'] = 'sh rt';
        return h;
      },
      'signature_invalid',
    ],
    ['missing signature', () => headers({ signature: null }), 'signature_invalid'],
    ['malformed signature (no v1= prefix)', () => headers({ signature: 'abc123' }), 'signature_invalid'],
    [
      'malformed signature (not hex)',
      () => headers({ signature: `v1=${'z'.repeat(64)}` }),
      'signature_invalid',
    ],
    [
      'malformed signature (wrong length)',
      () => headers({ signature: `v1=${'a'.repeat(63)}` }),
      'signature_invalid',
    ],
  ];

  for (const [name, build, code] of cases) {
    it(`rejects: ${name}`, async () => {
      const res = await send(build(), claimsBody());
      expect(res.statusCode, name).toBe(401);
      expect(res.json().error.code, name).toBe(code);
    });
  }
});

describe('timestamp window', () => {
  it('rejects an expired timestamp', async () => {
    const body = claimsBody();
    const res = await send(headers({ body, timestamp: Math.floor(Date.now() / 1000) - 400 }), body);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('timestamp_out_of_window');
  });

  it('rejects a future timestamp — a clock set forward is not a free pass', async () => {
    const body = claimsBody();
    const res = await send(headers({ body, timestamp: Math.floor(Date.now() / 1000) + 400 }), body);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('timestamp_out_of_window');
  });

  it('accepts a timestamp near the edge of the window', async () => {
    const body = claimsBody();
    const res = await send(headers({ body, timestamp: Math.floor(Date.now() / 1000) - 290 }), body);
    expect(res.statusCode).toBe(200);
  });
});

describe('replay', () => {
  it('accepts a nonce once and rejects the identical request the second time', async () => {
    const body = claimsBody();
    const nonce = randomUUID();
    const h = headers({ body, nonce });

    const first = await send({ ...h }, body);
    expect(first.statusCode, first.body).toBe(200);

    // Byte-identical replay: same signature, same nonce, same body.
    const second = await send({ ...h }, body);
    expect(second.statusCode).toBe(401);
    expect(second.json().error.code).toBe('nonce_replayed');
  });

  it('does not burn a nonce when the signature is invalid', async () => {
    // An attacker must not be able to lock the real worker out of a nonce by
    // sending garbage — which is why the nonce is recorded only after the
    // signature verifies.
    const body = claimsBody();
    const nonce = randomUUID();

    const bad = await send(headers({ body, nonce, secret: 'wrong-secret' }), body);
    expect(bad.statusCode).toBe(401);

    const good = await send(headers({ body, nonce }), body);
    expect(good.statusCode, 'the nonce must still be usable').toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Raw body — the highest-value tests in this file
// ─────────────────────────────────────────────────────────────────────────

describe('raw bytes are hashed, not a re-serialisation', () => {
  /**
   * Each body below survives a JSON round trip differently. If Core ever
   * verified against JSON.stringify(JSON.parse(body)) instead of the received
   * bytes, these would fail — which is exactly the bug they exist to catch.
   */
  /**
   * Built INSIDE each test, not at collection time: `ticketId` and `eventId`
   * are only set in beforeAll, and a fixture captured at module load would
   * silently sign `undefined`.
   */
  const variants: Array<[string, () => string]> = [
    [
      'unusual key ordering',
      () => {
        const b = JSON.parse(claimsBody()) as Record<string, unknown>;
        return JSON.stringify({
          claimed_ticket_id: b.claimed_ticket_id,
          feature: b.feature,
          claimed_product_id: b.claimed_product_id,
          correlation_id: b.correlation_id,
          attempt: b.attempt,
          job_id: b.job_id,
        });
      },
    ],
    ['pretty-printed whitespace', () => JSON.stringify(JSON.parse(claimsBody()), null, 2)],
    [
      'whitespace after colons and commas',
      () => {
        const b = JSON.parse(claimsBody()) as Record<string, unknown>;
        return `{"job_id": "${b.job_id}",  "feature": "noop", "attempt": 1,
          "correlation_id": "${b.correlation_id}", "claimed_product_id": "${b.claimed_product_id}",
          "claimed_ticket_id": "${b.claimed_ticket_id}"}`;
      },
    ],
  ];

  for (const [name, make] of variants) {
    it(`verifies a body with ${name}`, async () => {
      const body = make();
      // Guard the premise: if re-serialisation produced identical bytes the
      // test would prove nothing about raw-byte hashing.
      if (name !== 'unusual key ordering') {
        expect(JSON.stringify(JSON.parse(body))).not.toBe(body);
      }
      const res = await send(headers({ body }), body);
      expect(res.statusCode, res.body).toBe(200);
    });
  }

  it('verifies a non-ASCII body — byte length, not character length', async () => {
    // The em dash is 3 bytes in UTF-8 but 1 character. Hashing the string
    // length instead of the bytes would break here, as would latin-1.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tickets',
      headers: {
        'x-internal-key': config.INTERNAL_API_KEY,
        'content-type': 'application/json',
        'x-iris-product-id': PRODUCT,
        'x-iris-role': 'product',
        'x-iris-tenant-id': 'tenant_svcauth',
      },
      payload: { subject: 'unicode', description: 'Rapport trimestriel — échec de l’export ✅' },
    });
    const uniTicket = res.json().id as string;
    const uniEvent = await withSystemScope('test', async (tx) => {
      const { rows } = await tx.query<{ event_id: string }>(
        `SELECT event_id FROM event_outbox WHERE aggregate_id = $1 AND event_type = 'ticket.created'`,
        [uniTicket],
      );
      return rows[0]!.event_id;
    });

    const path = `/internal/ai/jobs/${uniEvent}/input`;
    const body = JSON.stringify({
      job_id: newId('aij'),
      feature: 'noop',
      attempt: 1,
      correlation_id: 'réq_unicode—✅',
      claimed_product_id: PRODUCT,
      claimed_ticket_id: uniTicket,
    });
    expect(Buffer.byteLength(body, 'utf8')).toBeGreaterThan(body.length);

    const out = await send(headers({ body, path }), body, path);
    expect(out.statusCode, out.body).toBe(200);
  });
});

describe('the scoped parser does not leak out of /internal', () => {
  it('POST /v1/tickets still receives a normally parsed JSON object', async () => {
    // If the raw-buffer parser were global, this route would receive a Buffer
    // and every non-internal endpoint in the platform would break.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tickets',
      headers: {
        'x-internal-key': config.INTERNAL_API_KEY,
        'content-type': 'application/json',
        'x-iris-product-id': PRODUCT,
        'x-iris-role': 'product',
        'x-iris-tenant-id': 'tenant_parser',
      },
      payload: { subject: 'parser check', description: 'must still parse normally' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().subject).toBe('parser check');
  });

  it('and /v1/tickets still rejects an unsigned caller as before', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/tickets' });
    expect(res.statusCode).toBe(401);
  });
});

describe('canonical string compatibility', () => {
  it('matches the published vector construction exactly', () => {
    // Locks Phase 2 to the SAME canonical form as the published integrator
    // contract. If someone "improves" it, this fails before anything ships.
    const sig = signRequest('sk_test_51H9xQmKvB2nRtYwLpZaCdEfG', {
      method: 'POST',
      path: '/v1/tickets',
      timestamp: 1774483200,
      nonce: '5f2b8c1a-9d3e-4a7b-8c6f-2e1d0a9b8c7d',
      body: '{"product_tenant_id":"acme-corp","description":"Cannot export the Q3 emissions report — the download button returns a 500.","category":"bug","severity":"high"}',
    });
    expect(sig).toBe('194eb588b7ad9e06cc477a5de3df4c06ae875d3c558dfa70d6465d65e1a293fb');
  });
});
