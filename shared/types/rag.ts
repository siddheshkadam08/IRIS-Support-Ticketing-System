/**
 * Grounded answer generation — Phase 13.
 *
 * Phase 11 retrieves, Phase 12 reorders, and this turns the top of that
 * already-authorized list into a short answer with citations.
 *
 * ⚠️ THE MODEL CITES SOURCE NUMBERS, NEVER IDENTIFIERS — the same structural
 * property Phase 12 established for reranking, for the same reason.
 *
 * Core numbers its own evidence 1..N and sends `{source_number, source_type,
 * title, excerpt}`. No source_id, product_id, product_tenant_id, reference or
 * raiser identity crosses the boundary. The model returns integers, and Core
 * maps them back through its own array.
 *
 * So a citation to a document Core did not supply is not something to detect —
 * it is unrepresentable. There is no field in which to name one.
 *
 * ⚠️ AND UNLIKE RERANKING, INVALID CITATIONS FAIL CLOSED.
 *
 * Phase 12 tolerates a bad ordinal: it drops it and keeps the row's previous
 * position, because a mangled *ranking* is still a valid set of authorized
 * rows — the worst outcome is a worse order. A mangled *citation* is
 * categorically different: it means the answer's provenance cannot be
 * verified, and an answer whose grounding cannot be checked is exactly the
 * thing this phase exists to prevent. So the whole answer is discarded and the
 * caller falls back to plain retrieval.
 *
 * ⚠️ AI PREDICTS/EXTRACTS. IRIS DECIDES. The model writes prose and points at
 * evidence. It changes no ticket state, sets no priority, closes nothing, and
 * cannot decide whether a user should file a ticket — Core reads the citation
 * count and decides that (ADR-009: deflection is not auto-resolution, and the
 * user must always be able to reach a human).
 */

/** One numbered piece of evidence, as the model sees it. Four fields. */
export interface RagEvidence {
  /** 1-based position in CORE's list. The only handle the model is given. */
  source_number: number;
  /**
   * `kb_article` or `resolved_ticket`. Not tenant data — it is the KIND of
   * evidence, and a curated article grounds a claim differently from a past
   * ticket, so withholding it would weaken the answer for no security gain.
   */
  source_type: 'kb_article' | 'resolved_ticket';
  title: string;
  excerpt: string;
}

/** What the model returns. Two fields. */
export interface RagData {
  answer: string;
  citations: number[];
}

export const RAG_PROMPT_VERSION = 'rag-v1';

/**
 * How many evidence items are sent.
 *
 * Deliberately small, and NOT a new retrieval limit: it is the top of the list
 * Phase 12 already produced, so no Phase 11 candidate bound was touched. The
 * measured corpus supplies 2–5 candidates per query anyway, so this is a
 * ceiling rather than a target.
 *
 * The objective is a high-quality small evidence set. Sending more would cost
 * tokens and latency to give the model more chances to cite something
 * marginal.
 */
export const RAG_MAX_EVIDENCE = 5;

/** Below this there is nothing to ground an answer in; skip the provider call. */
export const RAG_MIN_EVIDENCE = 1;

/** Chars of excerpt per evidence item. Bounds the prompt and the cost. */
export const RAG_EXCERPT_CHARS = 600;

/**
 * Hard ceiling on the answer.
 *
 * A grounded support answer is a paragraph, not an essay. Past this the model
 * has plainly stopped answering the question, and — as with the Phase 5 summary
 * — the answer is REJECTED rather than truncated: a reply cut mid-sentence
 * reads as complete while omitting whatever followed, which is worse than no
 * answer when the whole point is that claims are traceable.
 */
export const RAG_ANSWER_MAX_CHARS = 1200;

/** Below this it is not an answer — an empty or one-word reply is a failure. */
export const RAG_ANSWER_MIN_CHARS = 10;

export type RagOutcome =
  | 'grounded'
  | 'insufficient_evidence'
  | 'skipped_disabled'
  | 'skipped_no_evidence'
  | 'provider_timeout'
  | 'provider_unavailable'
  | 'malformed'
  | 'invalid_citation'
  | 'not_configured';

export type RagValidation =
  | { ok: true; answer: string; citations: number[]; insufficient: boolean }
  | { ok: false; reason: string };

/**
 * Validate a model response against the evidence it was given.
 *
 * PURE, so every rule below is testable without a provider, and FAIL-CLOSED:
 * anything it cannot verify becomes `ok: false` and the caller returns plain
 * retrieval results instead of an answer nobody can check.
 *
 * @param value the raw `data` object from the AI service
 * @param evidenceCount how many evidence items were supplied (citations are 1..N)
 */
export function validateRagOutput(value: unknown, evidenceCount: number): RagValidation {
  if (typeof value !== 'object' || value === null) return { ok: false, reason: 'not an object' };
  const raw = value as { answer?: unknown; citations?: unknown };

  // ── the answer ────────────────────────────────────────────────────────
  if (typeof raw.answer !== 'string') return { ok: false, reason: 'answer must be a string' };

  /**
   * Control characters are STRIPPED, not rejected, and tab/newline/CR become a
   * space rather than vanishing — the same normalisation the Phase 5 summary
   * validator uses, so two AI-authored strings displayed in the same UI cannot
   * behave differently.
   */
  const answer = [...raw.answer]
    .map((ch) => {
      const cp = ch.codePointAt(0) ?? 0;
      if (cp === 9 || cp === 10 || cp === 13) return ' ';
      return cp < 0x20 || cp === 0x7f ? '' : ch;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();

  if (answer.length === 0) return { ok: false, reason: 'answer is empty' };
  if (answer.length < RAG_ANSWER_MIN_CHARS) return { ok: false, reason: 'answer is too short' };
  if (answer.length > RAG_ANSWER_MAX_CHARS) {
    // Rejected, not truncated. See RAG_ANSWER_MAX_CHARS.
    return { ok: false, reason: 'answer ignored the length contract' };
  }

  // ── the citations ─────────────────────────────────────────────────────
  if (!Array.isArray(raw.citations)) return { ok: false, reason: 'citations must be an array' };

  const seen = new Set<number>();
  for (const c of raw.citations) {
    if (typeof c !== 'number' || !Number.isInteger(c)) {
      // Where a fabricated identifier would arrive. It is not a number, so it
      // is not a citation, and the answer it was meant to support is discarded.
      return { ok: false, reason: 'citation is not an integer' };
    }
    if (c < 1 || c > evidenceCount) {
      return { ok: false, reason: `citation ${c} is outside the supplied evidence` };
    }
    if (seen.has(c)) return { ok: false, reason: `citation ${c} is duplicated` };
    seen.add(c);
  }

  /**
   * ZERO CITATIONS IS A VALID, MEANINGFUL ANSWER — it is how the model says
   * "the supplied evidence does not answer this".
   *
   * It is flagged rather than rejected so Core can act on it: an ungrounded
   * answer must never be presented as though it were grounded, and ADR-009
   * requires the user to be offered a human instead. What Core must NOT do is
   * silently show prose with no sources under it.
   */
  return { ok: true, answer, citations: [...seen], insufficient: seen.size === 0 };
}

/**
 * The user-facing grounded answer, added ADDITIVELY to `AskResponse`.
 *
 * ⚠️ `cited` HOLDS 1-BASED INDEXES INTO `AskResponse.answers`, never database
 * identifiers. The evidence set IS the answers array, so a citation is just
 * "the third card". Nothing new about identity is exposed, and the widget
 * marks the cited cards it is already rendering.
 */
export interface GroundedAnswer {
  answer: string;
  cited: number[];
  /** True when the model reported the evidence does not answer the question. */
  insufficient: boolean;
}
