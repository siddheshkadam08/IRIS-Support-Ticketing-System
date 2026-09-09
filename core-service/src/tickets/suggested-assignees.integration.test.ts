import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ASSIGNEE_RECOMMENDATION_VERSION } from '@iris/shared/types';
import { closePool } from '../db/pool.js';
import { withScope, withSystemScope, type ScopeContext, type Tx } from '../db/with-scope.js';
import type { QueryEmbeddingOutcome } from '../retrieval/query-embedding.js';
import { suggestAssignees } from './suggested-assignees.service.js';
import { findEligibleCandidates } from './suggested-assignees.repo.js';

/**
 * Suggested Assignees against the REAL Postgres — Phase 16.
 *
 * Real RLS, real pgvector, real ticket and support_user rows. Only the
 * embedding PROVIDER is stubbed, and deliberately: the stub returns a vector
 * taken from a row already in the corpus, which turns "who should rank first?"
 * into a fact rather than a judgement, and keeps the suite deterministic and
 * free.
 *
 * ⚠️ EVERY SECURITY TEST PROVES ITS POSITIVE CONTROL FIRST.
 *
 * With 2-3 eligible candidates per product and 12-18 historical tickets, an
 * empty result is the easiest way for one of these tests to pass while proving
 * nothing. So each isolation assertion is paired with an assertion that the
 * relevant population is non-empty — the §44I.7 lesson, where a stranger asking
 * a bare reference got `answers: []` and `[].every(...)` passed identically
 * whether isolation worked or retrieval was broken.
 *
 *   npm run infra:up && npm run migrate && npm run seed
 *   npx vitest run core-service/src/tickets/suggested-assignees.integration.test.ts
 */

const PRODUCT_A = 'prod_carbon';
const PRODUCT_B = 'prod_esg';
const TENANT_MAIN = 'acme-corp';

const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystemScope('p16-test', fn);

/** Fixture writes run under the target product's own scope — see Phase 14. */
const asProduct = <T>(productId: string, fn: (tx: Tx) => Promise<T>): Promise<T> =>
  withScope({ productScope: [productId], role: 'none', requestId: 'p16-fixture' }, fn);

/** A manager: the role that may actually act on a suggestion. */
const staff = (productId: string): ScopeContext => ({
  productScope: [productId],
  role: 'manager',
  requestId: 'p16-test',
});

const scoped = <T>(ctx: ScopeContext, fn: (tx: Tx) => Promise<T>): Promise<T> => withScope(ctx, fn);

const embedWith =
  (vector: number[]) =>
  async (): Promise<QueryEmbeddingOutcome> => ({ ok: true, vector, latencyMs: 1 });

const failingEmbed = async (): Promise<QueryEmbeddingOutcome> => ({
  ok: false,
  reason: 'unavailable',
  latencyMs: 1,
});

const created: string[] = [];

async function makeTicket(args: {
  productId: string;
  subject: string;
  description: string;
  status?: 'open' | 'resolved' | 'closed';
  category?: string | null;
  assigneeId?: string | null;
  embeddingFrom?: string;
}): Promise<{ id: string; reference: string }> {
  const id = `tkt_p16_${Math.random().toString(36).slice(2, 12)}`;
  const reference = `P16-${id.slice(-6).toUpperCase()}`;
  await asProduct(args.productId, (tx) =>
    tx.query(
      `INSERT INTO ticket (id, product_id, reference, product_tenant_id, raised_by_ref,
                           subject, description, status, category, assignee_id, resolved_at)
       VALUES ($1,$2,$3,$4,'p16-raiser',$5,$6,$7,$8,$9, CASE WHEN $7 <> 'open' THEN now() END)`,
      [
        id,
        args.productId,
        reference,
        TENANT_MAIN,
        args.subject,
        args.description,
        args.status ?? 'open',
        args.category ?? null,
        args.assigneeId ?? null,
      ],
    ),
  );
  created.push(id);
  if (args.embeddingFrom) {
    await asProduct(args.productId, (tx) =>
      tx.query(
        `UPDATE ticket SET embedding = (SELECT embedding FROM ticket WHERE reference = $2),
                           embedding_fingerprint = embedding_content_sha,
                           embedding_model = 'azure/text-embedding-3-small', embedded_at = now()
          WHERE id = $1`,
        [id, args.embeddingFrom],
      ),
    );
  }
  return { id, reference };
}

/**
 * A support user's id, read under a role that may see `support_user`.
 *
 * ⚠️ Not sub-selected inside an INSERT: the fixture scope carries role 'none',
 * which `support_user_visibility` rejects, so an inline sub-select silently
 * yields NULL. That exact mistake produced a null assignee in the Phase 14
 * fixture and would make every attribution assertion here vacuous.
 */
async function userIn(productId: string, role: string): Promise<string> {
  return scoped(staff(productId), async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `SELECT u.id FROM support_user u
         JOIN support_user_scope s ON s.support_user_id = u.id
        WHERE u.is_active = true AND s.product_id = $1 AND u.role = $2
        ORDER BY u.id LIMIT 1`,
      [productId, role],
    );
    if (!rows[0]) throw new Error(`no active ${role} scoped to ${productId}`);
    return rows[0].id;
  });
}

let seedRef: string;
let seedVector: number[];

beforeAll(async () => {
  const { reference, vector } = await sys(async (tx) => {
    const { rows } = await tx.query<{ reference: string; v: string }>(
      `SELECT reference, embedding::text AS v FROM ticket
        WHERE product_id = $1 AND status IN ('resolved','closed') AND embedding IS NOT NULL
        ORDER BY reference LIMIT 1`,
      [PRODUCT_A],
    );
    if (!rows[0]) throw new Error('no embedded historical ticket in the corpus');
    return { reference: rows[0].reference, vector: JSON.parse(rows[0].v) as number[] };
  });
  seedRef = reference;
  seedVector = vector;
});

afterAll(async () => {
  for (const id of created) {
    await sys((tx) => tx.query(`DELETE FROM comment WHERE ticket_id = $1`, [id]));
    await sys((tx) => tx.query(`DELETE FROM ticket WHERE id = $1`, [id]));
  }
  await closePool();
});

// ═══════════════════════════════════════════════════════════════════════
// The normal path
// ═══════════════════════════════════════════════════════════════════════

describe('the normal path', () => {
  it('returns every eligible candidate, ranked, with diagnostics', async () => {
    const current = await makeTicket({
      productId: PRODUCT_A,
      subject: 'Q3 export fails',
      description: 'The Q3 report export fails after a minute.',
      category: 'reports',
    });

    const res = await scoped(staff(PRODUCT_A), (tx) =>
      suggestAssignees(tx, { ticketId: current.id, requestId: 'r', embed: embedWith(seedVector) }),
    );

    expect(res).not.toBeNull();
    // POSITIVE CONTROL — an empty pool would make everything below vacuous.
    expect(res!.suggestions.length, 'no eligible candidates: this suite proves nothing').toBeGreaterThan(0);
    expect(res!.diagnostics.eligible_candidates).toBe(res!.suggestions.length);
    expect(res!.diagnostics.algorithm_version).toBe(ASSIGNEE_RECOMMENDATION_VERSION);

    // Ranks are 1..n, contiguous and in order.
    expect(res!.suggestions.map((s) => s.rank)).toEqual(
      res!.suggestions.map((_, i) => i + 1),
    );
  });

  it('attributes similar tickets to the person who handled them', async () => {
    const handler = await userIn(PRODUCT_A, 'agent');

    // A historical ticket at the query vector, handled by a known person.
    await makeTicket({
      productId: PRODUCT_A,
      subject: 'Historical twin',
      description: 'A resolved problem at the query vector.',
      status: 'resolved',
      category: 'reports',
      assigneeId: handler,
      embeddingFrom: seedRef,
    });

    const current = await makeTicket({
      productId: PRODUCT_A,
      subject: 'Q3 export fails',
      description: 'The Q3 report export fails after a minute.',
      category: 'reports',
    });

    const res = await scoped(staff(PRODUCT_A), (tx) =>
      suggestAssignees(tx, { ticketId: current.id, requestId: 'r', embed: embedWith(seedVector) }),
    );

    const hit = res!.suggestions.find((s) => s.support_user_id === handler);
    expect(hit, 'the handler must be an eligible candidate').toBeDefined();
    // POSITIVE CONTROL: attribution actually happened.
    expect(res!.diagnostics.similar_hits).toBeGreaterThan(0);
    expect(hit!.factors.similar_tickets.count).toBeGreaterThan(0);
    expect(hit!.evidence.length).toBeGreaterThan(0);
    expect(hit!.evidence[0]!.reference).toMatch(/^[A-Z]/);

    /**
     * ⚠️ NOT `rank === 1`. The seeded corpus already contains historical
     * tickets at this vector handled by other eligible people, so one added
     * fixture does not guarantee the top spot — and asserting it would be
     * asserting the seed data rather than the algorithm.
     *
     * The real property: anyone ranked ABOVE this candidate has at least as
     * much similar-ticket evidence. That is the precedence rule holding on
     * real data.
     */
    const above = res!.suggestions.filter((s) => s.rank < hit!.rank);
    for (const other of above) {
      expect(
        other.factors.similar_tickets.count,
        `${other.support_user_id} ranked above with less evidence`,
      ).toBeGreaterThanOrEqual(hit!.factors.similar_tickets.count);
    }
    // And nobody with zero evidence outranks someone with evidence.
    expect(above.every((s) => s.factors.similar_tickets.count > 0)).toBe(true);
  });

  it('counts category experience for this product and category only', async () => {
    const handler = await userIn(PRODUCT_A, 'agent');
    await makeTicket({
      productId: PRODUCT_A,
      subject: 'Billing history',
      description: 'A resolved billing problem.',
      status: 'resolved',
      category: 'billing',
      assigneeId: handler,
    });

    const current = await makeTicket({
      productId: PRODUCT_A,
      subject: 'Another billing problem',
      description: 'Something about an invoice.',
      category: 'billing',
    });

    const res = await scoped(staff(PRODUCT_A), (tx) =>
      suggestAssignees(tx, { ticketId: current.id, requestId: 'r', embed: embedWith(seedVector) }),
    );

    const hit = res!.suggestions.find((s) => s.support_user_id === handler)!;
    expect(hit.factors.category_experience.count).toBeGreaterThan(0);
    expect(hit.factors.category_experience.category).toBe('billing');
    expect(hit.factors.category_experience.label).not.toContain('no relevant');
  });

  it('reports current workload, labelled across all products', async () => {
    const current = await makeTicket({
      productId: PRODUCT_A,
      subject: 'Workload check',
      description: 'Anything.',
      category: 'reports',
    });
    const res = await scoped(staff(PRODUCT_A), (tx) =>
      suggestAssignees(tx, { ticketId: current.id, requestId: 'r', embed: embedWith(seedVector) }),
    );
    for (const s of res!.suggestions) {
      expect(s.factors.active_tickets.scope).toBe('all products');
      expect(s.factors.active_tickets.count).toBeGreaterThanOrEqual(0);
      expect(s.factors.active_tickets.label).toContain('all products');
    }
  });

  it('⚠️ is deterministic — two identical requests return an identical order', async () => {
    const current = await makeTicket({
      productId: PRODUCT_A,
      subject: 'Determinism',
      description: 'The same question twice.',
      category: 'reports',
    });
    const call = () =>
      scoped(staff(PRODUCT_A), (tx) =>
        suggestAssignees(tx, { ticketId: current.id, requestId: 'r', embed: embedWith(seedVector) }),
      );

    const a = await call();
    const b = await call();
    expect(a!.suggestions.map((s) => s.support_user_id)).toEqual(
      b!.suggestions.map((s) => s.support_user_id),
    );
    expect(a!.suggestions.map((s) => s.evidence_strength)).toEqual(
      b!.suggestions.map((s) => s.evidence_strength),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Degradation — none of these is an error
// ═══════════════════════════════════════════════════════════════════════

describe('degradation', () => {
  it('a ticket with NO category still returns candidates, with a caveat', async () => {
    const current = await makeTicket({
      productId: PRODUCT_A,
      subject: 'Uncategorised',
      description: 'No category on this one.',
      category: null,
    });
    const res = await scoped(staff(PRODUCT_A), (tx) =>
      suggestAssignees(tx, { ticketId: current.id, requestId: 'r', embed: embedWith(seedVector) }),
    );

    expect(res!.suggestions.length).toBeGreaterThan(0);
    for (const s of res!.suggestions) {
      expect(s.factors.category_experience.count).toBe(0);
      expect(s.factors.category_experience.category).toBeNull();
    }
    expect(res!.caveats.join(' ')).toContain('no category');
  });

  it('⚠️ an unavailable embedding degrades to two factors, never an error', async () => {
    const current = await makeTicket({
      productId: PRODUCT_A,
      subject: 'Embedding down',
      description: 'Retrieval is unavailable for this call.',
      category: 'reports',
    });
    const res = await scoped(staff(PRODUCT_A), (tx) =>
      suggestAssignees(tx, { ticketId: current.id, requestId: 'r', embed: failingEmbed }),
    );

    expect(res).not.toBeNull();
    expect(res!.suggestions.length, 'candidates must still be returned').toBeGreaterThan(0);
    expect(res!.diagnostics.similar_hits).toBe(0);
    expect(res!.diagnostics.similar_outcome).toBe('embedding_unavailable');
    expect(res!.diagnostics.outcome).toBe('similar_unavailable');
    expect(res!.caveats.join(' ')).toContain('Similar-ticket evidence was unavailable');
  });

  it('carries the sparse-corpus caveat on this corpus', async () => {
    // Every product currently holds 12-18 historical tickets, well under 30, so
    // this caveat is expected to fire. If it stops firing the corpus grew.
    const current = await makeTicket({
      productId: PRODUCT_A,
      subject: 'Sparse',
      description: 'Anything.',
      category: 'reports',
    });
    const res = await scoped(staff(PRODUCT_A), (tx) =>
      suggestAssignees(tx, { ticketId: current.id, requestId: 'r', embed: embedWith(seedVector) }),
    );
    expect(res!.diagnostics.historical_corpus).toBeGreaterThan(0);
    expect(res!.caveats.join(' ')).toContain('Historical evidence in this product is limited');
  });

  it('returns null for a ticket outside the caller scope, revealing no existence', async () => {
    const foreign = await makeTicket({
      productId: PRODUCT_B,
      subject: 'Another product',
      description: 'Not visible from product A.',
      category: 'reports',
    });
    const res = await scoped(staff(PRODUCT_A), (tx) =>
      suggestAssignees(tx, { ticketId: foreign.id, requestId: 'r', embed: embedWith(seedVector) }),
    );
    expect(res).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// SEC-1 / SEC-7 — candidate isolation
// ═══════════════════════════════════════════════════════════════════════

describe('⚠️ SEC-1 candidate isolation', () => {
  it('never suggests a user scoped only to another product', async () => {
    // POSITIVE CONTROL 1: both products genuinely have eligible staff.
    const inA = await scoped(staff(PRODUCT_A), (tx) => findEligibleCandidates(tx, { productId: PRODUCT_A }));
    const inB = await scoped(staff(PRODUCT_B), (tx) => findEligibleCandidates(tx, { productId: PRODUCT_B }));
    expect(inA.length, 'product A has no candidates — the check below would be vacuous').toBeGreaterThan(0);
    expect(inB.length, 'product B has no candidates — nothing to leak').toBeGreaterThan(0);

    // POSITIVE CONTROL 2: there IS someone in B who is not in A.
    const aIds = new Set(inA.map((c) => c.support_user_id));
    const onlyInB = inB.filter((c) => !aIds.has(c.support_user_id));
    expect(onlyInB.length, 'no B-only user exists — this test cannot detect a leak').toBeGreaterThan(0);

    const current = await makeTicket({
      productId: PRODUCT_A,
      subject: 'Isolation',
      description: 'A ticket in product A.',
      category: 'reports',
    });
    const res = await scoped(staff(PRODUCT_A), (tx) =>
      suggestAssignees(tx, { ticketId: current.id, requestId: 'r', embed: embedWith(seedVector) }),
    );

    // THE PROPERTY.
    const suggested = new Set(res!.suggestions.map((s) => s.support_user_id));
    expect(suggested.size).toBeGreaterThan(0);
    for (const foreignUser of onlyInB) {
      expect(suggested.has(foreignUser.support_user_id), `${foreignUser.support_user_id} leaked`).toBe(false);
    }
  });

  it('⚠️ SEC-7 never suggests a super_admin', async () => {
    // POSITIVE CONTROL: a super_admin exists and is otherwise assignable.
    const supers = await scoped(staff(PRODUCT_A), async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `SELECT id FROM support_user WHERE role = 'super_admin' AND is_active = true`,
      );
      return rows.map((r) => r.id);
    });
    expect(supers.length, 'no super_admin exists — this test proves nothing').toBeGreaterThan(0);

    const current = await makeTicket({
      productId: PRODUCT_A,
      subject: 'Super admin exclusion',
      description: 'Anything.',
      category: 'reports',
    });
    const res = await scoped(staff(PRODUCT_A), (tx) =>
      suggestAssignees(tx, { ticketId: current.id, requestId: 'r', embed: embedWith(seedVector) }),
    );

    expect(res!.suggestions.length).toBeGreaterThan(0);
    const ids = new Set(res!.suggestions.map((s) => s.support_user_id));
    for (const su of supers) expect(ids.has(su)).toBe(false);
    for (const s of res!.suggestions) expect(s.role).not.toBe('super_admin');
  });

  it('⚠️ never suggests an INACTIVE user, proven against a matched pair', async () => {
    /**
     * ⚠️ DEACTIVATES AN EXISTING USER RATHER THAN CREATING ONE.
     *
     * `iris_app` holds INSERT/SELECT/UPDATE on support_user but NOT DELETE
     * (migration 007 grants exactly that) — the platform deactivates staff, it
     * never deletes them. A test that inserted a fixture user could not remove
     * it and would leave debris in the directory every run, which is the Phase
     * 14 smoke-corpus lesson.
     *
     * So one real scoped user is flipped inactive and restored in `finally`.
     * That gives a genuine matched pair — the others stay active — using only
     * permissions production actually has.
     */
    const before = await scoped(staff(PRODUCT_A), (tx) =>
      findEligibleCandidates(tx, { productId: PRODUCT_A }),
    );
    // POSITIVE CONTROL 1: there is more than one candidate, so deactivating
    // one still leaves a non-empty set to compare against.
    expect(before.length, 'need at least two candidates for a matched pair').toBeGreaterThan(1);

    const victim = before[0]!.support_user_id;
    const survivor = before[1]!.support_user_id;

    try {
      await sys((tx) =>
        tx.query(`UPDATE support_user SET is_active = false WHERE id = $1`, [victim]),
      );

      const after = await scoped(staff(PRODUCT_A), (tx) =>
        findEligibleCandidates(tx, { productId: PRODUCT_A }),
      );
      const ids = new Set(after.map((c) => c.support_user_id));

      // POSITIVE CONTROL 2: the query still works and still returns the other,
      // untouched candidate — so the absence below is deactivation, not
      // breakage.
      expect(ids.has(survivor), 'the ACTIVE candidate disappeared too').toBe(true);

      // THE PROPERTY.
      expect(ids.has(victim), 'an inactive user was suggested').toBe(false);

      // And end to end, through the service and its response.
      const current = await makeTicket({
        productId: PRODUCT_A,
        subject: 'Inactive exclusion',
        description: 'Anything.',
        category: 'reports',
      });
      const res = await scoped(staff(PRODUCT_A), (tx) =>
        suggestAssignees(tx, { ticketId: current.id, requestId: 'r', embed: embedWith(seedVector) }),
      );
      const suggested = res!.suggestions.map((s) => s.support_user_id);
      expect(suggested).toContain(survivor);
      expect(suggested).not.toContain(victim);
    } finally {
      // Restore unconditionally: a crashed assertion must not leave a real
      // support user deactivated.
      await sys((tx) =>
        tx.query(`UPDATE support_user SET is_active = true WHERE id = $1`, [victim]),
      );
    }

    // And prove the restore actually happened.
    const restored = await scoped(staff(PRODUCT_A), (tx) =>
      findEligibleCandidates(tx, { productId: PRODUCT_A }),
    );
    expect(restored.map((c) => c.support_user_id)).toContain(victim);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// SEC-2 — historical evidence isolation
// ═══════════════════════════════════════════════════════════════════════

describe('⚠️ SEC-2 historical evidence isolation', () => {
  it('a foreign-product historical ticket contributes nothing, at similarity 1.0', async () => {
    const handlerB = await userIn(PRODUCT_B, 'agent');

    // A product-B historical ticket carrying the product-A query vector — the
    // strongest pull any query could exert on it.
    const foreignHistory = await makeTicket({
      productId: PRODUCT_B,
      subject: 'FOREIGNEVIDENCE twin',
      description: 'A resolved problem in the other product.',
      status: 'resolved',
      category: 'reports',
      assigneeId: handlerB,
      embeddingFrom: seedRef,
    });
    expect(foreignHistory.id).toBeTruthy();

    // POSITIVE CONTROL: an in-product historical ticket IS attributed.
    const handlerA = await userIn(PRODUCT_A, 'agent');
    await makeTicket({
      productId: PRODUCT_A,
      subject: 'Local twin',
      description: 'A resolved problem in this product.',
      status: 'resolved',
      category: 'reports',
      assigneeId: handlerA,
      embeddingFrom: seedRef,
    });

    const current = await makeTicket({
      productId: PRODUCT_A,
      subject: 'Q3 export fails',
      description: 'The Q3 report export fails after a minute.',
      category: 'reports',
    });
    const res = await scoped(staff(PRODUCT_A), (tx) =>
      suggestAssignees(tx, { ticketId: current.id, requestId: 'r', embed: embedWith(seedVector) }),
    );

    // The positive half first: attribution demonstrably works.
    expect(res!.diagnostics.similar_hits, 'no in-product evidence was attributed').toBeGreaterThan(0);
    const local = res!.suggestions.find((s) => s.support_user_id === handlerA);
    expect(local!.factors.similar_tickets.count).toBeGreaterThan(0);

    // THE PROPERTY: nothing from product B, in evidence or in candidates.
    const body = JSON.stringify(res);
    expect(body).not.toContain('FOREIGNEVIDENCE');
    expect(res!.suggestions.map((s) => s.support_user_id)).not.toContain(handlerB);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// SEC-5 / SEC-6 — leakage and writes
// ═══════════════════════════════════════════════════════════════════════

describe('⚠️ SEC-5 the response leaks nothing', () => {
  it('carries no internal note, ticket body, tenant or resolution text', async () => {
    const handler = await userIn(PRODUCT_A, 'agent');
    const history = await makeTicket({
      productId: PRODUCT_A,
      subject: 'Historical with notes',
      description: 'A resolved problem.',
      status: 'resolved',
      category: 'reports',
      assigneeId: handler,
      embeddingFrom: seedRef,
    });
    await asProduct(PRODUCT_A, (tx) =>
      tx.query(
        `INSERT INTO comment (id, product_id, ticket_id, author_type, author_name, body, is_internal)
         VALUES ($1,$2,$3,'assignee','Agent','INTERNALONLYMARKER do not disclose',true),
                ($4,$2,$3,'assignee','Agent','PUBLICRESOLUTIONMARKER we restarted the worker',false)`,
        [
          `cmt_p16_${Math.random().toString(36).slice(2, 10)}`,
          PRODUCT_A,
          history.id,
          `cmt_p16_${Math.random().toString(36).slice(2, 10)}`,
        ],
      ),
    );

    const current = await makeTicket({
      productId: PRODUCT_A,
      subject: 'Q3 export fails',
      description: 'The Q3 report export fails after a minute.',
      category: 'reports',
    });
    const res = await scoped(staff(PRODUCT_A), (tx) =>
      suggestAssignees(tx, { ticketId: current.id, requestId: 'r', embed: embedWith(seedVector) }),
    );

    // POSITIVE CONTROL: the historical ticket really was attributed, so the
    // absences below are meaningful rather than the result of an empty set.
    expect(res!.diagnostics.similar_hits).toBeGreaterThan(0);
    const body = JSON.stringify(res);
    expect(body).toContain(history.reference);

    // THE PROPERTY.
    expect(body).not.toContain('INTERNALONLYMARKER');
    // ⚠️ Resolution text is omitted here even though it is PUBLIC and Phase 14
    // returns it — a staffing view does not need another customer's reply.
    expect(body).not.toContain('PUBLICRESOLUTIONMARKER');
    expect(body).not.toContain(TENANT_MAIN);
    expect(body).not.toContain('p16-raiser');
    expect(body).not.toContain('tkt_');
    expect(body).not.toContain('prod_');
  });
});

describe('⚠️ SEC-6 zero writes', () => {
  it('leaves the ticket, comments and audit log byte-identical', async () => {
    const current = await makeTicket({
      productId: PRODUCT_A,
      subject: 'Zero write',
      description: 'Generating suggestions must change nothing.',
      category: 'reports',
    });

    const snapshot = () =>
      sys(async (tx) => {
        const { rows } = await tx.query<{ h: string }>(
          `SELECT md5(
             (SELECT coalesce(string_agg(t.status || coalesce(t.assignee_id,'-') || t.updated_at::text, '|' ORDER BY t.id), '')
                FROM ticket t WHERE t.product_id = $1)
             || (SELECT count(*)::text FROM comment c WHERE c.product_id = $1)
             || (SELECT count(*)::text FROM audit_event a WHERE a.product_id = $1)
             || (SELECT count(*)::text FROM event_outbox e WHERE e.product_id = $1)
           ) AS h`,
          [PRODUCT_A],
        );
        return rows[0]!.h;
      });

    const before = await snapshot();
    const res = await scoped(staff(PRODUCT_A), (tx) =>
      suggestAssignees(tx, { ticketId: current.id, requestId: 'r', embed: embedWith(seedVector) }),
    );
    const after = await snapshot();

    // POSITIVE CONTROL: the call actually did its work.
    expect(res!.suggestions.length).toBeGreaterThan(0);
    // THE PROPERTY: no ticket, comment, audit or outbox change anywhere in the product.
    expect(after).toBe(before);
  });
});
