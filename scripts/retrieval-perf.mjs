/**
 * Phase 11 performance measurement, against the running stack.
 *
 *   node scripts/retrieval-perf.mjs
 *
 * Measures the WHOLE user-facing path — HTTP in, embedding, three SQL
 * strategies, fusion, HTTP out — because that is the number a user experiences.
 * Per-strategy costs come from the service's own diagnostics, which are already
 * emitted for every request.
 *
 * The query kinds are separated deliberately: an exact identifier does an extra
 * indexed lookup, a negative query does the same work and returns nothing, and
 * a lexical-only query still pays for the embedding. Reporting one blended
 * number would hide all three.
 */

import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);

const CORE = env.CORE_URL ?? 'http://localhost:4100';
const KEY = env.INTERNAL_API_KEY ?? 'dev_internal_key_change_me';

async function ask(question, raiserRef = 'perf-probe') {
  const t0 = Date.now();
  const res = await fetch(`${CORE}/v1/widget/ask`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-key': KEY,
      'x-iris-product-id': 'prod_carbon',
      'x-iris-role': 'raiser',
      'x-iris-tenant-id': 'tenant_perf',
      'x-iris-raiser-ref': raiserRef,
    },
    body: JSON.stringify({ question }),
  });
  await res.json().catch(() => ({}));
  return Date.now() - t0;
}

const CASES = [
  ['exact identifier', 'CARB-1011', 'usr_seed_4'],
  ['lexical keyword', 'duplicate records import'],
  ['typo', 'passwrd rest'],
  ['semantic paraphrase', 'I forgot my login details and cannot get in'],
  ['mixed', 'report export keeps timing out when I download it'],
  ['no result', 'how do I renew my passport at the embassy'],
];

const N = 12;

function stats(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const p = (q) => s[Math.min(s.length - 1, Math.floor(s.length * q))];
  return { p50: p(0.5), p95: p(0.95), max: s[s.length - 1] };
}

async function main() {
  // The AI service pools its Azure connection for the process lifetime, so the
  // first call after a restart pays a TLS handshake. Warm it, and say so,
  // rather than reporting a cold outlier as p95.
  await ask('warm up the provider connection pool');

  console.log(`\nend-to-end /v1/widget/ask latency, n=${N} per case\n`);
  console.log('case                    p50     p95     max');
  console.log('--------------------  ------  ------  ------');

  const all = [];
  for (const [label, q, ref] of CASES) {
    const xs = [];
    for (let i = 0; i < N; i++) xs.push(await ask(q, ref));
    all.push(...xs);
    const s = stats(xs);
    console.log(
      `${label.padEnd(20)}  ${String(s.p50).padStart(4)}ms  ${String(s.p95).padStart(4)}ms  ${String(s.max).padStart(4)}ms`,
    );
  }
  const s = stats(all);
  console.log(`\nall cases combined    ${String(s.p50).padStart(4)}ms  ${String(s.p95).padStart(4)}ms  ${String(s.max).padStart(4)}ms   (n=${all.length})`);

  // Throughput under concurrency, to show the path holds up when several users
  // search at once — the embedding call is the only shared external dependency.
  const CONC = 8;
  const t0 = Date.now();
  await Promise.all(
    Array.from({ length: CONC * 3 }, (_, i) =>
      ask(CASES[i % CASES.length][1], CASES[i % CASES.length][2]),
    ),
  );
  const wall = Date.now() - t0;
  console.log(
    `\nconcurrency ${CONC}: ${CONC * 3} searches in ${wall}ms  ->  ${((CONC * 3) / (wall / 1000)).toFixed(1)} searches/s`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
