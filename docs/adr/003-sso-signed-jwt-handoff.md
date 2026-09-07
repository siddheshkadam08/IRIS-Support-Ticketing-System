# ADR-003: SSO and identity federation — signed JWT handoff

**Status:** Accepted · **Date:** 2026-07-26 · **Answers brief §4.3**

## Context

The platform does not own end-user accounts — it accepts identity from the integrating product. The brief asks us to pick one of OIDC, SAML, or a signed-token handoff and explain why, and to answer: **what happens if the product's identity provider goes down — can existing tickets still be viewed?**

The decisive constraint is *where* this happens: inside an **iframe**, embedded in the product's own page, for a user the product authenticated seconds ago.

## Decision

**Short-lived signed JWT handoff as the primary mechanism. OIDC offered per-product. SAML not supported.**

The product mints a JWT (`exp − iat ≤ 300 s`, RS256/ES256, `kid` required) and the platform verifies it against the product's published JWKS. The raiser is keyed on **`(product_id, iss, sub)`** — never on email.

## Alternatives considered

| Option | Verdict | Why |
|---|---|---|
| **Signed JWT handoff** | ✅ **Chosen** | The product already authenticated this user. A redirect flow re-solves a solved problem, adds two network round-trips, and **breaks badly inside an iframe** — third-party cookie blocking and popup blockers make redirect-based auth unreliable in exactly our deployment context. Lowest integration cost: the product mints a token with key material it already has. |
| **OIDC** | ⚪ Offered, not default | Correct when a product wants the *platform* to drive login — e.g. a future standalone customer portal. Supported via per-product config. Not the default because it inverts the control flow for no gain in the embedded case. |
| **SAML** | ❌ Rejected | XML-DSig tooling, canonicalisation pitfalls, and redirect/POST binding friction inside an iframe, with no capability advantage over a signed JWT here. Add only if a specific integrator mandates it contractually. |
| **Shared session cookie** | ❌ Rejected | Requires same-site deployment, which destroys the "any product" portability that is the entire point. |

## Key sub-decisions

**Identity is keyed on `(product_id, iss, sub)`, not email.** Emails change and are not guaranteed unique across a product's customer tenants. The tuple is immutable and product-owned, which makes the mapping reliable and consistent across every ticket that user ever raises — which is what the brief asks for.

**Asymmetric algorithms only.** The verifier is given an explicit `['RS256','ES256']` allowlist. `alg: none` and HS256-confusion (signing with the public key as an HMAC secret) are the two classic JWT breaks, and a permissive verifier accepts both.

## Consequences

**Positive**
- No re-authentication, no redirect, no latency inside the widget. A user raises a ticket without noticing an identity boundary was crossed — a scored demo moment.
- No shared user store, no user-provisioning sync, no account lifecycle to maintain.

**Negative**
- Products must publish a JWKS endpoint and mint tokens. This is the one genuine ask at the low-code tier, and it is ~20 lines with any standard JWT library.
- We depend on their JWKS being reachable at raise time. Mitigated below.

**IdP-down behaviour — the brief asks this explicitly**

At raise time the platform **snapshots the raiser's identity onto the ticket** (`raiser_identity`: name, email, tenant, refs). Therefore:

| During a full IdP outage | |
|---|---|
| Existing tickets viewable and workable by support | ✅ Yes, fully. We depend on the IdP only at the *instant* of raise, never afterwards |
| Existing tickets viewable by the raiser | ✅ If they hold a valid session; otherwise blocked until the IdP returns |
| **New** SSO raises | ❌ Blocked — we cannot verify who is asking |
| Break-glass | Optional per-product "email-verified raise" (magic link), **off by default** because it is a weaker assertion. Such tickets are flagged `identity_assurance: 'email_verified'` so support can see the difference |

**Mitigations**
- JWKS cached per `Cache-Control`, refetched on unknown `kid`, **rate-limited to 1 refetch per key per 60 s** — otherwise a stream of bogus `kid`s turns us into a DoS amplifier against the product's IdP.
- `jti` replay cache for the token's lifetime.

## Related

HLD [§7.2](../HLD.md), [§7.4](../HLD.md) · [api-contract.md §4](../api-contract.md)
