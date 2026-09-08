/**
 * Phase 13 RAG quality evaluation, against the real running stack.
 *
 *   npx tsx scripts/rag-eval.ts
 *
 * ⚠️ WHAT THIS IS NOT. Not a benchmark. A small labelled set over one 120-item
 * corpus, one author, one reviewer's judgement. It is enough to tell "grounded
 * answers work and cite honestly" from "they hallucinate or mis-cite", and not
 * enough to publish a number.
 *
 * ⚠️ AND IT IS BUILT TO FIND FAILURES, not to flatter. It includes questions
 * the corpus cannot answer (the model must refuse), a deliberately
 * CONTRADICTORY pair inserted for the purpose (it must surface the conflict
 * rather than silently pick one), and an unsupported-claim check that greps the
 * answer for facts absent from the cited evidence.
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
  q: string;
  /** Title that must be cited. Empty = the model must refuse. */
  expectCited: string[];
  /** Substrings that must NOT appear — facts no source supports. */
  forbidden?: string[];
  /** Substrings signalling the answer acknowledged a conflict. */
  expectAny?: string[];
}

const CASES: Case[] = [
  {
    kind: 'direct',
    q: 'How do I reset my password?',
    expectCited: ['How to reset your password'],
    forbidden: ['call us', 'phone', 'refund'],
  },
  {
    kind: 'direct',
    q: 'How do I schedule a report to be sent every week?',
    expectCited: ['Scheduling a recurring report'],
  },
  {
    kind: 'paraphrase',
    q: 'I forgot my login details and cannot get in',
    expectCited: ['How to reset your password'],
  },
  {
    kind: 'paraphrase',
    q: 'everything appears twice after I uploaded the csv',
    expectCited: ['Duplicate records after an import'],
  },
  {
    kind: 'multi-source',
    q: 'I keep failing to sign in and now my account seems blocked — what do I do?',
    expectCited: ['Account locked after failed sign-in attempts', 'How to reset your password'],
  },
  {
    kind: 'ambiguous',
    q: 'my numbers look wrong',
    expectCited: [
      'Totals do not match the dashboard',
      'Duplicate records after an import',
      'Why my export is missing recent rows',
    ],
  },
  {
    kind: 'no-answer',
    q: 'how do I renew my passport at the embassy',
    expectCited: [],
  },
  {
    kind: 'no-answer',
    q: 'best recipe for sourdough bread starter',
    expectCited: [],
  },
];

/**
 * A deliberately contradictory pair, inserted for this run and removed after.
 * The corpus contains no genuine conflict, so one has to be created to test
 * whether the model surfaces it or silently picks a side.
 */
const CONFLICT = [
  {
    title: 'Export retention policy',
    body: 'Exported report files are retained for 30 days, after which they are permanently deleted.',
  },
  {
    title: 'Export file lifetime',
    body: 'Exported report files are retained for 7 days only. After 7 days the file is removed and must be regenerated.',
  },
];

async function ask(question: string) {
  const t0 = Date.now();
  const res = await fetch(`${CORE}/v1/widget/ask`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-key': KEY,
      'x-iris-product-id': PRODUCT,
      'x-iris-role': 'raiser',
      'x-iris-tenant-id': 'tenant_eval13',
      'x-iris-raiser-ref': 'eval13',
    },
    body: JSON.stringify({ question }),
  });
  const body = (await res.json()) as {
    answers?: Array<{ title: string }>;
    grounded_answer?: { answer: string; cited: number[]; insufficient: boolean };
  };
  return { body, ms: Date.now() - t0 };
}

async function main() {
  const client = new pg.Client({
    connectionString: env.ADMIN_DATABASE_URL ?? env.CORE_DATABASE_URL,
  });
  await client.connect();
  const scoped = async <T>(fn: () => Promise<T>): Promise<T> => {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.product_scope',$1,true), set_config('app.role','super_admin',true),
              set_config('app.request_id','eval13',true)`,
      [PRODUCT],
    );
    try {
      return await fn();
    } finally {
      await client.query('COMMIT');
    }
  };

  console.log('\nPhase 13 — RAG quality\n');
  console.log('kind          grounded cite-ok  ms    query');
  console.log('------------- -------- -------- ----- ------------------------------------');

  let answerable = 0;
  let grounded = 0;
  let citeCorrect = 0;
  let unsupported = 0;
  let refusalTotal = 0;
  let refusalCorrect = 0;
  const latencies: number[] = [];

  for (const c of CASES) {
    const { body, ms } = await ask(c.q);
    latencies.push(ms);
    const g = body.grounded_answer;
    const answers = body.answers ?? [];
    const citedTitles = (g?.cited ?? []).map((n) => answers[n - 1]?.title ?? '?');

    if (c.expectCited.length === 0) {
      // Correct behaviour: no grounded answer at all, or an explicit refusal
      // with no citations. Either way, nothing fabricated.
      refusalTotal++;
      const ok = !g || g.insufficient === true;
      if (ok) refusalCorrect++;
      console.log(
        `${c.kind.padEnd(13)} ${(ok ? 'refused' : 'ANSWERED').padEnd(8)} ${'-'.padEnd(8)} ${String(ms).padStart(4)}  ${c.q.slice(0, 40)}`,
      );
      continue;
    }

    answerable++;
    const isGrounded = Boolean(g) && !g!.insufficient;
    if (isGrounded) grounded++;
    // Citation correct = at least one cited source is an expected one, and
    // every cited source resolved to a card actually shown.
    const resolvesAll = citedTitles.every((t) => t !== '?');
    const hitsExpected = citedTitles.some((t) => c.expectCited.includes(t));
    if (isGrounded && resolvesAll && hitsExpected) citeCorrect++;

    const answer = (g?.answer ?? '').toLowerCase();
    const bad = (c.forbidden ?? []).filter((f) => answer.includes(f.toLowerCase()));
    if (bad.length) unsupported++;

    console.log(
      `${c.kind.padEnd(13)} ${(isGrounded ? 'yes' : 'no').padEnd(8)} ${(isGrounded && resolvesAll && hitsExpected ? 'yes' : 'NO').padEnd(8)} ${String(ms).padStart(4)}  ${c.q.slice(0, 40)}`,
    );
    if (isGrounded) console.log(`              cited: ${citedTitles.join(' + ')}`);
    if (bad.length) console.log(`              ⚠ unsupported: ${bad.join(', ')}`);
  }

  // ── contradictory sources ───────────────────────────────────────────────
  console.log('\ncontradictory sources (inserted for this run, removed after)');
  const ids: string[] = [];
  let conflictVerdict = 'not run';
  try {
    for (const c of CONFLICT) {
      const id = `kb_eval13_${Math.random().toString(36).slice(2, 10)}`;
      await scoped(() =>
        client.query(
          `INSERT INTO kb_article (id, product_id, title, body, category, status, is_public)
           VALUES ($1,$2,$3,$4,'general','published',true)`,
          [id, PRODUCT, c.title, c.body],
        ),
      );
      ids.push(id);
      await scoped(() =>
        client.query(
          `UPDATE kb_article SET embedding = (
             SELECT embedding FROM kb_article
              WHERE product_id = $2 AND title = 'Fixing failed report exports' LIMIT 1),
             embedding_fingerprint = embedding_content_sha,
             embedding_model = 'azure/text-embedding-3-small', embedded_at = now()
           WHERE id = $1`,
          [id, PRODUCT],
        ),
      );
    }

    const { body } = await ask('How long are exported report files kept before they are deleted?');
    const g = body.grounded_answer;
    const answers = body.answers ?? [];
    const cited = (g?.cited ?? []).map((n) => answers[n - 1]?.title ?? '?');
    const both =
      cited.includes('Export retention policy') && cited.includes('Export file lifetime');
    const a = (g?.answer ?? '').toLowerCase();
    const acknowledges =
      a.includes('conflict') ||
      a.includes('contradict') ||
      a.includes('differ') ||
      a.includes('inconsisten') ||
      (a.includes('30') && a.includes('7'));

    conflictVerdict = !g
      ? 'no answer (provider-filtered or no evidence)'
      : both && acknowledges
        ? 'SURFACED the conflict and cited both'
        : acknowledges
          ? 'acknowledged a conflict but did not cite both'
          : both
            ? 'cited both but did not acknowledge the conflict'
            : 'SILENTLY PICKED ONE — the failure mode this tests for';
    console.log(`  ${conflictVerdict}`);
    if (g) console.log(`  answer: "${g.answer.slice(0, 130)}…"`);
    console.log(`  cited: ${cited.join(' + ') || '(none)'}`);
  } finally {
    for (const id of ids) {
      await scoped(() => client.query(`DELETE FROM kb_article WHERE id = $1`, [id]));
    }
    const left = await scoped(async () => {
      const r = await client.query(`SELECT count(*) AS n FROM kb_article WHERE id LIKE 'kb_eval13_%'`);
      return Number(r.rows[0].n);
    });
    console.log(`  cleanup: ${left} inserted article(s) remaining (must be 0)`);
    await client.end();
  }

  latencies.sort((x, y) => x - y);
  const p = (q: number) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * q))];
  const pct = (x: number, n: number) => (n === 0 ? 'n/a' : `${((x / n) * 100).toFixed(0)}%`);

  console.log(`\n${answerable} answerable · ${refusalTotal} unanswerable`);
  console.log(`  grounded answer produced   ${pct(grounded, answerable)}  (${grounded}/${answerable})`);
  console.log(`  citation correct           ${pct(citeCorrect, answerable)}  (${citeCorrect}/${answerable})`);
  console.log(`  unsupported claim rate     ${pct(unsupported, answerable)}  (${unsupported}/${answerable})`);
  console.log(`  refusal correct            ${pct(refusalCorrect, refusalTotal)}  (${refusalCorrect}/${refusalTotal})`);
  console.log(`  contradiction              ${conflictVerdict}`);
  console.log(`\nlatency p50 ${p(0.5)}ms  p95 ${p(0.95)}ms  max ${latencies[latencies.length - 1]}ms\n`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
