# ADR-004: Multi-product isolation — Row-Level Security + application checks

**Status:** Accepted · **Date:** 2026-07-26 · **Answers brief §4.4** · **Related:** [ADR-007](007-polyglot-topology-one-db-credential.md)

## Context

Tickets from Product A and Product B live in one platform and must be isolated. The brief: *"A support user authorised for Product A should not see Product B tickets without explicit permission. How is this enforced — schema separation, row-level security, application-layer checks? Defend the choice."*

This underwrites the *No security holes* success criterion, and the platform's core value proposition — **cross-product single-pane analytics** — pulls in the opposite direction from isolation. Whatever we choose must deliver both.

The realistic threat is not a malicious insider. It is **a developer forgetting a `WHERE product_id = $1` at 2 a.m. on day three of a hackathon.**

## Decision

**PostgreSQL Row-Level Security on `product_id`, plus application-layer scope checks. Defence in depth.**

Every session sets `app.product_scope`, `app.support_user_id`, `app.role`, `app.request_id` via `SET LOCAL` inside a transaction. Every product-scoped table has both `ENABLE` and `FORCE ROW LEVEL SECURITY`. The application connects as a **non-owner** role.

## Alternatives considered

| Option | Verdict | Why |
|---|---|---|
| **RLS + app checks** | ✅ **Chosen** | One schema, one migration story, trivial cross-product analytics. Decisively: **if an application query forgets a `product_id` predicate, the failure mode is "zero rows," not "another product's rows."** The app-layer check is the readable early gate; the database is the backstop that a code bug cannot bypass. |
| **Application-layer checks alone** | ❌ Rejected | One forgotten predicate is a cross-tenant data leak with no error, no alert, and no test failure. Relies on perfect discipline across every query ever written, forever. |
| **Schema-per-product** | ❌ Rejected | N schemas migrating in lockstep; onboarding a product becomes a DDL event rather than an INSERT; cross-product analytics becomes a `UNION` over N schemas that must be regenerated on every onboarding. Strictly worse ops for the same guarantee RLS gives. |
| **Database-per-product** | ❌ Rejected | Strongest isolation, heaviest ops, and it **destroys the single-pane cross-product visibility that is the product's reason to exist.** Correct for a regulated multi-tenant SaaS; wrong here. |

## The two footguns — why this ADR exists at all

RLS is easy to configure into a state where it silently does nothing. Both of these produce a system that *looks* correct, passes casual testing, and makes our central security claim false.

**1. Table owners bypass RLS.** In Postgres the owner is exempt from RLS **unless forced**. If the app connects as the role that created the tables, every policy is decorative — with no error message anywhere.

```sql
ALTER TABLE ticket ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket FORCE  ROW LEVEL SECURITY;   -- applies to the owner too
```
Plus: app connects as `iris_app` (non-owner), DDL runs as `iris_migrator`. Never `SUPERUSER`, never `BYPASSRLS`.

**2. Pooled connections leak session state.** `SET` persists for the life of the *connection*. Behind a pool, request A's scope leaks into request B — a cross-tenant read with no code defect visible anywhere. Only `SET LOCAL`, always inside an explicit transaction.

**Enforced structurally, not by discipline:** `core-service/src/db/` exposes exactly one way to reach Postgres — `withScope(ctx, fn)`. Nothing else may check out a client; an ESLint rule fails the build on any direct `pool.query` outside `db/`. CI rejects a migration that creates a product-scoped table without all four required lines.

## Consequences

**Positive**
- Cross-product analytics is a plain query with a wider scope — no unions, no fan-out.
- Onboarding a product is an `INSERT`, not a migration.
- The same mechanism expresses the T0/T1/T2 access tiers (HLD §9.2), so JIT ticket access is the same enforcement path as tenant isolation rather than a second system.
- "Admin sees everything" is an additional **policy branch**, never `BYPASSRLS` — one mechanism to audit.

**Negative**
- Postgres-specific. Migrating engines would mean reimplementing isolation. Accepted deliberately.
- Every query path must go through `withScope`, which is a real constraint on how the service is written.
- RLS predicates add planning cost. Mitigated: every index on a product-scoped table **leads with `product_id`**.

**Verification**
- Security test 5 asserts that a query written *without* a `product_id` predicate returns zero rows. This proves RLS is genuinely enforcing, rather than proving our `WHERE` clauses happen to be correct today — and it runs live in the demo.

## Related

HLD [§9](../HLD.md), [§9.1](../HLD.md), [§9.2](../HLD.md) · [core-service/SKILLS.md](../../core-service/SKILLS.md) · [infra/SKILLS.md](../../infra/SKILLS.md)
