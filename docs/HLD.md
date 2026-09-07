# IRIS Intelligent Support Ticketing Platform — High Level Design

| | |
|---|---|
| **Problem ID** | IRIS-HACK-P-2026-002 |
| **Document** | High Level Design (HLD) — authoritative architecture spec |
| **Status** | Baseline v1.0 — supersedes `Ticketing_Platform_Design.md` where the two disagree (see §3) |
| **Companion docs** | [api-contract.md](api-contract.md) · [demo-script.md](demo-script.md) · [port-mapping.md](port-mapping.md) · [adr/](adr/) |

---

## 1. What we are building, in one paragraph

A **standalone** support ticketing platform with its own database, its own admin portal, and its own support-user identity system, which **any** IRIS product can integrate with in one of three escalating tiers (zero / low / full code). A product's end user raises a ticket from inside that product; the ticket lives entirely in the platform; the assigned support engineer receives **scoped, time-bounded access back into the originating product**; when the ticket resolves, that access auto-revokes. The platform never owns end-user accounts and never owns a product's permission model — it federates identity in, and relays capability out.

**The thesis:** the value is not the ticket CRUD. The value is the **integration boundary** — the contract, the identity handoff, and the auto-revoking access grant. Those three are where the design effort goes.

---

## 2. Requirements traceability

Every mandated capability from the brief, and where in this design it is satisfied. Nothing in §3 of the brief is unaddressed.

| Brief § | Requirement | Satisfied in | Service |
|---|---|---|---|
| 3.1 | Standalone service, own DB, owns workflow + audit | §5, §8 | core-service |
| 3.1 | Multi-product tenancy with strong isolation | §9 | core-service (RLS) |
| 3.1 | Per-product configuration | §8.2, §12 | core-service `products/` |
| 3.2 | REST API: raise/get/list/comment/status/history | [api-contract.md §4](api-contract.md) | gateway → core-service |
| 3.2 | Webhooks on state change | §11, [api-contract.md §6](api-contract.md) | notification-service `channels/webhook` |
| 3.2 | Per-product credentials + rate limiting | §7.1, §7.4 | gateway |
| 3.2 | Versioned contract | [api-contract.md §9](api-contract.md) | gateway |
| 3.3 | Embeddable widget, branded, per-product fields | §6, §6.1 | widget |
| 3.4 | SSO / identity federation, no platform-owned end users | §7.2 | gateway `auth/` |
| 3.4 | Support users have platform-native identity | §7.3 | core-service `users/` |
| 3.5 | Core workflow, comments, rating, routing | §10 | core-service `tickets/` |
| 3.6 | Scoped time-bounded access, grant + revoke callback, logged, retried | §13 | core-service `access/` |
| 3.7 | Admin portal: counters, filters, detail, triage, user mgmt, config | §12 | admin-panel |
| 3.8 | TAT + performance analytics | §14 | core-service `sla/` + admin-panel |
| 3.9 | AI: classify, suggest assignee, draft, summarise | §15 | ai-service |
| 4.1–4.6 | Six defended design decisions | §3 + [ADR 001–006](adr/) | — |
| §5 | Ten "what done looks like" criteria | [demo-script.md](demo-script.md) | — |

**Beyond the brief** — introduced by the UI mockups (§3.6), not mandated. Listed here so it is unambiguous that these are *additions*, not requirements, and are therefore cut first under time pressure:

| Capability | Satisfied in | Phase |
|---|---|---|
| Knowledge Base | §8.1, §12 | 6.5 |
| Widget deflection / Search Docs | §6.1, §15.4 | 6.5 |
| AI Insights page | §15.5 | 4 |
| Automations | §12.1 | 7 |
| Agent skills + availability | §8.1, §15.1 | 4 |
| Live Chat | §6.1 — **stubbed** | 8 (stretch) |

---

## 3. Corrections to the prior design doc

`Ticketing_Platform_Design.md` is a strong design. Five things in it are wrong or under-specified once you commit to the agreed service topology. This HLD overrides them.

### 3.1 ❌ "Python/FastAPI for API + services" → ✅ Polyglot, with a hard boundary

The prior doc argues for one runtime. The agreed folder topology is polyglot (Node for gateway/core/worker/notification, Python for AI). **Keep the polyglot split** — but for a better reason than the prior doc gives, and with a rule that caps its cost.

| | |
|---|---|
| **Why polyglot wins here** | It parallelises the team. The Node track (contract, workflow, RLS, admin API) and the Python track (classification, embeddings, scoring) proceed independently from hour one. In a time-boxed build, team throughput beats runtime uniformity. Python is also genuinely the better tool for the AI layer (`sentence-transformers`, `scikit-learn`), and Node is genuinely the better tool for a high-concurrency I/O gateway. |
| **What normally makes polyglot expensive** | Shared types drift, duplicated auth logic, two migration stories, two ORMs, two sets of DB credentials. |
| **The rule that removes the cost** | **Only `core-service` holds a database credential.** `ai-service` and `worker` are stateless. `ai-service` receives payloads and returns predictions over HTTP; it never opens a DB connection. See §3.3. |

Because of that rule, the cross-language surface shrinks to five HTTP endpoints described by one OpenAPI file in `shared/contracts/`. There is almost nothing left to drift.

### 3.2 ❌ "Redis + Celery" → ✅ Redis + BullMQ

Celery's producer protocol (kombu) is Python-shaped. With Node producers (core-service) enqueuing to Celery consumers, you hand-roll message envelopes and lose the ergonomics of both sides. **Use BullMQ.** The queue is Node end-to-end; `ai-service` becomes a plain request/response HTTP service that the Node worker calls. Simpler, one retry semantic, one dashboard.

### 3.3 ❌ AI service reads pgvector directly → ✅ AI service is DB-less

The prior doc implies the AI layer queries pgvector for similar tickets. If it does, it opens a second path to the data that **bypasses Row-Level Security** — and RLS is the entire isolation story (§9). One forgotten `product_id` predicate in a Python similarity query and cross-product ticket text leaks into an assignee suggestion.

**Corrected flow:** `ai-service` generates the embedding and hands it back. `core-service` stores it and performs the `ORDER BY embedding <=> $1` search *inside an RLS-scoped transaction*. When `ai-service` needs neighbours, it calls `POST /internal/tickets/similar` on core-service.

> **Invariant #1 — one credential.** Exactly one process in this system holds a Postgres credential: `core-service`. Every isolation guarantee in §9 depends on this. If any other service needs data, it asks core-service over HTTP.

### 3.4 ⚠️ Pre-auth link demoted the callback → ✅ Ship both, demo both

The prior doc makes the client-minted pre-auth link primary and the server-to-server callback "advanced, optional." That is the better security design (§13.4 explains why) — but the brief names the callback explicitly in a scored success criterion:

> *"Callback access flow — ticket raised, support user assigned, **callback invoked**, scoped access granted, ticket closed, **revoke callback invoked**, access removed."*

Demoting it risks failing an explicit criterion in pursuit of elegance. **Both mechanisms ship**, and the two sample products each demonstrate one:

| Sample product | Access mechanism | What it proves |
|---|---|---|
| **product-a (Carbon)** | Server-to-server **callback** (full-code) | The literal brief requirement, end to end, including revoke-failure retry |
| **product-b (iFile)** | Client-minted **pre-auth link** (low-code) | The innovation: a compromised platform cannot fabricate access |

This is efficient — the two products already exist to prove portability. Giving them different access mechanisms proves portability *and* covers both criteria in the same demo minutes.

### 3.5 ⚠️ Revoke-on-`resolved` vs the brief's revoke-on-`closed`

The brief says revoke on close. The prior doc chose resolve. Resolve is the tighter, more defensible position (access should not survive the customer-rating window). **Decision: revoke at `resolved`, and re-assert an idempotent revoke at `closed`.** We get the stronger posture *and* satisfy the brief's literal wording, and the second revoke costs one no-op call.

### 3.6 Corrections from the UI mockups

The mockups (`docs/images/`) arrived after this HLD was first baselined. They contradict it in three places and add two modules. All are now folded into the sections below; [ui-spec-deltas.md](ui-spec-deltas.md) is retained only as the rationale record.

| # | Mockup shows | Conflict | Resolution |
|---|---|---|---|
| 1 | **"Auto Resolved: 742"** + Deflection Rate 22% | §15's hard rule is *AI is suggestive, never autonomous*; the brief says drafts *"must be reviewed by a human before sending, never auto-sent"* | **Deflection** (a user gets an answer from the widget and never files a ticket — no ticket ever exists) is allowed and is the 22%. **Auto-resolution** (AI sends on an open ticket and closes it) is not. The counter is renamed **"Self-Served"** and counts widget conversations, never tickets. See §15.4 and [ADR-009](adr/009-deflection-is-not-auto-resolution.md) |
| 2 | Statuses `Open / In Progress / Resolved / On Hold`; no `assigned` | §10's state machine has `assigned` and `waiting_on_raiser` | Keep the state machine unchanged — `assigned` is what fires the dual JIT grant (§13), so collapsing it would destroy the access model. `waiting_on_raiser` **displays** as "On Hold"; `assigned` is a fact about the ticket (`assignee_id`), not a filter chip. See §10.1 |
| 3 | Column labelled **"Priority"** | The brief, the API, and the DB all say `severity` | `severity` remains the stored and published name. **"Priority" is a display label only**, mapped in one file (`admin-panel/src/lib/labels.ts`). No second field is introduced |

**Added as first-class modules** (neither was in the original design): **Knowledge Base** — a stretch goal that graduated, because it is the corpus widget deflection retrieves from; without it the 22% is unreachable. **Automations** — a rules engine, in the mockup but in neither the brief nor the original design; scoped deliberately to a fixed catalogue (§12.1, [ADR-010](adr/010-automations-fixed-catalogue.md)).

**Widget scope grew roughly 4×**, from a raise-ticket form to a conversational assistant. Prioritised in §6; **Live Chat is deferred and honestly stubbed** ([ADR-011](adr/011-live-chat-deferred.md)) — it is the single largest scope risk in either image.

---

## 4. Tenancy model — read this before anything else

Two tenancy layers. Conflating them is the pitfall the brief calls out by name.

```
Platform (IRIS Ticketing)
 └── Product tenant            ← an integrating product: CARBON, iFile, GST …
      └── Customer tenant       ← that product's own customer company
           └── End user          ← the human who raises a ticket
```

| Layer | Who owns the identity | Stored as | Isolation strength |
|---|---|---|---|
| **Product** | The platform | `product_id` (platform PK) | **Primary security boundary.** Enforced by RLS. A support user scoped to CARBON cannot read an iFile ticket without an explicit scope grant. |
| **Customer** | The integrating product | `product_tenant_id` (opaque string, product-owned) | Filtering, analytics, and access-scope narrowing. The platform never authenticates these; it records them. |
| **End user** | The integrating product | `raised_by_ref` (opaque `sub` from the product's JWT) + cached `raiser_identity` snapshot | Never a platform account. |

> **Invariant #2 — no unscoped read.** Every product-scoped table carries `product_id`, and no code path reads one without a `product_id` predicate. This is enforced at the database, not by convention (§9).

---

## 5. Logical architecture

```
   INTEGRATING PRODUCT (CARBON / iFile)
   ┌──────────────────────────────────────────────────────────┐
   │  <script src=".../widget.js">   ·  backend SDK / REST     │
   │  webhook receiver (low+)        ·  access callback (full) │
   │  JWKS endpoint (identity)       ·  pre-auth mint (low+)   │
   └───────────────┬──────────────────────────────────────────┘
                   │  HTTPS · /v1/* · HMAC-SHA256 + product JWT
        ═══════════▼══════════════ public boundary ═══════════════
   ┌──────────────────────────────────────────────────────────┐
   │ nginx :80/:443   static: admin-panel, widget.js           │
   └───────────────┬──────────────────────────────────────────┘
                   │
   ┌───────────────▼───────────┐
   │ gateway :4000             │  HMAC verify · JWKS verify · rate limit
   │ (Node)                    │  idempotency · request-id · error envelope
   └───────────────┬───────────┘  NO business logic
                   │ internal HTTP (mTLS-optional, network-isolated)
   ┌───────────────▼──────────────────────────────────────────┐
   │ core-service :4100  (Node)          ★ sole DB credential  │
   │  tickets/ · access/ · users/ · products/ · sla/ · audit/  │
   │  events/ (transactional outbox) · storage/ · db/ (RLS)    │
   └───┬──────────────────────────────────┬───────────────────┘
       │ outbox → BullMQ                   │ SQL (RLS session)
   ┌───▼─────────────┐  ┌─────────────┐   │
   │ worker (Node)   │  │notification-│   │
   │ AI + async jobs │  │service :5100│   │
   └───┬─────────────┘  │ email·whatsapp  │
       │ HTTP           │ slack·webhook   │
   ┌───▼─────────────┐  └─────────────┘   │
   │ ai-service :5000│   ★ DB-less        │
   │ (Python)        │                    │
   └─────────────────┘                    │
   ┌───────────────────────────────────────▼──────────────────┐
   │ Postgres :5432 (+pgvector, RLS FORCED) · Redis :6379      │
   │ MinIO :9000 (attachments, S3 API — Azure Blob in prod)    │
   └──────────────────────────────────────────────────────────┘
```

### 5.1 Service responsibilities and boundaries

| Service | Owns | Explicitly does **not** | Port |
|---|---|---|---|
| **nginx** | TLS, static hosting, path routing, CORS preflight for widget assets | Any auth decision | 80/443 |
| **gateway** | HMAC verification, JWT/JWKS verification, per-product rate limiting, idempotency keys, request-id minting, error envelope normalisation | Business rules, DB access, state transitions | 4000 |
| **core-service** | Ticket state machine, access grants, support users, per-product config, SLA clocks, audit writes, outbox, attachment storage, **all SQL** | Sending anything outbound; AI inference | 4100 |
| **ai-service** | Classification, embeddings, assignee scoring, draft generation, summarisation | **Any database connection**; any state | 5000 |
| **notification-service** | Outbound dispatch with retry/backoff/DLQ for email, WhatsApp, Slack, **and product webhooks**; delivery ledger | Deciding *whether* an event should fire | 5100 |
| **worker** | Consuming BullMQ jobs, orchestrating AI calls, writing results back via core-service internal API | Direct DB access | — |
| **admin-panel** | Support-facing UI | Talking to core-service directly (goes via gateway) | 3000 / static |
| **widget** | Embeddable support UI in an iframe: raise a ticket, my tickets, ask/deflect (§6.1) | Holding any secret; verifying its own identity JWT | static |

**Why `notification-service` also handles product webhooks:** email, WhatsApp, Slack, and webhooks share the same hard parts — signed payload, exponential backoff, dead-letter queue, delivery ledger, per-product enable/disable. Building that machinery twice is waste. One outbound dispatcher, four transports, one retry policy, one auditable delivery log.

**Why a separate `gateway` at all** (the reasonable objection: it's middleware, put it in core-service): it buys a scored narrative. "core-service is not reachable from any public interface" is a one-sentence answer to *No security holes*, and it forces the auth code to be a standalone, testable unit rather than a middleware tangle inside the domain. The cost is ~400 lines and one hop. **Discipline required:** the moment gateway grows a business rule, the boundary has failed. Gateway is allowed to know about products and credentials. It is not allowed to know what a ticket is.

---

## 6. The embeddable widget (zero-code tier)

```html
<script src="https://support.iris.example/widget.js"
        data-product-key="pub_live_carbon_8f2a"
        data-identity-token="<short-lived JWT minted by the product>"
        defer></script>
```

- Mounts an **iframe**, not inline DOM — total CSS/JS isolation from the host page in both directions. The host cannot read the widget's data; the widget cannot be restyled into breakage by host CSS.
- Carries a **publishable key** (`pub_…`), never the secret. The publishable key is deliberately low-privilege — it authorises only the four read/create operations in §6.1, and a leak is rate-limited spam rather than a breach.
- **Configuration is server-side.** Which fields show, which categories exist, which severity is the default, the brand colours and logo — all fetched from `GET /v1/widget/config` keyed by the publishable key. A product changes its widget by editing config in the admin portal, with **no redeploy on the product side**. This is what makes the zero-code claim literally true.
- On submit: `POST /v1/tickets`, then renders confirmation with the human-readable reference (`CARB-1042`).

### 6.1 Capability scope — what we build, and what we stub

The mockup shows a full conversational support assistant, not a form (§3.6). That is roughly 4× the original scope, so it is prioritised rather than accepted wholesale.

| Capability | Priority | Endpoint | Reasoning |
|---|---|---|---|
| **Create a Ticket** | 🔴 **P0** | `POST /v1/tickets` | The mandated core. Never at risk |
| **My Tickets** | 🔴 **P0** | `GET /v1/tickets` | One list call against an endpoint that already exists |
| **Ask a Question** | 🟠 **P1** | `POST /v1/widget/ask` | This *is* deflection — retrieval over KB + resolved tickets, both already embedded for classification. High reuse, low marginal cost |
| **Search Docs** | 🟠 **P1** | `GET /v1/kb/articles` | Same corpus, direct search rather than conversational |
| **AI Suggestions** (pre-submit) | 🟠 **P1** | `POST /v1/widget/ask` | Same retrieval pipeline, surfaced before submit. Also a brief stretch goal — near-free once P1 exists |
| **Upload Screenshot** | 🟡 P2 | `POST /v1/attachments` | Upload is P0 regardless; *vision understanding* of the image is the stretch |
| **Announcements** | 🟡 P2 | widget config | Cheap, low value. Cut without hesitation |
| **Live Chat** | 🔴 **P3 — stubbed** | — | WebSocket transport, presence, agent routing, typing state, transcript persistence, reconnect. **The single largest scope risk in the mockup** |

**How Live Chat is stubbed honestly:** the button converts the conversation into a ticket and tells the user *"an agent will pick this up — you'll get an email."* That is a real, working outcome, not a chat window that never connects. Never let a stub look finished. See [ADR-011](adr/011-live-chat-deferred.md).

**Context-awareness** ("understands the product you're in") is already free: the publishable key identifies the product, and `metadata` on the raise call carries the host page/route.

### 6.2 Widget abuse controls

A publishable key is scrapeable from the page — that is inherent to the design, so it must not be load-bearing. Three controls:

1. **Origin allowlist** per product. `Origin` header must match a registered origin; enforced at the gateway *and* echoed as `frame-ancestors` CSP.
2. **Identity JWT required** for authenticated raise. Without a valid product-signed JWT the request is anonymous, and anonymous raise is **off by default** per product.
3. **Tight rate limits** on the publishable key: 20 tickets / 10 min per `(product, source IP)`, 5 / min per `(product, raiser sub)`.

---

## 7. Identity and authentication — four distinct systems

This is where most implementations get muddled. There are **four** separate auth systems and they must not be confused.

| # | Who is authenticating | To what | Mechanism | Lives in |
|---|---|---|---|---|
| 1 | **Integrating product (server)** | Platform `/v1/*` | HMAC-SHA256 over a canonical request string | gateway `auth/` |
| 2 | **End user (ticket raiser)** | Platform, via the product | Short-lived JWT signed by the product, verified against its JWKS | gateway `auth/` |
| 3 | **Support user (IRIS staff)** | Admin portal | Platform-native: email + Argon2id password + session JWT + TOTP (optional) | core-service `users/` |
| 4 | **Platform** | Integrating product (callbacks/webhooks) | HMAC-SHA256 signature the *product* verifies | notification-service |

### 7.1 Product → platform (system 1)

Per-product `client_id` + `client_secret`. The secret is stored **hashed** (Argon2id) and never leaves the platform on the wire — it signs, it is not transmitted. Full canonical-string spec and a **verifiable test vector** in [api-contract.md §3](api-contract.md). Replay defence: ±300s timestamp window plus a Redis nonce cache (TTL 600s).

### 7.2 End user → platform (system 2) — SSO decision

**Chosen: signed short-lived JWT handoff. OIDC offered. SAML rejected.**

| Option | Verdict | Reasoning |
|---|---|---|
| **Signed JWT handoff** | ✅ **Chosen** | The product *already authenticated this user seconds ago*. A redirect-based flow re-solves a solved problem, adds two network round-trips, and breaks badly inside an iframe (third-party cookie blocking, popup blockers). Lowest integration cost: the product mints a JWT with its existing key material. |
| **OIDC** | ⚪ Offered, not default | Correct when a product wants the *platform* to drive login — e.g. a standalone customer portal. Supported via per-product config, not the default path. |
| **SAML** | ❌ Rejected | XML-DSig tooling, redirect/POST binding friction inside an iframe, no capability advantage over a signed JWT for this use case. Add only if a specific integrator mandates it contractually. |

**Identity mapping rule:** the platform keys the raiser on `(product_id, iss, sub)` — never on email. Emails change and are not guaranteed unique across a product's customer tenants. The tuple is immutable and product-owned.

**IdP-down fallback** (the brief asks this explicitly): at raise time the platform **caches a snapshot of the raiser's identity onto the ticket** (`raiser_identity`: name, email, tenant, display refs). Consequences:

- Existing tickets remain fully viewable and workable by support **even with the product's IdP completely down** — the platform depends on the IdP only at the moment of raise, never afterwards.
- A down IdP blocks only *new* SSO raises.
- Break-glass: an optional per-product "email-verified raise" path (magic link to a verified address) covers new raises during an outage. **Off by default** — it is a weaker identity assertion and must be a conscious product choice. Tickets raised this way are flagged `identity_assurance: 'email_verified'` so support can see the difference.

### 7.3 Support user identity and RBAC (system 3)

Platform-native. Four roles:

| Role | Product scope | Capabilities |
|---|---|---|
| **super_admin** | All products | Everything: cross-product analytics, product onboarding, user management, config. Sees all ticket data by **explicit policy**, not by RLS bypass (§9.3). |
| **product_admin** | Assigned products | Per-product config (queues, SLAs, severities, routing, callback URLs, widget fields), user management within scope |
| **manager** | Assigned products (± customer tenants) | Assign/reassign, view team analytics, escalate. No config changes. |
| **agent** | Assigned products (± customer tenants) | T0 queue metadata always; **T1 full ticket data only on tickets assigned to them** (§9.2) |

---

## 8. Data model

Postgres 16 + `pgvector`. Every product-scoped table carries `product_id NOT NULL`.

### 8.1 Core tables

| Table | Key columns | Notes |
|---|---|---|
| `product` | `id`, `slug`, `name`, `client_id`, `client_secret_hash`, `publishable_key`, `jwks_url`, `allowed_issuers[]`, `allowed_origins[]`, `webhook_url`, `webhook_secret_hash`, `access_callback_url`, `access_mechanism` (`callback`\|`preauth`\|`both`), `config` (jsonb), `api_version_pin` | The tenant root |
| `ticket` | `id`, `reference` (`CARB-1042`), `product_id`, `product_tenant_id`, `raised_by_ref`, `raiser_identity` (jsonb snapshot), `identity_assurance`, `category`, `severity`, `status`, `queue_id`, `assignee_id`, `summary`, `embedding vector(384)`, `ai_classification` (jsonb + confidences), `rating`, `rating_comment`, `sentiment`, timestamps | `raised_at`, `first_response_at`, `assigned_at`, `resolved_at`, `closed_at` |
| `comment` | `ticket_id`, `author_type` (`raiser`\|`assignee`\|`system`), `author_ref`, `body`, `is_internal`, `created_at` | `is_internal` never leaves the platform |
| `attachment` | `ticket_id`, `blob_key`, `filename`, `content_type`, `size_bytes`, `uploaded_by`, `scan_status` | See §16.3 for the XSS trap |
| `support_user` | `id`, `email`, `password_hash`, `role`, `totp_secret`, `is_active`, `availability` (`available`\|`busy`\|`away`) | **No standing access to ticket payloads.** `availability` feeds the availability factor in assignee scoring and lets an agent mute themselves |
| `support_user_scope` | `support_user_id`, `product_id`, `product_tenant_id` (nullable = whole product) | Drives the RLS scope GUC |
| `support_user_skill` | `support_user_id`, `skill`, `proficiency` | Explicit domain signal alongside the learned embedding similarity — unlike the embedding, a manager can **see and edit** it, which is what makes the suggestion trustworthy (§15.1) |
| `queue` | `product_id`, `name`, `routing_rules` (jsonb) | `(category, severity, tenant)` → queue |
| `kb_article` | `id`, `product_id`, `title`, `body`, `category`, `status` (`draft`\|`published`), `views`, `helpful_yes`, `helpful_no`, `embedding vector(384)` | The corpus widget deflection retrieves from (§15.4) |
| `automation_rule` | `id`, `product_id`, `name`, `trigger`, `conditions` (jsonb), `action`, `action_config` (jsonb), `is_active` | Fixed catalogue, not a general rule engine (§12.1) |
| `widget_conversation` | `id`, `product_id`, `product_tenant_id`, `raised_by_ref`, `turns` (jsonb), `outcome` (`self_served`\|`ticket_created`\|`abandoned`), `ticket_id` (nullable), `started_at`, `ended_at` | **Source of the Self-Served metric.** `outcome='self_served'` means no ticket was ever created — see §3.6 |
| `access_grant` | `ticket_id`, `support_user_id`, `layer` (`platform`\|`product`), `mechanism` (`rls`\|`callback`\|`preauth_link`), `scope_kind`, `resource_ref`, `state`, `granted_at`, `expires_at`, `revoke_due_at`, `revoked_at`, `product_grant_ref`, `activation_response` (jsonb), `revoke_response` (jsonb), `attempt_count` | **One assignment writes two rows** (one per layer) |
| `preauth_token` | `ticket_id`, `token_ciphertext`, `scope_kind`, `resource_ref`, `max_ttl_seconds`, `launch_url_template`, `bound_support_user_id`, `state` (`inert`\|`active`\|`expired`\|`revoked`) | Product-minted, platform-relayed |
| `audit_event` | `actor_type`, `actor_ref`, `action`, `entity_type`, `entity_id`, `product_id`, `before` (jsonb), `after` (jsonb), `request_id`, `source_ip`, `occurred_at` | **Append-only.** `REVOKE UPDATE, DELETE` from the app role |
| `sla_clock` | `ticket_id`, `target_seconds`, `accumulated_business_seconds`, `segments` (jsonb array of pause/run spans), `breached_at` | Reconstructable, auditable |
| `event_outbox` | `id`, `product_id`, `aggregate_type`, `aggregate_id`, `event_type`, `payload` (jsonb), `created_at`, `published_at` | §11.1 |
| `delivery_log` | `channel`, `target`, `event_id`, `attempt`, `status_code`, `response_body`, `attempted_at` | Webhook + notification ledger |
| `idempotency_key` | `product_id`, `key`, `request_fingerprint`, `response_body`, `status_code`, `created_at` | 24h TTL |

### 8.2 Per-product configuration (`product.config` jsonb)

Everything a product can tune without a platform deploy: `queues[]`, `categories[]`, `severities[]` with SLA targets, `business_calendar` (timezone, working days, hours, holidays), `routing_rules[]`, `widget` (fields, defaults, branding, enabled capabilities per §6.1), `notifications` (per-event channel matrix), `ai_thresholds` (`auto_route_p1`, `auto_route_margin`, `triage_floor`), `assignee_weights`, `access` (mechanism, `max_ttl_seconds`, `scope_kind`), `auto_close_days`, `knowledge_base` (enabled, public categories), `automations` (per-rule enablement), `deflection` (enabled, `min_score`, `max_suggestions`).

> Thresholds and weights are **config, not code**. Every number the brief asks us to defend must be tunable per product once real volume accrues.

---

## 9. Multi-product isolation — the defended decision

**Chosen: PostgreSQL Row-Level Security on `product_id`, plus application-layer scope checks. Defence in depth.**

| Option | Verdict | Reasoning |
|---|---|---|
| **RLS + app checks** | ✅ **Chosen** | One schema, one migration story, trivial cross-product analytics. Critically: if an application query *forgets* a `product_id` predicate, the failure mode is **"zero rows,"** not **"another product's rows."** The app-layer check is the readable early gate; the DB is the backstop that cannot be bypassed by a code bug. |
| Schema-per-product | ❌ Rejected | N schemas migrating in lockstep; onboarding a product becomes a DDL event; cross-product analytics becomes a UNION over N schemas that must be regenerated on every onboarding. |
| Database-per-product | ❌ Rejected | Strongest isolation, heaviest ops, and it destroys the single-pane cross-product visibility that is the product's core value proposition. |

### 9.1 RLS mechanics — and the two footguns that will bite

Every DB session runs inside a transaction that first sets:

```sql
SET LOCAL app.product_scope   = 'prod_carbon,prod_ifile';  -- comma-joined product ids
SET LOCAL app.support_user_id = 'su_01JQZ...';
SET LOCAL app.role            = 'agent';
SET LOCAL app.request_id      = 'req_01JQZ...';
```

```sql
CREATE POLICY ticket_product_isolation ON ticket
  USING (product_id::text = ANY (string_to_array(current_setting('app.product_scope', true), ',')));
```

> ### ⚠️ Footgun 1 — table owners bypass RLS silently
> In Postgres, the **table owner is exempt from RLS unless you force it**. If the app connects as the role that created the tables, every policy you wrote is decorative and the demo's security claim is false — with no error message anywhere.
> **Mitigation, both belt and braces:**
> ```sql
> ALTER TABLE ticket ENABLE ROW LEVEL SECURITY;
> ALTER TABLE ticket FORCE  ROW LEVEL SECURITY;   -- applies to the owner too
> ```
> and connect the application as a **non-owner role** (`iris_app`), with DDL run by a separate `iris_migrator` role. Never `SUPERUSER`, never `BYPASSRLS`.

> ### ⚠️ Footgun 2 — pooled connections leak session state
> `SET` persists for the life of the *connection*. With a pgBouncer or `pg.Pool` in front, request A's `app.product_scope` leaks into request B — a cross-tenant read with no code defect visible anywhere.
> **Mitigation:** `SET LOCAL` only, always inside an explicit `BEGIN … COMMIT`. Enforce it structurally: `core-service/src/db/` exposes exactly one way to reach the database — `withScope(ctx, fn)` — which opens the transaction, sets the GUCs, and runs the callback. Nothing else may check out a client. Add a CI lint that fails on any direct `pool.query` outside `db/`.

**Verification is part of the demo.** §6 of [demo-script.md](demo-script.md) runs a negative test live: an agent scoped only to iFile requests a CARBON ticket by id and gets a `404` — not a `403`, because a `403` would confirm the ticket exists.

### 9.2 Three access tiers for support users (zero standing access)

| Tier | What it grants | When | Enforced by |
|---|---|---|---|
| **T0 — queue metadata** | Summary, category, severity, age, tenant of **unassigned** tickets in scope. No comments, no attachments, no raiser PII. Enough to triage and pick. | Standing, for scoped users | RLS on a restricted view `ticket_queue_v` |
| **T1 — platform ticket data** | Full ticket: comments, attachments, raiser identity, history | On assignment → auto-revoked on `resolved` | RLS predicate requiring an active `access_grant(layer='platform')` for *this* `(user, ticket)` |
| **T2 — product resource access** | A section / file / dataset **inside the integrating product** | On assignment → auto-revoked on `resolved` | The product validates a capability (§13) |

```sql
CREATE POLICY comment_requires_jit_grant ON comment USING (
  EXISTS (SELECT 1 FROM access_grant g
           WHERE g.ticket_id = comment.ticket_id
             AND g.support_user_id::text = current_setting('app.support_user_id', true)
             AND g.layer = 'platform' AND g.state = 'granted'
             AND (g.expires_at IS NULL OR g.expires_at > now()))
  OR current_setting('app.role', true) IN ('super_admin', 'product_admin')
);
```

### 9.3 "Admin sees everything" is a policy, not a bypass

Super-admin visibility is expressed as an **additional RLS policy branch**, never as `BYPASSRLS` and never as a code path that skips `withScope`. This matters: it means there is exactly one enforcement mechanism to reason about and audit, and admin reads are still logged with the same actor context.

---

## 10. Ticket lifecycle

```
                self-assign │ manager-assign │ AI auto-assign
      open ──────────────────────────────────────────────► assigned
       ▲                                                        │ agent picks up
       │                                                        ▼
       │                                                   in_progress ⇄ waiting_on_raiser
       │                                                        │            (SLA clock pauses)
       │ reopen (audited, re-issues both grants)                │ resolve
       │                                                        ▼
       └──────────────────── reopen ─────────────────────── resolved
                                                                │ raiser rates 1–5★ (+ comment)
                                                                │ auto-close after N business days
                                                                ▼
                                                              closed
```

**Transition rules** (enforced in `core-service/src/tickets/state-machine.ts`, not scattered across handlers):

| From → To | Who | Side effects |
|---|---|---|
| `open → assigned` | agent (self), manager, AI auto-assign | **Dual JIT grant issued** (T1 + T2); `assigned_at` set; `ticket.assigned` webhook |
| `assigned → in_progress` | assignee | `ticket.in_progress` webhook |
| `in_progress ⇄ waiting_on_raiser` | assignee | **SLA clock pauses/resumes** (§14) |
| `* → resolved` | assignee, manager | **Both grants revoked**; `resolved_at` set; rating request to raiser; `ticket.resolved` webhook |
| `resolved → closed` | raiser rates, or auto-close after N days | Idempotent re-assert of revoke; `ticket.closed` webhook |
| `resolved/closed → open` | raiser or manager | Audited; **both grants re-issued** (fresh or reactivated within `max_ttl`); `ticket.reopened` webhook |

`first_response_at` is stamped on the **first non-internal comment authored by a support user** — locked here, per the brief's warning that an unlocked definition makes every TAT number arguable.

### 10.1 Stored status vs displayed status

The mockup's status vocabulary differs from the state machine's (§3.6). The state machine is authoritative; the difference is a **display mapping only**, held in one file (`admin-panel/src/lib/labels.ts`).

| Stored | Displayed | Note |
|---|---|---|
| `open` | Open | |
| `assigned` | Open, with the assignee shown | **Not a filter chip.** Assignment is a fact about the ticket (`assignee_id`) that the Assignee column already communicates |
| `in_progress` | In Progress | |
| `waiting_on_raiser` | **On Hold** | The mockup's "On Hold". SLA clock pauses here (§14) |
| `resolved` | Resolved | |
| `closed` | Closed | |

> **`assigned` stays in the state machine.** It is the transition that fires the dual JIT grant (§13) — collapsing it into `in_progress` to match the mockup's chip list would destroy the access model, which is the platform's differentiator. A UI label is never a reason to change a state machine.

---

## 11. Async architecture

### 11.1 Transactional outbox — the thing that keeps the security claim true

**Problem:** the ticket transitions to `resolved` and we must revoke access. If we `COMMIT` the status change and *then* enqueue the revoke job, a Redis blip between the two means **access outlives the ticket forever**, with no error. That is a direct failure of *No security holes*, caused by a two-phase-commit problem, not by bad crypto.

**Solution:** the state change and the event insert happen in **one transaction**.

```
BEGIN
  UPDATE ticket SET status='resolved', resolved_at=now() WHERE id=$1;
  UPDATE access_grant SET state='revoke_pending' WHERE ticket_id=$1;
  INSERT INTO event_outbox (event_type, payload, ...) VALUES ('ticket.resolved', ...);
  INSERT INTO audit_event (...) VALUES (...);
COMMIT
        │
        └─► publisher (LISTEN/NOTIFY + 1s safety poll) ─► BullMQ ─► consumers
```

Either everything happened or nothing did. The publisher is at-least-once; consumers are idempotent on `event_id`.

### 11.2 Queues and consumers

| Queue | Producer | Consumer | Job |
|---|---|---|---|
| `ai.classify` | outbox on `ticket.created` | worker → ai-service | classify + embed + summarise, write back via core internal API |
| `ai.suggest_assignee` | outbox on classify complete | worker → ai-service | ranked candidates with per-factor contributions |
| `access.grant` / `access.revoke` | outbox on assign/resolve | worker | invoke product callback or bind pre-auth token |
| `notify.*` | outbox on any lifecycle event | notification-service | email / WhatsApp / Slack |
| `webhook.deliver` | outbox on any lifecycle event | notification-service | signed HTTP POST to product |
| `automation.evaluate` | outbox on any lifecycle event | worker | match rules, apply actions (§12.1) |

**Access jobs get a dedicated queue and their own concurrency.** A backlog of AI classification must never delay a revoke — that is the difference between a slow demo and a security failure.

**Retry policy:** exponential backoff `1s → 5s → 25s → 2m → 10m`, 5 attempts, then dead-letter. DLQ entries surface as a red banner in the admin portal — a dead-lettered *revoke* is a security incident and is styled as one.

---

## 12. Admin portal

Built against the same gateway the products use (plus a `/admin/*` surface). Deliberately **not** a CRUD-screen exercise — the brief warns explicitly that *"the admin portal can swallow time if treated as a CRUD-screen exercise."*

The mockup specifies **nine pages** (§3.6). That is more than the time allows, so they are built in strict value order and the build **stops when time runs out** rather than delivering nine half-pages.

| # | Page | Priority | Content |
|---|---|---|---|
| 1 | **Ticket detail** | 🔴 P0 | **Built first.** One timeline merging state transitions, comments (internal notes visually distinct), attachments, **access grant/revoke events with the product's actual responses and latencies**, and the raw audit trail. This single view answers four of the ten success criteria and gets the most polish |
| 2 | **Dashboard** | 🔴 P0 | Live counters per product and total, each click-through to a filtered list. Plus the two views that drive real work: *SLA breaches & high severity across all products*, and the *unassigned triage queue* (AI-uncertain tickets flagged). The **Self-Served** counter here counts widget deflections, never tickets (§3.6) |
| 3 | **Tickets** | 🔴 P0 | Filter/search by product, tenant, category, severity, status, assignee, raised-by, date range. Cursor-paginated |
| 4 | **Agents** | 🟠 P1 | Support users, roles, scopes, **skills**, availability, workload; per-user profile with resolved count, avg rating, avg TAT, common categories, rating trend |
| 5 | **Audit Logs** | 🟠 P1 | Filterable by user, action, entity, date. Cheap — the `audit_event` schema already supports it |
| 6 | **AI Insights** | 🟠 P1 | Classification accuracy, avg confidence, auto-routing rate, Self-Served rate, confidence distribution, **Top Misclassified Intents**. See §15.5 |
| 7 | **Analytics** | 🟡 P2 | TAT p50/p90, SLA compliance %, CSAT trend, top **and bottom** performers |
| 8 | **Settings** | 🟡 P2 | Per-product config: queues, SLAs, severities, routing, callback URL + access mechanism, widget fields and branding, notification matrix, AI thresholds. Editing here changes a live integration with **no product redeploy** — the zero-code proof, demonstrated live (demo script §7.4) |
| 9 | **Knowledge Base** | ⚪ P3 | Article CRUD, categories, publish state, views, helpful % |
| 10 | **Automations** | ⚪ P3 | Toggles over the fixed catalogue in §12.1 |

Focus on the views that do real work — triaging the queue, finding SLA breaches, managing the team. **Skip ornate forms for things admins touch twice a year.**

### 12.1 Automations — a catalogue, not an engine

The mockup shows a rules table (*High Priority Auto Escalation*, *SLA Breach Alert*, *Sentiment Escalation*, *Auto Assign by Category*, *Auto Close Resolved*). This is scoped deliberately.

**Build:** a fixed catalogue of ~6 trigger types and ~5 action types, each with an on/off toggle and simple conditions.
**Do not build:** a general-purpose visual rule builder. That is a product in itself and it will consume the entire remaining build. See [ADR-010](adr/010-automations-fixed-catalogue.md).

Rules evaluate in `worker` off the outbox event stream, **never inline in the request path** — a slow or looping rule must never delay a ticket write.

> ### ⚠️ Loop protection is mandatory
>
> An action that mutates a ticket emits an event that can re-trigger a rule that mutates it again. Three controls, all required:
>
> 1. Every automation-originated mutation carries `actor_type='automation'`
> 2. Rule evaluation **skips events whose actor is an automation**
> 3. A chain is capped at **3 executions**; exceeding it logs an error and stops
>
> Without these, one badly-configured rule saturates the queue and takes the demo down.

---

## 13. Runtime access — the differentiator

Support users hold **zero standing access** to ticket payloads or product resources. Assignment grants on two layers just-in-time; resolve revokes both.

### 13.1 T1 — platform access (platform-owned, RLS)

On assignment, `access_grant(layer='platform', mechanism='rls')` becomes `granted`, and the RLS predicate in §9.2 opens *that ticket's* data to *that user only*. On resolve it flips to `revoked`. No callback, no network, no trust gap — the platform enforces its own data directly and synchronously.

### 13.2 T2 — product access, mechanism A: server-to-server callback (full-code, product-a)

```
ASSIGN  ──► POST {product.access_callback_url}   HMAC-signed
            { event: "access.grant_requested", grant_id, ticket_id, product_tenant_id,
              actor: {support_user_id, email, display_name},
              scope: {kind: "dataset", resource_ref: "carbon:report:8842"},
              expires_at }
        ◄── 200 { status: "granted", product_grant_ref: "carbon-grant-771", expires_at }

RESOLVE ──► POST {callback}  { event: "access.revoke_requested", grant_id, product_grant_ref }
        ◄── 200 { status: "revoked" }
            on failure → 5 retries w/ backoff → DLQ → access.revoke_failed → admin red flag
```

### 13.3 T2 — product access, mechanism B: client-minted pre-authorized link (low-code, product-b)

The product mints an **inert** capability at raise time using auth context it already has, and hands it to the platform. The platform can only *bind and time-box* it.

```
RAISE   (product) ──► POST /v1/tickets { …, preauth_grant: { token, scope_kind, resource_ref,
                       max_ttl_seconds, launch_url_template } }        ← token is INERT
ASSIGN  (platform) ─► bind token to assignee identity; state inert → active;
                       render launch link in the ticket UI
USE     (assignee) ─► opens link → the product's OWN middleware validates:
                       signature valid · not expired · ticket still open · identity == bound user
                       → scoped session, only that resource
RESOLVE (platform) ─► state → revoked; product's next validation fails; max_ttl caps it regardless
```

### 13.4 Why mechanism B is the stronger design

> **The platform never holds the power to grant access on its own.** It can only relay and time-box a capability the product minted and signed. The platform never sees the product's signing key. Therefore **even a fully compromised platform cannot fabricate access into a product** — it can only replay a product-minted, product-scoped, product-validated capability.

Mechanism A cannot make that claim: a compromised platform can send a forged, correctly-HMAC'd grant request for any user and any scope. Both ship because the brief mandates A; B is the answer to "what would you build with more time," and it is a genuinely reusable pattern beyond ticketing.

### 13.5 Threat model

| Threat | Control |
|---|---|
| Forged grant request (mechanism A) | HMAC-SHA256 with per-product secret + timestamp window + nonce cache. The product must verify; the sample product's verification code is the reference implementation. |
| Compromised platform fabricates access | **Mechanism B is immune** — no product signing key on the platform. Mechanism A is not; this is the documented reason B exists. |
| Leaked **inert** pre-auth token | Useless. Not bound to a subject, not active. Activation requires the assignee's platform-authenticated identity. |
| Leaked **active** launch link | Bound to one assignee identity (product re-checks identity, ideally re-auth via SSO on open), single ticket scope, short `max_ttl`. Not a standalone bearer secret. |
| Over-broad access | `scope_kind` + `resource_ref` are chosen **by the product at mint time**, never by the platform. Never "full admin." |
| Access outlives the ticket | Three independent expiries: platform revokes at `resolved`; `max_ttl ≤ SLA target`; product re-checks ticket status on every use. Any one surviving is sufficient. |
| Product ignores revoke (mechanism A) | 5 retries w/ backoff → DLQ → `access.revoke_failed` → admin red flag → optional Slack page. Mechanism B degrades safely: it self-expires even if nothing is ever delivered. |
| Assignee reads another ticket's data | T1 RLS predicate is `(user, ticket)`-specific; there is no query path to a second ticket without a second grant. |
| Replay of a valid signed request | Timestamp ±300s + Redis nonce cache (TTL 600s) + signature binds method and path, so a captured request cannot be replayed against a different endpoint. |

---

## 14. TAT and SLA — locked definitions

Three measured metrics:

1. **Time to first response** — `raised_at → first_response_at` (first non-internal support comment).
2. **Time to resolution** — `raised_at → resolved_at`.
3. **Assignment to resolution** — `assigned_at → resolved_at`.

**Two deliberately different clocks, reported side by side:**

| Clock | Pauses? | Used for |
|---|---|---|
| **SLA clock** | Yes — outside the product's business calendar (overnight, weekends, holidays), and whenever status is `waiting_on_raiser` | SLA compliance %, breach alerts, agent performance |
| **Customer-facing TAT** | No — wall clock, never pauses | What we show the raiser; what analytics reports as "elapsed" |

Reporting both prevents the argument the brief warns about ("your SLA says 4h but I waited 3 days"). Both numbers are true; they measure different things. `sla_clock.segments` stores every run/pause span, so any number is reconstructable and auditable after the fact — **never store only a total**, because a total cannot be recomputed when a business calendar changes.

**Three SLA health states**, not two. The mockup's SLA Health panel adds a warning band the original design lacked:

| State | Condition |
|---|---|
| **On Track** | < 80% of the SLA target consumed |
| **At Risk** | **≥ 80% of target consumed and not yet resolved** |
| **Breached** | Target exceeded |

The middle band is the operationally useful one: a dashboard that shows only breaches is a post-mortem tool. *At Risk* is what lets a lead intervene before the breach happens.

Analytics report **p50 and p90, not averages** — a mean TAT hides exactly the tail that matters. SLA compliance % rolls over 7 / 30 / 90 days per product / category / severity.

---

## 15. AI layer

Built **after** the workflow exists — the brief names building AI first as a trap, and it is: without the state machine there is no labelled structure to predict into.

**Hard rule: AI is suggestive, never autonomous, on anything customer-facing.** Drafts are never auto-sent.

> **The autonomy boundary, stated precisely** (because the mockup blurs it — §3.6):
>
> | | Definition | Allowed |
> |---|---|---|
> | **Deflection** | A user asks the widget a question, gets a KB/AI answer, and **never files a ticket**. No ticket is ever created, so nothing was resolved on anyone's behalf | ✅ Yes |
> | **Auto-resolution** | An AI-generated response is sent on an **open ticket**, and the ticket moves to `resolved` without a human | ❌ **No** — violates the brief |
>
> Full reasoning in [ADR-009](adr/009-deflection-is-not-auto-resolution.md).

### 15.1 Capabilities

| Capability | Approach | Output |
|---|---|---|
| **Classify** | Embedding + classifier head over synthetic training set → product, category, severity | Labels + `p1`, `p2`, margin |
| **Suggest assignee** | Transparent weighted score, **not** a black box | Ranked candidates **with per-factor contribution shown** |
| **Draft response** | Retrieval over similar *resolved* tickets → generation | Draft in an editor, human must send |
| **Summarise** | One line for the queue view | ≤ 120 chars |
| **Embeddings** | `sentence-transformers` → `vector(384)` | Returned to core-service for storage |

**Assignee scoring factors** (weights are per-product config): domain fit (similarity to that user's past resolved tickets + category match) · track record (avg CSAT and trend on similar tickets) · speed (avg TAT on this category) · availability (open workload penalty). The UI shows *why* a candidate ranked first — a manager who cannot see the reasoning will not trust the suggestion.

> ⚠️ **Design caution:** weighting CSAT heavily optimises short-term satisfaction but starves lower-rated agents of the tickets they need to improve, and the "bottom performers" view in §12 then has no path upward. **Cap the availability penalty and reserve a share of tickets for development.** This is a deliberate fairness choice, not an oversight.

**Training data: synthetic or anonymised only. Never real customer data.** Seed set lives in `infra/seed/`.

### 15.2 Confidence handling — the decision the brief asks us to show

Two numbers per prediction: top confidence `p1`, and **margin** `p1 − p2`. Margin matters as much as confidence — a confident-but-contested prediction is not the same as a confident one.

| Condition | Action |
|---|---|
| `p1 ≥ 0.80` **and** margin `≥ 0.25` | **Auto-route** to the suggested product/queue |
| `0.50 ≤ p1 < 0.80`, **or** margin `< 0.15` | **Soft-route** to the suggested queue, flagged `AI-uncertain`, surfaced in triage for confirmation |
| `p1 < 0.50` | **Unclassified → human triage queue** |

**The brief's worked example — 60% Product X vs 35% Product Y:** `p1 = 0.60`, margin `= 0.25`. `p1` falls in the middle band → **soft-route to Product X, flagged AI-uncertain.** Not auto-routed (confidence below 0.80), not dumped as unclassified (a clear leader exists — discarding that signal wastes information and makes a human redo work the model already did). Both probabilities are persisted in `ticket.ai_classification`, so every misclassification is explainable after the fact. Thresholds live in `product.config.ai_thresholds` — config, not code.

### 15.3 The eval harness is a deliverable, not an afterthought

The success criterion is measurable: *"When 10 sample tickets are submitted, at least 7 are classified correctly into product + category + severity."*

`ai-service/eval/` holds a held-out labelled set and a scoring script that prints a confusion matrix and per-field accuracy. **It runs live in the demo** (§8 of the demo script) — a scored, reproducible number beats a claim. Build it early; it is also the fastest feedback loop for tuning thresholds.

### 15.4 Retrieval and deflection

Added per §3.6. The widget's *Ask a Question* and *Search Docs* capabilities (§6.1) retrieve over two corpora that are **already embedded for other reasons** — KB articles and resolved tickets — which is what makes this incremental rather than a new subsystem.

```
user question
   → POST /v1/widget/ask               (publishable key + identity JWT)
   → embed the question                (ai-service, same model as classification)
   → POST /internal/tickets/similar    (core-service — RLS-scoped, product-filtered)
   → rank KB articles + resolved tickets by score
   → return: answers + suggested_action ∈ {answer, create_ticket}
```

| Rule | Reasoning |
|---|---|
| **No ticket is created** by this path | It is deflection, not resolution (§15 autonomy boundary) |
| Every conversation is recorded in `widget_conversation` with an `outcome` | This is the sole source of the Self-Served metric. Without the record the metric is unauditable |
| **`ai-service` never queries pgvector directly** | Retrieval goes through `core-service/internal`, preserving Invariant #1 (§3.3). One forgotten `product_id` predicate here would leak another product's ticket text into a customer-facing answer |
| Below `product.config.deflection.min_score` → offer to create a ticket | A weak answer is worse than no answer; do not force a deflection |
| The user can always reach *Create a Ticket* in one click | Deflection must never become a wall between a customer and support |

### 15.5 AI Insights — closing the loop

The mockup's AI Insights page is mostly free, because §15.3 already mandates an eval harness.

| Metric | Source |
|---|---|
| Classification accuracy | The **same code** as `eval/run_eval.py`, scored against human-corrected classifications |
| Avg confidence | Mean `p1` over the window |
| Auto-routing rate | Share landing in the `p1 ≥ 0.80 ∧ margin ≥ 0.25` band — a direct visualisation of §15.2 |
| Self-Served rate | `widget_conversation` where `outcome='self_served'` |
| Confidence distribution | Histogram of `p1`, bucketed to the three routing bands |
| **Top Misclassified Intents** | Corrections made in triage |

> **The live page and the demo score read from one implementation.** Two accuracy definitions will disagree, and the one on screen during the demo will be the wrong one.

*Top Misclassified Intents* is the most valuable panel: a human corrects a label in triage, and the system surfaces which intents it is systematically worst at. That is a feedback loop, not a vanity metric.

---

## 16. Cross-cutting concerns

### 16.1 Audit trail

Append-only `audit_event`: every API call, state transition, assignment, comment, config change, and access grant/revoke — with actor, timestamp, `request_id`, source IP, and before/after. Enforced at the database: `REVOKE UPDATE, DELETE ON audit_event FROM iris_app`. The application *cannot* rewrite history even if compromised. Compliance-grade by construction, not by policy.

### 16.2 Request correlation

`X-Request-Id` is minted at the gateway (or accepted from a trusted caller), propagated through core-service → outbox → BullMQ job → worker → ai-service → notification-service, and stamped on every `audit_event` and `delivery_log` row. One id reconstructs a full cross-service trace — including which AI call produced a given classification.

### 16.3 Attachment handling — two traps

1. **Stored XSS in the admin portal.** An SVG (or HTML) attachment rendered inline in the admin portal executes script in an authenticated super-admin's session. This is a *complete* platform compromise delivered through a feature we are required to build. **Mitigations:** serve attachments only from a **separate origin** (never the admin panel's), always with `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, and a content-type allowlist that excludes `image/svg+xml` and `text/html`. Never render an attachment inline.
2. **Signed URLs, not proxied bytes.** Download links are short-lived pre-signed URLs (5 min) issued only after the RLS check passes — so the access-grant model applies to attachment bytes too, not just to metadata.

Storage: **MinIO** (S3 API) in local/dev, **Azure Blob** in production, behind one adapter in `core-service/src/storage/`. Same code path; one config value. Size cap 25 MB; content-type allowlist.

### 16.4 Failure modes and graceful degradation

| Failure | Behaviour | Blast radius |
|---|---|---|
| **ai-service down** | Tickets raise normally, land **unclassified in triage**. Jobs retry from the queue. | AI features only — the workflow is unaffected |
| **Redis down** | Outbox rows accumulate unpublished; publisher drains on recovery. Sync API keeps serving. **Rate limiting fails closed** for widget keys, open for authenticated products. | Async lag, no data loss |
| **Product webhook 5xx** | Backoff retries → DLQ → admin banner. A dead-lettered *revoke* is flagged as a security incident. | That product's event stream |
| **Product IdP down** | Existing tickets fully viewable and workable (cached `raiser_identity`). New SSO raises blocked; optional break-glass path. | New raises only |
| **notification-service down** | Queued; delivered on recovery. Ticket ops never block on notification. | Delivery latency |
| **Postgres down** | Full outage. Single point of failure — accepted for the hackathon; production answer is HA + read replicas. | Everything |
| **core-service down** | Gateway returns `503` with the standard error envelope; widget shows a retry-able error and preserves the user's typed description in local storage. | Everything, but no data loss |

### 16.5 Non-functional targets

| Metric | Target |
|---|---|
| `POST /v1/tickets` p95 (sync path, AI excluded) | < 300 ms |
| Ticket list / detail p95 | < 400 ms |
| AI classification available | < 10 s after raise (async) |
| Webhook delivery p95 | < 30 s |
| Access revoke on resolve (T1) | Synchronous, in-transaction — **0 s** |
| Access revoke on resolve (T2 callback) | < 30 s p95, guaranteed by `max_ttl` regardless |

---

## 17. Deployment topology

See [port-mapping.md](port-mapping.md) for the authoritative port table and the public/internal split.

- **Local + demo:** `infra/docker-compose.yml` brings up everything — nginx, all five services, Postgres+pgvector, Redis, MinIO. One command from a clean machine to a working demo. This is the deliverable.
- **Production (aspirational):** `infra/helm/` targets AKS. **Not built for the hackathon** — a stub with a README stating the intended shape. Claiming Kubernetes readiness we have not tested would be worse than saying "compose today, Helm charts sketched."
- **Network posture:** only `80/443` and the two sample-product ports bind to the host's public interface. Postgres, Redis, MinIO, core-service, ai-service, and notification-service bind to the compose-internal network only — **no `ports:` publishing** for those. An exposed Postgres is the single most common accidental hole in hackathon demos, and it is a one-line mistake.

> **Environment note (corrected 2026-07-26):** an earlier draft of this section said containers were unavailable. That was wrong. The **Docker CLI is absent, but Podman 5.8.3 is installed and working**, with `podman-compose`. The local stack therefore runs from `infra/podman-compose.yml` — Postgres 17.10 with pgvector 0.8.5 on 5432, Redis on 6380. `node v22.17.0` ✅, `python 3.12.4` ✅.
>
> The machine also has a **native Windows PostgreSQL 18 on port 5433**, which this project deliberately does not use: pgvector cannot be installed into it without the Visual Studio C++ workload (not present) and an elevated `nmake install`. See [port-mapping.md](port-mapping.md).

---

## 18. Build plan

Sequenced so the highest-risk, highest-scoring work is proven earliest. The brief's own warning drives the order: build the workflow before the AI, and design the contract before anything.

| Phase | Deliverable | Why here |
|---|---|---|
| **0 — Foundations** | docker-compose up (Postgres+pgvector, Redis, MinIO), migrations, RLS policies **with the negative test passing**, audit table, `withScope` helper | The isolation guarantee is the hardest thing to retrofit. Prove it on day one with a failing-then-passing test. |
| **1 — Contract + core** | OpenAPI in `shared/contracts/`, gateway (HMAC + JWKS + rate limit + idempotency), ticket CRUD + state machine, outbox | The brief: *"the integration contract is the highest-leverage design decision."* A bad contract makes everything after it painful. |
| **2 — Access boundary** | Dual JIT grant: T1 RLS + T2 callback + T2 pre-auth link, full grant→use→resolve→revoke, retry + DLQ | The riskiest and most differentiating feature. Front-load it; a stub is acceptable, a broken half-implementation is not. |
| **3 — Widget + SSO** | Widget iframe (**P0 capabilities only**, §6.1), server-side config, JWT/JWKS handoff, two branded sample products | Proves portability — three success criteria at once |
| **4 — Admin portal** | The nine pages in §12, **in the stated order**, ticket detail first | Ticket detail alone answers four criteria |
| **5 — Notifications** | Email, then webhooks, then WhatsApp (BSP) if time | Webhooks are mandated; WhatsApp is polish |
| **6 — AI layer** | Eval harness first, then classify → summarise → assignee scoring → draft. Adds `ai-service/src/retrieval/` | Eval-first means every subsequent change is measurable |
| **6.5 — KB + deflection** | KB article CRUD, embedding, widget **P1** capabilities (§6.1), Self-Served metric | **Only after every §5 success criterion demonstrably passes.** Reuses the phase-6 embedding pipeline, so it is genuinely incremental |
| **7 — Automations** | Fixed catalogue, toggles, loop protection (§12.1) | Not in the brief. Pure upside, therefore last of the non-stretch work |
| **8 — Stretch** | Live Chat, vision-on-screenshots, anomaly detection, AI-suggested KB articles, sentiment → manager flag, bulk ops, multi-language, customer portal | Only after everything above is done |

> **Sequencing rule from the brief, worth repeating:** *"Attempting and falling short on a stretch goal is fine if the core build is solid; skipping the core to chase stretch goals is not."*

---

## 19. Risk register

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| 1 | RLS misconfigured (owner bypass / pooled GUC leak) — security claim is silently false | **High** | **Critical** | §9.1 both footguns; automated negative test in CI from phase 0; single `withScope` entry point + lint |
| 2 | ~~Docker not installed → infra work blocked~~ | — | — | ✅ **Closed.** Podman 5.8.3 is installed and the stack runs on it. The original assessment was wrong |
| 3 | Access callback half-built with weak auth | Medium | **Critical** | The brief explicitly permits a stub. **A clear design with a stub beats a real implementation with holes.** |
| 4 | Admin portal consumes all remaining time | High | Medium | Nine pages in strict priority order (§12); **stop when time runs out** rather than shipping nine half-pages. No ornate forms. Ticket detail gets the polish; everything else is functional-plain. |
| 9 | **Widget scope expansion** — the mockup shows a conversational assistant, ~4× the original form. Chasing all of it starves the core | **High** | **High** | §6.1 priorities. **Live Chat (P3) is the single largest scope risk in either mockup** — a whole realtime subsystem — and is stubbed as a ticket conversion ([ADR-011](adr/011-live-chat-deferred.md)). P1 deflection ships only after every §5 criterion passes (phase 6.5) |
| 10 | Automation rule loop saturates the queue and takes the demo down | Medium | High | Three mandatory controls in §12.1: `actor_type='automation'`, skip automation-authored events, cap chains at 3 |
| 5 | AI misses the 7/10 bar | Medium | Medium | Eval harness in phase 6 *first*; synthetic set tuned to the demo categories; confidence bands mean uncertain tickets route to triage rather than route wrongly |
| 6 | Polyglot integration friction | Medium | Medium | Invariant #1 (one DB credential) caps the shared surface at five HTTP endpoints |
| 7 | Demo environment differs from dev (port blocks, Windows reservations) | Medium | High | Demo pre-flight checklist in [demo-script.md §1](demo-script.md), rehearsed on the actual demo machine |
| 8 | Webhook receiver on the sample product isn't reachable from the platform container | Medium | Medium | Both on the same compose network; use service DNS names, never `localhost` |

---

## 20. Open decisions

| # | Decision | Current position | Needs |
|---|---|---|---|
| 1 | Access revoke timing | **Resolved:** revoke at `resolved`, idempotent re-assert at `closed` (§3.5) | ✅ Closed |
| 2 | First-response definition | **Resolved:** first non-internal support comment (§10) | ✅ Closed |
| 3 | Pre-auth `max_ttl` ceiling | Default `≤ SLA target`, hard ceiling 72 h | Confirm the hard ceiling |
| 4 | WhatsApp provider | BSP (Gupshup / Wati / AiSensy / 360dialog) for v1; direct Cloud API later behind the same abstraction | Name the BSP if a WABA contract already exists |
| 5 | Auto-close window | `resolved → closed` after **3 business days** without reopen | Confirm |
| 6 | AI hosting | Self-hosted small model (data-residency friendly) assumed | Confirm vs hosted API — affects demo latency and offline resilience |
| 7 | Sample product B language | Python/Flask, deliberately different from product A (Node), to prove the contract is language-independent | Confirm — costs a Python HMAC helper in `shared/` |

---

## 21. Judging alignment

| Criterion | Weight | Where this design earns it |
|---|---|---|
| **Problem Impact** | 25% | Real internal pain; §12 cross-product single pane; §19 reusability of the access pattern beyond ticketing |
| **Solution Feasibility** | 25% | §17 one-command compose; §18 risk-ordered phasing; §16.4 explicit degradation; stubs permitted where the brief permits them |
| **Innovation** | 15% | §13.3–13.4 client-minted pre-auth capability — a compromised platform cannot fabricate access. §15.2 margin-aware confidence, not just top-1. |
| **Demo Quality** | 15% | [demo-script.md](demo-script.md) — timed, rehearsed, with live negative security tests and a live AI eval score |
| **Implementation Readiness** | 15% | [api-contract.md](api-contract.md) with a verifiable HMAC test vector; OpenAPI in `shared/contracts/`; migrations + seed in `infra/` |
| **Team Collaboration** | 5% | §3.1 polyglot split parallelises Node and Python tracks; `shared/contracts/` is the coordination artifact |

---

## Appendix A — ADR index

One ADR per decision that must be defended. ADRs 001–006 answer the brief's §4 ("Design Decisions You Must Defend") directly; 007–008 cover architecture choices the brief does not name but a judge will ask about; 009–011 record the decisions forced by the UI mockups (§3.6), which are the ones most likely to be re-litigated mid-build by someone reading the mockup instead of this document.

| ADR | Decision | Brief § | Status |
|---|---|---|---|
| [001](adr/001-integration-contract-rest-webhooks.md) | Integration contract: REST + webhooks (GraphQL and signed event bus rejected) | 4.1 | Accepted |
| [002](adr/002-callback-security-hmac.md) | Callback security: HMAC-SHA256 (mTLS and signed-JWT considered) | 4.2 | Accepted |
| [003](adr/003-sso-signed-jwt-handoff.md) | SSO: signed JWT handoff (OIDC optional, SAML rejected) | 4.3 | Accepted |
| [004](adr/004-isolation-row-level-security.md) | Isolation: RLS + app-layer checks (schema-per-tenant, DB-per-tenant rejected) | 4.4 | Accepted |
| [005](adr/005-ai-confidence-thresholds.md) | AI confidence thresholds and margin-aware routing | 4.5 | Accepted |
| [006](adr/006-tat-definitions-and-clock-pauses.md) | TAT definitions and clock-pause rules (two clocks) | 4.6 | Accepted |
| [007](adr/007-polyglot-topology-one-db-credential.md) | Polyglot topology and the one-DB-credential invariant | — | Accepted |
| [008](adr/008-dual-access-mechanism.md) | Dual access mechanism: callback + client-minted pre-auth link | — | Accepted |
| [009](adr/009-deflection-is-not-auto-resolution.md) | Deflection is not auto-resolution — the AI autonomy boundary | — | Accepted |
| [010](adr/010-automations-fixed-catalogue.md) | Automations as a fixed catalogue, not a rule engine | — | Accepted |
| [011](adr/011-live-chat-deferred.md) | Live Chat deferred; the stub converts a conversation to a ticket | — | Accepted |
