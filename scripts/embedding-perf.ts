/**
 * Phase 10 provider performance probe.
 *
 * Measures the embedding call through the REAL signed AI service at several
 * concurrency levels, so the numbers describe the deployed path rather than a
 * direct provider call.
 *
 *   npx tsx scripts/embedding-perf.ts
 *
 * WHY CONCURRENCY IS THE AXIS. Phase 5 recorded a "burst capacity limit" that
 * turned out to be a connection pool rebuilt per call — roughly four seconds
 * of TCP+TLS setup per request, which only became visible under concurrency.
 * The embedding transport is a second, separate httpx client, so it could have
 * reintroduced exactly that defect. A flat p50 as concurrency rises is the
 * evidence that it did not.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { requestSignatureHeader } from '@iris/shared/hmac';

const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)] as const),
) as Record<string, string>;

const AI_URL = env.AI_SERVICE_URL ?? 'http://localhost:5000';
const AI_SECRET = env.AI_SERVICE_HMAC_SECRET ?? 'dev_ai_service_hmac_secret_change_me';

const TEXT =
  'Payment transactions intermittently fail with HTTP 502 for roughly 30% of customers, ' +
  'beginning immediately after version 4.8.2 was deployed to the production cluster.';

async function once(): Promise<{ ms: number; ok: boolean; dim: number }> {
  const path = '/v1/execute';
  const body = JSON.stringify({
    feature: 'embedding',
    request_id: `perf_${randomUUID()}`,
    input: { subject: null, description: TEXT },
  });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomUUID();
  const t0 = Date.now();
  const res = await fetch(`${AI_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-iris-service-id': 'worker',
      'x-iris-timestamp': timestamp,
      'x-iris-nonce': nonce,
      'x-iris-signature': requestSignatureHeader(AI_SECRET, {
        method: 'POST',
        path,
        timestamp,
        nonce,
        body: Buffer.from(body, 'utf8'),
      }),
    },
    body,
  });
  const ms = Date.now() - t0;
  if (!res.ok) return { ms, ok: false, dim: 0 };
  const json = (await res.json()) as { data: { vector: number[] } };
  return { ms, ok: true, dim: json.data.vector.length };
}

async function level(concurrency: number, total: number) {
  const results: Array<{ ms: number; ok: boolean; dim: number }> = [];
  let cursor = 0;
  const t0 = Date.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (;;) {
        if (cursor++ >= total) return;
        results.push(await once());
      }
    }),
  );
  const wall = Date.now() - t0;
  const ok = results.filter((r) => r.ok);
  const lat = ok.map((r) => r.ms).sort((a, b) => a - b);
  const p = (q: number) => lat[Math.min(lat.length - 1, Math.floor(lat.length * q))] ?? 0;

  console.log(
    `  concurrency ${String(concurrency).padStart(2)}  ` +
      `n=${results.length}  ok=${ok.length}  ` +
      `p50 ${String(p(0.5)).padStart(5)}ms  p95 ${String(p(0.95)).padStart(5)}ms  ` +
      `max ${String(p(1)).padStart(5)}ms  ` +
      `throughput ${(ok.length / (wall / 1000)).toFixed(2)}/s  ` +
      `dims ${new Set(ok.map((r) => r.dim)).size === 1 ? ok[0]?.dim : 'MIXED'}`,
  );
}

async function main(): Promise<void> {
  console.log('\nembedding latency through the signed AI service\n');
  // A warm-up so the first measured level is not paying for the pooled
  // client's very first TLS handshake — that cost is real but one-off, and
  // attributing it to concurrency-1 would misreport the steady state.
  await once();
  for (const c of [1, 4, 8, 16]) await level(c, Math.max(12, c * 2));
  console.log('');
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
