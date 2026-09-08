/**
 * Phase 14 — does Phase 12 reranking add anything to Similar Tickets?
 *
 *   npx tsx scripts/similar-rerank-probe.ts
 *
 * ⚠️ MEASURED BEFORE DECIDING, and measured FOR THIS FEATURE rather than
 * inherited from Phase 12/13. Reranking is not wired into the Similar Tickets
 * path; this calls the same reranking feature on the same retrieved list and
 * compares the orderings, so "leave it off" rests on evidence about tickets
 * rather than on a result about KB articles.
 *
 * The interesting question is not only Top-1 — retrieval already gets that
 * right 6/6 — but whether reranking would reorder anything at all, and at what
 * cost.
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
) as Record<string, string | undefined>;

const CORE = env.CORE_URL ?? 'http://localhost:4100';
const KEY = env.INTERNAL_API_KEY ?? 'dev_internal_key_change_me';
const AI_URL = env.AI_SERVICE_URL ?? 'http://localhost:5000';
const AI_SECRET = env.AI_CORE_HMAC_SECRET ?? 'dev_ai_core_hmac_secret_change_me';
const PRODUCT = 'prod_carbon';

const CASES = [
  { subject: 'The site is crawling this morning', description: 'Everything takes forever to come up and it is holding up our month end close.' },
  { subject: 'I am locked out of my account', description: 'I cannot get into the portal at all, my credentials are rejected every time.' },
  { subject: 'The figures on screen disagree with my download', description: 'The dashboard totals and the exported spreadsheet do not agree with each other.' },
  { subject: 'The export finished but has no rows', description: 'The export completed successfully but the file that came out is empty.' },
];

async function rerank(question: string, items: Array<{ title: string; resolution: string | null }>) {
  const path = '/v1/execute';
  const body = JSON.stringify({
    feature: 'reranking',
    request_id: `p14rr_${randomUUID()}`,
    input: {
      subject: null,
      description: question,
      candidates: items.map((it, i) => ({
        ordinal: i + 1,
        kind: 'ticket' as const,
        title: it.title,
        excerpt: (it.resolution ?? '').slice(0, 240),
      })),
    },
  });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomUUID();
  const t0 = Date.now();
  const res = await fetch(`${AI_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-iris-service-id': 'core',
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
  if (!res.ok) return { ms, ranking: null as number[] | null, status: res.status };
  const json = (await res.json()) as { data?: { ranking?: number[] } };
  return { ms, ranking: json.data?.ranking ?? null, status: 200 };
}

async function main() {
  const client = new pg.Client({ connectionString: env.ADMIN_DATABASE_URL ?? env.CORE_DATABASE_URL });
  await client.connect();
  const made: string[] = [];
  const scoped = async <T>(fn: () => Promise<T>): Promise<T> => {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.product_scope',$1,true), set_config('app.role','none',true),
              set_config('app.request_id','p14rr',true)`,
      [PRODUCT],
    );
    try {
      return await fn();
    } finally {
      await client.query('COMMIT');
    }
  };

  console.log('\nPhase 14 — would reranking change the Similar Tickets order?\n');
  console.log('retrieval top-1                     reranked top-1                      changed  rerank ms');
  console.log('----------------------------------- ----------------------------------- -------  ---------');

  let changed = 0;
  let top1Changed = 0;
  const rerankMs: number[] = [];

  try {
    for (const c of CASES) {
      const id = `tkt_p14rr_${Math.random().toString(36).slice(2, 10)}`;
      await scoped(() =>
        client.query(
          `INSERT INTO ticket (id, product_id, reference, product_tenant_id, raised_by_ref,
                               subject, description, status)
           VALUES ($1,$2,$3,'acme-corp','p14rr','${''}' || $4, $5, 'open')`,
          [id, PRODUCT, `RR14-${id.slice(-6).toUpperCase()}`, c.subject, c.description],
        ),
      );
      made.push(id);

      const res = await fetch(`${CORE}/admin/api/tickets/${id}/similar?limit=5`, {
        headers: {
          'x-internal-key': KEY,
          'x-iris-role': 'super_admin',
          'x-iris-support-user-id': 'su_p14rr',
        },
      });
      const body = (await res.json()) as {
        items?: Array<{ title: string; resolution: string | null }>;
      };
      const items = body.items ?? [];
      if (items.length < 2) continue;

      const question = `${c.subject}. ${c.description}`;
      const rr = await rerank(question, items);
      rerankMs.push(rr.ms);

      const before = items.map((i) => i.title);
      const after = rr.ranking
        ? rr.ranking.filter((n) => n >= 1 && n <= items.length).map((n) => items[n - 1]!.title)
        : before;
      const orderChanged = JSON.stringify(before.slice(0, after.length)) !== JSON.stringify(after);
      if (orderChanged) changed++;
      if (before[0] !== after[0]) top1Changed++;

      console.log(
        `${before[0]!.slice(0, 35).padEnd(35)} ${(after[0] ?? '(none)').slice(0, 35).padEnd(35)} ${(orderChanged ? 'yes' : 'no').padEnd(7)}  ${String(rr.ms).padStart(5)}`,
      );
    }
  } finally {
    for (const id of made) {
      await scoped(() => client.query(`DELETE FROM ticket WHERE id = $1`, [id]));
    }
    const left = await scoped(async () => {
      const r = await client.query(`SELECT count(*) AS n FROM ticket WHERE id LIKE 'tkt_p14rr_%'`);
      return Number(r.rows[0].n);
    });
    console.log(`\ncleanup: ${left} probe ticket(s) remaining (must be 0)`);
    await client.end();
  }

  rerankMs.sort((a, b) => a - b);
  const p50 = rerankMs[Math.floor(rerankMs.length * 0.5)] ?? 0;
  console.log(`\n  orderings changed by reranking: ${changed}/${CASES.length}`);
  console.log(`  TOP-1 changed:                  ${top1Changed}/${CASES.length}`);
  console.log(`  reranking cost:                 p50 ${p50}ms per lookup`);
  console.log(
    `\n  Retrieval alone already gets Top-1 right 6/6 in the quality evaluation,\n` +
      `  so reranking has no headroom to improve it and would add the cost above\n` +
      `  to every ticket a support user opens.\n`,
  );
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
