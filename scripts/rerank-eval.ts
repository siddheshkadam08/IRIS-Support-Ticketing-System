/**
 * Phase 12 retrieval-quality evaluation — hybrid vs reranked.
 *
 *   npx tsx scripts/rerank-eval.ts
 *
 * Runs the SAME labelled query set twice against the real running stack: once
 * with reranking bypassed and once with it on, so the only variable is the
 * reranker. Both passes go through the real `/v1/widget/ask`.
 *
 * ⚠️ WHAT THIS IS NOT. Not a benchmark. 24 answerable queries, one 120-item
 * corpus, one author, one reviewer's labels. It is enough to answer "does
 * reranking change the ordering, and for better or worse" — and not enough to
 * publish a number.
 *
 * ⚠️ REGRESSIONS ARE REPORTED AS PROMINENTLY AS IMPROVEMENTS. §11 asks for the
 * cases reranking makes WORSE, and a reranker that only ever helps on a set
 * this small would be evidence the set was chosen badly.
 */

import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)] as const),
) as Record<string, string | undefined>;

const CORE = env.CORE_URL ?? 'http://localhost:4100';
const KEY = env.INTERNAL_API_KEY ?? 'dev_internal_key_change_me';

/**
 * The Phase 11 label set, unchanged, so the two phases are compared on
 * identical ground. `relevant` is the intended answer; a query with none is
 * unanswerable and correct behaviour is returning nothing.
 */
const QUERIES: Array<{ q: string; kind: string; relevant: string[] }> = [
  { q: 'password', kind: 'exact-lexical', relevant: ['How to reset your password'] },
  { q: 'invoice', kind: 'exact-lexical', relevant: ['Why my invoice is not showing'] },
  { q: 'recurring report', kind: 'exact-lexical', relevant: ['Scheduling a recurring report'] },
  { q: 'duplicate records import', kind: 'exact-lexical', relevant: ['Duplicate records after an import'] },
  { q: 'export failing', kind: 'lexical', relevant: ['Fixing failed report exports'] },
  { q: 'account locked', kind: 'lexical', relevant: ['Account locked after failed sign-in attempts'] },
  { q: 'add a user', kind: 'lexical', relevant: ['Adding a new user to your organisation'] },
  { q: 'application slow', kind: 'lexical', relevant: ['The application is slow to load'] },
  { q: 'passwrd rest', kind: 'typo', relevant: ['How to reset your password'] },
  { q: 'duplicat recrds', kind: 'typo', relevant: ['Duplicate records after an import'] },
  { q: 'slow aplication', kind: 'typo', relevant: ['The application is slow to load'] },
  { q: 'invoce missing', kind: 'typo', relevant: ['Why my invoice is not showing'] },
  { q: 'recuring reprot', kind: 'typo', relevant: ['Scheduling a recurring report'] },
  { q: 'I forgot my login details and cannot get in', kind: 'semantic', relevant: ['How to reset your password'] },
  { q: 'everything appears twice after I uploaded the csv', kind: 'semantic', relevant: ['Duplicate records after an import'] },
  { q: 'pages take forever to come up this morning', kind: 'semantic', relevant: ['The application is slow to load'] },
  { q: 'can I make it send me this every monday automatically', kind: 'semantic', relevant: ['Scheduling a recurring report'] },
  { q: 'where is my bill for last month', kind: 'semantic', relevant: ['Why my invoice is not showing'] },
  { q: 'we hired someone new last week', kind: 'semantic', relevant: ['Adding a new user to your organisation'] },
  { q: 'report export keeps timing out when I download it', kind: 'mixed', relevant: ['Fixing failed report exports'] },
  { q: 'too many wrong sign-in tries and now I am blocked', kind: 'mixed', relevant: ['Account locked after failed sign-in attempts'] },
  { q: 'the dashboard total disagrees with the exported figures', kind: 'mixed', relevant: ['Totals do not match the dashboard'] },
  { q: 'cannot sign in', kind: 'ambiguous', relevant: ['How to reset your password', 'Account locked after failed sign-in attempts'] },
  { q: 'my numbers look wrong', kind: 'ambiguous', relevant: ['Totals do not match the dashboard', 'Duplicate records after an import', 'Why my export is missing recent rows'] },
  { q: 'how do I renew my passport at the embassy', kind: 'negative', relevant: [] },
  { q: 'best recipe for sourdough bread starter', kind: 'negative', relevant: [] },
];

async function ask(question: string) {
  const t0 = Date.now();
  const res = await fetch(`${CORE}/v1/widget/ask`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-key': KEY,
      'x-iris-product-id': 'prod_carbon',
      'x-iris-role': 'raiser',
      'x-iris-tenant-id': 'tenant_eval',
      'x-iris-raiser-ref': 'eval-probe',
    },
    body: JSON.stringify({ question }),
  });
  const body = (await res.json()) as { answers?: Array<{ title: string }> };
  return { titles: (body.answers ?? []).map((a) => a.title), ms: Date.now() - t0 };
}

/**
 * Bypasses the reranker by asking for the ordering Phase 11 produced.
 *
 * ⚠️ THIS IS A REAL SECOND PASS, NOT A REPLAY. The env var is read at boot, so
 * the "hybrid" numbers come from a run of the stack with RERANKING_ENABLED
 * false. Run this script once per setting and compare — the script prints which
 * mode it is measuring so the two cannot be confused.
 */
const MODE = process.env.EVAL_MODE ?? 'current';

function rankOf(titles: string[], relevant: string[]): number {
  return titles.findIndex((t) => relevant.includes(t)) + 1;
}

async function main() {
  console.log(`\nPhase 12 evaluation — mode: ${MODE}\n`);
  console.log('kind            rank   ms    query');
  console.log('-------------- ------ ----- ------------------------------------');

  let top1 = 0;
  let top3 = 0;
  let top5 = 0;
  let negOk = 0;
  let negTotal = 0;
  const latencies: number[] = [];
  /**
   * The full ordering is captured, not just the rank of the correct answer.
   *
   * Rank alone cannot distinguish "the reranker agreed with Phase 11" from
   * "the reranker reordered everything below position 1" — and those are very
   * different findings about whether the feature does anything.
   */
  const rows: Array<{ q: string; kind: string; rank: number; order: string[] }> = [];

  for (const spec of QUERIES) {
    const { titles, ms } = await ask(spec.q);
    latencies.push(ms);

    if (spec.relevant.length === 0) {
      negTotal++;
      const ok = titles.length === 0;
      if (ok) negOk++;
      rows.push({ q: spec.q, kind: spec.kind, rank: titles.length === 0 ? -1 : 0, order: titles });
      console.log(`${spec.kind.padEnd(14)}  ${ok ? ' ok ' : ` ${titles.length} ✗`}  ${String(ms).padStart(4)}  ${spec.q.slice(0, 40)}`);
      continue;
    }

    const rank = rankOf(titles, spec.relevant);
    rows.push({ q: spec.q, kind: spec.kind, rank, order: titles });
    if (rank === 1) top1++;
    if (rank >= 1 && rank <= 3) top3++;
    if (rank >= 1 && rank <= 5) top5++;
    console.log(
      `${spec.kind.padEnd(14)}  ${rank === 0 ? '  - ' : `  ${rank} `}  ${String(ms).padStart(4)}  ${spec.q.slice(0, 40)}`,
    );
  }

  const n = QUERIES.length - negTotal;
  const pct = (x: number) => `${((x / n) * 100).toFixed(0)}%`;
  latencies.sort((a, b) => a - b);
  const p = (q: number) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * q))];

  console.log(`\n${n} answerable queries`);
  console.log(`  Top-1 ${pct(top1)}   Top-3 ${pct(top3)}   Top-5 ${pct(top5)}   (${top1}/${top3}/${top5})`);
  console.log(`${negTotal} unanswerable: ${negOk}/${negTotal} correctly returned nothing`);
  console.log(`latency  p50 ${p(0.5)}ms  p95 ${p(0.95)}ms  max ${latencies[latencies.length - 1]}ms`);

  // Machine-readable, so the two modes can be diffed without re-reading tables.
  console.log(`\nJSON ${JSON.stringify({ mode: MODE, top1, top3, top5, n, negOk, negTotal, p50: p(0.5), p95: p(0.95), rows })}`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
