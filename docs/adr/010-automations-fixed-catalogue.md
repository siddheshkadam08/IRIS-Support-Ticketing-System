# ADR-010: Automations as a fixed catalogue, not a rule engine

**Status:** Accepted · **Date:** 2026-07-26 · **Source:** UI mockup reconciliation

## Context

The admin panel mockup (`docs/images/Image.jpg`, page 6) shows an **Automations** table: `Automation Name / Trigger / Action / Status`, with rows such as *High Priority Auto Escalation*, *SLA Breach Alert*, *Sentiment Escalation*, *Auto Assign by Category*, and *Auto Close Resolved*.

Automations appear in **neither the brief nor the original design document**. The closest the brief comes is a stretch goal: *"SLA tracking with automatic escalation when response times slip."*

The risk is scope, and it is a specific and well-known one: "configurable automation" reads like a small feature and expands without limit. A trigger/condition/action builder needs a condition DSL, a validation layer, an execution engine, a testing story, a debugging view, and a UI for composing all of it. **That is a product, not a feature.** Salesforce and Zendesk each employ teams on it.

The mockup's own content, read carefully, does not actually ask for that: five named rules, each a simple trigger→action pair with an on/off toggle.

## Decision

**Build a fixed catalogue of ~6 trigger types and ~5 action types, each rule being a toggle plus simple conditions. Do not build a general-purpose rule builder.**

| | |
|---|---|
| **Triggers** | ticket created · status changed · SLA threshold crossed · sentiment negative · no response in N days · rating received |
| **Actions** | notify manager · send email/Slack alert · auto-assign by category · change severity · close ticket |
| **Conditions** | Simple field comparisons on a fixed set (`severity`, `category`, `product_tenant_id`, `age`) — **not** a nestable expression language |
| **Storage** | `automation_rule (product_id, name, trigger, conditions jsonb, action, action_config jsonb, is_active)` |
| **Execution** | In `worker`, off the outbox event stream — **never inline in the request path** |

### Loop protection is mandatory, not optional

An action that mutates a ticket emits an event that can re-trigger a rule that mutates it again. Three controls, all required:

1. Every automation-originated mutation carries `actor_type='automation'`
2. Rule evaluation **skips events whose actor is an automation**
3. A chain is capped at **3 executions**; exceeding it logs an error and stops

Without these, one badly-configured rule saturates the queue and takes the demo down — during the demo, in front of judges, with no obvious cause.

## Alternatives considered

| Option | Verdict | Why |
|---|---|---|
| **Fixed catalogue + toggles** | ✅ **Chosen** | Delivers everything the mockup actually shows, in roughly a day. Bounded, testable, and impossible to misconfigure into an infinite loop beyond the cap. |
| **General visual rule builder** | ❌ Rejected | A product in itself. Would consume the entire remaining build, and the brief is unambiguous: *"skipping the core to chase stretch goals is not [fine]."* Automations are not even a stretch goal — they are unrequested. |
| **Hard-code the five rules with no configuration** | ❌ Rejected | Marginally cheaper, but per-product enablement is genuinely needed (a product that wants no auto-close must be able to turn it off) and the mockup shows toggles. The catalogue gives that for very little extra. |
| **Skip automations entirely** | ⚪ Serious contender | Defensible — they are unrequested. Rejected because SLA auto-escalation *is* a named stretch goal, several rules are near-free once the outbox event stream exists, and the mockup promises them. Scheduled **last** among non-stretch work (phase 7) so they are cut first if time runs out. |
| Evaluate rules inline on the request path | ❌ Rejected | A slow or looping rule would delay or fail a ticket write. Automations must never be able to break the core workflow. |

## Consequences

**Positive**
- Reuses the outbox event stream already built for webhooks and notifications — genuinely incremental.
- SLA auto-escalation, a named stretch goal, arrives essentially free.
- Bounded surface means bounded testing: each trigger×action pair is enumerable.

**Negative**
- Users cannot express a rule outside the catalogue. **Accepted deliberately** — this is the constraint that keeps the feature finishable. Extending the catalogue later is additive.
- The mockup implies more flexibility than we ship. Documented here so it reads as a scoping decision, not an oversight.

**Risk**
- Scope creep during implementation is the real danger: "just let conditions nest" is one PR away from the rejected option. **A PR that adds expression nesting, a condition DSL, or a rule-composition UI is out of scope and should be closed with a link to this ADR.**

## Related

HLD [§3.6](../HLD.md), [§12.1](../HLD.md), [§11.2](../HLD.md), [§18](../HLD.md) · [core-service/SKILLS.md §7](../../core-service/SKILLS.md) · [worker/SKILLS.md §4](../../worker/SKILLS.md)
