/**
 * Phase 11 retrieval-quality evaluation.
 *
 *   npx tsx scripts/retrieval-eval.ts
 *
 * Compares FTS / trigram / vector / hybrid on ONE labelled query set, through
 * the real signed AI service and the real Postgres.
 *
 * ⚠️ WHAT THIS IS NOT. Not a benchmark. 26 queries, one 120-item corpus, one
 * author, one reviewer's judgement of relevance. It is enough to see WHERE each
 * strategy wins and whether fusion preserves those wins — and not enough to
 * publish a number.
 *
 * ⚠️ THE QUERY SET IS NOT BUILT TO FLATTER HYBRID. It deliberately includes
 * cases each single strategy should win outright (an exact keyword for FTS, a
 * misspelling for trigram, a paraphrase for vector) and cases where NOTHING
 * should be returned. A fusion that wins everything on a set like this would be
 * evidence the set was wrong, not that the fusion was good.
 *
 * Relevance labels: 2 = highly relevant (the intended answer), 1 = related
 * (plausibly useful), 0 = irrelevant. Top-k counts a label-2 hit in the first k.
 */

import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { requestSignatureHeader } from '@iris/shared/hmac';
import {
  CANDIDATES_PER_STRATEGY,
  TRIGRAM_SIMILARITY_FLOOR,
  VECTOR_SIMILARITY_FLOOR,
  candidateKey,
  fuseRankings,
} from '@iris/shared/types';

const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)] as const),
) as Record<string, string>;

const AI_URL = env.AI_SERVICE_URL ?? 'http://localhost:5000';
const AI_SECRET = env.AI_CORE_HMAC_SECRET ?? 'dev_ai_core_hmac_secret_change_me';
const PRODUCT = 'prod_carbon';

type Kind = 'exact-lexical' | 'lexical' | 'typo' | 'semantic' | 'mixed' | 'ambiguous' | 'negative';

interface Q {
  q: string;
  kind: Kind;
  /** Article titles that are the intended answer (label 2). Empty = nothing is relevant. */
  relevant: string[];
  /** Titles that are plausibly useful (label 1). Not counted as a hit. */
  related?: string[];
}

const QUERIES: Q[] = [
  // ── exact lexical: FTS should be decisive ──────────────────────────────
  { q: 'password', kind: 'exact-lexical', relevant: ['How to reset your password'] },
  { q: 'invoice', kind: 'exact-lexical', relevant: ['Why my invoice is not showing'] },
  { q: 'recurring report', kind: 'exact-lexical', relevant: ['Scheduling a recurring report'] },
  { q: 'duplicate records import', kind: 'exact-lexical', relevant: ['Duplicate records after an import'] },

  // ── lexical phrases ────────────────────────────────────────────────────
  { q: 'export failing', kind: 'lexical', relevant: ['Fixing failed report exports'] },
  { q: 'account locked', kind: 'lexical', relevant: ['Account locked after failed sign-in attempts'] },
  { q: 'add a user', kind: 'lexical', relevant: ['Adding a new user to your organisation'] },
  { q: 'application slow', kind: 'lexical', relevant: ['The application is slow to load'] },

  // ── typos: trigram is the only strategy that can recover these ─────────
  { q: 'passwrd rest', kind: 'typo', relevant: ['How to reset your password'] },
  { q: 'duplicat recrds', kind: 'typo', relevant: ['Duplicate records after an import'] },
  { q: 'slow aplication', kind: 'typo', relevant: ['The application is slow to load'] },
  { q: 'invoce missing', kind: 'typo', relevant: ['Why my invoice is not showing'] },
  { q: 'recuring reprot', kind: 'typo', relevant: ['Scheduling a recurring report'] },

  // ── semantic paraphrase: little or no lexical overlap ──────────────────
  { q: 'I forgot my login details and cannot get in', kind: 'semantic', relevant: ['How to reset your password'], related: ['Account locked after failed sign-in attempts'] },
  { q: 'everything appears twice after I uploaded the csv', kind: 'semantic', relevant: ['Duplicate records after an import'] },
  { q: 'pages take forever to come up this morning', kind: 'semantic', relevant: ['The application is slow to load'] },
  { q: 'can I make it send me this every monday automatically', kind: 'semantic', relevant: ['Scheduling a recurring report'] },
  { q: 'where is my bill for last month', kind: 'semantic', relevant: ['Why my invoice is not showing'] },
  { q: 'we hired someone new last week', kind: 'semantic', relevant: ['Adding a new user to your organisation'] },

  // ── mixed lexical + semantic ───────────────────────────────────────────
  { q: 'report export keeps timing out when I download it', kind: 'mixed', relevant: ['Fixing failed report exports'], related: ['Timeouts when saving large forms'] },
  { q: 'too many wrong sign-in tries and now I am blocked', kind: 'mixed', relevant: ['Account locked after failed sign-in attempts'], related: ['How to reset your password'] },
  { q: 'the dashboard total disagrees with the exported figures', kind: 'mixed', relevant: ['Totals do not match the dashboard'], related: ['Why my export is missing recent rows'] },

  // ── genuinely ambiguous: several answers are defensible ────────────────
  { q: 'cannot sign in', kind: 'ambiguous', relevant: ['How to reset your password', 'Account locked after failed sign-in attempts'] },
  { q: 'my numbers look wrong', kind: 'ambiguous', relevant: ['Totals do not match the dashboard', 'Duplicate records after an import', 'Why my export is missing recent rows'] },

  // ── negative: nothing in the corpus answers these ──────────────────────
  { q: 'how do I renew my passport at the embassy', kind: 'negative', relevant: [] },
  { q: 'best recipe for sourdough bread starter', kind: 'negative', relevant: [] },
];

async function embed(text: string): Promise<number[]> {
  const path = '/v1/execute';
  const body = JSON.stringify({
    feature: 'embedding',
    request_id: `eval_${randomUUID()}`,
    input: { subject: null, description: text },
  });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomUUID();
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
  if (!res.ok) throw new Error(`embed HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as { data: { vector: number[] } }).data.vector;
}

interface Scored {
  title: string;
  key: string;
}

async function main(): Promise<void> {
  const client = new pg.Client({ connectionString: env.CORE_DATABASE_URL });
  await client.connect();
  await client.query('BEGIN');
  await client.query(
    `SELECT set_config('app.product_scope',$1,true), set_config('app.role','agent',true),
            set_config('app.request_id','eval',true)`,
    [PRODUCT],
  );

  const strategies = ['fts', 'trigram', 'vector', 'hybrid'] as const;
  type S = (typeof strategies)[number];
  const top: Record<S, [number, number, number]> = {
    fts: [0, 0, 0],
    trigram: [0, 0, 0],
    vector: [0, 0, 0],
    hybrid: [0, 0, 0],
  };
  // Negative queries are scored the opposite way: returning NOTHING is correct.
  const negOk: Record<S, number> = { fts: 0, trigram: 0, vector: 0, hybrid: 0 };
  let negTotal = 0;

  const byKind = new Map<Kind, Record<S, number>>();

  console.log(`\nProduct ${PRODUCT}   ${QUERIES.length} labelled queries`);
  console.log(`floors: vector >= ${VECTOR_SIMILARITY_FLOOR}, trigram > ${TRIGRAM_SIMILARITY_FLOOR}\n`);
  console.log('kind            fts  trg  vec  hyb   query');
  console.log('-------------- ---- ---- ---- ----   ------------------------------------');

  for (const spec of QUERIES) {
    const vec = await embed(spec.q);
    const lit = `[${vec.join(',')}]`;

    const ftsRows = await client.query<Scored & { score: string }>(
      `SELECT k.title, 'kb_article:'||k.id AS key, ts_rank(k.search_tsv, websearch_to_tsquery('english',$2)) AS score
         FROM kb_article k WHERE k.product_id=$1 AND k.status='published' AND k.is_public
           AND k.search_tsv @@ websearch_to_tsquery('english',$2)
        ORDER BY score DESC, k.id LIMIT $3`,
      [PRODUCT, spec.q, CANDIDATES_PER_STRATEGY],
    );
    const trgRows = await client.query<Scored & { score: string }>(
      `SELECT k.title, 'kb_article:'||k.id AS key, similarity(k.title,$2) AS score
         FROM kb_article k WHERE k.product_id=$1 AND k.status='published' AND k.is_public
           AND similarity(k.title,$2) > $4
        ORDER BY score DESC, k.id LIMIT $3`,
      [PRODUCT, spec.q, CANDIDATES_PER_STRATEGY, TRIGRAM_SIMILARITY_FLOOR],
    );
    const vecRows = await client.query<Scored & { score: string }>(
      `SELECT k.title, 'kb_article:'||k.id AS key, 1-(k.embedding <=> $2::vector) AS score
         FROM kb_article k WHERE k.product_id=$1 AND k.status='published' AND k.is_public
           AND k.embedding IS NOT NULL AND 1-(k.embedding <=> $2::vector) >= $4
        ORDER BY k.embedding <=> $2::vector, k.id LIMIT $3`,
      [PRODUCT, lit, CANDIDATES_PER_STRATEGY, VECTOR_SIMILARITY_FLOOR],
    );

    const titleOf = new Map<string, string>();
    for (const r of [...ftsRows.rows, ...trgRows.rows, ...vecRows.rows]) titleOf.set(r.key, r.title);

    // The SAME fusion the service uses, on the same candidate lists.
    const fused = fuseRankings({
      fts: ftsRows.rows.map((r) => r.key),
      trigram: trgRows.rows.map((r) => r.key),
      vector: vecRows.rows.map((r) => r.key),
    });
    const hybridRanked = [...fused.entries()]
      .sort((a, b) => (b[1].score !== a[1].score ? b[1].score - a[1].score : a[0] < b[0] ? -1 : 1))
      .map(([key]) => ({ key, title: titleOf.get(key)! }));

    const lists: Record<S, Array<{ title: string }>> = {
      fts: ftsRows.rows,
      trigram: trgRows.rows,
      vector: vecRows.rows,
      hybrid: hybridRanked,
    };

    const isNeg = spec.relevant.length === 0;
    if (isNeg) negTotal++;

    const cells: string[] = [];
    for (const s of strategies) {
      const titles = lists[s].map((r) => r.title);
      if (isNeg) {
        const ok = titles.length === 0;
        if (ok) negOk[s]++;
        cells.push(ok ? ' ok ' : ` ${titles.length} ✗`);
        continue;
      }
      const rank = titles.findIndex((t) => spec.relevant.includes(t)) + 1;
      if (rank === 1) top[s][0]++;
      if (rank >= 1 && rank <= 3) top[s][1]++;
      if (rank >= 1 && rank <= 5) top[s][2]++;
      cells.push(rank === 0 ? '  - ' : `  ${rank} `);

      const k = byKind.get(spec.kind) ?? { fts: 0, trigram: 0, vector: 0, hybrid: 0 };
      if (rank === 1) k[s]++;
      byKind.set(spec.kind, k);
    }
    console.log(`${spec.kind.padEnd(14)} ${cells.join(' ')}   ${spec.q.slice(0, 44)}`);
  }

  const positives = QUERIES.length - negTotal;
  const pct = (x: number, n: number) => `${((x / n) * 100).toFixed(0)}%`;

  console.log(`\n${positives} answerable queries — rank of the intended answer`);
  console.log('              Top-1    Top-3    Top-5');
  for (const s of strategies) {
    console.log(
      `${s.padEnd(10)} ${pct(top[s][0], positives).padStart(6)}   ${pct(top[s][1], positives).padStart(6)}   ${pct(top[s][2], positives).padStart(6)}   (${top[s].join('/')} of ${positives})`,
    );
  }

  console.log(`\n${negTotal} unanswerable queries — correct behaviour is returning NOTHING`);
  for (const s of strategies) {
    console.log(`${s.padEnd(10)} ${negOk[s]}/${negTotal} correct`);
  }

  console.log('\nTop-1 by query kind (where each strategy actually wins)');
  const kinds: Kind[] = ['exact-lexical', 'lexical', 'typo', 'semantic', 'mixed', 'ambiguous'];
  console.log('kind             n   fts  trg  vec  hyb');
  for (const kind of kinds) {
    const k = byKind.get(kind);
    if (!k) continue;
    const n = QUERIES.filter((q) => q.kind === kind).length;
    console.log(
      `${kind.padEnd(14)} ${String(n).padStart(2)}  ${String(k.fts).padStart(4)} ${String(k.trigram).padStart(4)} ${String(k.vector).padStart(4)} ${String(k.hybrid).padStart(4)}`,
    );
  }

  await client.query('COMMIT');
  await client.end();
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
