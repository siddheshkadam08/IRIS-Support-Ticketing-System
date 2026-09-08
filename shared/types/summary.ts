/**
 * AI ticket summary — Phase 5.
 *
 * WHAT THIS IS FOR. Classification answers "what kind of ticket is this?".
 * Summary answers "what is actually happening in this ticket?" — so an agent
 * can grasp it without reading the whole thing.
 *
 * ⚠️ INFORMATIONAL ONLY. The summary changes no business state. It cannot
 * touch priority, severity, category, routing, assignment, status or
 * authorization, and it is structurally incapable of doing so: those fields
 * are not in this contract, and Core's validator returns nothing but a string.
 *
 * WHY IT IS A SEPARATE FEATURE rather than two more fields on the
 * classification payload:
 *
 *   - the Phase 4 contract is frozen at 18 fields, deliberately;
 *   - the two capabilities must fail INDEPENDENTLY. A ticket whose summary
 *     fails must keep its classification, and vice versa. Sharing one
 *     execution would make either failure lose both results;
 *   - `UNIQUE(event_id, feature)` already gives each its own identity,
 *     retry budget, audit trail and replay, at no cost.
 *
 * The reference implementation instead appends a second inline call inside
 * classification and swallows its failures. That is coherent for a synchronous
 * request/response design; IRIS is asynchronous and already owns retry, so a
 * separate feature is both simpler and stricter here.
 */

/**
 * The whole output contract. One field.
 *
 * Everything a summary could plausibly also carry — recommendation, root
 * cause, resolution, next action, confidence, sentiment — is deliberately
 * absent. Each would either duplicate classification, invite the model to
 * speculate, or turn an informational field into an implied decision.
 */
export interface SummaryData {
  summary: string;
}

/**
 * Hard ceiling, enforced by Core.
 *
 * The prompt asks for roughly 40 words; this is the point past which the model
 * has plainly ignored the contract rather than merely run long. Over this the
 * execution FAILS rather than being truncated: unlike keywords, the summary is
 * the entire payload, so there is no other work being protected by salvaging
 * it — and a summary cut off mid-sentence is worse than none, because it reads
 * as complete while omitting whatever came after the cut.
 *
 * The reference enforces no bound at all, which is the gap this closes.
 */
export const SUMMARY_MAX_CHARS = 600;

/** Below this it is not a summary; an empty or one-word reply is a failure. */
export const SUMMARY_MIN_CHARS = 10;

/** What the prompt asks for. Well inside SUMMARY_MAX_CHARS, on purpose. */
export const SUMMARY_TARGET_WORDS = 40;
