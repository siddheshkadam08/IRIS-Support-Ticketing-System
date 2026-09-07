# ADR-001: Integration contract — REST + webhooks

**Status:** Accepted · **Date:** 2026-07-26 · **Answers brief §4.1** · **Related:** [ADR-003](003-sso-signed-jwt-handoff.md), [ADR-008](008-dual-access-mechanism.md)

## Context

The brief calls this *"the single most important design decision in the build."* The platform exposes one contract that every integrating product codes against, and the brief requires three integration depths — zero, low, and full code — with the zero-code tier being genuinely code-free beyond a script tag.

The contract has to satisfy four forces at once:

1. **Low adoption cost.** An IRIS product team should integrate in under a day, in whatever language they already use.
2. **Debuggability.** When an integration breaks at 2 a.m., both sides need to see what was sent.
3. **External versioning.** A product on v1 keeps working when v2 ships, and we do not control their release cadence.
4. **Push, not poll.** Products need ticket state changes without polling us.

## Decision

**REST/JSON over HTTPS, plus outbound webhooks. Versioned by URL path (`/v1`). Authenticated with per-product HMAC-SHA256 credentials.**

Six endpoints (raise, get, list, comment, change status, history) plus a webhook event catalogue. Full spec in [api-contract.md](../api-contract.md); machine-readable OpenAPI in `shared/contracts/`.

## Alternatives considered

| Option | Verdict | Why |
|---|---|---|
| **REST + webhooks** | ✅ **Chosen** | Lowest integration cost across the widest set of products — every language has an HTTP client and every developer already knows the idiom. Trivial to stub, log, `curl`, and replay. Webhooks push state changes without polling. Critically, it is the only option that makes the zero-code tier honest: the widget is just a REST client, so "paste a script tag" is a complete integration. |
| **GraphQL** | ❌ Rejected | Imposes schema and runtime burden on *every* integrator for a small, stable operation set (six endpoints). Versioning for external consumers is harder, not easier — deprecating a field across N unknown clients is worse than a URL major bump you control. Fine internally; wrong at a public boundary designed for low-effort adoption. |
| **Signed event bus** (Kafka/NATS) | ❌ Rejected | Forces every integrating product to run a consumer, manage offsets, and handle rebalancing. That raises the integration floor above "paste a script tag," which breaks the zero/low-code goal outright. We use a queue **internally** (BullMQ) for fan-out — the rejection is about the *boundary*, not the pattern. |
| **gRPC** | ❌ Rejected | Excellent for internal service-to-service. At an external boundary it demands codegen and HTTP/2 tooling from every integrator, and browsers cannot call it directly — which kills the widget. |

## Consequences

**Positive**
- A product can complete an integration with `curl` and debug it from server logs. That property is worth more than any elegance gained elsewhere.
- Contract tests in `shared/contracts/` run in CI both directions, so an accidental v1 break fails our build rather than a customer's.
- The published HMAC test vector ([api-contract.md §3.3](../api-contract.md)) lets an integrator self-verify their signing code before their first live call.

**Negative**
- REST over-fetches relative to GraphQL. Accepted: the response shapes are small and the client set is narrow.
- Webhooks are at-least-once, so every product must deduplicate on `event_id`. Documented prominently; the sample products implement it as reference.
- We carry the webhook delivery burden — retries, backoff, DLQ. Mitigated by handling it in `notification-service` alongside email/WhatsApp/Slack, which need identical machinery.

**Mitigations**
- Gap recovery via `GET /v1/tickets?updated_after=` so webhooks are an optimisation over polling, never the only path to a state change.
- URL-path versioning keeps the version visible in every log line, with no invisible header state.

## Related

HLD [§4](../HLD.md), [§5.1](../HLD.md) · [api-contract.md §1](../api-contract.md), [§9](../api-contract.md)
