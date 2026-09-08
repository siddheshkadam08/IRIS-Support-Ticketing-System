import { newId, type AskAnswer, type AskResponse } from '@iris/shared/types';
import type { Tx } from '../db/with-scope.js';
import type { ProductConfig } from '../products/product.repo.js';
import { hybridSearch } from '../retrieval/hybrid.service.js';
import { logger } from '../logger.js';

/**
 * Deflection.
 *
 * ⚠️ This path NEVER creates a ticket and never touches one. A user getting an
 * answer and choosing not to file is deflection; AI sending on an open ticket
 * and closing it is auto-resolution, which is forbidden.
 * See docs/adr/009-deflection-is-not-auto-resolution.md
 *
 * PHASE 11: the ranking is now hybrid — FTS + trigram + vector, fused by
 * weighted RRF. The prediction the Phase 1 comment here made held exactly: the
 * signature did not change, `AskResponse` did not change, and the widget was
 * not touched.
 *
 * ⚠️ TWO PROPERTIES OF THE OLD BEHAVIOUR HAD TO BE PRESERVED DELIBERATELY,
 * because both are business behaviour rather than ranking detail:
 *
 *  1. `min_score` STILL MEANS WHAT IT MEANT. Every seeded product carries
 *     `deflection.min_score: 0.05`, and it gates `suggested_action`. The old
 *     score was `ts_rank * 4 + similarity(title, q)` — unbounded and
 *     uncalibrated, measured live at 4.5073 for a good match and 0.2903 for a
 *     typo match. At that scale 0.05 was passed by ANY row the lexical filter
 *     returned, so in practice the gate meant "was there a match at all".
 *     `hybrid_score` is normalised to [0,1] and a single-strategy top hit
 *     scores that strategy's weight (>= 0.2), so 0.05 keeps exactly that
 *     meaning. No product config had to change.
 *
 *  2. AN UNANSWERABLE QUESTION STILL OFFERS THE TICKET FORM. Lexical retrieval
 *     had a natural floor: no match, no answers, `create_ticket`. Vector search
 *     has none — `ORDER BY embedding <=> q LIMIT k` returns k rows for any
 *     query at all. Adding it naively would have turned every off-topic
 *     question into confident-looking answers and quietly suppressed the ticket
 *     form. VECTOR_SIMILARITY_FLOOR restores the floor, calibrated against
 *     measured relevant/irrelevant similarity distributions rather than chosen.
 */
export async function ask(
  tx: Tx,
  args: {
    productId: string;
    productTenantId: string | null;
    raiserRef: string | null;
    question: string;
    conversationId: string | null;
    config: ProductConfig;
    /** Threads widget -> gateway -> core -> ai-service -> logs. Never the query. */
    requestId: string;
  },
): Promise<AskResponse> {
  const minScore = args.config.deflection?.min_score ?? 0.05;
  const maxSuggestions = args.config.deflection?.max_suggestions ?? 4;

  /**
   * ONE call, ONE query embedding, both corpora.
   *
   * The old code issued two independent searches and concatenated them, which
   * meant articles and tickets were ranked on scales that were never comparable
   * — `ts_rank * 4 + similarity` for one, bare `ts_rank` for the other — and
   * then sorted against each other anyway. Fusing them in one ranking is the
   * fix, and it also means the expensive step happens once.
   */
  const { hits, diagnostics } = await hybridSearch(tx, {
    productId: args.productId,
    query: args.question,
    limit: maxSuggestions,
    requestId: args.requestId,
  });

  /**
   * Bounded, non-sensitive observability.
   *
   * NOT LOGGED: the question text (user input, may contain anything), any row
   * content, any vector, any credential. Length and per-strategy counts are
   * enough to answer "why did this query return nothing?" without recording
   * what was asked.
   */
  logger.info(
    { request_id: args.requestId, product_id: args.productId, ...diagnostics },
    'deflection retrieval',
  );

  /**
   * PHASE 12 SCORE SEMANTICS — Option A: the reranker decides ORDER, and the
   * score stays Phase 11's retrieval score.
   *
   * The two numbers mean different things. `hybrid_score` is "how strongly did
   * three retrieval strategies agree this row matches?"; a reranker score would
   * be "how well does this row answer the question?". Blending them needs
   * coefficients nobody has validated, and would break `min_score`, which every
   * seeded product sets and which is calibrated against the Phase 11 scale.
   *
   * So `AskAnswer.score` is unchanged and unblended — the array ORDER carries
   * the reranking, which is exactly what the widget consumes.
   */
  const answers: AskAnswer[] = hits.map((h) => ({
    type: h.source_type,
    id: h.source_id,
    title: h.title,
    excerpt: h.snippet,
    score: h.hybrid_score,
  }));

  /**
   * ⚠️ THE GATE READS THE MAXIMUM SCORE, NOT THE FIRST ONE — changed in
   * Phase 12, and it had to be.
   *
   * `score` is the Phase 11 RETRIEVAL score and deliberately stays that way
   * (see the ordering note above). Reranking changes the ORDER, so
   * `answers[0]` is no longer guaranteed to be the highest-scoring row — and
   * the old `answers[0].score >= min_score` would then have gated a perfectly
   * good result set to `create_ticket` purely because the reranker promoted a
   * row with a slightly lower retrieval score.
   *
   * The maximum expresses what the threshold always meant: "is there any
   * answer here worth offering?". With reranking off, `answers[0]` IS the
   * maximum, so behaviour is identical to Phase 11.
   */
  const best = answers.reduce((m, a) => (a.score > m ? a.score : m), 0);
  // A weak answer is worse than no answer — offer the ticket form instead of
  // forcing a deflection the user will not trust.
  const suggested = best >= minScore && answers.length > 0 ? 'answer' : 'create_ticket';

  const conversationId = await upsertConversation(tx, {
    conversationId: args.conversationId,
    productId: args.productId,
    productTenantId: args.productTenantId,
    raiserRef: args.raiserRef,
    question: args.question,
    answered: suggested === 'answer',
    topAnswer: answers[0]?.title ?? null,
  });

  return {
    conversation_id: conversationId,
    suggested_action: suggested,
    answers,
    prefill: {
      description: args.question,
      category: null,
      severity: (args.config.default_severity as AskResponse['prefill']['severity']) ?? 'medium',
    },
  };
}

async function upsertConversation(
  tx: Tx,
  args: {
    conversationId: string | null;
    productId: string;
    productTenantId: string | null;
    raiserRef: string | null;
    question: string;
    answered: boolean;
    topAnswer: string | null;
  },
): Promise<string> {
  const turn = {
    at: new Date().toISOString(),
    question: args.question,
    answered: args.answered,
    top_answer: args.topAnswer,
  };

  if (args.conversationId) {
    const { rowCount } = await tx.query(
      `UPDATE widget_conversation
          SET turns = turns || $2::jsonb,
              outcome = CASE WHEN outcome = 'ticket_created' THEN outcome
                             WHEN $3 THEN 'self_served' ELSE outcome END
        WHERE id = $1`,
      [args.conversationId, JSON.stringify([turn]), args.answered],
    );
    if (rowCount && rowCount > 0) return args.conversationId;
    // Fall through and create if the id was unknown or not visible.
  }

  const id = newId('cnv');
  await tx.query(
    `INSERT INTO widget_conversation
       (id, product_id, product_tenant_id, raised_by_ref, turns, outcome)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
    [
      id,
      args.productId,
      args.productTenantId,
      args.raiserRef,
      JSON.stringify([turn]),
      // 'self_served' is provisional until the user either leaves (it stands)
      // or files a ticket (it flips). Either way the row is the audit record
      // behind the Self-Served metric.
      args.answered ? 'self_served' : 'abandoned',
    ],
  );
  return id;
}

/** Called when a conversation escalates into a ticket. */
export async function markConversationEscalated(
  tx: Tx,
  conversationId: string,
  ticketId: string,
): Promise<void> {
  await tx.query(
    `UPDATE widget_conversation
        SET outcome = 'ticket_created', ticket_id = $2, ended_at = now()
      WHERE id = $1`,
    [conversationId, ticketId],
  );
}

/** Transcript, used when Live Chat converts a conversation to a ticket. */
export async function conversationTranscript(
  tx: Tx,
  conversationId: string,
): Promise<string | null> {
  const { rows } = await tx.query<{ turns: Array<{ question?: string; at?: string }> }>(
    `SELECT turns FROM widget_conversation WHERE id = $1`,
    [conversationId],
  );
  const turns = rows[0]?.turns;
  if (!turns?.length) return null;
  return turns
    .filter((t) => t.question)
    .map((t) => `• ${t.question}`)
    .join('\n');
}
