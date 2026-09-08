/**
 * Phase 11 calibration probe — evidence for the vector similarity floor.
 *
 * ⚠️ THE PROBLEM THIS EXISTS TO SOLVE.
 *
 * `ask.service.ts` gates deflection on `answers[0].score >= min_score`, and
 * `min_score: 0.05` is seeded into every product config. Today a nonsense query
 * returns ZERO lexical rows, so `suggested_action` is `create_ticket` and the
 * user is offered the ticket form.
 *
 * Vector search has no such property: `ORDER BY embedding <=> q LIMIT k`
 * ALWAYS returns k rows, however irrelevant. Adding it naively would make every
 * nonsense query produce confident-looking answers and suppress the ticket
 * form — a silent business-behaviour regression, which Phase 11 forbids.
 *
 * A similarity FLOOR restores the "no plausible answer" outcome. This measures
 * where to put it instead of guessing.
 *
 *   npx tsx scripts/retrieval-calibrate.ts
 */

import pg from 'pg';
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
const PRODUCT = 'prod_carbon';

async function embed(text: string): Promise<number[]> {
  const path = '/v1/execute';
  const body = JSON.stringify({
    feature: 'embedding',
    request_id: `cal_${randomUUID()}`,
    input: { subject: null, description: text },
  });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomUUID();
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
  if (!res.ok) throw new Error(`embed HTTP ${res.status}`);
  return ((await res.json()) as { data: { vector: number[] } }).data.vector;
}

/**
 * RELEVANT queries have a genuine answer in the corpus. IRRELEVANT ones do not
 * — and are deliberately plausible English about software, not gibberish,
 * because "xyzzy quux" is trivially far from everything and would flatter the
 * floor. A user asking a real question this corpus cannot answer is the case
 * that matters.
 */
const RELEVANT = [
  'I forgot my login details and cannot get in',
  'downloading the spreadsheet keeps failing halfway',
  'everything appears twice after I uploaded the csv',
  'pages take forever to come up this morning',
  'where is my bill for last month',
  'set up an automatic weekly summary',
];

const IRRELEVANT = [
  'how do I renew my passport at the embassy',
  'best recipe for sourdough bread starter',
  'what is the capital city of Portugal',
  'my dog will not eat his food',
  'flight delayed compensation rules in the EU',
  'how to change a bicycle tyre inner tube',
];

async function main(): Promise<void> {
  const client = new pg.Client({ connectionString: env.CORE_DATABASE_URL });
  await client.connect();
  await client.query('BEGIN');
  await client.query(
    `SELECT set_config('app.product_scope',$1,true), set_config('app.role','agent',true),
            set_config('app.request_id','calibrate',true)`,
    [PRODUCT],
  );

  const top = async (text: string) => {
    const v = `[${(await embed(text)).join(',')}]`;
    const r = await client.query<{ sim: string; title: string }>(
      `SELECT (1 - (k.embedding <=> $1::vector)) AS sim, k.title
         FROM kb_article k
        WHERE k.product_id = $2 AND k.status='published' AND k.embedding IS NOT NULL
        ORDER BY k.embedding <=> $1::vector LIMIT 3`,
      [v, PRODUCT],
    );
    return r.rows.map((x) => ({ sim: Number(x.sim), title: x.title }));
  };

  console.log('\ntop-3 cosine similarity, prod_carbon KB corpus\n');
  console.log('  kind        top1    top2    top3   query');
  console.log('  ---------- ------- ------- ------  ------------------------------');

  const rel: number[] = [];
  const irr: number[] = [];

  for (const q of RELEVANT) {
    const t = await top(q);
    rel.push(t[0]!.sim);
    console.log(
      `  RELEVANT   ${t.map((x) => x.sim.toFixed(3)).join('   ')}   ${q.slice(0, 40)}`,
    );
  }
  for (const q of IRRELEVANT) {
    const t = await top(q);
    irr.push(t[0]!.sim);
    console.log(
      `  irrelevant ${t.map((x) => x.sim.toFixed(3)).join('   ')}   ${q.slice(0, 40)}`,
    );
  }

  const min = (a: number[]) => Math.min(...a);
  const max = (a: number[]) => Math.max(...a);
  console.log(
    `\n  relevant   top1  min ${min(rel).toFixed(3)}  max ${max(rel).toFixed(3)}` +
      `\n  irrelevant top1  min ${min(irr).toFixed(3)}  max ${max(irr).toFixed(3)}`,
  );
  const gap = min(rel) - max(irr);
  console.log(
    `\n  separation: ${gap > 0 ? `CLEAN, gap ${gap.toFixed(3)}` : `OVERLAPPING by ${(-gap).toFixed(3)}`}` +
      `\n  a floor anywhere in (${max(irr).toFixed(3)}, ${min(rel).toFixed(3)}) separates these sets`,
  );

  await client.query('COMMIT');
  await client.end();
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
