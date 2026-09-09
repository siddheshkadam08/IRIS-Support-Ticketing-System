import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EMBEDDING_DIM, EMBEDDING_MODEL_ID, type KbArticleAdminDTO } from '@iris/shared/types';
import { buildServer } from '../server.js';
import { config } from '../config.js';
import { closePool } from '../db/pool.js';
import { withScope, withSystemScope, type Tx } from '../db/with-scope.js';
import { applyEmbedding, selectPending } from '../embeddings/embedding.repo.js';
import { ftsArticles, vectorArticles } from '../retrieval/hybrid.repo.js';
import { getArticle, listArticles } from './kb.repo.js';

/**
 * KB authoring and lifecycle, against the REAL Postgres — Phase 18.
 *
 * Nothing here is mocked. RLS is genuinely enforcing, the migration-018 column
 * grants are genuinely refusing, `embedding_content_sha` is genuinely being
 * recomputed by the database, and the corpus predicates are the ones retrieval
 * actually uses — imported from hybrid.repo.ts rather than restated, so a
 * change to KB_CORPUS breaks this file instead of silently diverging from it.
 *
 *   npm run infra:up && npm run migrate
 *   npx vitest run core-service/src/knowledge-base
 *
 * ⚠️ WHY THE ASSERTIONS ARE POSITIVE CONTROLS.
 *
 * "Product B cannot see product A's article" passes trivially if the article
 * was never created, if the id was wrong, or if the endpoint 404s for everyone.
 * So every isolation test here first proves the SAME request succeeds for the
 * owner, using the same id in the same run. A negative on its own is not
 * evidence; a negative next to a positive is.
 */

const PRODUCT_A = 'prod_carbon';
const PRODUCT_B = 'prod_esg';

let app: Awaited<ReturnType<typeof buildServer>>;

// ─────────────────────────────────────────────────────────────────────────
// Callers — exactly the headers the gateway sets after authenticating
// ─────────────────────────────────────────────────────────────────────────

const headers = (role: string, scope: string, userId: string) => ({
  'x-internal-key': config.INTERNAL_API_KEY,
  'content-type': 'application/json',
  'x-iris-support-user-id': userId,
  'x-iris-role': role,
  'x-iris-scope': scope,
});

const agentA = () => headers('agent', PRODUCT_A, 'su_kb_agent_a');
const managerA = () => headers('manager', PRODUCT_A, 'su_kb_manager_a');
const adminA = () => headers('product_admin', PRODUCT_A, 'su_kb_admin_a');
const adminB = () => headers('product_admin', PRODUCT_B, 'su_kb_admin_b');
/**
 * A super admin carrying concrete scopes, which is what a real session holds:
 * `effectiveScopes` expands super_admin to every product id at login. It
 * matters for writes — `kb_isolation`'s WITH CHECK is
 * `product_id = ANY (app_scope())` with no super-admin escape, so a super admin
 * with an EMPTY scope header can read everything and write nothing.
 */
const superA = () => headers('super_admin', `${PRODUCT_A},${PRODUCT_B}`, 'su_kb_super');

// ─────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────

const made: string[] = [];

/**
 * Teardown runs as the OWNER, deliberately.
 *
 * `iris_app` has DELETE revoked on `kb_article` (006, deliberately left revoked
 * by 018 — archive is the delete). So the suite cannot clean up through the
 * pool it tests with, and this is the same reason `seed.ts` opens its own admin
 * connection. Needing this connection is itself evidence the revoke is real.
 */
const ADMIN_URL =
  process.env.ADMIN_DATABASE_URL ?? 'postgres://postgres:postgres_dev_pw@localhost:5432/iris';

async function purge(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const client = new pg.Client({ connectionString: ADMIN_URL, application_name: 'iris-kb-test' });
  await client.connect();
  try {
    await client.query(`DELETE FROM audit_event WHERE entity_type = 'kb_article' AND entity_id = ANY($1)`, [ids]);
    await client.query(`DELETE FROM kb_article WHERE id = ANY($1)`, [ids]);
  } finally {
    await client.end();
  }
}

const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystemScope('kb-test', fn);

/**
 * The scope an embedding WRITE must run in.
 *
 * ⚠️ NOT withSystemScope. `kb_isolation`'s WITH CHECK is
 * `product_id = ANY (app_scope())` with no super-admin escape, and system scope
 * carries an EMPTY scope — so a write under it is refused by RLS. That is not a
 * quirk of this test: `embedding.service.ts` resolves the owning product under
 * system scope and then re-scopes to that one product before writing, for
 * exactly this reason. Mirroring it here means the suite exercises the real
 * path rather than a privileged shortcut around it.
 */
const asOwner = <T>(productId: string, fn: (tx: Tx) => Promise<T>): Promise<T> =>
  withScope({ productScope: [productId], role: 'none', requestId: 'kb-test-embed' }, fn);
const asRole = <T>(role: 'product' | 'raiser' | 'none', productId: string, fn: (tx: Tx) => Promise<T>) =>
  withScope({ productScope: [productId], role, raiserRef: 'kb-test-raiser', requestId: 'kb-test' }, fn);

/** A deterministic, non-degenerate unit vector, as the embedding suite uses. */
const vector = (seed: number): number[] => {
  const v = new Array<number>(EMBEDDING_DIM).fill(0);
  v[seed % EMBEDDING_DIM] = 1;
  return v;
};

/** A phrase unlikely to collide with the 48 seeded articles. */
const MARKER = `zylotrix${Math.random().toString(36).slice(2, 8)}`;

async function create(
  hdrs: Record<string, string>,
  over: Record<string, unknown> = {},
): Promise<{ status: number; body: KbArticleAdminDTO & { error?: { code: string; message: string } } }> {
  const res = await app.inject({
    method: 'POST',
    url: '/admin/api/kb/articles',
    headers: hdrs,
    payload: JSON.stringify({
      product_id: PRODUCT_A,
      title: `${MARKER} widget calibration drift`,
      body: `The ${MARKER} calibration routine drifts when the sensor is cold. Warm the unit for ten minutes before calibrating.`,
      category: 'hardware',
      ...over,
    }),
  });
  const body = res.json();
  if (res.statusCode === 201) made.push(body.id);
  return { status: res.statusCode, body };
}

const getArticleAdmin = (hdrs: Record<string, string>, id: string) =>
  app.inject({ method: 'GET', url: `/admin/api/kb/articles/${id}`, headers: hdrs });

const patchArticle = (hdrs: Record<string, string>, id: string, payload: unknown) =>
  app.inject({
    method: 'PATCH',
    url: `/admin/api/kb/articles/${id}`,
    headers: hdrs,
    payload: JSON.stringify(payload),
  });

const setStatus = (hdrs: Record<string, string>, id: string, status: string) =>
  app.inject({
    method: 'PATCH',
    url: `/admin/api/kb/articles/${id}/status`,
    headers: hdrs,
    payload: JSON.stringify({ status }),
  });

const listKb = (hdrs: Record<string, string>, qs = '') =>
  app.inject({ method: 'GET', url: `/admin/api/kb/articles${qs}`, headers: hdrs });

/** Rows the article's own product would rank through the real FTS corpus query. */
async function corpusHits(productId: string, id: string): Promise<boolean> {
  const hits = await sys((tx) => ftsArticles(tx, { productId, query: MARKER, limit: 20 }));
  return hits.some((h) => h.source_id === id);
}

async function auditRows(id: string): Promise<Array<{ action: string; before: unknown; after: unknown }>> {
  return sys(async (tx) => {
    const { rows } = await tx.query<{ action: string; before: unknown; after: unknown }>(
      `SELECT action, before, after FROM audit_event
        WHERE entity_type = 'kb_article' AND entity_id = $1
        ORDER BY occurred_at, id`,
      [id],
    );
    return rows;
  });
}

async function raw(id: string) {
  return sys(async (tx) => {
    const { rows } = await tx.query<{
      status: string;
      views: number;
      embedding_content_sha: string;
      embedding_fingerprint: string | null;
      has_embedding: boolean;
      product_id: string;
    }>(
      `SELECT status, views, embedding_content_sha, embedding_fingerprint, product_id,
              (embedding IS NOT NULL) AS has_embedding
         FROM kb_article WHERE id = $1`,
      [id],
    );
    return rows[0]!;
  });
}

beforeAll(async () => {
  app = await buildServer();
});

afterAll(async () => {
  await app.close();
  await purge(made);
  await closePool();
});

// ═══════════════════════════════════════════════════════════════════════
// Creation
// ═══════════════════════════════════════════════════════════════════════

describe('creation always lands in draft', () => {
  it('an agent can create, and the article is a draft', async () => {
    const { status, body } = await create(agentA());
    expect(status).toBe(201);
    expect(body.status).toBe('draft');
    expect(body.product_id).toBe(PRODUCT_A);
    expect(body.body).toContain(MARKER);
    // Not eligible for the corpus, so it has no index state at all.
    expect(body.index_state).toBeNull();
  });

  /**
   * The repository writes 'draft' as a SQL LITERAL, so this cannot be defeated
   * by any value a caller sends. Asserted rather than assumed, because the zod
   * schema stripping the key and the SQL ignoring it are two different
   * guarantees and only one of them is visible in the route.
   */
  it('a status supplied by the caller is ignored, not honoured', async () => {
    const { status, body } = await create(agentA(), { status: 'published' });
    expect(status).toBe(201);
    expect(body.status).toBe('draft');
    expect((await raw(body.id)).status).toBe('draft');
  });

  it('rejects an empty title and an over-long one', async () => {
    expect((await create(agentA(), { title: '   ' })).status).toBe(400);
    expect((await create(agentA(), { title: 'x'.repeat(201) })).status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// A draft reaches no customer and no retrieval strategy
// ═══════════════════════════════════════════════════════════════════════

describe('a draft is invisible outside staff', () => {
  let id: string;

  beforeAll(async () => {
    id = (await create(agentA())).body.id;
  });

  it('staff can read it (the positive control)', async () => {
    const res = await getArticleAdmin(adminA(), id);
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(id);
  });

  it('RLS hides it from an integrating product', async () => {
    const rows = await asRole('product', PRODUCT_A, (tx) =>
      tx.query(`SELECT id FROM kb_article WHERE id = $1`, [id]),
    );
    expect(rows.rowCount).toBe(0);
  });

  it('RLS hides it from an end user', async () => {
    const rows = await asRole('raiser', PRODUCT_A, (tx) =>
      tx.query(`SELECT id FROM kb_article WHERE id = $1`, [id]),
    );
    expect(rows.rowCount).toBe(0);
  });

  it('the widget-facing repository does not list it', async () => {
    const listed = await asRole('product', PRODUCT_A, (tx) => listArticles(tx, { limit: 50 }));
    expect(listed.map((a) => a.id)).not.toContain(id);
  });

  it('it is not in KB_CORPUS, so no retrieval strategy can rank it', async () => {
    expect(await corpusHits(PRODUCT_A, id)).toBe(false);
  });

  it('the embedding sweep does not offer it', async () => {
    const pending = await sys((tx) => selectPending(tx, { model: EMBEDDING_MODEL_ID, limit: 32 }));
    expect(pending.map((p) => p.subject_id)).not.toContain(id);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// The lifecycle, end to end, on one article
// ═══════════════════════════════════════════════════════════════════════

describe('the full lifecycle against the real corpus and the real sweep', () => {
  let id: string;
  let shaAtPublish: string;

  beforeAll(async () => {
    id = (await create(agentA())).body.id;
  });

  it('an agent cannot publish', async () => {
    const res = await setStatus(agentA(), id, 'published');
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('forbidden');
    expect((await raw(id)).status).toBe('draft');
  });

  it('a manager can publish (the positive control for the same request)', async () => {
    const res = await setStatus(managerA(), id, 'published');
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('published');
  });

  it('publishing puts it in KB_CORPUS immediately', async () => {
    expect(await corpusHits(PRODUCT_A, id)).toBe(true);
  });

  it('and the widget-facing repository now lists it', async () => {
    const listed = await asRole('product', PRODUCT_A, (tx) => listArticles(tx, { limit: 50 }));
    expect(listed.map((a) => a.id)).toContain(id);
  });

  /**
   * ⚠️ THE STATE THE UI EXISTS TO SHOW. The article is live and searchable by
   * two of the three strategies, and the vector strategy has never seen it.
   */
  it('index state is pending: live in text search, absent from vector search', async () => {
    const dto = getArticleAdmin(adminA(), id);
    expect((await dto).json().index_state).toBe('pending');
  });

  it('the existing embedding sweep now offers it, with no event and no queue', async () => {
    const pending = await sys((tx) => selectPending(tx, { model: EMBEDDING_MODEL_ID, limit: 32 }));
    const item = pending.find((p) => p.subject_id === id);
    expect(item).toBeDefined();
    expect(item!.subject_type).toBe('kb_article');
    expect(item!.text).toContain(MARKER);
    shaAtPublish = item!.fingerprint;
  });

  it('applying a vector through the existing writer makes it indexed', async () => {
    const ok = await asOwner(PRODUCT_A, (tx) =>
      applyEmbedding(tx, {
        subjectType: 'kb_article',
        subjectId: id,
        productId: PRODUCT_A,
        fingerprint: shaAtPublish,
        vector: vector(7),
        model: EMBEDDING_MODEL_ID,
      }),
    );
    expect(ok).toBe(true);
    expect((await getArticleAdmin(adminA(), id)).json().index_state).toBe('indexed');
  });

  it('and vector retrieval can now reach it', async () => {
    const hits = await sys((tx) =>
      vectorArticles(tx, { productId: PRODUCT_A, vector: vector(7), limit: 10 }),
    );
    expect(hits.map((h) => h.source_id)).toContain(id);
  });

  it('the sweep stops offering it once it is current', async () => {
    const pending = await sys((tx) => selectPending(tx, { model: EMBEDDING_MODEL_ID, limit: 32 }));
    expect(pending.map((p) => p.subject_id)).not.toContain(id);
  });

  // ── editing a published article ──────────────────────────────────────

  it('an agent cannot edit it now that it is published', async () => {
    const res = await patchArticle(agentA(), id, { title: 'agent rewrite' });
    expect(res.statusCode).toBe(403);
  });

  it('a manager can edit it, and the generated content hash moves', async () => {
    const before = await raw(id);
    const res = await patchArticle(managerA(), id, {
      body: `The ${MARKER} calibration routine drifts when the sensor is cold. Warm the unit for TWENTY minutes.`,
    });
    expect(res.statusCode).toBe(200);
    const after = await raw(id);
    expect(after.embedding_content_sha).not.toBe(before.embedding_content_sha);
  });

  it('the edit makes it pending again, with no code dispatching anything', async () => {
    expect((await getArticleAdmin(adminA(), id)).json().index_state).toBe('pending');
    const pending = await sys((tx) => selectPending(tx, { model: EMBEDDING_MODEL_ID, limit: 32 }));
    expect(pending.map((p) => p.subject_id)).toContain(id);
  });

  it('re-embedding the edited text returns it to indexed', async () => {
    const sha = (await raw(id)).embedding_content_sha;
    await asOwner(PRODUCT_A, (tx) =>
      applyEmbedding(tx, {
        subjectType: 'kb_article',
        subjectId: id,
        productId: PRODUCT_A,
        fingerprint: sha,
        vector: vector(11),
        model: EMBEDDING_MODEL_ID,
      }),
    );
    expect((await getArticleAdmin(adminA(), id)).json().index_state).toBe('indexed');
  });

  // ── withdrawal ───────────────────────────────────────────────────────

  it('unpublishing removes it from KB_CORPUS in the same instant', async () => {
    expect(await corpusHits(PRODUCT_A, id)).toBe(true); // positive control
    const res = await setStatus(managerA(), id, 'draft');
    expect(res.statusCode).toBe(200);
    expect(await corpusHits(PRODUCT_A, id)).toBe(false);
  });

  it('and from vector retrieval too', async () => {
    const hits = await sys((tx) =>
      vectorArticles(tx, { productId: PRODUCT_A, vector: vector(11), limit: 10 }),
    );
    expect(hits.map((h) => h.source_id)).not.toContain(id);
  });

  it('the vector is retained, not cleared, so a restore costs nothing', async () => {
    expect((await raw(id)).has_embedding).toBe(true);
  });

  it('an unpublished article has no index state, rather than a misleading one', async () => {
    expect((await getArticleAdmin(adminA(), id)).json().index_state).toBeNull();
  });

  it('archiving withdraws identically', async () => {
    await setStatus(managerA(), id, 'published');
    expect(await corpusHits(PRODUCT_A, id)).toBe(true); // positive control
    const res = await setStatus(managerA(), id, 'archived');
    expect(res.statusCode).toBe(200);
    expect(await corpusHits(PRODUCT_A, id)).toBe(false);
  });

  it('an archived article cannot be published directly', async () => {
    const res = await setStatus(managerA(), id, 'published');
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('invalid_state_transition');
    expect(res.json().error.message).toMatch(/draft/i);
    expect((await raw(id)).status).toBe('archived');
  });

  it('an archived article cannot be edited, by anyone', async () => {
    for (const who of [managerA(), adminA(), superA()]) {
      const res = await patchArticle(who, id, { title: `${MARKER} rewritten` });
      expect(res.statusCode).toBe(409);
    }
  });

  it('restoring through draft republishes, and the retained vector is still current', async () => {
    expect((await setStatus(managerA(), id, 'draft')).statusCode).toBe(200);
    expect((await setStatus(managerA(), id, 'published')).statusCode).toBe(200);

    // No re-embedding was needed: the text never changed while it was away.
    expect((await getArticleAdmin(adminA(), id)).json().index_state).toBe('indexed');
    const pending = await sys((tx) => selectPending(tx, { model: EMBEDDING_MODEL_ID, limit: 32 }));
    expect(pending.map((p) => p.subject_id)).not.toContain(id);
  });

  it('re-publishing an already-published article is refused, not silently repeated', async () => {
    const res = await setStatus(managerA(), id, 'published');
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/already published/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Views
// ═══════════════════════════════════════════════════════════════════════

describe('the admin read has no view-count side effect', () => {
  it('reading through the editor five times leaves views untouched', async () => {
    const id = (await create(agentA())).body.id;
    const before = (await raw(id)).views;
    for (let i = 0; i < 5; i++) expect((await getArticleAdmin(adminA(), id)).statusCode).toBe(200);
    expect((await raw(id)).views).toBe(before);
  });

  /**
   * The positive control, and a regression guard on the OTHER repository: the
   * customer-facing read still counts, so the two paths are genuinely different
   * rather than both having been neutered.
   */
  it('but the customer-facing read still counts a view', async () => {
    const id = (await create(agentA())).body.id;
    await setStatus(managerA(), id, 'published');
    const before = (await raw(id)).views;
    await asRole('product', PRODUCT_A, (tx) => getArticle(tx, id));
    expect((await raw(id)).views).toBe(before + 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Product isolation
// ═══════════════════════════════════════════════════════════════════════

describe('product isolation, each with a positive control', () => {
  let idA: string;

  beforeAll(async () => {
    idA = (await create(agentA())).body.id;
    await setStatus(managerA(), idA, 'published');

    /**
     * One article of PRODUCT_A in each state, so the status filters below have
     * data behind them. A `?status=archived` sweep that returns nothing proves
     * nothing about isolation — it passes just as happily when the endpoint is
     * broken.
     */
    const draft = (await create(agentA())).body.id;
    expect((await raw(draft)).status).toBe('draft');
    const archived = (await create(agentA())).body.id;
    await setStatus(managerA(), archived, 'published');
    await setStatus(managerA(), archived, 'archived');
  });

  it('SEC-1 product B cannot read product A article; product A can', async () => {
    expect((await getArticleAdmin(adminA(), idA)).statusCode).toBe(200);
    const res = await getArticleAdmin(adminB(), idA);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('ticket_not_found');
  });

  it('SEC-2 product B cannot update it; product A can', async () => {
    expect((await patchArticle(adminA(), idA, { category: 'calibration' })).statusCode).toBe(200);
    expect((await patchArticle(adminB(), idA, { category: 'stolen' })).statusCode).toBe(404);
    expect((await raw(idA)).product_id).toBe(PRODUCT_A);
  });

  it('SEC-3 product B cannot transition it; product A can', async () => {
    expect((await setStatus(adminB(), idA, 'archived')).statusCode).toBe(404);
    expect((await raw(idA)).status).toBe('published');
    expect((await setStatus(adminA(), idA, 'draft')).statusCode).toBe(200);
    await setStatus(adminA(), idA, 'published');
  });

  it('SEC-4 creating into another tenant is refused before the insert', async () => {
    const res = await create(adminA(), { product_id: PRODUCT_B });
    expect(res.status).toBe(404);
    // Nothing was written: product B gained no article with this run's marker.
    const leaked = await sys(async (tx) => {
      const { rows } = await tx.query(
        `SELECT id FROM kb_article WHERE product_id = $1 AND title LIKE $2`,
        [PRODUCT_B, `%${MARKER}%`],
      );
      return rows.length;
    });
    expect(leaked).toBe(0);
  });

  it('SEC-11 the refusal never names the other tenant', async () => {
    const res = await getArticleAdmin(adminB(), idA);
    const text = JSON.stringify(res.json());
    expect(text).not.toContain(PRODUCT_A);
    expect(text).not.toContain('carbon');
  });

  /**
   * SEC-7. The filter surface is where a leak would actually appear, so this
   * sweeps combinations rather than checking one.
   */
  it('SEC-7 no filter combination leaks another tenant', async () => {
    /**
     * Each of these is expected to MATCH something for PRODUCT_A, so a clean
     * pass means "the filter ran, returned rows, and every row was ours" rather
     * than "the filter returned nothing". `?q=%25` is deliberately excluded and
     * asserted separately: a literal '%' is supposed to match nothing.
     */
    const queries = [
      '',
      '?limit=100',
      '?limit=100&offset=0',
      '?status=published&limit=100',
      '?status=draft&limit=100',
      '?status=archived&limit=100',
      `?q=${MARKER}&limit=100`,
      '?q=the&limit=100&offset=0',
      `?product_id=${PRODUCT_A}&limit=100`,
      `?product_id=${PRODUCT_A}&status=published&q=${MARKER}&limit=100&offset=0`,
    ];
    for (const qs of queries) {
      const res = await listKb(adminA(), qs);
      expect(res.statusCode, qs).toBe(200);
      const rows: KbArticleAdminDTO[] = res.json().data;
      expect(rows.length, `expected rows for ${qs}`).toBeGreaterThan(0);
      for (const r of rows) expect(r.product_id, qs).toBe(PRODUCT_A);
    }
  });

  it('SEC-7 an out-of-scope product filter is refused, not silently emptied', async () => {
    const res = await listKb(adminA(), `?product_id=${PRODUCT_B}`);
    expect(res.statusCode).toBe(404);
  });

  it('a super admin holding both tenants sees both', async () => {
    const res = await listKb(superA(), '?limit=100');
    expect(res.statusCode).toBe(200);
    const products = new Set(res.json().data.map((r: KbArticleAdminDTO) => r.product_id));
    expect(products.has(PRODUCT_A)).toBe(true);
    expect(products.has(PRODUCT_B)).toBe(true);
  });

  /**
   * Without escaping, `%` in the search box becomes a LIKE wildcard and the
   * "search" silently returns the entire knowledge base. The value is bound
   * either way, so this is not an injection — it is a filter that means
   * something other than what was typed, which is worse for being invisible.
   */
  it('a LIKE wildcard typed into search is a literal, not a match-everything', async () => {
    const everything = (await listKb(adminA(), '?limit=100')).json();
    const wildcard = (await listKb(adminA(), '?q=%25&limit=100')).json();
    const underscore = (await listKb(adminA(), '?q=_&limit=100')).json();

    expect(everything.total).toBeGreaterThan(0);
    expect(wildcard.total).toBe(0);
    expect(underscore.total).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// The tenant column is not writable, at the database
// ═══════════════════════════════════════════════════════════════════════

describe('SEC-8 product_id cannot be changed', () => {
  let id: string;

  beforeAll(async () => {
    id = (await create(agentA())).body.id;
  });

  it('the API rejects the field rather than ignoring it', async () => {
    const res = await patchArticle(adminA(), id, { product_id: PRODUCT_B });
    expect(res.statusCode).toBe(400);
    expect((await raw(id)).product_id).toBe(PRODUCT_A);
  });

  /**
   * ⚠️ THE ASSERTION THAT ACTUALLY MATTERS. Removing a key from a zod schema is
   * a convention; a revoked column privilege is a guarantee. This bypasses the
   * route entirely and issues the UPDATE the route refuses to build, through
   * the same pool and the same `iris_app` role the application uses.
   */
  it('and the database refuses the UPDATE even when the route is bypassed', async () => {
    await expect(
      withScope({ productScope: [PRODUCT_A, PRODUCT_B], role: 'super_admin', requestId: 'kb-sec8' }, (tx) =>
        tx.query(`UPDATE kb_article SET product_id = $2 WHERE id = $1`, [id, PRODUCT_B]),
      ),
    ).rejects.toThrow(/permission denied/i);

    expect((await raw(id)).product_id).toBe(PRODUCT_A);
  });

  it('is_public is likewise not writable by the application', async () => {
    await expect(
      withScope({ productScope: [PRODUCT_A], role: 'super_admin', requestId: 'kb-sec8b' }, (tx) =>
        tx.query(`UPDATE kb_article SET is_public = false WHERE id = $1`, [id]),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('and DELETE remains revoked, so archive is the only withdrawal', async () => {
    await expect(
      withScope({ productScope: [PRODUCT_A], role: 'super_admin', requestId: 'kb-sec8c' }, (tx) =>
        tx.query(`DELETE FROM kb_article WHERE id = $1`, [id]),
      ),
    ).rejects.toThrow(/permission denied/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Audit
// ═══════════════════════════════════════════════════════════════════════

describe('SEC-10 every mutation writes exactly one audit event', () => {
  it('create, edit and transition each add exactly one row, in order', async () => {
    const { body } = await create(agentA());
    const id = body.id;

    expect(await auditRows(id)).toHaveLength(1);
    expect((await auditRows(id))[0]!.action).toBe('kb_article.created');

    await patchArticle(agentA(), id, { title: `${MARKER} revised title` });
    expect(await auditRows(id)).toHaveLength(2);

    await setStatus(managerA(), id, 'published');
    const rows = await auditRows(id);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.action)).toEqual([
      'kb_article.created',
      'kb_article.updated',
      'kb_article.status_changed',
    ]);
  });

  it('a status change records the exact before and after states', async () => {
    const id = (await create(agentA())).body.id;
    await setStatus(managerA(), id, 'published');
    await setStatus(managerA(), id, 'archived');

    const rows = (await auditRows(id)).filter((r) => r.action === 'kb_article.status_changed');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.before).toMatchObject({ status: 'draft' });
    expect(rows[0]!.after).toMatchObject({ status: 'published' });
    expect(rows[1]!.before).toMatchObject({ status: 'published' });
    expect(rows[1]!.after).toMatchObject({ status: 'archived' });
  });

  it('an edit records the content hash on both sides, so the text is identifiable', async () => {
    const id = (await create(agentA())).body.id;
    await patchArticle(agentA(), id, { body: `${MARKER} completely different text entirely.` });

    const row = (await auditRows(id)).find((r) => r.action === 'kb_article.updated')!;
    const before = row.before as { content_sha: string; body_chars: number };
    const after = row.after as { content_sha: string; body_chars: number };
    expect(before.content_sha).toHaveLength(64);
    expect(after.content_sha).toHaveLength(64);
    expect(after.content_sha).not.toBe(before.content_sha);
  });

  /** A refused mutation must leave no trace claiming it happened. */
  it('a refused transition writes no audit row', async () => {
    const id = (await create(agentA())).body.id;
    const before = (await auditRows(id)).length;
    expect((await setStatus(agentA(), id, 'published')).statusCode).toBe(403);
    expect((await auditRows(id)).length).toBe(before);
  });

  it('a refused cross-tenant edit writes no audit row', async () => {
    const id = (await create(agentA())).body.id;
    const before = (await auditRows(id)).length;
    expect((await patchArticle(adminB(), id, { title: 'nope' })).statusCode).toBe(404);
    expect((await auditRows(id)).length).toBe(before);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Listing
// ═══════════════════════════════════════════════════════════════════════

describe('the list is paginated in SQL, not in the application', () => {
  it('total counts the whole filtered set while data holds one page', async () => {
    const res = await listKb(adminA(), '?limit=2');
    expect(res.statusCode).toBe(200);
    const payload = res.json();
    expect(payload.data.length).toBeLessThanOrEqual(2);
    expect(payload.total).toBeGreaterThan(payload.data.length);
    expect(payload.has_more).toBe(true);
  });

  it('offset advances without repeating a row', async () => {
    const first = (await listKb(adminA(), '?limit=3&offset=0')).json();
    const second = (await listKb(adminA(), '?limit=3&offset=3')).json();
    const overlap = first.data
      .map((r: KbArticleAdminDTO) => r.id)
      .filter((id: string) => second.data.some((r: KbArticleAdminDTO) => r.id === id));
    expect(overlap).toHaveLength(0);
  });

  it('orders by updated_at descending', async () => {
    const rows: KbArticleAdminDTO[] = (await listKb(adminA(), '?limit=20')).json().data;
    const stamps = rows.map((r) => Date.parse(r.updated_at));
    expect([...stamps].sort((a, b) => b - a)).toEqual(stamps);
  });

  it('the list never carries article bodies', async () => {
    const rows: KbArticleAdminDTO[] = (await listKb(adminA(), '?limit=20')).json().data;
    for (const r of rows) expect(r.body).toBeUndefined();
  });

  it('rejects a limit beyond the cap rather than silently clamping it', async () => {
    expect((await listKb(adminA(), '?limit=1000')).statusCode).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Existing behaviour is unchanged
// ═══════════════════════════════════════════════════════════════════════

describe('SEC-13 the seeded corpus is untouched by this phase', () => {
  it('all four tenants still hold their twelve published, embedded articles', async () => {
    const rows = await sys(async (tx) => {
      const { rows } = await tx.query<{ product_id: string; n: string; emb: string }>(
        `SELECT product_id, count(*) AS n, count(embedding) AS emb
           FROM kb_article
          WHERE status = 'published' AND is_public = true AND title NOT LIKE $1
          GROUP BY product_id ORDER BY product_id`,
        [`%${MARKER}%`],
      );
      return rows;
    });
    expect(rows).toHaveLength(4);
    for (const r of rows) {
      expect(Number(r.n)).toBe(12);
      expect(Number(r.emb)).toBe(12);
    }
  });

  it('SEC-12 RLS is still enabled and forced on kb_article', async () => {
    const row = await sys(async (tx) => {
      const { rows } = await tx.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'kb_article'`,
      );
      return rows[0]!;
    });
    expect(row.relrowsecurity).toBe(true);
    expect(row.relforcerowsecurity).toBe(true);
  });
});
