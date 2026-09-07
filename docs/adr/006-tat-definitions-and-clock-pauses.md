# ADR-006: TAT definitions and clock pauses — two clocks

**Status:** Accepted · **Date:** 2026-07-26 · **Answers brief §4.6**

## Context

The brief warns: *"TAT seems simple but isn't. Does the clock pause when waiting on the raiser? Does it pause overnight or on weekends? Does the SLA clock differ from the customer-facing TAT? Without this, TAT numbers will be misleading."*

Two legitimate parties want incompatible answers from the same measurement:

- **The support team** is judged on time it could control. Being blocked on a customer over a weekend is not their failure.
- **The customer** experienced three calendar days of waiting, whatever our calendar says.

Picking one number makes the other party's experience unrepresentable, and produces the argument the brief predicts: *"your SLA says 4 hours but I waited 3 days."*

## Decision

**Two clocks, both stored, always reported side by side.**

| Clock | Pauses | Used for |
|---|---|---|
| **SLA clock** | Outside the product's business calendar (timezone, working days/hours, holidays) **and** while status is `waiting_on_raiser` | SLA compliance %, breach alerts, agent performance |
| **Customer-facing TAT** | Never — wall clock | What we show the raiser; what analytics reports as "elapsed" |

**Three measured metrics:** time to first response (`raised_at → first_response_at`), time to resolution (`raised_at → resolved_at`), assignment to resolution (`assigned_at → resolved_at`).

**Locked definitions:**
- **`first_response_at` = the first non-internal comment authored by a support user.** Not the move to `assigned` — a ticket being picked up is not a response to the customer.
- **`waiting_on_raiser` is an explicit status**, not an inferred state. A clock that pauses on a guess is a clock nobody trusts.
- Business calendar, pause rules, and severity→SLA targets are **per-product config**.

**Storage:** `sla_clock.segments` holds every run/pause span as `{from, to, state}`. **Never store only a total** — a total cannot be recomputed when a calendar changes, and cannot be audited when a number is disputed.

**Three health states:** On Track (< 80% consumed) · **At Risk (≥ 80% consumed, unresolved)** · Breached.

## Alternatives considered

| Option | Verdict | Why |
|---|---|---|
| **Two clocks, both reported** | ✅ **Chosen** | Both numbers are true; they measure different things. Reporting both pre-empts the argument instead of losing it. Costs one extra column and one extra chart series. |
| Wall clock only | ❌ Rejected | Punishes a team for a customer who replied on Monday, and for a holiday. Makes SLA targets meaningless as a management tool. |
| Business-hours clock only | ❌ Rejected | Systematically understates customer pain and produces the exact quote in the brief. A customer does not care about our calendar. |
| Pause on inferred inactivity | ❌ Rejected | Pausing because "no agent action in 24 h" rewards inattention. The pause must be an explicit, audited state transition someone is accountable for. |
| First response = `assigned` | ❌ Rejected | Assignment is invisible to the customer. It would let the metric be gamed by mass-assigning tickets nobody has read. |
| Store only accumulated totals | ❌ Rejected | Unauditable and unrecomputable. When a number is disputed — and it will be — we must be able to reconstruct it. |

## Consequences

**Positive**
- Any TAT number is reconstructable from `segments` and defensible in a dispute.
- Analytics report **p50 and p90, not averages** — a mean hides exactly the tail that matters, which is the reason anyone looks at TAT.
- *At Risk* makes the dashboard operational rather than a post-mortem: a lead can intervene before the breach.

**Negative**
- Two numbers need explaining on every screen. Mitigated by always labelling them and never showing one alone.
- Business-calendar arithmetic across timezones and holidays is genuinely fiddly and needs real unit tests. It is isolated in `core-service/src/sla/` for exactly that reason.
- `waiting_on_raiser` depends on agents actually setting it. Mitigated: it is a prominent one-click action on ticket detail, and an automation rule can set it on an outbound question.

## Related

HLD [§14](../HLD.md), [§10](../HLD.md), [§10.1](../HLD.md) · [core-service/SKILLS.md §6](../../core-service/SKILLS.md) · [demo-script.md §7.2](../demo-script.md)
