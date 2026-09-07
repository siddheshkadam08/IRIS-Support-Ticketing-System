# ADR-008: Dual access mechanism — callback and client-minted pre-authorized link

**Status:** Accepted · **Date:** 2026-07-26 · **Related:** [ADR-002](002-callback-security-hmac.md)

## Context

The brief mandates (§3.6) that on assignment the platform invokes a product-registered callback granting scoped access, and on close invokes a revoke callback — and names it in a scored success criterion:

> *"Callback access flow — ticket raised, support user assigned, **callback invoked**, scoped access granted in the integrating product, ticket closed, **revoke callback invoked**, access removed."*

The brief also identifies this as the riskiest part of the build and explicitly permits a stub over a broken implementation.

The design tension: the callback mechanism is what the brief asks for, but it has a structural weakness ([ADR-002](002-callback-security-hmac.md)) — **it trusts the platform.** A compromised platform can mint a correctly-signed grant for any user and any scope. For a system whose entire pitch is time-bounded scoped access, that is worth doing better than.

The prior design doc resolved this by making a client-minted pre-authorized link the *primary* mechanism and demoting the callback to "advanced, optional." That is the better security design — and it risks failing an explicitly scored criterion in pursuit of elegance.

## Decision

**Ship both. Demonstrate both. Each sample product uses a different one.**

| Sample product | Mechanism | Proves |
|---|---|---|
| **product-a (Carbon)** | Server-to-server **callback** (full-code) | The literal brief requirement, end to end, including revoke-failure retry and DLQ |
| **product-b (iFile)** | Client-minted **pre-auth link** (low-code) | The innovation: a compromised platform cannot fabricate access |

This is efficient rather than expensive: the two sample products already exist to prove portability. Giving them different access mechanisms proves portability **and** covers both criteria in the same demo minutes — and demonstrates that the contract supports more than one access model, which is itself a portability argument.

**Layer T1 is unchanged and independent of this choice:** platform-side access to ticket data is granted by RLS synchronously, in the same transaction as the assignment. No callback, no network, no trust gap.

**Revoke timing:** at `resolved`, with an idempotent re-assert at `closed`. The brief says close; resolve is tighter (access should not survive the customer-rating window). Doing both satisfies the brief's literal wording and takes the stronger posture, at the cost of one no-op call.

## Alternatives considered

| Option | Verdict | Why |
|---|---|---|
| **Both mechanisms** | ✅ **Chosen** | Satisfies the mandated criterion *and* ships the stronger design. Marginal cost is low because the lifecycle, state machine, and audit trail are shared — only the T2 transport differs. |
| Callback only | ❌ Rejected | Meets the brief and stops there. Leaves the "compromised platform forges access" weakness unanswered, which is the most interesting question in the whole problem statement. |
| Pre-auth link only | ❌ Rejected | Better security, but demotes an explicitly scored success criterion to optional. Elegance is not worth failing a stated criterion. |
| Platform-owned permission model | ❌ Rejected outright | Would require the platform to understand every product's ACLs. Destroys "any product" portability, and makes us the single most valuable target in the estate. The brief is explicit: *"the platform doesn't own the product's permission model, just signals it."* |

## Why mechanism B is stronger

> **The platform never holds the power to grant access on its own.** It can only *relay and time-box* a capability the product minted and signed. The platform never sees the product's signing key. Therefore **even a fully compromised platform cannot fabricate access into the product** — it can only replay a product-minted, product-scoped capability that the product still validates on use.

Mechanism A cannot make that claim. This asymmetry is the reason both exist, and it is the sharpest thing to say to a judge.

Mechanism B also **degrades safely**: it self-expires via `max_ttl` even if no revoke is ever delivered. Mechanism A depends on delivery, which is why a dead-lettered revoke there is treated as a security incident.

## Consequences

**Positive**
- Three independent expiries protect every T2 grant, and **any one surviving is sufficient**: platform revokes at resolve; `max_ttl ≤ SLA target`; the product re-checks ticket status on use.
- The pattern generalises well beyond ticketing — the brief calls this out as a reusability goal.

**Negative**
- Two code paths in `core-service/src/access/`, two sets of tests, two integration guides. Contained by sharing the `access_grant` lifecycle and state machine; only the transport differs.
- Mechanism B asks the product to mint and validate a capability — more work than registering a callback URL. Mitigated: it is ~30 lines using auth context they already have, and the sample product is the reference implementation.

**Risk**
- This is the riskiest feature in the build. Per the brief, **a clear design with a stub beats a real implementation with security holes.** If time runs short, the callback path ships real and the pre-auth path ships stubbed with its design documented — not the reverse, because the callback is the mandated one.

## Related

HLD [§3.4](../HLD.md), [§13](../HLD.md), [§13.2](../HLD.md)–[§13.5](../HLD.md) · [api-contract.md §8](../api-contract.md) · [demo-script.md §5](../demo-script.md)
