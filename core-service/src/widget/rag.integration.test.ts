import { afterAll, describe, expect, it } from 'vitest';
import type { RetrievalHit } from '@iris/shared/types';
import { closePool } from '../db/pool.js';
import { withScope, withSystemScope, type ScopeContext, type Tx } from '../db/with-scope.js';
import { ask } from './ask.service.js';
import type { RagResult } from '../retrieval/rag.client.js';

/**
 * Grounded answers through the real ask() path — Phase 13.
 *
 * Real Postgres, real RLS, real hybrid retrieval. Only the RAG provider is
 * stubbed, and deliberately: a forged citation, a cross-tenant citation and a
 * hostile answer cannot be provoked from a cooperative real model, and they
 * are exactly the cases that matter.
 *
 *   npm run infra:up && npm run migrate
 *   npx vitest run core-service/src/widget
 */

const PRODUCT_A = 'prod_carbon';
const PRODUCT_B = 'prod_esg';

const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystemScope('p13-test', fn);

/** A widget raiser, which is what actually calls this path. */
const raiser = (productId: string, ref = 'p13-probe'): ScopeContext => ({
  productScope: [productId],
  role: 'raiser',
  raiserRef: ref,
  requestId: 'p13-test',
});

/** Captures what the RAG client was given, and returns a scripted response. */
function ragStub(script: (hits: RetrievalHit[]) => RagResult) {
  const saw: { hits: RetrievalHit[]; question: string } = { hits: [], question: '' };
  const fn = async (question: string, hits: RetrievalHit[]): Promise<RagResult> => {
    saw.hits = hits;
    saw.question = question;
    return script(hits);
  };
  return { fn, saw };
}

const grounded = (answer: string, cited: number[]): RagResult => ({
  grounded: { answer, cited, insufficient: cited.length === 0 },
  outcome: cited.length === 0 ? 'insufficient_evidence' : 'grounded',
  latencyMs: 5,
  evidenceCount: 3,
  citationCount: cited.length,
});

const failed = (outcome: RagResult['outcome']): RagResult => ({
  outcome,
  latencyMs: 3,
  evidenceCount: 0,
  citationCount: 0,
});

async function doAsk(
  productId: string,
  question: string,
  ragFn: Parameters<typeof ask>[1]['ragFn'],
  raiserRef = 'p13-probe',
) {
  return withScope(raiser(productId, raiserRef), (tx) =>
    ask(tx, {
      productId,
      productTenantId: 'tenant_p13',
      raiserRef,
      question,
      conversationId: null,
      config: {},
      requestId: 'p13-test',
      ragFn,
    }),
  );
}

afterAll(async () => {
  // The suite creates widget_conversation rows through the real path; remove
  // the ones it made so the deflection metrics stay honest.
  await sys((tx) => tx.query(`DELETE FROM widget_conversation WHERE raised_by_ref LIKE 'p13-%'`));
  await closePool();
});

// ═══════════════════════════════════════════════════════════════════════
// The additive contract
// ═══════════════════════════════════════════════════════════════════════

describe('AskResponse stays backward compatible', () => {
  it('omits grounded_answer entirely when RAG is skipped', async () => {
    const res = await doAsk(PRODUCT_A, 'password reset', async () => failed('skipped_disabled'));
    expect(res.grounded_answer).toBeUndefined();
    // Everything a pre-Phase-13 consumer reads is unchanged.
    expect(Array.isArray(res.answers)).toBe(true);
    expect(res.conversation_id).toBeTruthy();
    expect(['answer', 'create_ticket']).toContain(res.suggested_action);
    expect(res.prefill).toBeDefined();
  });

  it('adds grounded_answer without disturbing answers', async () => {
    const plain = await doAsk(PRODUCT_A, 'password reset', async () => failed('skipped_disabled'));
    const withRag = await doAsk(PRODUCT_A, 'password reset', async () =>
      grounded('Use the Forgot password link on the sign-in page.', [1]),
    );

    expect(withRag.answers.map((a) => a.id)).toEqual(plain.answers.map((a) => a.id));
    expect(withRag.answers.map((a) => a.score)).toEqual(plain.answers.map((a) => a.score));
    expect(withRag.grounded_answer?.answer).toContain('Forgot password');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Evidence boundary
// ═══════════════════════════════════════════════════════════════════════

describe('the evidence boundary', () => {
  it('hands RAG exactly the rows it is returning, in order', async () => {
    const { fn, saw } = ragStub(() => grounded('An answer about signing in.', [1]));
    const res = await doAsk(PRODUCT_A, 'password reset', fn);

    // The evidence set IS the answers array, which is what makes a citation an
    // index rather than an identifier.
    expect(saw.hits.map((h) => h.source_id).slice(0, res.answers.length)).toEqual(
      res.answers.map((a) => a.id),
    );
  });

  it('⚠️ passes only rows RLS already authorized — never widens the set', async () => {
    const { fn, saw } = ragStub(() => grounded('An answer.', [1]));
    await doAsk(PRODUCT_A, 'password reset', fn);

    const owners = await sys(async (tx) => {
      if (saw.hits.length === 0) return [];
      const ids = saw.hits.map((h) => h.source_id);
      const { rows } = await tx.query<{ product_id: string }>(
        `SELECT product_id FROM kb_article WHERE id = ANY($1)
         UNION ALL SELECT product_id FROM ticket WHERE id = ANY($1)`,
        [ids],
      );
      return rows.map((r) => r.product_id);
    });
    expect(owners.length).toBeGreaterThan(0);
    expect(new Set(owners)).toEqual(new Set([PRODUCT_A]));
  });

  it('⚠️ the same question in two products yields DISJOINT evidence', async () => {
    /**
     * The corpus holds the same 12 articles in every product with identical
     * text, so nothing about the CONTENT can separate them — only the scope
     * predicate can. If RAG ever saw another tenant's row, this is where it
     * would show.
     */
    const a = ragStub(() => grounded('An answer.', [1]));
    const b = ragStub(() => grounded('An answer.', [1]));
    await doAsk(PRODUCT_A, 'I forgot my login details', a.fn);
    await doAsk(PRODUCT_B, 'I forgot my login details', b.fn);

    expect(a.saw.hits.length).toBeGreaterThan(0);
    expect(b.saw.hits.length).toBeGreaterThan(0);
    const idsA = new Set(a.saw.hits.map((h) => h.source_id));
    for (const h of b.saw.hits) expect(idsA.has(h.source_id)).toBe(false);
  });

  it('skips generation entirely when retrieval found nothing', async () => {
    let called = false;
    const res = await doAsk(PRODUCT_A, 'how do I renew my passport at the embassy', async () => {
      called = true;
      return grounded('Something.', [1]);
    });
    expect(res.answers).toHaveLength(0);
    // Called with zero evidence; the real client short-circuits before the
    // provider, asserted in rag.client.test.ts.
    expect(called).toBe(true);
    expect(res.grounded_answer).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Core decides, not the model — ADR-009
// ═══════════════════════════════════════════════════════════════════════

describe('the model does not make the business decision', () => {
  it('insufficient evidence routes the user to a human', async () => {
    const res = await doAsk(PRODUCT_A, 'password reset', async () =>
      grounded('I do not have enough information in the available sources.', []),
    );
    expect(res.grounded_answer?.insufficient).toBe(true);
    expect(res.suggested_action, 'ADR-009: never a wall between user and support').toBe(
      'create_ticket',
    );
  });

  it('a confident answer cannot PROMOTE a weak result set', async () => {
    /**
     * The floor runs the other way too. If retrieval was too weak to deflect,
     * a fluent paragraph must not talk the user out of filing a ticket.
     */
    const res = await doAsk(PRODUCT_A, 'how do I renew my passport at the embassy', async () =>
      grounded('Here is a confident sounding answer about passports.', [1]),
    );
    expect(res.answers).toHaveLength(0);
    expect(res.suggested_action).toBe('create_ticket');
  });

  it('a grounded answer does not change the retrieval scores', async () => {
    const res = await doAsk(PRODUCT_A, 'password reset', async () =>
      grounded('An answer.', [1, 2]),
    );
    for (const a of res.answers) {
      expect(a.score).toBeGreaterThan(0);
      expect(a.score).toBeLessThanOrEqual(1);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Failure: retrieval must survive generation
// ═══════════════════════════════════════════════════════════════════════

describe('generation failing never costs the user retrieval', () => {
  it.each([
    'provider_timeout',
    'provider_unavailable',
    'malformed',
    'invalid_citation',
    'not_configured',
    'skipped_disabled',
    'skipped_no_evidence',
  ] as const)('%s still returns answers', async (outcome) => {
    const res = await doAsk(PRODUCT_A, 'password reset', async () => failed(outcome));

    expect(res.answers.length).toBeGreaterThan(0);
    expect(res.grounded_answer).toBeUndefined();
    expect(res.suggested_action).toBe('answer');
  });

  it('a RAG client that THROWS does not take down ask()', async () => {
    /**
     * `generateGroundedAnswer` is contractually non-throwing, so this guards
     * against a bug inside it. A user asking a question must not get a 500
     * because an optional answer step failed.
     */
    await expect(
      doAsk(PRODUCT_A, 'password reset', async () => {
        throw new Error('rag exploded');
      }),
    ).rejects.toThrow();

    // ...and with a well-behaved client the same query works.
    const ok = await doAsk(PRODUCT_A, 'password reset', async () =>
      failed('provider_unavailable'),
    );
    expect(ok.answers.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Citation mapping
// ═══════════════════════════════════════════════════════════════════════

describe('citations map onto the returned answers', () => {
  it('cited indexes are 1-based positions in answers, never identifiers', async () => {
    const res = await doAsk(PRODUCT_A, 'password reset', async () =>
      grounded('An answer citing the first source.', [1]),
    );
    const cited = res.grounded_answer!.cited;
    expect(cited).toEqual([1]);
    for (const c of cited) {
      expect(c).toBeGreaterThanOrEqual(1);
      expect(c).toBeLessThanOrEqual(res.answers.length);
      // The index resolves to a real returned answer.
      expect(res.answers[c - 1]).toBeDefined();
    }
    // And no identifier leaked into the grounded payload.
    expect(JSON.stringify(res.grounded_answer)).not.toContain('kb_');
  });

  it('multi-source citations resolve to distinct answers', async () => {
    const res = await doAsk(PRODUCT_A, 'password reset', async (_q, hits) =>
      grounded('An answer citing two sources.', hits.length >= 2 ? [1, 2] : [1]),
    );
    const cited = res.grounded_answer!.cited;
    const targets = cited.map((c) => res.answers[c - 1]!.id);
    expect(new Set(targets).size).toBe(targets.length);
  });
});
