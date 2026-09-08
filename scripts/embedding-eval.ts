/**
 * Phase 10 retrieval evaluation and tenant-isolation probe.
 *
 * A VALIDATION HARNESS, not part of the running system. It goes through the
 * real signed AI service for every query embedding — no direct provider calls,
 * no reimplemented signing — so what it measures is the deployed path.
 *
 *   npx tsx scripts/embedding-eval.ts
 *
 * ⚠️ WHAT THIS IS NOT. It is not a benchmark. The corpus is 120 items, the
 * queries are hand-written by one person, and the ground truth is one
 * reviewer's judgement of which article answers which question. It is enough
 * to tell "retrieval works" from "retrieval is broken", and enough to compare
 * two rankers on the same 20 questions. It is not enough to publish a number.
 *
 * THE CORPUS HAS A PROPERTY THAT MAKES THE ISOLATION TEST UNUSUALLY STRONG:
 * the same 12 KB articles exist in all four products with byte-identical text,
 * so their vectors are identical too. Every product's copy sits at exactly the
 * same distance from any query. Nothing about the vectors can separate them —
 * only the tenant predicate can. A missing predicate would not degrade the
 * result, it would return an arbitrary tenant's row.
 */

import pg from 'pg';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { requestSignatureHeader } from '@iris/shared/hmac';

const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)] as const),
) as Record<string, string>;

const AI_URL = env.AI_SERVICE_URL ?? 'http://localhost:5000';
const AI_SECRET = env.AI_SERVICE_HMAC_SECRET ?? 'dev_ai_service_hmac_secret_change_me';

/**
 * Query -> the KB article TITLE that answers it.
 *
 * Deliberately paraphrases rather than titles. Asking "How to reset your
 * password" and being handed "How to reset your password" measures string
 * matching, which full-text search already does perfectly and which tells us
 * nothing about embeddings. These are phrased as a frustrated user would
 * phrase them, several with no lexical overlap with the target at all —
 * "nothing happens when I click the big green button" shares no content word
 * with "Fixing failed report exports".
 */
const QUERIES: Array<{ q: string; expect: string }> = [
  { q: 'I forgot my login details and cannot get in', expect: 'How to reset your password' },
  { q: 'too many wrong tries and now it will not let me sign in', expect: 'Account locked after failed sign-in attempts' },
  { q: 'need to give my colleague access to our account', expect: 'Adding a new user to your organisation' },
  { q: 'downloading the spreadsheet keeps failing halfway', expect: 'Fixing failed report exports' },
  { q: 'can I make it send me this every monday automatically', expect: 'Scheduling a recurring report' },
  { q: 'the numbers I pulled yesterday are not in the file', expect: 'Why my export is missing recent rows' },
  { q: 'the sum on screen disagrees with what I downloaded', expect: 'Totals do not match the dashboard' },
  { q: 'everything appears twice after I uploaded the csv', expect: 'Duplicate records after an import' },
  { q: 'pages take forever to come up this morning', expect: 'The application is slow to load' },
  { q: 'it spins and dies when I submit a long form', expect: 'Timeouts when saving large forms' },
  { q: 'where is my bill for last month', expect: 'Why my invoice is not showing' },
  { q: 'how do I contact someone about a problem', expect: 'Getting help and raising a ticket' },
  // Harder: no lexical overlap with the target title at all.
  { q: 'nothing happens when I click the big green button to get my data out', expect: 'Fixing failed report exports' },
  { q: 'my account says it is disabled', expect: 'Account locked after failed sign-in attempts' },
  { q: 'we hired someone new last week', expect: 'Adding a new user to your organisation' },
  { q: 'figures are double counted', expect: 'Duplicate records after an import' },
  { q: 'system is unusably sluggish', expect: 'The application is slow to load' },
  { q: 'set up an automatic weekly summary', expect: 'Scheduling a recurring report' },
  { q: 'billing document missing from my portal', expect: 'Why my invoice is not showing' },
  { q: 'the page just hangs when I press save on a big entry', expect: 'Timeouts when saving large forms' },
];

const PRODUCT = 'prod_carbon';

async function embed(text: string): Promise<number[]> {
  const path = '/v1/execute';
  const body = JSON.stringify({
    feature: 'embedding',
    request_id: `eval_${randomUUID()}`,
    input: { subject: null, description: text },
  });

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomUUID();
  const signature = requestSignatureHeader(AI_SECRET, {
    method: 'POST',
    path,
    timestamp,
    nonce,
    body: Buffer.from(body, 'utf8'),
  });

  const res = await fetch(`${AI_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-iris-service-id': 'worker',
      'x-iris-timestamp': timestamp,
      'x-iris-nonce': nonce,
      'x-iris-signature': signature,
    },
    body,
  });
  if (!res.ok) throw new Error(`embed failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { data: { vector: number[] } };
  return json.data.vector;
}

/** Mirrors withScope(): the same SET LOCAL GUCs the application uses. */
async function scoped<T>(
  client: pg.Client,
  productScope: string,
  role: string,
  fn: () => Promise<T>,
): Promise<T> {
  await client.query('BEGIN');
  await client.query(
    `SELECT set_config('app.product_scope',$1,true),
            set_config('app.role',$2,true),
            set_config('app.request_id','embedding-eval',true)`,
    [productScope, role],
  );
  try {
    return await fn();
  } finally {
    await client.query('COMMIT');
  }
}

async function main(): Promise<void> {
  const client = new pg.Client({ connectionString: env.CORE_DATABASE_URL });
  await client.connect();

  const latencies: number[] = [];
  let vecTop1 = 0;
  let vecTop3 = 0;
  let vecTop5 = 0;
  let ftsTop1 = 0;
  let ftsTop3 = 0;
  let ftsTop5 = 0;
  let leaks = 0;

  console.log(`\nProduct scope: ${PRODUCT}   queries: ${QUERIES.length}\n`);
  console.log('rank(vec) rank(fts)  query');
  console.log('--------- ---------  ----------------------------------------');

  for (const { q, expect } of QUERIES) {
    const t0 = Date.now();
    const vector = await embed(q);
    latencies.push(Date.now() - t0);
    const literal = `[${vector.join(',')}]`;

    const { vecRows, ftsRows } = await scoped(client, PRODUCT, 'agent', async () => {
      // The vector ranker under test. Tenant predicate INSIDE the query,
      // before ORDER BY and LIMIT — see embedding.repo.ts.
      const v = await client.query<{ id: string; title: string; product_id: string }>(
        `SELECT k.id, k.title, k.product_id
           FROM kb_article k
          WHERE k.product_id = $2
            AND k.status = 'published'
            AND k.embedding IS NOT NULL
          ORDER BY k.embedding <=> $1::vector
          LIMIT 5`,
        [literal, PRODUCT],
      );
      // The EXISTING ranker, unchanged, as the baseline: the hybrid full-text
      // + trigram score from kb.repo.ts searchArticles().
      const f = await client.query<{ id: string; title: string }>(
        `SELECT id, title
           FROM kb_article
          WHERE (search_tsv @@ websearch_to_tsquery('english', $1)
                 OR similarity(title, $1) > 0.15)
            AND product_id = $2
          ORDER BY (ts_rank(search_tsv, websearch_to_tsquery('english', $1)) * 4
                    + similarity(title, $1)) DESC
          LIMIT 5`,
        [q, PRODUCT],
      );
      return { vecRows: v.rows, ftsRows: f.rows };
    });

    // ⚠️ Isolation: every row must belong to the scoped product. With four
    // byte-identical copies of each article this is the only thing that can
    // be wrong.
    for (const r of vecRows) if (r.product_id !== PRODUCT) leaks++;

    const vRank = vecRows.findIndex((r) => r.title === expect) + 1;
    const fRank = ftsRows.findIndex((r) => r.title === expect) + 1;
    if (vRank === 1) vecTop1++;
    if (vRank >= 1 && vRank <= 3) vecTop3++;
    if (vRank >= 1) vecTop5++;
    if (fRank === 1) ftsTop1++;
    if (fRank >= 1 && fRank <= 3) ftsTop3++;
    if (fRank >= 1) ftsTop5++;

    const fmt = (r: number) => (r === 0 ? '  -  ' : `  ${r}  `);
    console.log(`${fmt(vRank)}     ${fmt(fRank)}    ${q.slice(0, 52)}`);
  }

  const n = QUERIES.length;
  const pct = (x: number) => `${((x / n) * 100).toFixed(0)}%`;
  latencies.sort((a, b) => a - b);

  console.log(`\n              Top-1    Top-3    Top-5`);
  console.log(`vector      ${pct(vecTop1).padStart(5)}   ${pct(vecTop3).padStart(5)}   ${pct(vecTop5).padStart(5)}   (${vecTop1}/${vecTop3}/${vecTop5} of ${n})`);
  console.log(`full-text   ${pct(ftsTop1).padStart(5)}   ${pct(ftsTop3).padStart(5)}   ${pct(ftsTop5).padStart(5)}   (${ftsTop1}/${ftsTop3}/${ftsTop5} of ${n})`);
  console.log(
    `\nquery embedding latency  p50 ${latencies[Math.floor(n * 0.5)]}ms  p95 ${latencies[Math.floor(n * 0.95)]}ms  max ${latencies[n - 1]}ms`,
  );
  console.log(`cross-tenant rows returned: ${leaks}`);

  await runIsolationProbes(client);
  await client.end();
}

/**
 * The isolation tests that matter, run against the real policies.
 *
 * Each takes a vector that is a PERFECT match for a row in another tenant and
 * asks whether that row can be reached. A perfect match is the strongest form
 * of the question: if the ranking could ever return it, this is when.
 */
async function runIsolationProbes(client: pg.Client): Promise<void> {
  console.log('\n── tenant isolation ──────────────────────────────────────');

  /**
   * Fetching the victim row needs prod_esg's OWN scope.
   *
   * The first attempt ran this unscoped and got zero rows — RLS working
   * exactly as designed, and worth recording: even the test harness cannot
   * read a tenant's vectors without asserting that tenant's scope.
   */
  const victim = await scoped(client, 'prod_esg', 'agent', async () => {
    const r = await client.query<{ id: string; product_id: string; vec: string }>(
      `SELECT id, product_id, embedding::text AS vec
         FROM kb_article
        WHERE product_id = 'prod_esg' AND embedding IS NOT NULL
        LIMIT 1`,
    );
    if (!r.rows[0]) throw new Error('no prod_esg vector to probe with');
    return r.rows[0];
  });

  // 1. Query with prod_esg's OWN vector while scoped to prod_carbon.
  const hits = await scoped(client, 'prod_carbon', 'agent', async () => {
    const r = await client.query<{ id: string; product_id: string; sim: string }>(
      `SELECT k.id, k.product_id, (1 - (k.embedding <=> $1::vector))::text AS sim
         FROM kb_article k
        WHERE k.product_id = 'prod_carbon' AND k.embedding IS NOT NULL
        ORDER BY k.embedding <=> $1::vector
        LIMIT 5`,
      [victim.vec],
    );
    return r.rows;
  });
  const own = hits.filter((h) => h.product_id !== 'prod_carbon').length;
  console.log(
    `  exact-match vector from prod_esg, scoped to prod_carbon: ${hits.length} rows, ${own} foreign  ` +
      `${own === 0 ? 'PASS' : 'FAIL'}  (top similarity ${Number(hits[0]?.sim ?? 0).toFixed(4)})`,
  );

  // 2. The same query with NO product predicate, relying on RLS alone.
  const rlsOnly = await scoped(client, 'prod_carbon', 'agent', async () => {
    const r = await client.query<{ product_id: string }>(
      `SELECT k.product_id FROM kb_article k
        WHERE k.embedding IS NOT NULL
        ORDER BY k.embedding <=> $1::vector LIMIT 5`,
      [victim.vec],
    );
    return r.rows;
  });
  const rlsForeign = rlsOnly.filter((r) => r.product_id !== 'prod_carbon').length;
  console.log(
    `  same query with RLS as the ONLY control:                 ${rlsOnly.length} rows, ${rlsForeign} foreign  ` +
      `${rlsForeign === 0 ? 'PASS' : 'FAIL'}`,
  );

  // 3. An unscoped session must see nothing at all — RLS fails closed.
  const none = await scoped(client, '', 'none', async () => {
    const r = await client.query(`SELECT id FROM kb_article WHERE embedding IS NOT NULL LIMIT 5`);
    return r.rowCount ?? 0;
  });
  console.log(`  unscoped session (role 'none', empty scope):             ${none} rows  ${none === 0 ? 'PASS' : 'FAIL'}`);

  // 4. A raiser must not reach resolved TICKET vectors belonging to others.
  const raiser = await scoped(client, 'prod_carbon', 'raiser', async () => {
    const r = await client.query(
      `SELECT id FROM ticket WHERE embedding IS NOT NULL AND status IN ('resolved','closed') LIMIT 5`,
    );
    return r.rowCount ?? 0;
  });
  console.log(
    `  raiser with no raiser_ref reaching ticket vectors:       ${raiser} rows  ${raiser === 0 ? 'PASS' : 'FAIL'}`,
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
