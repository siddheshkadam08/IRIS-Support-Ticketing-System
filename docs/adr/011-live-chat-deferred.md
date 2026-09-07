# ADR-011: Live Chat deferred — the stub converts a conversation to a ticket

**Status:** Accepted · **Date:** 2026-07-26 · **Source:** UI mockup reconciliation · **Related:** [ADR-009](009-deflection-is-not-auto-resolution.md)

## Context

The widget mockup (`docs/images/Image (1).jpg`) presents a full conversational support assistant with eight capabilities, one of which is **Live Chat — "Talk to an agent."** The "how it works" flow ends with *"Resolves with AI or hands off to human agent."*

The original design (HLD §6) described a raise-ticket **form**. The mockup is roughly **4× that scope**, and Live Chat is by far the largest single item in it.

Real-time chat is not a UI feature. It requires:

- WebSocket (or SSE) transport, with reconnection and message replay after a drop
- Agent presence and availability tracking
- Live routing — which available agent, in which queue, with what capacity
- Typing indicators, read receipts, delivery ordering
- Transcript persistence, and reconciliation of a transcript into a ticket
- A second real-time UI in the admin panel for agents to work in
- Load and connection-count handling for every embedded product page

None of this is technically hard in isolation. Collectively it is a subsystem comparable in size to the ticket workflow itself — and it appears in **neither the brief nor its stretch goals**.

Meanwhile the brief is explicit: *"Attempting and falling short on a stretch goal is fine if the core build is solid; skipping the core to chase stretch goals is not."*

## Decision

**Defer Live Chat. Ship the button with an honest stub.**

The *Talk to an agent* button converts the current widget conversation into a ticket — carrying the conversation turns as the initial description — and tells the user plainly:

> *"We've created ticket CARB-1042 from this conversation. An agent will pick this up and you'll get an email — you can track it under My Tickets."*

That is a **real, working outcome**: the user's intent is captured, a human will respond, and the user can track it. It is not a chat window that spins forever or a button that does nothing.

**The rule this follows: never let a stub look finished.** The UI says what will happen. A judge or user discovering a dead feature costs far more than the feature was worth.

## Alternatives considered

| Option | Verdict | Why |
|---|---|---|
| **Stub as ticket conversion** | ✅ **Chosen** | Preserves the user journey the mockup promises, costs roughly an hour, and is honest about what happens next. The conversation context is not lost — it becomes the ticket body, which is arguably more useful to an agent than a live chat they must be present for. |
| Build real-time chat | ❌ Rejected | A subsystem-sized commitment for an unrequested feature. Would put every scored criterion at risk. This is exactly the trap the brief warns about. |
| Polling-based "fake" chat | ❌ Rejected | Cheaper than WebSockets but still needs presence, routing, an agent-side UI, and transcript handling — most of the cost, a worse experience, and it *looks* finished, which makes it dishonest. |
| Remove the button entirely | ⚪ Considered | Cleanest technically. Rejected because human handoff is a genuine user need and the mockup promises it; the ticket conversion satisfies the need at negligible cost. |
| Third-party chat widget embed | ❌ Rejected | Would mean a second vendor, a second identity model, and a second data store outside our audit trail — undermining the single-source-of-truth claim that is the platform's whole point. |

## Consequences

**Positive**
- Widget P0 and P1 (create ticket, my tickets, ask/deflect, search docs) ship solidly instead of eight capabilities shipping half-built.
- The conversation-to-ticket path is reusable: it is also how a low-confidence deflection escalates ([ADR-009](009-deflection-is-not-auto-resolution.md)), so it is not throwaway work.
- Nothing built here has to be discarded when real chat is added later — the transcript model and handoff trigger are the same.

**Negative**
- The demo cannot show live chat. Mitigated: it was never a success criterion, and the honest framing ("here's what we deliberately deferred and why") reads as engineering judgement rather than as a gap.
- The built widget will not fully match the mockup. Documented here and in HLD §6.1 so the difference is visibly a decision.

**If asked in Q&A**

> *"Live chat is a realtime subsystem — presence, routing, transports, transcripts, and a second agent-side UI. It's in neither the brief nor its stretch goals, and building it would have put the mandated criteria at risk. So the button captures the conversation as a ticket and tells the user an agent is coming. That's a real outcome today, and the transcript model is the same one real chat would need."*

## Related

HLD [§3.6](../HLD.md), [§6.1](../HLD.md), [§18](../HLD.md), [§19](../HLD.md) · [widget/SKILLS.md §1](../../widget/SKILLS.md) · [ui-spec-deltas.md §2.4](../ui-spec-deltas.md)
