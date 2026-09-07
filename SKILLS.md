# SKILLS.md — IRIS Ticketing Platform

**The one file everybody reads before writing code.** Universal rules, conventions, and patterns that apply to every service. Each project has its own `SKILLS.md` with service-specific guidance.

> **How to use this:** read this file once, fully. Then read the `SKILLS.md` of whatever you're working in. If you're an AI assistant working in this repo, load both before making changes.

| Project | Runtime | Port | Skills |
|---|---|---|---|
| [admin-panel](admin-panel/SKILLS.md) | React 18 + TS + Vite | 3000 | Support-facing UI, 9 pages |
| [widget](widget/SKILLS.md) | Vanilla TS, no framework | static | Embeddable iframe, ships to third-party pages |
| [gateway](gateway/SKILLS.md) | Node 22 + TS + Fastify | 4000 | Auth, rate limit, routing. **No business logic** |
| [core-service](core-service/SKILLS.md) | Node 22 + TS + Fastify | 4100 | The brain. **Sole DB credential holder** |
| [ai-service](ai-service/SKILLS.md) | Python 3.12 + FastAPI | 5000 | Inference only. **Stateless, no DB** |
| [notification-service](notification-service/SKILLS.md) | Node 22 + TS | 5100 | Outbound dispatch: email, WhatsApp, Slack, webhooks |
| [worker](worker/SKILLS.md) | Node 22 + TS + BullMQ | — | Queue consumer. **No DB** |
| [shared](shared/SKILLS.md) | TS + Python | — | Contracts, HMAC utils, types |
| [infra](infra/SKILLS.md) | Docker Compose, nginx, SQL | — | Local stack, migrations, seed |

**Design docs:** [HLD.md](docs/HLD.md) — **the authoritative baseline** · [api-contract.md](docs/api-contract.md) · [adr/](docs/adr/) — 11 decision records · [demo-script.md](docs/demo-script.md) · [port-mapping.md](docs/port-mapping.md) · [ui-spec-deltas.md](docs/ui-spec-deltas.md) *(superseded — rationale record only)*

---

## 1. The four invariants

These are not style preferences. Breaking any one of them breaks a security guarantee or a scored criterion. If a change requires breaking one, it is the wrong change.

### 🔒 Invariant 1 — exactly one process holds a database credential

`core-service`. Nothing else. Not `worker`, not `ai-service`, not `notification-service`, not a migration script running in another container.

**Why:** every isolation guarantee runs through Row-Level Security, which is applied per-session by `core-service`. A second connection is a second, unpoliced path to the data.
**If you need data elsewhere:** add an endpoint under `core-service/src/internal/` and call it over HTTP.

### 🔒 Invariant 2 — no unscoped read

Every product-scoped table carries `product_id`, and no query reaches the database except through `withScope()`. See [core-service/SKILLS.md](core-service/SKILLS.md).

**Why:** if a query forgets a `product_id` predicate, RLS makes the failure *"zero rows"*, never *"another product's rows."*

### 🔒 Invariant 3 — the gateway knows about credentials, never about tickets

The gateway may know what a product is and what a valid signature is. It must never know what a ticket is, what statuses exist, or when access is granted.

**Why:** the moment business logic leaks into the gateway, "core-service is unreachable from outside" stops being a security boundary and becomes a deployment detail.

### 🔒 Invariant 4 — AI is suggestive, never autonomous

No AI output is ever sent to a customer or applied to a ticket without a human action. Drafts are drafts. Classifications below threshold go to human triage. See [ui-spec-deltas.md §1.1](docs/ui-spec-deltas.md) — "deflection" (user never files a ticket) is allowed; "auto-resolution" (AI closes an open ticket) is not.

---

## 2. Naming — one convention per layer, no exceptions

| Layer | Convention | Example |
|---|---|---|
| Files & folders | `kebab-case` | `access-grant.service.ts`, `assignee-scoring/` |
| TS types, interfaces, classes, React components | `PascalCase` | `AccessGrant`, `TicketDetailPage` |
| TS variables, functions | `camelCase` | `issueAccessGrant()` |
| TS constants | `SCREAMING_SNAKE` | `MAX_ATTACHMENT_BYTES` |
| Python modules, functions, variables | `snake_case` | `classify_ticket()` |
| Python classes | `PascalCase` | `ClassificationResult` |
| **Database** tables & columns | `snake_case`, tables **singular** | `access_grant`, `product_tenant_id` |
| **API JSON** fields | `snake_case` | `{"product_tenant_id": "...", "raised_at": "..."}` |
| Env vars | `SCREAMING_SNAKE`, service-prefixed | `CORE_DATABASE_URL`, `AI_MODEL_PATH` |
| Queue / job names | `dot.separated` | `ai.classify`, `access.revoke` |
| Event types | `entity.past_tense_verb` | `ticket.resolved`, `access.revoked` |
| Git branches | `type/short-description` | `feat/access-grant-callback` |

> **The API is `snake_case` JSON, not `camelCase`.** It is published in [api-contract.md](docs/api-contract.md) and consumed by Python. Convert at the boundary in TS services — never leak `camelCase` into a response body.

### 2.1 Identifier prefixes

Every public id is a prefixed ULID. **ULIDs, not UUIDs** — they sort chronologically, which makes cursor pagination and log reading dramatically easier.

| Prefix | Entity | Prefix | Entity |
|---|---|---|---|
| `tkt_` | ticket | `su_` | support user |
| `cmt_` | comment | `evt_` | webhook event |
| `att_` | attachment | `req_` | request |
| `grt_` | access grant | `kb_` | KB article |
| `prod_` | product | `aut_` | automation rule |
| `cnv_` | widget conversation | | |

Human-facing ticket references are **per-product**: `CARB-1042`, `EDU-2087`. Never a global sequence.

---

## 3. Universal service requirements

Every HTTP service ships these on day one. Not later.

### 3.1 Health endpoint

```
GET /health  →  200 {"status":"ok","service":"core-service","version":"1.0.0","uptime_s":412}
```

Liveness only — do **not** check dependencies here, or one slow database takes every service out of the load balancer. Dependency checks go in `GET /health/ready`.

### 3.2 Structured JSON logs, always

```jsonc
{"level":"info","ts":"2026-03-26T09:02:11.412Z","service":"core-service",
 "request_id":"req_01JQZ8X5N3","product_id":"prod_carbon","support_user_id":"su_01JQ",
 "msg":"access grant issued","grant_id":"grt_01JQ","layer":"product","duration_ms":412}
```

- **Never `console.log`.** Use the service logger (`pino` in Node, `structlog` in Python).
- **Every log line carries `request_id`.** Without it, a cross-service trace is unreconstructable — and that is the audit story.
- **Never log:** `client_secret`, `webhook_secret`, JWTs, pre-auth tokens, passwords, raiser PII beyond an id. Redact by default; the logger has a redaction list — add to it.

### 3.3 Config from env, validated at boot

```ts
// config.ts — every service has exactly one of these
const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  PORT: z.coerce.number(),
  CORE_DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
});
export const config = Env.parse(process.env); // throws at boot, not at 3am
```

**Fail fast and loudly at startup.** A service that boots with a missing config value and fails on the first request is worse than one that refuses to boot. Keep `.env.example` current — a new dev's first command should be `cp .env.example .env`.

### 3.4 Graceful shutdown

On `SIGTERM`: stop accepting new work → finish in-flight requests/jobs (max 15 s) → close DB pool and Redis → exit. A worker killed mid-job must leave the job re-runnable, never half-applied.

### 3.5 Request-id propagation

Minted at the gateway (or accepted from a trusted caller), then threaded through **every** hop: gateway → core-service → outbox row → BullMQ job → worker → ai-service → notification-service → `audit_event` → `delivery_log`. Always the header `X-Request-Id`.

---

## 4. Error handling

### 4.1 One envelope, everywhere

Every non-2xx, in every service, internal or external:

```jsonc
{"error":{"code":"ticket_not_found","message":"Human readable.","request_id":"req_...","details":{}}}
```

`code` is stable and machine-readable. `message` may be reworded freely. **Callers branch on `code`, never on `message`.** Full catalogue: [api-contract.md §2.5](docs/api-contract.md).

### 4.2 Rules

- **Throw typed errors, catch at the edge.** One error-handling middleware per service converts a typed error to the envelope. Handlers do not build error responses by hand.
- **Never leak internals.** No stack traces, SQL, or file paths in a response body. Log them with the `request_id` instead.
- **Do not distinguish "not found" from "not yours"** — both are `404`. A `403` confirms the resource exists.
- **Fail closed on security decisions.** If a signature check errors, reject. If a scope lookup errors, deny. Never `catch { return allow }`.

---

## 5. Data and time

- **All timestamps are `timestamptz` in the DB, RFC 3339 UTC with `Z` in JSON.** Never store or transmit local time. The SLA business-calendar logic converts to the product's timezone at the point of calculation and nowhere else.
- **Durations are integer seconds**, named `*_seconds`. Never "minutes" in one place and "ms" in another.
- **Money:** none in this system. If that changes, integer minor units.
- **Enums live in the database** as a `CHECK` constraint or a lookup table, mirrored in `shared/types`. Never a bare string column with the values only enforced in TS.
- **Soft deletes:** none, except where a table is explicitly append-only. If something must disappear, it is an anonymisation, and it is audited.

---

## 6. Security rules that apply to everyone

| Rule | Detail |
|---|---|
| **No secrets in code or git** | Env only. `.env` is gitignored; `.env.example` holds names with dummy values |
| **Constant-time comparison** for any secret, signature, or token | `crypto.timingSafeEqual` / `hmac.compare_digest`. A `===` on a signature is a timing oracle |
| **Validate at the boundary** | Every external input parsed by a schema (zod / pydantic) before it reaches logic. Never trust a shape |
| **Parameterised SQL only** | No string interpolation into SQL, ever, including in migrations and seed scripts |
| **Attachments are never rendered inline** | `Content-Disposition: attachment`, separate origin, SVG and HTML blocked. See [HLD §16.3](docs/HLD.md) |
| **Internal services are not publicly bound** | No `ports:` stanza for core-service, ai-service, notification-service, Postgres, Redis, MinIO |
| **Every state change writes an audit event** | In the same transaction as the change |

---

## 7. Testing

| Layer | Where | What | Must pass before merge |
|---|---|---|---|
| **Unit** | Per service | Pure logic: state machine, HMAC, SLA clock, scoring weights | ✅ |
| **Contract** | `shared/contracts/` | Request/response shapes against the OpenAPI spec, both directions | ✅ |
| **Integration** | Per service | Real Postgres + Redis via compose, no mocks for those two | ✅ |
| **Security** | `core-service` | The five negative tests from [demo-script.md §6](docs/demo-script.md) | ✅ **Non-negotiable** |
| **E2E** | Deferred | Full raise → classify → assign → grant → resolve → revoke | Before demo |

**The security tests are written first and never skipped.** They are the proof behind the *No security holes* criterion. A PR that makes one fail does not merge, regardless of what else it does.

Every bug fix starts with a failing test that reproduces it.

---

## 8. Git and PR workflow

```
feat|fix|docs|refactor|test|chore(scope): imperative summary

Body: why, not what. The diff shows what.
```

Examples: `feat(access): bind pre-auth token to assignee on assignment` · `fix(sla): pause clock on waiting_on_raiser transition`

- Branch off `main`: `feat/short-description`. Small PRs, one concern each.
- **Definition of done** (§9) is a PR checklist, not an aspiration.
- Never commit: `.env`, `node_modules`, `dist`, `__pycache__`, model weights, real customer data.

---

## 9. Definition of done

A change is done when **all** of these are true:

- [ ] Matches the naming conventions in §2
- [ ] Inputs validated at the boundary with a schema
- [ ] Errors use the standard envelope with a catalogued `code`
- [ ] Logs are structured and carry `request_id`; no secrets or PII logged
- [ ] State changes write an `audit_event` **in the same transaction**
- [ ] DB access goes through `withScope()` (core-service only)
- [ ] Unit + integration tests pass; new logic has new tests
- [ ] The five security tests still pass
- [ ] Contract change? → `shared/contracts/` updated **in the same PR**
- [ ] New config? → `.env.example` updated
- [ ] Breaking API change? → new major version, never an edit to v1
- [ ] Doesn't break any invariant in §1

---

## 10. Scope discipline

The mockups ([ui-spec-deltas.md](docs/ui-spec-deltas.md)) show more than we are building. The brief is explicit:

> *"Attempting and falling short on a stretch goal is fine if the core build is solid; skipping the core to chase stretch goals is not."*

**Build order is not negotiable:** foundations → contract → access boundary → widget + SSO → admin portal → notifications → AI → everything else.

**Explicitly deferred, and honestly stubbed:** Live Chat (a whole realtime subsystem), vision-on-screenshots, anomaly detection, AI-suggested KB articles, multi-language, customer portal, Helm charts.

**A clear design with a stub beats a real implementation with security holes.** The brief says this about the access callback specifically, and it generalises. When you stub, say so in the UI and in the README — never let a stub look finished.

---

## 11. Quick reference

Full runbook: [README.md](README.md). Every command below is verified.

```bash
# From a cold clone
npm install
npm run infra:up          # Podman: Postgres+pgvector :5432, Redis :6380
cp .env.example .env
npm run migrate && npm run seed
npm run build             # widget bundle → widget/dist
npm run dev               # core :4100 + gateway :4000 + test page :3100
                          # → http://localhost:3100

# Day to day
npm test                  # 50 TypeScript + 25 Python unit tests
npm run test:e2e          # widget + admin + contract conformance (needs the stack up)
npm run test:security     # the negative security tests
npm run test:contract     # live responses vs the OpenAPI spec
npm run typecheck
npm run infra:reset       # wipe the DB volume, then migrate + seed again

# ai-service — not built yet; spec only
# See ai-service/TODO.md
```

**After changing widget code, run `npm run build`** — the gateway serves the built bundle, so source edits alone will not appear. Backend code hot-reloads.

**When stuck on a decision:** check [HLD.md](docs/HLD.md) first — most architectural questions are already answered there with the rejected alternatives. If it genuinely isn't, add an ADR in `docs/adr/` rather than deciding in a code comment.
