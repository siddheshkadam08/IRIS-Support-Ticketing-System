# ADR-002: Callback security model — HMAC-SHA256

**Status:** Accepted · **Date:** 2026-07-26 · **Answers brief §4.2** · **Related:** [ADR-008](008-dual-access-mechanism.md)

## Context

When a support user is assigned a ticket, the platform tells the integrating product *"grant scoped access to this user."* The brief asks directly: **how does the product trust that the request really came from the platform, and what stops a malicious actor forging a grant request?**

This is the highest-stakes message the system sends. A forged grant is unauthorised access to a customer's data inside a third-party product.

Constraints: the product may be in any language; the mechanism must be implementable in an afternoon by an integrator; and it must work for both directions of signed traffic (our webhooks out, their API calls in).

## Decision

**HMAC-SHA256 over a canonical string, with a per-product shared secret, a ±300 s timestamp window, and a nonce cache.**

The same primitive secures all three signed paths — inbound API calls, outbound webhooks, and access grant/revoke callbacks — so there is one thing to implement, document, and test.

Canonical string binds **method and path**, so a captured request cannot be replayed against a different endpoint. Verification uses constant-time comparison. Reference implementations and shared test vectors live in `shared/hmac-utils/`, imported by both the gateway and the sample products — a divergence becomes a failing test rather than a 2 a.m. mystery.

## Alternatives considered

| Option | Verdict | Why |
|---|---|---|
| **HMAC-SHA256 shared secret** | ✅ **Chosen** | Implementable in ~15 lines in any language with only a standard library. No PKI, no certificate lifecycle, no clock-skew-on-cert-expiry class of failure. The secret is never transmitted — it signs. Familiar to anyone who has integrated Stripe or GitHub webhooks, which is most integrators. |
| **mTLS** | ❌ Rejected | Strongest transport authentication, but it demands certificate provisioning, distribution, rotation, and a trust store on the product's side — plus it is frequently terminated at a load balancer the product team does not control, silently destroying the guarantee. Far too heavy for the adoption cost we are targeting. |
| **Signed JWT (asymmetric, platform-signed)** | ⚪ Considered, not chosen | Genuinely attractive: the product needs only our public key, so there is no shared secret to leak from *their* side. Rejected for v1 because it adds key distribution and rotation, and does not remove the fundamental limitation below. Worth revisiting if we productise. |
| **IP allowlisting** | ❌ Rejected as primary | Not authentication. Useful as defence in depth; useless alone. Any compromised host in an allowlisted range forges freely. |

## Consequences

**Positive**
- One primitive across every signed path; one test-vector file asserted by both TS and Python.
- Replay is closed by three independent controls: timestamp window, nonce cache, and method/path binding inside the signature.

**Negative — stated honestly, because it is the reason ADR-008 exists**
- **HMAC authenticates the platform, so it necessarily trusts the platform.** A fully compromised platform can mint a correctly-signed grant request for any user and any scope. No shared-secret scheme can prevent this.
- Shared secrets must be distributed and rotated. Mitigated by storing only an Argon2id hash and supporting rotation with an overlap window.

**Mitigations**
- The limitation above is precisely why the client-minted pre-authorized link ([ADR-008](008-dual-access-mechanism.md)) exists as the second mechanism. There, the platform holds no signing key and **cannot** forge a grant even when fully compromised.
- Products are instructed to verify the signature, the timestamp window, **and** the nonce — verifying only the signature leaves replay open, and that is the most common integrator mistake.

## Related

HLD [§13.2](../HLD.md), [§13.5](../HLD.md) · [api-contract.md §3](../api-contract.md), [§8.1](../api-contract.md)
