/**
 * Agent Copilot — Phase 15.
 *
 * Drafts a customer reply for a support agent, grounded in the current ticket,
 * authorized knowledge articles and similar historical tickets.
 *
 * ⚠️ THE ONE RULE THIS PHASE EXISTS TO ENFORCE:
 *
 *     AI-GENERATED CONTENT IS A DRAFT UNTIL AN AUTHORIZED HUMAN EXPLICITLY
 *     SENDS IT.
 *
 * And the guarantee underneath it:
 *
 *     THE AI SERVICE HAS NO CAPABILITY TO SEND A CUSTOMER-FACING COMMENT.
 *
 * That is structural, not a policy anyone has to remember. Drafting is a
 * read-only endpoint that returns text; sending is `POST
 * /admin/api/tickets/:id/comments`, which requires an authenticated support
 * user, was written in Phase 1 and is untouched by this phase. Core calls the
 * AI service; the AI service never calls Core, holds no database credential,
 * and holds no token that could post anything.
 *
 * ⚠️ DRAFTS ARE EPHEMERAL, AND THAT IS A SECURITY DECISION.
 *
 * Nothing is persisted. The draft is returned to the browser, the agent edits
 * it in the reply box that already existed, and the text that reaches the
 * customer is whatever the human had in that box when they pressed Send.
 *
 * A whole class of attacks therefore cannot be expressed: there is no stored
 * draft to send later, to send from another tab, to send after discarding, to
 * read across users or products, or to tamper with. "Discard" is closing the
 * box. The server never trusts a client-supplied draft identity because there
 * is no draft identity.
 *
 * ⚠️ IT DECIDES NOTHING. Drafting changes no priority, severity, category,
 * status, assignment, SLA or access grant, and creates no comment. A citation
 * proves where a sentence came from; it does not make the action in that
 * sentence authorized.
 */

/**
 * One numbered piece of evidence, as the model sees it.
 *
 * ⚠️ NOTE WHAT IS ABSENT: source_id, ticket id, product_id, product_tenant_id,
 * reference, raiser identity, URL. Core numbers its own evidence and the model
 * cites NUMBERS, so a citation to something Core did not supply is
 * unrepresentable — the same property Phases 12 and 13 established.
 */
export interface CopilotEvidence {
  /** 1-based position in CORE's list. The only handle the model is given. */
  source_number: number;
  /**
   * ⚠️ THE KINDS MEAN DIFFERENT THINGS, and the prompt leans on the
   * distinction. A knowledge article is documented guidance. A historical
   * ticket is *one thing that happened once* — evidence that a problem has
   * been seen before, never proof that its cause or fix applies now.
   */
  kind: 'kb_article' | 'historical_ticket';
  title: string;
  excerpt: string;
}

/** What the model returns. Two fields. */
export interface CopilotData {
  draft: string;
  citations: number[];
}

/**
 * Must match `COPILOT_PROMPT_VERSION` in ai-service/src/api/copilot.py.
 *
 * v2 (pre-Phase-16 hardening): the ban on describing company actions became an
 * explicit enumeration, after the general form was measured failing 6/6 on a
 * refund demand ("I will escalate this to the appropriate team"); and an
 * explicit conflicting-evidence rule was added to match Phase 13 RAG.
 *
 * v3: v2 still failed (5/6 refund demand, 6/6 account deletion). The
 * prohibitions were arguing with the deliverable the same prompt asked for — "a
 * reply", which in the model's learned sense ends with what the company will
 * do. v3 asks instead for the INFORMATIONAL HALF of a reply, with the agent
 * owning the half that commits anyone, so omitting a company action completes
 * the task rather than leaving it unfinished. Measured 0/6 and 0/6.
 */
export const COPILOT_PROMPT_VERSION = 'copilot-v3';

/**
 * Evidence budget, split by kind.
 *
 * Small on purpose. A reply is grounded in a couple of relevant things, not in
 * everything the corpus can return — and each extra source is another chance
 * for the model to cite something marginal. The measured corpus supplies 12
 * articles and ~13 historical tickets per product, so these are ceilings rather
 * than targets.
 */
export const COPILOT_MAX_KB_EVIDENCE = 3;
export const COPILOT_MAX_HISTORICAL_EVIDENCE = 2;
export const COPILOT_MAX_EVIDENCE = COPILOT_MAX_KB_EVIDENCE + COPILOT_MAX_HISTORICAL_EVIDENCE;

/** Chars of excerpt per evidence item. Bounds the prompt and the cost. */
export const COPILOT_EXCERPT_CHARS = 600;

/** Public comments of the current ticket included as context, newest last. */
export const COPILOT_MAX_TICKET_COMMENTS = 6;

/**
 * Hard ceiling on the draft.
 *
 * A support reply is a few paragraphs. Past this the model has stopped writing
 * a reply, and — as with the Phase 5 summary and the Phase 13 answer — it is
 * REJECTED rather than truncated: a reply cut mid-sentence reads as complete
 * while omitting whatever qualified it, which is exactly the wrong failure for
 * text a human is about to send to a customer.
 */
export const COPILOT_DRAFT_MAX_CHARS = 2000;

/** Below this it is not a reply — an empty or one-word draft is a failure. */
export const COPILOT_DRAFT_MIN_CHARS = 20;

export type CopilotOutcome =
  | 'drafted'
  | 'insufficient_evidence'
  | 'no_evidence'
  | 'provider_timeout'
  | 'provider_unavailable'
  /**
   * ⚠️ The provider read this exact prompt and REFUSED it — Azure's content
   * management policy, arriving as HTTP 400 upstream. Distinct from
   * `provider_unavailable` because nothing is down and a retry can only fail
   * again: an operator chasing an outage here would find none, and a caller
   * treating it as transient would be wrong. Nothing retries either one.
   */
  | 'provider_refused'
  | 'malformed'
  | 'invalid_citation'
  | 'not_configured';

export type CopilotValidation =
  | { ok: true; draft: string; citations: number[]; insufficient: boolean }
  | { ok: false; reason: string };

/**
 * Validate a model response against the evidence it was given.
 *
 * PURE and FAIL-CLOSED. Anything unverifiable returns `ok: false` and the agent
 * gets no draft at all — which is the safe outcome, because the alternative is
 * putting text a human might send in front of them with provenance nobody can
 * check.
 *
 * @param evidenceCount how many sources were supplied; citations are 1..N
 */
export function validateCopilotOutput(value: unknown, evidenceCount: number): CopilotValidation {
  if (typeof value !== 'object' || value === null) return { ok: false, reason: 'not an object' };
  const raw = value as { draft?: unknown; citations?: unknown };

  if (typeof raw.draft !== 'string') return { ok: false, reason: 'draft must be a string' };

  /**
   * Control characters are STRIPPED and tab/newline/CR become spaces — with one
   * deliberate exception below. The same normalisation the summary and RAG
   * validators use, so every AI-authored string in the platform behaves the
   * same way in the same UI.
   *
   * ⚠️ PARAGRAPH BREAKS SURVIVE. A customer reply is not a one-liner, and
   * collapsing it into a wall of text would make the agent reformat every
   * draft by hand. Runs of blank lines collapse to exactly one break; every
   * other whitespace run collapses to a single space.
   */
  const draft = raw.draft
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) =>
      [...line]
        .filter((ch) => {
          const cp = ch.codePointAt(0) ?? 0;
          return cp >= 0x20 && cp !== 0x7f;
        })
        .join('')
        .replace(/[^\S\n]+/g, ' ')
        .trim(),
    )
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (draft.length === 0) return { ok: false, reason: 'draft is empty' };
  if (draft.length < COPILOT_DRAFT_MIN_CHARS) return { ok: false, reason: 'draft is too short' };
  if (draft.length > COPILOT_DRAFT_MAX_CHARS) {
    return { ok: false, reason: 'draft ignored the length contract' };
  }

  if (!Array.isArray(raw.citations)) return { ok: false, reason: 'citations must be an array' };

  const seen = new Set<number>();
  for (const c of raw.citations) {
    if (typeof c !== 'number' || !Number.isInteger(c)) {
      // Where a fabricated identifier arrives. It is not a number, so it is not
      // a citation, and the draft it was meant to support is discarded.
      return { ok: false, reason: 'citation is not an integer' };
    }
    if (c < 1 || c > evidenceCount) {
      return { ok: false, reason: `citation ${c} is outside the supplied evidence` };
    }
    if (seen.has(c)) return { ok: false, reason: `citation ${c} is duplicated` };
    seen.add(c);
  }

  /**
   * ⚠️ EMPTY CITATIONS ARE VALID HERE, and that differs from Phase 13 RAG on
   * purpose.
   *
   * RAG exists to answer a question from sources, so an uncited answer is a
   * failure of the thing it was asked to do. A support reply legitimately
   * contains sentences that cite nothing — an acknowledgement, a request for
   * more detail, a next step. Requiring a citation would push the model to
   * attach one to a sentence it does not support, which is worse than none.
   *
   * It is FLAGGED so Core and the UI can tell the agent the draft rests on no
   * evidence, which is exactly when a human should read it hardest.
   */
  return { ok: true, draft, citations: [...seen], insufficient: seen.size === 0 };
}

/**
 * What the agent's browser receives.
 *
 * `sources` are the evidence items the draft could cite, in the same order the
 * model saw them, so the UI can show "the draft used these" beside the text.
 * Titles only — no identifiers.
 */
export interface CopilotDraftResponse {
  /** Absent unless a fully validated draft was produced. */
  draft?: string;
  /** 1-based indexes into `sources`. Never identifiers. */
  citations: number[];
  sources: Array<{ source_number: number; kind: CopilotEvidence['kind']; title: string }>;
  /** True when the draft cites nothing — the agent should read it harder. */
  insufficient: boolean;
  outcome: CopilotOutcome;
  /** Bounded, non-sensitive diagnostics. Never draft, ticket or evidence text. */
  diagnostics: {
    kb_evidence: number;
    historical_evidence: number;
    ticket_comments: number;
    retrieval_ms: number;
    generation_ms: number | null;
    total_ms: number;
    model: string | null;
    prompt_version: string;
  };
}
