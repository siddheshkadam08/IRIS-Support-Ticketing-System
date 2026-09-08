import {
  RAG_EXCERPT_CHARS,
  RAG_MAX_EVIDENCE,
  RAG_MIN_EVIDENCE,
  validateRagOutput,
  type GroundedAnswer,
  type RagEvidence,
  type RagOutcome,
  type RetrievalHit,
} from '@iris/shared/types';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { callAiService } from './ai-call.js';

/**
 * Grounded answer generation — Phase 13.
 *
 * Turns the top of the already-authorized Phase 11 + Phase 12 list into a short
 * answer with citations. It reads; it writes nothing and decides nothing.
 *
 * ⚠️ AUTHORIZATION HAPPENED BEFORE THIS FUNCTION EXISTS.
 *
 * `hits` are rows RLS and the explicit product predicate already permitted, in
 * the order Phase 12 left them. This function does not filter, re-check or
 * widen that set — it cannot, and must not be able to. The model is never an
 * authorization mechanism; it is handed evidence that was already cleared and
 * asked to write about it.
 *
 * ⚠️ THE MODEL CITES SOURCE NUMBERS, NEVER IDENTIFIERS. Evidence is numbered
 * 1..N and carries no source_id, product_id, reference or tenant identity. A
 * citation to a document Core did not supply is unrepresentable.
 *
 * ⚠️ AND IT FAILS CLOSED. Unlike Phase 12 reranking, which drops a bad ordinal
 * and keeps going, an unverifiable citation discards the WHOLE answer: a
 * mangled ranking is still a valid set of authorized rows, but an answer whose
 * provenance cannot be checked is precisely what this phase exists to prevent.
 */

export interface RagResult {
  /** Absent unless a fully validated, grounded answer was produced. */
  grounded?: GroundedAnswer;
  outcome: RagOutcome;
  latencyMs: number | null;
  evidenceCount: number;
  citationCount: number;
}

export type RagFn = (
  question: string,
  hits: RetrievalHit[],
  requestId: string,
) => Promise<RagResult>;

/**
 * Generate a grounded answer. NEVER THROWS.
 *
 * Every failure path returns no `grounded` field and an outcome saying why, so
 * the caller returns plain retrieval results. Generation failing must never
 * make retrieval unavailable.
 */
export async function generateGroundedAnswer(
  question: string,
  hits: RetrievalHit[],
  requestId: string,
  fetchImpl?: typeof fetch,
): Promise<RagResult> {
  const skip = (outcome: RagOutcome, latencyMs: number | null = null): RagResult => ({
    outcome,
    latencyMs,
    evidenceCount: 0,
    citationCount: 0,
  });

  if (!config.RAG_ENABLED) return skip('skipped_disabled');
  if (hits.length < RAG_MIN_EVIDENCE) return skip('skipped_no_evidence');

  const window = hits.slice(0, RAG_MAX_EVIDENCE);

  const evidence: RagEvidence[] = window.map((h, i) => ({
    source_number: i + 1,
    source_type: h.source_type,
    title: h.title,
    // Bounded: the snippet is already a Phase 11 excerpt, and this caps what a
    // single long row can contribute to the prompt.
    excerpt: h.snippet.slice(0, RAG_EXCERPT_CHARS),
  }));

  const outcome = await callAiService<unknown>(
    {
      feature: 'rag',
      requestId,
      // The question travels as `description` — the field for "the text to
      // process" — matching how embedding and reranking carry theirs.
      input: { subject: null, description: question, evidence },
      timeoutMs: config.RAG_TIMEOUT_MS,
    },
    fetchImpl,
  );

  if (!outcome.ok) {
    /**
     * Temporary (timeout, 429, 5xx, unreachable) and permanent (no credential,
     * unparseable body) collapse to the same ACTION here — return retrieval
     * results — but keep distinct outcome codes so a degradation is
     * diagnosable without turning on debug logging. Encoding a retryability
     * signal that nothing acts on would be a second retry owner waiting to be
     * written; BullMQ remains the only one in the platform.
     */
    const reason: RagOutcome =
      outcome.reason === 'timeout'
        ? 'provider_timeout'
        : outcome.reason === 'not_configured'
          ? 'not_configured'
          : outcome.reason === 'invalid'
            ? 'malformed'
            : 'provider_unavailable';
    logger.warn(
      {
        request_id: requestId,
        reason,
        status: outcome.status,
        ms: outcome.latencyMs,
        evidence_count: evidence.length,
      },
      'grounded answer unavailable - returning retrieval results',
    );
    return { outcome: reason, latencyMs: outcome.latencyMs, evidenceCount: evidence.length, citationCount: 0 };
  }

  /**
   * ⚠️ THE VALIDATION BOUNDARY, and it is fail-closed.
   *
   * Length, control characters, citation type, citation range and duplicates
   * are all checked against the evidence THIS call supplied. Anything that
   * cannot be verified discards the answer entirely — the user gets retrieval
   * results rather than prose whose sources cannot be confirmed.
   */
  const checked = validateRagOutput(outcome.value, evidence.length);
  if (!checked.ok) {
    const invalidCitation = checked.reason.includes('citation');
    logger.warn(
      {
        request_id: requestId,
        // The REASON only. Never the answer text, which is model prose about
        // customer content.
        reason: checked.reason,
        evidence_count: evidence.length,
      },
      'grounded answer rejected by validation',
    );
    return {
      outcome: invalidCitation ? 'invalid_citation' : 'malformed',
      latencyMs: outcome.latencyMs,
      evidenceCount: evidence.length,
      citationCount: 0,
    };
  }

  return {
    grounded: {
      answer: checked.answer,
      // Already validated as 1..N over `window`, which is the head of `hits` —
      // so these are exactly 1-based indexes into the answers the caller
      // returns. No identifier is involved at any point.
      cited: checked.citations,
      insufficient: checked.insufficient,
    },
    outcome: checked.insufficient ? 'insufficient_evidence' : 'grounded',
    latencyMs: outcome.latencyMs,
    evidenceCount: evidence.length,
    citationCount: checked.citations.length,
  };
}
