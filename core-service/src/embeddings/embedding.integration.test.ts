import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EMBEDDING_DIM, EMBEDDING_MODEL_ID } from '@iris/shared/types';
import { closePool } from '../db/pool.js';
import { withScope, withSystemScope, type Tx } from '../db/with-scope.js';
import {
  applyEmbedding,
  embeddingStats,
  recordPermanentFailure,
  searchSimilarArticles,
  searchSimilarTickets,
  selectPending,
} from './embedding.repo.js';
import { applyEmbeddings } from './embedding.service.js';

/**
 * Embedding persistence and retrieval, against the REAL Postgres — Phase 10.
 *
 * Nothing here is mocked. The generated `embedding_content_sha` column is
 * genuinely computing hashes, RLS is genuinely enforcing, and `vector(1536)`
 * is genuinely rejecting anything of another width. That matters more than
 * usual for this feature, because almost every way an embedding corpus goes
 * wrong is SILENT: a NaN that never appears in a result, a stale vector that
 * looks current, a tenant predicate that was applied one step too late.
 *
 *   npm run infra:up && npm run migrate
 *   npx vitest run core-service/src/embeddings
 */

const PRODUCT_A = 'prod_carbon';
const PRODUCT_B = 'prod_esg';

const unit = (seed: number): number[] => {
  // A deterministic, non-degenerate vector. Not all-zeros, so it survives
  // validation, and seed-dependent so two of them are distinguishable.
  const v = new Array<number>(EMBEDDING_DIM).fill(0);
  v[seed % EMBEDDING_DIM] = 1;
  return v;
};

const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystemScope('emb-test', fn);
const scoped = <T>(productId: string, fn: (tx: Tx) => Promise<T>): Promise<T> =>
  withScope({ productScope: [productId], role: 'none', requestId: 'emb-test' }, fn);

/** A real ticket, created directly: this suite tests the repo, not the route. */
async function makeTicket(productId: string, subject: string, description: string) {
  const id = `tkt_test_${Math.random().toString(36).slice(2, 12)}`;
  await scoped(productId, (tx) =>
    tx.query(
      `INSERT INTO ticket (id, product_id, reference, product_tenant_id,
                           raised_by_ref, subject, description, status)
       VALUES ($1,$2,$3,'tenant_emb_test','emb-test',$4,$5,'resolved')`,
      [id, productId, `EMB-${id.slice(-8)}`, subject, description],
    ),
  );
  const sha = await scoped(productId, async (tx) => {
    const { rows } = await tx.query<{ s: string }>(
      `SELECT embedding_content_sha AS s FROM ticket WHERE id = $1`,
      [id],
    );
    return rows[0]!.s;
  });
  return { id, sha };
}

const created: string[] = [];

beforeAll(async () => {
  // Nothing to prepare; the corpus this suite needs, it makes.
});

afterAll(async () => {
  // Test tickets are real rows in a real table. Remove them so the corpus this
  // phase measured is the corpus that remains.
  for (const id of created) {
    await sys((tx) => tx.query(`DELETE FROM ticket WHERE id = $1`, [id]));
  }
  await closePool();
});

async function ticket(productId: string, subject: string, description: string) {
  const t = await makeTicket(productId, subject, description);
  created.push(t.id);
  return t;
}

// ═══════════════════════════════════════════════════════════════════════
// The generated fingerprint
// ═══════════════════════════════════════════════════════════════════════

describe('the content fingerprint is computed by Postgres', () => {
  it('is stable for identical text and different for different text', async () => {
    const a = await ticket(PRODUCT_A, 'Export fails', 'The nightly export returns a 500.');
    const b = await ticket(PRODUCT_A, 'Export fails', 'The nightly export returns a 500.');
    const c = await ticket(PRODUCT_A, 'Export fails', 'The nightly export returns a 404.');

    expect(a.sha).toBe(b.sha);
    expect(a.sha).not.toBe(c.sha);
    expect(a.sha).toMatch(/^[0-9a-f]{64}$/);
  });

  it('IGNORES reformatting — the property migration 016 exists to deliver', async () => {
    /**
     * ⚠️ This failed before 016. The original expression trimmed BEFORE
     * collapsing whitespace, and Postgres `trim()` strips spaces only — so a
     * trailing newline survived, became a trailing space, and changed the
     * hash. A reformat then cost a real, billed re-embedding.
     */
    const plain = await ticket(PRODUCT_A, 'Slow login', 'Users wait 30s to sign in.');
    const messy = await ticket(
      PRODUCT_A,
      '  Slow login\t',
      '\n\n Users   wait 30s\tto sign in. \n ',
    );
    expect(messy.sha).toBe(plain.sha);
  });

  it('changes when the SUBJECT changes, not only the description', async () => {
    const a = await ticket(PRODUCT_A, 'Login slow', 'Users wait 30s.');
    const b = await ticket(PRODUCT_A, 'Login broken', 'Users wait 30s.');
    expect(a.sha).not.toBe(b.sha);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Persistence
// ═══════════════════════════════════════════════════════════════════════

describe('applying a vector', () => {
  it('writes the vector, the fingerprint, the model and the timestamp', async () => {
    const t = await ticket(PRODUCT_A, 'Import duplicates', 'Every row appears twice.');
    const ok = await scoped(PRODUCT_A, (tx) =>
      applyEmbedding(tx, {
        subjectType: 'ticket',
        subjectId: t.id,
        productId: PRODUCT_A,
        fingerprint: t.sha,
        vector: unit(1),
        model: EMBEDDING_MODEL_ID,
      }),
    );
    expect(ok).toBe(true);

    const row = await scoped(PRODUCT_A, async (tx) => {
      const { rows } = await tx.query(
        `SELECT vector_dims(embedding) AS dims, embedding_fingerprint AS fp,
                embedding_model AS model, embedded_at IS NOT NULL AS stamped
           FROM ticket WHERE id = $1`,
        [t.id],
      );
      return rows[0]!;
    });
    expect(row.dims).toBe(EMBEDDING_DIM);
    expect(row.fp).toBe(t.sha);
    expect(row.model).toBe(EMBEDDING_MODEL_ID);
    expect(row.stamped).toBe(true);
  });

  it('⚠️ REFUSES a vector whose fingerprint no longer matches the row', async () => {
    /**
     * The race that matters. An item is read, sent to Azure, and comes back a
     * second later. If the ticket was edited in that window, writing the
     * vector would stamp the row with the NEW fingerprint while holding a
     * vector of the OLD text — and because the fingerprint would then match,
     * nothing would ever revisit it. A stale vector that looks current is
     * strictly worse than a missing one.
     */
    const t = await ticket(PRODUCT_A, 'Race', 'Original text.');

    await scoped(PRODUCT_A, (tx) =>
      tx.query(`UPDATE ticket SET description = 'Edited text, different meaning.' WHERE id = $1`, [
        t.id,
      ]),
    );

    const ok = await scoped(PRODUCT_A, (tx) =>
      applyEmbedding(tx, {
        subjectType: 'ticket',
        subjectId: t.id,
        productId: PRODUCT_A,
        fingerprint: t.sha, // the pre-edit fingerprint
        vector: unit(2),
        model: EMBEDDING_MODEL_ID,
      }),
    );

    expect(ok, 'the guard must bite').toBe(false);
    const still = await scoped(PRODUCT_A, async (tx) => {
      const { rows } = await tx.query(`SELECT embedding IS NULL AS empty FROM ticket WHERE id=$1`, [
        t.id,
      ]);
      return rows[0]!.empty;
    });
    expect(still, 'and the row must remain un-embedded, therefore pending').toBe(true);
  });

  it('cannot write across a tenant boundary', async () => {
    const t = await ticket(PRODUCT_A, 'Isolation', 'Belongs to product A.');
    const ok = await scoped(PRODUCT_B, (tx) =>
      applyEmbedding(tx, {
        subjectType: 'ticket',
        subjectId: t.id,
        productId: PRODUCT_B,
        fingerprint: t.sha,
        vector: unit(3),
        model: EMBEDDING_MODEL_ID,
      }),
    );
    expect(ok).toBe(false);
  });

  it('rejects a wrong-width vector at the DATABASE, not just in code', async () => {
    const t = await ticket(PRODUCT_A, 'Width', 'Dimension check.');
    await expect(
      scoped(PRODUCT_A, (tx) =>
        applyEmbedding(tx, {
          subjectType: 'ticket',
          subjectId: t.id,
          productId: PRODUCT_A,
          fingerprint: t.sha,
          vector: new Array(384).fill(0.1),
          model: EMBEDDING_MODEL_ID,
        }),
      ),
    ).rejects.toThrow(/expected 1536 dimensions/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// The service's validation boundary
// ═══════════════════════════════════════════════════════════════════════

describe('the service refuses to persist a corrupting vector', () => {
  it('rejects NaN before it can silently poison ranking', async () => {
    const t = await ticket(PRODUCT_A, 'NaN', 'Poison check.');
    const bad = unit(4);
    bad[10] = Number.NaN;

    const r = await applyEmbeddings([
      {
        subject_type: 'ticket',
        subject_id: t.id,
        fingerprint: t.sha,
        vector: bad,
        model: EMBEDDING_MODEL_ID,
      },
    ]);

    expect(r.applied).toBe(0);
    expect(r.skipped[0]?.reason).toContain('not finite');
  });

  it('rejects an all-zero vector', async () => {
    const t = await ticket(PRODUCT_A, 'Zeros', 'Zero check.');
    const r = await applyEmbeddings([
      {
        subject_type: 'ticket',
        subject_id: t.id,
        fingerprint: t.sha,
        vector: new Array(EMBEDDING_DIM).fill(0),
        model: EMBEDDING_MODEL_ID,
      },
    ]);
    expect(r.applied).toBe(0);
    expect(r.skipped[0]?.reason).toBe('vector is all zeros');
  });

  it('rejects a vector from a DIFFERENT model', async () => {
    /**
     * Two embedding spaces mixed in one column degrade every ranking in the
     * corpus, and look like nothing at all — no error, no NULL, just worse
     * results forever.
     */
    const t = await ticket(PRODUCT_A, 'Model', 'Model check.');
    const r = await applyEmbeddings([
      {
        subject_type: 'ticket',
        subject_id: t.id,
        fingerprint: t.sha,
        vector: unit(5),
        model: 'azure/text-embedding-3-large',
      },
    ]);
    expect(r.applied).toBe(0);
    expect(r.skipped[0]?.reason).toBe('model_mismatch');
  });

  it('one bad item does not cost the others their write', async () => {
    const good = await ticket(PRODUCT_A, 'Good', 'This one is fine.');
    const bad = await ticket(PRODUCT_A, 'Bad', 'This one is not.');
    const poison = unit(6);
    poison[0] = Number.POSITIVE_INFINITY;

    const r = await applyEmbeddings([
      {
        subject_type: 'ticket',
        subject_id: bad.id,
        fingerprint: bad.sha,
        vector: poison,
        model: EMBEDDING_MODEL_ID,
      },
      {
        subject_type: 'ticket',
        subject_id: good.id,
        fingerprint: good.sha,
        vector: unit(7),
        model: EMBEDDING_MODEL_ID,
      },
    ]);

    expect(r.applied).toBe(1);
    expect(r.skipped).toHaveLength(1);
  });

  it('reports an unknown subject rather than failing the batch', async () => {
    const r = await applyEmbeddings([
      {
        subject_type: 'ticket',
        subject_id: 'tkt_does_not_exist',
        fingerprint: 'f'.repeat(64),
        vector: unit(8),
        model: EMBEDDING_MODEL_ID,
      },
    ]);
    expect(r.applied).toBe(0);
    expect(r.skipped[0]?.reason).toBe('subject_not_found');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Pending, and the permanent-failure quarantine
// ═══════════════════════════════════════════════════════════════════════

describe('pending work', () => {
  it('offers an un-embedded resolved ticket and stops once it is embedded', async () => {
    const t = await ticket(PRODUCT_A, 'Pending', 'A distinctive pending marker string.');

    const before = await sys((tx) => selectPending(tx, { model: EMBEDDING_MODEL_ID, limit: 32 }));
    expect(before.some((i) => i.subject_id === t.id)).toBe(true);

    await applyEmbeddings([
      {
        subject_type: 'ticket',
        subject_id: t.id,
        fingerprint: t.sha,
        vector: unit(9),
        model: EMBEDDING_MODEL_ID,
      },
    ]);

    const after = await sys((tx) => selectPending(tx, { model: EMBEDDING_MODEL_ID, limit: 32 }));
    expect(after.some((i) => i.subject_id === t.id)).toBe(false);
  });

  it('offers it again after an edit, and NOT after a reformat', async () => {
    const t = await ticket(PRODUCT_A, 'Edit', 'The original description.');
    await applyEmbeddings([
      {
        subject_type: 'ticket',
        subject_id: t.id,
        fingerprint: t.sha,
        vector: unit(10),
        model: EMBEDDING_MODEL_ID,
      },
    ]);

    // A reformat must NOT make it pending.
    await scoped(PRODUCT_A, (tx) =>
      tx.query(`UPDATE ticket SET description = E'  The original    description.  \n' WHERE id=$1`, [
        t.id,
      ]),
    );
    let pending = await sys((tx) => selectPending(tx, { model: EMBEDDING_MODEL_ID, limit: 32 }));
    expect(pending.some((i) => i.subject_id === t.id)).toBe(false);

    // A real change must.
    await scoped(PRODUCT_A, (tx) =>
      tx.query(`UPDATE ticket SET description = 'Completely different text now.' WHERE id=$1`, [
        t.id,
      ]),
    );
    pending = await sys((tx) => selectPending(tx, { model: EMBEDDING_MODEL_ID, limit: 32 }));
    expect(pending.some((i) => i.subject_id === t.id)).toBe(true);
  });

  it('never offers an OPEN ticket — the corpus is resolved outcomes only', async () => {
    const t = await ticket(PRODUCT_A, 'Open', 'Still being worked on.');
    await scoped(PRODUCT_A, (tx) =>
      tx.query(`UPDATE ticket SET status = 'open' WHERE id = $1`, [t.id]),
    );
    const pending = await sys((tx) => selectPending(tx, { model: EMBEDDING_MODEL_ID, limit: 32 }));
    expect(pending.some((i) => i.subject_id === t.id)).toBe(false);
  });

  it('carries NO tenant identifier to the worker', async () => {
    await ticket(PRODUCT_A, 'Leak check', 'Nothing here should name a product.');
    const pending = await sys((tx) => selectPending(tx, { model: EMBEDDING_MODEL_ID, limit: 5 }));
    const raw = JSON.stringify(pending);
    expect(raw).not.toContain('prod_');
    expect(Object.keys(pending[0] ?? {})).toEqual([
      'subject_type',
      'subject_id',
      'text',
      'fingerprint',
    ]);
  });

  it('QUARANTINES a permanent failure and stops re-offering it', async () => {
    /**
     * Without this, a ticket Azure's content filter refuses would be
     * re-attempted every cycle forever — billing a provider call each time for
     * an answer that cannot change. That directly contradicts the platform's
     * own rule that permanent errors stop immediately.
     */
    const t = await ticket(PRODUCT_A, 'Filtered', 'Content the provider will always refuse.');

    const stamped = await scoped(PRODUCT_A, (tx) =>
      recordPermanentFailure(tx, {
        subjectType: 'ticket',
        subjectId: t.id,
        productId: PRODUCT_A,
        fingerprint: t.sha,
        code: 'provider_content_filter',
      }),
    );
    expect(stamped).toBe(true);

    const pending = await sys((tx) => selectPending(tx, { model: EMBEDDING_MODEL_ID, limit: 32 }));
    expect(pending.some((i) => i.subject_id === t.id)).toBe(false);

    // ...and editing the text clears the quarantine, with no operator action.
    await scoped(PRODUCT_A, (tx) =>
      tx.query(`UPDATE ticket SET description = 'Rewritten, entirely benign now.' WHERE id=$1`, [
        t.id,
      ]),
    );
    const after = await sys((tx) => selectPending(tx, { model: EMBEDDING_MODEL_ID, limit: 32 }));
    expect(after.some((i) => i.subject_id === t.id)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Retrieval
// ═══════════════════════════════════════════════════════════════════════

describe('similarity search', () => {
  it('ranks the closest vector first', async () => {
    const near = await ticket(PRODUCT_A, 'Near', 'Nearest neighbour probe.');
    const far = await ticket(PRODUCT_A, 'Far', 'Distant neighbour probe.');

    await applyEmbeddings([
      {
        subject_type: 'ticket',
        subject_id: near.id,
        fingerprint: near.sha,
        vector: unit(100),
        model: EMBEDDING_MODEL_ID,
      },
      {
        subject_type: 'ticket',
        subject_id: far.id,
        fingerprint: far.sha,
        vector: unit(900),
        model: EMBEDDING_MODEL_ID,
      },
    ]);

    const hits = await scoped(PRODUCT_A, (tx) =>
      searchSimilarTickets(tx, { vector: unit(100), productId: PRODUCT_A, limit: 3 }),
    );
    expect(hits[0]?.id).toBe(near.id);
    expect(hits[0]?.similarity).toBeCloseTo(1, 4);
  });

  it('⚠️ NEVER returns another tenant’s row, even on a PERFECT match', async () => {
    /**
     * The strongest form of the isolation question. The query vector is an
     * exact match for product B's row, so if ranking could ever surface it,
     * this is when. The tenant predicate is inside the query, before ORDER BY
     * and LIMIT — filtering afterwards would return fewer than k rows while
     * looking like a working search.
     */
    const foreign = await ticket(PRODUCT_B, 'Foreign', 'Belongs to another product entirely.');
    await applyEmbeddings([
      {
        subject_type: 'ticket',
        subject_id: foreign.id,
        fingerprint: foreign.sha,
        vector: unit(500),
        model: EMBEDDING_MODEL_ID,
      },
    ]);

    const hits = await scoped(PRODUCT_A, (tx) =>
      searchSimilarTickets(tx, { vector: unit(500), productId: PRODUCT_A, limit: 10 }),
    );
    expect(hits.some((h) => h.id === foreign.id)).toBe(false);
  });

  it('excludes the query ticket itself when asked', async () => {
    const self = await ticket(PRODUCT_A, 'Self', 'Self-exclusion probe.');
    await applyEmbeddings([
      {
        subject_type: 'ticket',
        subject_id: self.id,
        fingerprint: self.sha,
        vector: unit(700),
        model: EMBEDDING_MODEL_ID,
      },
    ]);

    const withSelf = await scoped(PRODUCT_A, (tx) =>
      searchSimilarTickets(tx, { vector: unit(700), productId: PRODUCT_A, limit: 5 }),
    );
    const without = await scoped(PRODUCT_A, (tx) =>
      searchSimilarTickets(tx, {
        vector: unit(700),
        productId: PRODUCT_A,
        limit: 5,
        excludeId: self.id,
      }),
    );
    expect(withSelf.some((h) => h.id === self.id)).toBe(true);
    expect(without.some((h) => h.id === self.id)).toBe(false);
  });

  it('never returns an un-embedded row as a padded tail result', async () => {
    /**
     * `embedding IS NOT NULL` is required, not cosmetic: `<=>` against NULL is
     * NULL, and NULL sorts LAST under ASC — so without it every result set
     * would be silently padded with rows that have no vector at all.
     */
    const hits = await scoped(PRODUCT_A, (tx) =>
      searchSimilarTickets(tx, { vector: unit(1234), productId: PRODUCT_A, limit: 50 }),
    );
    for (const h of hits) expect(h.similarity).not.toBeNaN();
  });

  it('finds the real KB corpus and keeps it product-scoped', async () => {
    const a = await scoped(PRODUCT_A, (tx) =>
      searchSimilarArticles(tx, { vector: unit(11), productId: PRODUCT_A, limit: 12 }),
    );
    const b = await scoped(PRODUCT_B, (tx) =>
      searchSimilarArticles(tx, { vector: unit(11), productId: PRODUCT_B, limit: 12 }),
    );
    expect(a).toHaveLength(12);
    expect(b).toHaveLength(12);
    // The same 12 topics exist in both products with identical text, so the
    // titles match while the ids must not.
    expect(new Set(a.map((h) => h.id)).size).toBe(12);
    for (const hit of a) expect(b.some((x) => x.id === hit.id)).toBe(false);
  });
});

describe('coverage reporting', () => {
  it('counts eligible, embedded, pending and failed per subject type', async () => {
    const stats = await sys((tx) => embeddingStats(tx, EMBEDDING_MODEL_ID));
    const kb = stats.find((s) => s.subject_type === 'kb_article')!;
    expect(kb.eligible).toBe(48);
    expect(kb.embedded).toBe(48);
    expect(kb.pending).toBe(0);
    expect(kb.failed).toBe(0);
  });
});
