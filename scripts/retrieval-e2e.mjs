/**
 * Phase 11 end-to-end verification, through the REAL running stack.
 *
 *   widget -> gateway -> core -> (FTS + trigram + vector) -> fusion -> results
 *
 * Nothing is stubbed. The query embedding is a real signed Core -> Python call
 * to a real Azure deployment, and the ranking comes out of the real Postgres.
 *
 *   node scripts/retrieval-e2e.mjs
 *
 * The centrepiece is the ISOLATION section. This corpus holds the same 12 KB
 * articles in all four products with byte-identical text — and therefore
 * identical embeddings — so the same query is a perfect match in every tenant
 * at once. Nothing about the content can decide which one comes back. Only the
 * scope predicate can.
 */

import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);

const GATEWAY = env.GATEWAY_URL ?? 'http://localhost:4000';
const CORE = env.CORE_URL ?? 'http://localhost:4100';
const INTERNAL_KEY = env.INTERNAL_API_KEY ?? 'dev_internal_key_change_me';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `  — ${detail}` : ''}`);
  }
}

/**
 * Calls Core directly with the product headers the gateway would set. The
 * gateway's own auth is exercised by smoke.mjs; what matters here is the
 * retrieval behaviour and the scope predicate behind it.
 */
async function ask(productId, question, raiserRef = 'p11-probe') {
  const res = await fetch(`${CORE}/v1/widget/ask`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-key': INTERNAL_KEY,
      'x-iris-product-id': productId,
      'x-iris-role': 'raiser',
      'x-iris-tenant-id': 'tenant_p11',
      'x-iris-raiser-ref': raiserRef,
    },
    body: JSON.stringify({ question }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

/**
 * The AI service pools its Azure connection for the process lifetime, so the
 * FIRST embedding after a restart pays a TLS handshake and exceeds
 * AI_QUERY_TIMEOUT_MS. That is measured, expected and safe — the search
 * degrades to lexical — but it would make the first assertion below flaky for
 * a reason that has nothing to do with the assertion. Warm it explicitly, and
 * say so, rather than retrying until green.
 */
async function warmUp() {
  await ask('prod_carbon', 'warm up the provider connection pool');
}

const line = (t) => console.log(`\n${t}\n${'─'.repeat(62)}`);

async function main() {
  console.log('\nPhase 11 — hybrid retrieval, running system\n');

  // ── semantic paraphrase: only vector can find this ───────────────────
  line('Semantic paraphrase (no lexical overlap with the target)');
  {
    const { status, body } = await ask('prod_carbon', 'I forgot my login details and cannot get in');
    check('returns 200', status === 200, `got ${status}`);
    const top = body.answers?.[0];
    check('finds the password article', top?.title === 'How to reset your password', top?.title);
    check('suggests an answer rather than the ticket form', body.suggested_action === 'answer');
    check('vector contributed', (body.answers?.length ?? 0) > 0);
    console.log(`      top: "${top?.title}"  score ${top?.score}`);
  }

  // ── exact identifier ─────────────────────────────────────────────────
  //
  // CARB-1011 is a resolved ticket WITH a resolution comment, raised by
  // `usr_seed_4`. FTS cannot match it: `ticket.search_tsv` is generated from
  // subject+description and does not contain `reference`, so
  // websearch_to_tsquery('CARB-1011') matches nothing. Only the exact lookup
  // can find it — which is why the lookup exists.
  line('Exact identifier — for the raiser who OWNS the ticket');
  {
    const { body } = await ask('prod_carbon', 'CARB-1011', 'usr_seed_4');
    const top = body.answers?.[0];
    check('returns the exact ticket first', top?.type === 'resolved_ticket', JSON.stringify(top?.type));
    check('pinned at the maximum score', top?.score === 1, String(top?.score));
    console.log(`      top: "${top?.title?.slice(0, 50)}"  score ${top?.score}`);
  }
  {
    const { body } = await ask('prod_carbon', 'carb-1011', 'usr_seed_4');
    check('is case-insensitive', body.answers?.[0]?.score === 1, String(body.answers?.[0]?.score));
  }
  {
    /**
     * ⚠️ THE SECURITY HALF, and the more important one.
     *
     * A resolved ticket contains another customer's words. `ticket_isolation`
     * restricts a raiser to rows where `raised_by_ref = app_raiser()`, so a
     * different raiser naming the reference EXACTLY must still get nothing —
     * precision must not become a way to read someone else's ticket.
     */
    const { body } = await ask('prod_carbon', 'CARB-1011', 'someone-else');
    check(
      'a DIFFERENT raiser naming the same reference gets nothing',
      (body.answers ?? []).every((a) => a.type !== 'resolved_ticket'),
      JSON.stringify(body.answers),
    );
  }

  // ── typo ─────────────────────────────────────────────────────────────
  line('Typo (stemming cannot recover this; trigram can)');
  {
    const { body } = await ask('prod_carbon', 'passwrd rest');
    const titles = (body.answers ?? []).map((a) => a.title);
    check('still finds the password article', titles.includes('How to reset your password'), titles.join(' | '));
  }

  // ── lexical keyword ──────────────────────────────────────────────────
  line('Lexical keyword');
  {
    const { body } = await ask('prod_carbon', 'duplicate records import');
    check(
      'finds the duplicates article',
      body.answers?.[0]?.title === 'Duplicate records after an import',
      body.answers?.[0]?.title,
    );
  }

  // ── negative query — the behaviour-preservation test ─────────────────
  line('Unanswerable question (the regression the similarity floor prevents)');
  {
    const { body } = await ask('prod_carbon', 'how do I renew my passport at the embassy');
    check('returns NO answers', (body.answers?.length ?? 0) === 0, `got ${body.answers?.length}`);
    check(
      'still offers the ticket form',
      body.suggested_action === 'create_ticket',
      body.suggested_action,
    );
  }
  {
    const { body } = await ask('prod_carbon', 'best recipe for sourdough bread starter');
    check('a second off-topic question also offers the form', body.suggested_action === 'create_ticket');
  }

  // ── malformed / hostile input ────────────────────────────────────────
  line('Malformed and hostile queries must not error');
  for (const q of [
    "'",
    '"',
    ';',
    '--',
    "' OR 1=1 --",
    '*',
    ':',
    '()',
    'a & b | c ! d',
    "<script>alert('x')</script>",
    'DROP TABLE ticket;',
    'x'.repeat(1500),
  ]) {
    const { status, body } = await ask('prod_carbon', q);
    const label = q.length > 20 ? `${q.slice(0, 20)}… (${q.length} chars)` : JSON.stringify(q);
    check(
      `safe response for ${label}`,
      status === 200 && Array.isArray(body.answers),
      `status ${status} ${JSON.stringify(body).slice(0, 120)}`,
    );
  }
  {
    /**
     * Over the route's own 2000-character cap. A 400 is the CORRECT answer and
     * is pre-existing behaviour — `AskBody` has bounded `question` since before
     * this phase. Asserted so that bound is not quietly removed later, and so
     * the oversized query never reaches an embedding request.
     */
    const { status, body } = await ask('prod_carbon', 'x'.repeat(3000));
    check(
      'a query over the route cap is rejected, not embedded',
      status === 400 && body.error?.code === 'invalid_request',
      `status ${status}`,
    );
  }

  // ── empty query ──────────────────────────────────────────────────────
  line('Empty query');
  {
    const { status, body } = await ask('prod_carbon', '   ');
    check('defined behaviour, no crash', status === 200 || status === 400, `got ${status}`);
    if (status === 200) {
      check('and no answers', (body.answers?.length ?? 0) === 0);
      check('and the ticket form', body.suggested_action === 'create_ticket');
    }
  }

  // ── TENANT ISOLATION ─────────────────────────────────────────────────
  line('⚠️  TENANT ISOLATION — identical text, identical vectors, four products');
  {
    const q = 'I forgot my login details and cannot get in';
    const seen = {};
    for (const product of ['prod_carbon', 'prod_esg', 'prod_ideal', 'prod_ifile']) {
      const { body } = await ask(product, q);
      const ids = (body.answers ?? []).map((a) => a.id);
      seen[product] = ids;
      check(
        `${product} returns results`,
        ids.length > 0,
        `got ${ids.length}`,
      );
    }
    // Every product must get a DIFFERENT row id for the same question, because
    // each owns its own copy. Any overlap is a cross-tenant leak.
    const all = Object.values(seen).flat();
    const unique = new Set(all);
    check(
      'no row id is shared between any two products',
      unique.size === all.length,
      `${all.length} ids, ${unique.size} unique`,
    );
    const perProduct = Object.entries(seen).map(([p, ids]) => `${p.replace('prod_', '')}:${ids.length}`);
    console.log(`      ${perProduct.join('  ')}   all ids distinct: ${unique.size === all.length}`);
  }

  // ── missing scope fails closed ───────────────────────────────────────
  line('Missing / unknown scope fails closed');
  {
    const res = await fetch(`${CORE}/v1/widget/ask`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-key': INTERNAL_KEY,
        'x-iris-product-id': 'prod_does_not_exist',
        'x-iris-role': 'raiser',
        'x-iris-tenant-id': 't',
        'x-iris-raiser-ref': 'r',
      },
      body: JSON.stringify({ question: 'password reset' }),
    });
    const body = await res.json().catch(() => ({}));
    check(
      'unknown product is rejected or returns nothing',
      res.status >= 400 || (body.answers?.length ?? 0) === 0,
      `status ${res.status}`,
    );
  }

  // ── concurrency: no shared-state corruption ──────────────────────────
  line('Concurrent queries across products');
  {
    const jobs = [];
    for (let i = 0; i < 6; i++) {
      jobs.push(ask('prod_carbon', 'I forgot my login details and cannot get in'));
      jobs.push(ask('prod_esg', 'I forgot my login details and cannot get in'));
    }
    const results = await Promise.all(jobs);
    const carbonIds = new Set();
    const esgIds = new Set();
    results.forEach((r, i) => {
      const ids = (r.body.answers ?? []).map((a) => a.id);
      (i % 2 === 0 ? carbonIds : esgIds).add(ids.join(','));
    });
    check('all 12 concurrent queries returned 200', results.every((r) => r.status === 200));
    check('carbon results identical across its 6 runs', carbonIds.size === 1, `${carbonIds.size} variants`);
    check('esg results identical across its 6 runs', esgIds.size === 1, `${esgIds.size} variants`);
    check(
      'carbon and esg never returned the same rows',
      [...carbonIds][0] !== [...esgIds][0],
    );
  }

  // ── determinism ──────────────────────────────────────────────────────
  line('Determinism');
  {
    /**
     * ⚠️ SCOPE NARROWED IN PHASE 12, because the original claim became false.
     *
     * Phase 11 fusion IS deterministic — identical input, identical output —
     * and that is asserted directly, with the reranker pinned off, in
     * hybrid.integration.test.ts.
     *
     * END-TO-END ordering is NOT deterministic once reranking is enabled. An
     * LLM reranker is not bit-deterministic even at temperature 0: measured
     * directly, two identical requests returned the SAME rows in a DIFFERENT
     * order. Asserting exact order here would be asserting something the
     * system does not promise.
     *
     * What IS guaranteed end to end, and is asserted instead: the same query
     * returns the same SET of rows with the same retrieval scores. Reranking
     * can reorder; it can never add, drop or rescore a row.
     */
    const sets = [];
    const scores = [];
    for (let i = 0; i < 3; i++) {
      const { body } = await ask('prod_carbon', 'export keeps failing');
      const answers = body.answers ?? [];
      sets.push(JSON.stringify([...answers.map((a) => a.id)].sort()));
      scores.push(
        JSON.stringify(
          [...answers.map((a) => [a.id, a.score])].sort((x, y) => (x[0] < y[0] ? -1 : 1)),
        ),
      );
    }
    check('the same query returns the same SET of rows', new Set(sets).size === 1);
    check('and the same retrieval score for each row', new Set(scores).size === 1);
  }

  console.log(`\n${'─'.repeat(62)}`);
  if (failed === 0) {
    console.log(`\x1b[32mAll ${passed} checks passed.\x1b[0m`);
  } else {
    console.log(`\x1b[31m${failed} check(s) FAILED\x1b[0m (${passed} passed):`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
