import { newId, type AskAnswer, type AskResponse } from '@iris/shared/types';
import type { Tx } from '../db/with-scope.js';
import { searchArticles, searchResolvedTickets } from '../knowledge-base/kb.repo.js';
import type { ProductConfig } from '../products/product.repo.js';

/**
 * Deflection.
 *
 * ⚠️ This path NEVER creates a ticket and never touches one. A user getting an
 * answer and choosing not to file is deflection; AI sending on an open ticket
 * and closing it is auto-resolution, which is forbidden.
 * See docs/adr/009-deflection-is-not-auto-resolution.md
 *
 * Today the ranking is Postgres full-text + trigram. When ai-service exists it
 * contributes vector similarity over the embedding columns and this function's
 * signature does not change.
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
  },
): Promise<AskResponse> {
  const minScore = args.config.deflection?.min_score ?? 0.05;
  const maxSuggestions = args.config.deflection?.max_suggestions ?? 4;

  const [articles, tickets] = await Promise.all([
    searchArticles(tx, args.question, { limit: maxSuggestions }),
    searchResolvedTickets(tx, args.question, 2),
  ]);

  const answers: AskAnswer[] = [
    ...articles.map<AskAnswer>((a) => ({
      type: 'kb_article',
      id: a.id,
      title: a.title,
      excerpt: a.excerpt,
      score: a.score ?? 0,
    })),
    ...tickets.map<AskAnswer>((t) => ({
      type: 'resolved_ticket',
      id: t.id,
      title: t.title,
      excerpt: t.excerpt,
      score: t.score,
    })),
  ]
    .sort((a, b) => b.score - a.score)
    .slice(0, maxSuggestions);

  const best = answers[0]?.score ?? 0;
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
