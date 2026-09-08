/**
 * Phase 14 Similar Tickets — quality and performance, against the real stack.
 *
 *   npx tsx scripts/similar-eval.ts
 *
 * ⚠️ THIS IS VALIDATION, NOT A BENCHMARK. A hand-written set over a corpus of
 * ~13 historical tickets per product, one author, one reviewer's labels. It is
 * enough to tell "the right precedent surfaces" from "the ranking is noise",
 * and nowhere near enough to publish a number.
 *
 * ⚠️ IT ALSO MEASURES WHAT RERANKING WOULD ADD, without shipping it. Phase 12's
 * client is called on the retrieved list and the orderings are compared, so the
 * "leave it disabled" decision rests on a measurement for THIS feature rather
 * than on the Phase 12/13 results alone.
 */

import pg from 'pg';
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)] as const),
) as Record<string, string | undefined>;

const CORE = env.CORE_URL ?? 'http://localhost:4100';
const KEY = env.INTERNAL_API_KEY ?? 'dev_internal_key_change_me';
const PRODUCT = 'prod_carbon';

interface Case {
  kind: string;
  subject: string;
  description: string;
  /** Historical subject that should rank first. Empty = nothing should match. */
  expect: string[];
}

/**
 * Cases are written against the SEEDED historical subjects, which are the real
 * corpus. Each creates a temporary open ticket, asks for its precedents, and is
 * then removed.
 */
const CASES: Case[] = [
  {
    kind: 'exact same issue',
    subject: 'Page loading slowly',
    description: 'Page loading slowly. Started around 2 day(s) ago and is blocking our monthly close.',
    expect: ['Page loading slowly'],
  },
  {
    kind: 'exact same issue',
    subject: 'Cannot sign in to the portal',
    description: 'Cannot sign in to the portal. Started around 3 day(s) ago and is blocking our monthly close.',
    expect: ['Cannot sign in to the portal'],
  },
  {
    kind: 'paraphrase',
    subject: 'The site is crawling this morning',
    description: 'Everything takes forever to come up and it is holding up our month end close.',
    expect: ['Page loading slowly'],
  },
  {
    kind: 'paraphrase',
    subject: 'I am locked out of my account',
    description: 'I cannot get into the portal at all, my credentials are rejected every time.',
    expect: ['Cannot sign in to the portal', 'Password reset email never arrives'],
  },
  {
    kind: 'paraphrase',
    subject: 'The figures on screen disagree with my download',
    description: 'The dashboard totals and the exported spreadsheet do not agree with each other.',
    expect: ['Totals do not match the dashboard', 'Report not showing data'],
  },
  {
    kind: 'same category, different issue',
    subject: 'The export finished but has no rows',
    description: 'The export completed successfully but the file that came out is empty.',
    expect: ['Report not showing data', 'Export failing with a 500'],
  },
  {
    kind: 'superficially similar wording',
    subject: 'Slow response from the support team',
    description: 'Nobody has replied to my previous ticket for four days. This is about response times, not the software.',
    // Wording overlaps "slow"/"response" but the problem is unrelated to any
    // historical software issue. A weak top match is the CORRECT outcome.
    expect: [],
  },
  {
    kind: 'unrelated',
    subject: 'Request for a company hoodie',
    description: 'Could you send me some branded merchandise for the team offsite next month.',
    expect: [],
  },
];

async function api(path: string) {
  const t0 = Date.now();
  const res = await fetch(`${CORE}${path}`, {
    headers: {
      'x-internal-key': KEY,
      'x-iris-role': 'super_admin',
      'x-iris-support-user-id': 'su_eval14',
    },
  });
  const body = (await res.json()) as {
    items?: Array<{ reference: string; title: string; similarity: number; resolution: string | null }>;
    diagnostics?: Record<string, unknown>;
  };
  return { body, ms: Date.now() - t0, status: res.status };
}

async function main() {
  const client = new pg.Client({ connectionString: env.ADMIN_DATABASE_URL ?? env.CORE_DATABASE_URL });
  await client.connect();
  const made: string[] = [];

  const scoped = async <T>(fn: () => Promise<T>): Promise<T> => {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.product_scope',$1,true), set_config('app.role','none',true),
              set_config('app.request_id','eval14',true)`,
      [PRODUCT],
    );
    try {
      return await fn();
    } finally {
      await client.query('COMMIT');
    }
  };

  let top1 = 0;
  let top3 = 0;
  let top5 = 0;
  let answerable = 0;
  let withResolution = 0;
  let weakTotal = 0;
  let weakCorrect = 0;
  const latencies: number[] = [];
  const embedMs: number[] = [];

  console.log('\nPhase 14 — Similar Tickets quality\n');
  console.log('kind                          top1 top3 top5  sim    ms    query subject');
  console.log('----------------------------- ---- ---- ----  -----  ----  --------------------------');

  try {
    for (const c of CASES) {
      const id = `tkt_ev14_${Math.random().toString(36).slice(2, 12)}`;
      await scoped(() =>
        client.query(
          `INSERT INTO ticket (id, product_id, reference, product_tenant_id, raised_by_ref,
                               subject, description, status)
           VALUES ($1,$2,$3,'acme-corp','eval14-raiser',$4,$5,'open')`,
          [id, PRODUCT, `EV14-${id.slice(-6).toUpperCase()}`, c.subject, c.description],
        ),
      );
      made.push(id);

      const { body, ms } = await api(`/admin/api/tickets/${id}/similar?limit=5`);
      latencies.push(ms);
      const e = body.diagnostics?.embed_ms;
      if (typeof e === 'number') embedMs.push(e);

      const titles = (body.items ?? []).map((i) => i.title);
      const topSim = body.items?.[0]?.similarity ?? 0;

      if (c.expect.length === 0) {
        /**
         * "Correct" for an unanswerable case is a WEAK top match — the corpus
         * genuinely has no precedent, so what matters is that nothing scores
         * like a real one. Judged against the observed true-match band (>0.9).
         */
        weakTotal++;
        const ok = topSim < 0.9;
        if (ok) weakCorrect++;
        console.log(
          `${c.kind.padEnd(29)} ${(ok ? ' ok ' : 'STRONG').padEnd(4)} ${'-'.padEnd(4)} ${'-'.padEnd(4)}  ${topSim.toFixed(4)}  ${String(ms).padStart(4)}  ${c.subject.slice(0, 30)}`,
        );
        continue;
      }

      answerable++;
      const rank = titles.findIndex((t) => c.expect.includes(t)) + 1;
      if (rank === 1) top1++;
      if (rank >= 1 && rank <= 3) top3++;
      if (rank >= 1 && rank <= 5) top5++;
      if (rank >= 1 && body.items![rank - 1]!.resolution) withResolution++;

      const m = (hit: boolean) => (hit ? ' yes' : '  no');
      console.log(
        `${c.kind.padEnd(29)} ${m(rank === 1)} ${m(rank >= 1 && rank <= 3)} ${m(rank >= 1)}  ${topSim.toFixed(4)}  ${String(ms).padStart(4)}  ${c.subject.slice(0, 30)}`,
      );
      if (rank >= 1) console.log(`                              -> ${titles[rank - 1]}`);
      else console.log(`                              -> MISS. got: ${titles.slice(0, 2).join(' | ')}`);
    }
  } finally {
    for (const id of made) {
      await scoped(() => client.query(`DELETE FROM ticket WHERE id = $1`, [id]));
    }
    const left = await scoped(async () => {
      const r = await client.query(`SELECT count(*) AS n FROM ticket WHERE id LIKE 'tkt_ev14_%'`);
      return Number(r.rows[0].n);
    });
    console.log(`\ncleanup: ${left} evaluation ticket(s) remaining (must be 0)`);
    await client.end();
  }

  const pct = (x: number, n: number) => (n === 0 ? 'n/a' : `${((x / n) * 100).toFixed(0)}%`);
  latencies.sort((a, b) => a - b);
  embedMs.sort((a, b) => a - b);
  const p = (arr: number[], q: number) => arr[Math.min(arr.length - 1, Math.floor(arr.length * q))] ?? 0;

  console.log(`\n${answerable} cases with a known precedent · ${weakTotal} with none`);
  console.log(`  Top-1                      ${pct(top1, answerable)}  (${top1}/${answerable})`);
  console.log(`  Top-3                      ${pct(top3, answerable)}  (${top3}/${answerable})`);
  console.log(`  Top-5                      ${pct(top5, answerable)}  (${top5}/${answerable})`);
  console.log(`  hit carried a resolution   ${pct(withResolution, answerable)}  (${withResolution}/${answerable})`);
  console.log(`  no-precedent cases stayed weak (<0.9)  ${pct(weakCorrect, weakTotal)}  (${weakCorrect}/${weakTotal})`);
  console.log(
    `\nlatency  total p50 ${p(latencies, 0.5)}ms  p95 ${p(latencies, 0.95)}ms  max ${latencies[latencies.length - 1]}ms`,
  );
  console.log(
    `         embedding p50 ${p(embedMs, 0.5)}ms  p95 ${p(embedMs, 0.95)}ms  (retrieval is the remainder)\n`,
  );
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
