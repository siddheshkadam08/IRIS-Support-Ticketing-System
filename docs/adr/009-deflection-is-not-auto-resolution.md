# ADR-009: Deflection is not auto-resolution — the AI autonomy boundary

**Status:** Accepted · **Date:** 2026-07-26 · **Source:** UI mockup reconciliation · **Related:** [ADR-005](005-ai-confidence-thresholds.md), [ADR-011](011-live-chat-deferred.md)

## Context

The admin panel mockup (`docs/images/Image.jpg`) shows a dashboard counter labelled **"Auto Resolved: 742"** alongside a **Deflection Rate of 22%**.

This appears to contradict two hard commitments:

- The brief, on AI drafts: *"must be reviewed by a human before sending, **never auto-sent**."*
- HLD §15: *"AI is suggestive, never autonomous, on anything customer-facing."*

Left unreconciled, this is not just an internal inconsistency — it is a **credibility problem in the demo**. A judge who sees "Auto Resolved" next to a claim that AI never acts autonomously will (correctly) probe it, and the answer will sound like a retrofit.

The underlying capability the mockup is pointing at is real and valuable: a user asks the widget a question, gets a good answer from the knowledge base, and goes away happy without filing a ticket.

## Decision

**Draw the boundary at whether a ticket exists.**

| Concept | Definition | Allowed |
|---|---|---|
| **Deflection** | A user asks the widget a question, gets a KB/AI answer, and **never files a ticket**. No ticket is ever created, so nothing was resolved on anyone's behalf | ✅ **Yes** |
| **Auto-resolution** | An AI-generated response is sent on an **open ticket**, and the ticket moves to `resolved` without a human | ❌ **No** — violates the brief |

**Consequences for the build:**

1. The dashboard counter is renamed **"Self-Served"** and counts `widget_conversation` rows with `outcome='self_served'`. **It never counts tickets.** The metric card links to the deflection log, not to a ticket list.
2. `POST /v1/widget/ask` explicitly creates no ticket and returns no ticket id.
3. The user can always reach *Create a Ticket* in one click. Deflection must never become a wall between a customer and support.
4. Below `product.config.deflection.min_score`, the widget offers to create a ticket instead of answering — a weak answer is worse than no answer.
5. Every deflected conversation is recorded, so the metric is auditable rather than asserted.

## Alternatives considered

| Option | Verdict | Why |
|---|---|---|
| **Deflection allowed, auto-resolution forbidden** | ✅ **Chosen** | Captures the genuine value (customers self-serve, support volume drops) without ever letting AI speak for the company on an open ticket. The distinction is principled, not a semantic dodge: in deflection the user is choosing to accept an answer; in auto-resolution the system is deciding on their behalf. |
| Allow auto-resolution on high confidence | ❌ Rejected | Directly violates the brief. Also wrong on the merits: a wrong auto-resolution closes a real problem and tells the customer it is fixed — the worst possible failure mode for a support system, and the one that destroys trust fastest. |
| Forbid deflection too | ❌ Rejected | Over-corrects. Answering a question a user asked, before any ticket exists, is a search feature, not autonomy. Forbidding it would discard the mockup's most valuable idea and a brief stretch goal (*"AI suggests a likely solution to the raiser before they submit"*). |
| Keep the "Auto Resolved" label, define it as deflection | ❌ Rejected | The cheapest fix and the worst one. The label would be actively misleading to judges, support staff, and future maintainers. Names in a UI are documentation. |

## Consequences

**Positive**
- The AI autonomy story becomes one sentence that survives cross-examination: *"AI never sends anything to a customer on a ticket; it only answers questions before a ticket exists."*
- The Self-Served metric is auditable — every count has a `widget_conversation` row behind it.
- Consistent with [ADR-005](005-ai-confidence-thresholds.md): uncertain classification degrades to human triage; weak deflection degrades to ticket creation. **Both fail toward a human, never toward a confident wrong answer.**

**Negative**
- "Self-Served" is a less impressive-sounding number than "Auto Resolved". Accepted — an accurate number we can defend beats an impressive one we cannot.
- The mockup will not match the built UI on this label. Documented here so it reads as a deliberate decision rather than an implementation miss.

## Related

HLD [§3.6](../HLD.md), [§15](../HLD.md), [§15.4](../HLD.md), [§15.5](../HLD.md) · [api-contract.md §5.8](../api-contract.md) · [ui-spec-deltas.md §1.1](../ui-spec-deltas.md)
