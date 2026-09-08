import {
  COPILOT_EXCERPT_CHARS,
  COPILOT_MAX_HISTORICAL_EVIDENCE,
  COPILOT_MAX_KB_EVIDENCE,
  COPILOT_MAX_TICKET_COMMENTS,
  COPILOT_PROMPT_VERSION,
  validateCopilotOutput,
  type CopilotDraftResponse,
  type CopilotEvidence,
  type CopilotOutcome,
} from '@iris/shared/types';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { callAiService } from '../retrieval/ai-call.js';
import { hybridSearch } from '../retrieval/hybrid.service.js';
import type { QueryEmbeddingOutcome } from '../retrieval/query-embedding.js';
import type { Tx } from '../db/with-scope.js';
import { findSimilar } from './similar.service.js';

/**
 * Agent Copilot — Phase 15.
 *
 *     current ticket + KB evidence + historical tickets
 *         -> copilot-v1 -> Azure gpt-4.1 -> validated DRAFT
 *
 * ⚠️ THIS FUNCTION CANNOT SEND ANYTHING. It returns text to the agent's
 * browser. Sending is `POST /admin/api/tickets/:id/comments`, written in Phase
 * 1, untouched by this phase, and requiring an authenticated support user. The
 * AI service never calls Core at all.
 *
 * ⚠️ NOTHING IS PERSISTED. The draft exists in the response and then in a text
 * box. There is no stored draft to send later, from another tab, after
 * discarding, or as another user — so that entire class of attack is
 * unrepresentable rather than defended against. "Discard" is closing the box.
 *
 * ⚠️ IT DECIDES NOTHING AND WRITES NOTHING. No comment, no status change, no
 * priority, severity, assignment, SLA or access grant.
 */

export interface CopilotArgs {
  ticketId: string;
  requestId: string;
  /** Test seam. Production passes nothing. */
  generate?: typeof callAiService;
  /** Test seam for the two retrieval embeddings. Production passes nothing. */
  embed?: (query: string, requestId: string) => Promise<QueryEmbeddingOutcome>;
}

interface TicketRow {
  subject: string | null;
  description: string;
  status: string;
  category: string | null;
  severity: string | null;
  product_id: string;
}

/**
 * Evidence comes from TWO sources, used for what each is actually good at.
 *
 * ⚠️ NOT all three retrieval systems blindly. Phase 11 `hybridSearch` returns
 * both articles and resolved tickets, and Phase 14 also returns resolved
 * tickets — so taking tickets from both would duplicate them. Phase 14's ticket
 * results are strictly richer for this purpose (they carry the reference,
 * status and the public resolution), so:
 *
 *   knowledge      <- Phase 11 hybrid retrieval, ARTICLES only
 *   what happened  <- Phase 14 similar tickets, with their resolutions
 *
 * Both are already product-scoped and RLS-bounded by their own queries, before
 * ORDER BY and LIMIT. This function adds no authorization of its own and could
 * not weaken theirs.
 */
async function gatherEvidence(
  tx: Tx,
  args: { ticketId: string; ticket: TicketRow; requestId: string; embed?: CopilotArgs['embed'] },
): Promise<{ evidence: CopilotEvidence[]; kb: number; historical: number }> {
  const query = [args.ticket.subject ?? '', args.ticket.description]
    .join('\n\n')
    .replace(/\s+/g, ' ')
    .trim();

  const [kbResult, similarResult] = await Promise.allSettled([
    hybridSearch(tx, {
      productId: args.ticket.product_id,
      query,
      // Ask for more than needed: the ticket hits are discarded below, so a
      // tight limit would starve the article side.
      limit: COPILOT_MAX_KB_EVIDENCE * 3,
      requestId: args.requestId,
      embed: args.embed,
    }),
    findSimilar(tx, {
      ticketId: args.ticketId,
      limit: COPILOT_MAX_HISTORICAL_EVIDENCE,
      requestId: args.requestId,
      embed: args.embed,
    }),
  ]);

  /**
   * Either retrieval source may fail without failing the draft — but a draft
   * grounded in nothing is reported as such rather than dressed up. See the
   * `no_evidence` outcome in draftReply().
   */
  const articles =
    kbResult.status === 'fulfilled'
      ? kbResult.value.hits.filter((h) => h.source_type === 'kb_article').slice(0, COPILOT_MAX_KB_EVIDENCE)
      : [];
  if (kbResult.status === 'rejected') {
    logger.warn(
      { request_id: args.requestId, err: message(kbResult.reason) },
      'copilot: knowledge retrieval failed - continuing with what is available',
    );
  }

  const historical =
    similarResult.status === 'fulfilled' && similarResult.value
      ? similarResult.value.items.slice(0, COPILOT_MAX_HISTORICAL_EVIDENCE)
      : [];
  if (similarResult.status === 'rejected') {
    logger.warn(
      { request_id: args.requestId, err: message(similarResult.reason) },
      'copilot: historical retrieval failed - continuing with what is available',
    );
  }

  const evidence: CopilotEvidence[] = [];
  for (const a of articles) {
    evidence.push({
      source_number: evidence.length + 1,
      kind: 'kb_article',
      title: a.title,
      excerpt: a.snippet.slice(0, COPILOT_EXCERPT_CHARS),
    });
  }
  for (const h of historical) {
    evidence.push({
      source_number: evidence.length + 1,
      kind: 'historical_ticket',
      title: h.title,
      // The public resolution is the useful part. A past ticket with no
      // recorded outcome teaches the model nothing, so it contributes its
      // subject only and the prompt already treats it as weak evidence.
      excerpt: (h.resolution ?? '(no resolution was recorded)').slice(0, COPILOT_EXCERPT_CHARS),
    });
  }

  return { evidence, kb: articles.length, historical: historical.length };
}

/**
 * ⚠️ PUBLIC COMMENTS ONLY, ENFORCED IN SQL.
 *
 * Internal notes are "never leaves the platform" by the schema's own comment.
 * The surest way to keep one out of a customer reply is to never put it in the
 * prompt — so the predicate is here, not a filter applied afterwards, and the
 * model is never given the chance to quote something it should not.
 *
 * This is the safest supported behaviour. Feeding internal notes as clearly
 * labelled agent-only context would give richer drafts, and would also mean one
 * prompt-injection away from a private note reaching a customer. Recorded as a
 * limitation rather than guessed at.
 */
async function publicComments(
  tx: Tx,
  ticketId: string,
): Promise<Array<{ author: 'customer' | 'support'; body: string }>> {
  const { rows } = await tx.query<{ author_type: string; body: string }>(
    `SELECT author_type, body FROM comment
      WHERE ticket_id = $1 AND is_internal = false
      ORDER BY created_at DESC
      LIMIT $2`,
    [ticketId, COPILOT_MAX_TICKET_COMMENTS],
  );
  // Newest-first from SQL so the LIMIT keeps the most recent; reversed here so
  // the model reads the conversation in order.
  return rows
    .reverse()
    .map((r) => ({
      author: r.author_type === 'raiser' ? ('customer' as const) : ('support' as const),
      body: r.body,
    }));
}

/**
 * Generate a draft reply.
 *
 * Returns null when the ticket is not visible under the caller's scope, so an
 * unauthorized id cannot be used to probe for existence.
 *
 * NEVER THROWS for a provider problem. Every failure returns an outcome and no
 * draft — the ticket is untouched, no comment exists, and the agent can simply
 * write the reply themselves.
 */
export async function draftReply(
  tx: Tx,
  args: CopilotArgs,
): Promise<CopilotDraftResponse | null> {
  const started = Date.now();

  const { rows } = await tx.query<TicketRow>(
    `SELECT subject, description, status, category, severity, product_id
       FROM ticket WHERE id = $1`,
    [args.ticketId],
  );
  const ticket = rows[0];
  if (!ticket) return null;

  const [{ evidence, kb, historical }, comments] = await Promise.all([
    gatherEvidence(tx, {
      ticketId: args.ticketId,
      ticket,
      requestId: args.requestId,
      embed: args.embed,
    }),
    publicComments(tx, args.ticketId),
  ]);
  const retrievalMs = Date.now() - started;

  const sources = evidence.map((e) => ({
    source_number: e.source_number,
    kind: e.kind,
    title: e.title,
  }));

  const respond = (
    outcome: CopilotOutcome,
    extra: Partial<CopilotDraftResponse> = {},
    generationMs: number | null = null,
  ): CopilotDraftResponse => ({
    citations: [],
    sources,
    insufficient: true,
    outcome,
    diagnostics: {
      kb_evidence: kb,
      historical_evidence: historical,
      ticket_comments: comments.length,
      retrieval_ms: retrievalMs,
      generation_ms: generationMs,
      total_ms: Date.now() - started,
      model: null,
      prompt_version: COPILOT_PROMPT_VERSION,
    },
    ...extra,
  });

  /**
   * ⚠️ NO EVIDENCE, NO DRAFT.
   *
   * A reply written from the ticket alone would be fluent, ungrounded and
   * indistinguishable from a grounded one on screen — the exact thing this
   * phase exists to prevent. The agent is told there is nothing to ground a
   * draft in and writes the reply themselves, which is a worse experience and
   * a correct one.
   */
  if (evidence.length === 0) return respond('no_evidence');

  const outcome = await (args.generate ?? callAiService)<unknown>(
    {
      feature: 'copilot',
      requestId: args.requestId,
      input: {
        // `description` is unused by this feature but required by the frozen
        // contract shape; the real content travels in ticket_context.
        subject: null,
        description: ticket.description,
        ticket_context: {
          subject: ticket.subject,
          description: ticket.description,
          status: ticket.status,
          category: ticket.category,
          severity: ticket.severity,
          public_comments: comments,
        },
        copilot_evidence: evidence,
      },
      timeoutMs: config.COPILOT_TIMEOUT_MS,
    },
  );

  if (!outcome.ok) {
    const reason: CopilotOutcome =
      outcome.reason === 'timeout'
        ? 'provider_timeout'
        : outcome.reason === 'not_configured'
          ? 'not_configured'
          : outcome.reason === 'invalid'
            ? 'malformed'
            : 'provider_unavailable';
    logger.warn(
      {
        request_id: args.requestId,
        reason,
        status: outcome.status,
        ms: outcome.latencyMs,
        evidence_count: evidence.length,
      },
      'copilot: draft unavailable',
    );
    return respond(reason, {}, outcome.latencyMs);
  }

  /**
   * ⚠️ FAIL-CLOSED VALIDATION. Length, control characters, citation type,
   * range and duplicates, all checked against the evidence THIS call supplied.
   * Anything unverifiable returns no draft — putting text a human might send
   * in front of them with provenance nobody can check is the worst outcome
   * available here.
   */
  const checked = validateCopilotOutput(outcome.value, evidence.length);
  if (!checked.ok) {
    logger.warn(
      // The REASON only. Never the draft text, which is model prose about
      // customer content.
      { request_id: args.requestId, reason: checked.reason, evidence_count: evidence.length },
      'copilot: draft rejected by validation',
    );
    return respond(
      checked.reason.includes('citation') ? 'invalid_citation' : 'malformed',
      {},
      outcome.latencyMs,
    );
  }

  return {
    draft: checked.draft,
    citations: checked.citations,
    sources,
    insufficient: checked.insufficient,
    outcome: checked.insufficient ? 'insufficient_evidence' : 'drafted',
    diagnostics: {
      kb_evidence: kb,
      historical_evidence: historical,
      ticket_comments: comments.length,
      retrieval_ms: retrievalMs,
      generation_ms: outcome.latencyMs,
      total_ms: Date.now() - started,
      model: 'azure/gpt-4.1',
      prompt_version: COPILOT_PROMPT_VERSION,
    },
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
