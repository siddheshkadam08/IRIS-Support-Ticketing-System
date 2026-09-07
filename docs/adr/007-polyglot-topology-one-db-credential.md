# ADR-007: Polyglot service topology and the one-DB-credential invariant

**Status:** Accepted · **Date:** 2026-07-26 · **Supersedes** the single-runtime choice in `Ticketing_Platform_Design.md` §3 · **Related:** [ADR-004](004-isolation-row-level-security.md)

## Context

The original design doc argued for one runtime — Python/FastAPI everywhere — on the reasonable grounds that a single stack is simpler to operate. The agreed service topology is polyglot: Node for gateway/core/worker/notification, Python for AI.

Two forces pull against each other:

- **Runtime uniformity** reduces operational surface: one dependency manager, one test harness, one set of idioms.
- **Team throughput** matters more in a time-boxed build. A Node track and a Python track can proceed independently from hour one; a single stack serialises the team on whoever knows it best.

Polyglot normally costs: shared types drift, duplicated auth logic, two migration stories, two ORMs, and — most dangerously — **two sets of database credentials**.

## Decision

**Keep the polyglot split, and cap its cost with a single hard invariant:**

> **Exactly one process in this system holds a Postgres credential: `core-service`.**

`ai-service` and `worker` are stateless. `ai-service` receives payloads over HTTP and returns predictions; it never opens a database connection. When it needs data — vector neighbours for retrieval or draft generation — it calls `POST /internal/tickets/similar` on `core-service`, which performs the query inside an RLS-scoped transaction.

Also decided here, correcting the original design:

**Redis + BullMQ, not Celery.** Celery's producer protocol (kombu) is Python-shaped. With Node producers enqueuing to Python consumers you hand-roll message envelopes and lose the ergonomics of both. BullMQ makes the queue Node end-to-end and turns `ai-service` into a plain request/response HTTP service.

## Alternatives considered

| Option | Verdict | Why |
|---|---|---|
| **Polyglot + one DB credential** | ✅ **Chosen** | Parallelises the team from hour one. Python is genuinely the better tool for the AI layer (`sentence-transformers`, `scikit-learn`); Node is genuinely better for a high-concurrency I/O gateway. The invariant shrinks the cross-language surface to ~5 HTTP endpoints described by one OpenAPI file — leaving almost nothing to drift. |
| Single runtime — Python everywhere | ❌ Rejected | Simpler ops, but serialises the team and puts the gateway's high-concurrency I/O work in the less natural runtime. The original doc's reasoning was sound in isolation; it undervalued parallel throughput under a deadline. |
| Single runtime — Node everywhere | ❌ Rejected | Would force the AI layer into a weaker ecosystem for embeddings and classical ML. The AI layer is a scored criterion (≥7/10); handicapping it to save a `requirements.txt` is a bad trade. |
| Polyglot with shared DB access | ❌ **Rejected — actively dangerous** | This is what the original design implied by having the AI layer query pgvector directly. It opens a **second path to the data that bypasses RLS**. One forgotten `product_id` predicate in a Python similarity query leaks another product's ticket text into an assignee suggestion or a customer-facing answer. |
| Celery for the queue | ❌ Rejected | See above — cross-language producer/consumer friction for no benefit once `ai-service` is stateless. |

## Consequences

**Positive**
- One enforcement point for isolation. Every guarantee in [ADR-004](004-isolation-row-level-security.md) rests on `withScope`, and there is no second door.
- `ai-service` becomes trivially testable and horizontally scalable — no state, no migrations, no connection pool.
- Two teams ship in parallel with `shared/contracts/` as the only coordination artifact.
- A compromise of `ai-service` or `worker` yields no direct database access.

**Negative**
- An extra network hop for vector retrieval. **Accepted deliberately** — it is the price of having exactly one enforcement point, and it is a same-host call on the compose network.
- Two dependency managers, two test harnesses, two Dockerfiles.
- The invariant must be actively defended. The moment someone adds `psycopg` to `ai-service` "just for similarity search," the isolation story is gone — and it will look like a reasonable performance optimisation in the PR.

**Enforcement**
- `ai-service` has **no database URL in its environment at all**. Not a wrong one — none. The failure is a missing-config error at boot, not a silent second connection.
- Documented as Invariant #1 in [/SKILLS.md](../../SKILLS.md) and repeated in the `ai-service` and `worker` skills files.

## Related

HLD [§3.1](../HLD.md), [§3.2](../HLD.md), [§3.3](../HLD.md), [§5.1](../HLD.md) · [ai-service/SKILLS.md](../../ai-service/SKILLS.md) · [worker/SKILLS.md](../../worker/SKILLS.md)
