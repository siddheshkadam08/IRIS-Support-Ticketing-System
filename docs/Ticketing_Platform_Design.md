# Intelligent Support Ticketing Platform — System Design

| | |
|---|---|
| **Scope** | Standalone, multi-product ticketing platform any product plugs into — zero / low / full-code integration |
| **Source brief** | `Challenge_1_Support_Ticketing_System.docx` |
| **This doc** | Design spec. Build phases in §16. |

---

## 1. The two-layer tenancy model (read this first)

Everything hangs on separating two tenancy layers.

```
Platform
 └── Product tenant           ← an integrating product (CARBON, GST, …)
      └── Customer tenant      ← that product's own customer/company
           └── End user        ← the person who raises a ticket
```

- **Platform tenants = integrating products.** Isolation between products is the primary security boundary. A support user authorised for CARBON must not see another product's tickets without an explicit grant.
- **Customer tenants = each product's customers.** The platform stores `product_tenant_id` as an opaque string the product owns. The platform does not manage these accounts; it records them for filtering, isolation, and analytics.
- Two support-visibility scopes therefore exist: *product-level* and, optionally, *customer-level* within a product.

Every ticket, comment, audit row, and analytics aggregation carries `(product_id, product_tenant_id)`. No code path reads a ticket without a `product_id` predicate.

---

## 2. Architecture overview

```
                    ┌──────────────────────────────────────────────┐
Integrating product │  Widget (JS/iframe)  ·  API calls (SDK)       │
(CARBON, GST, …)    │  Webhook receiver*   ·  Pre-auth link mint    │
                    └───────────────┬──────────────────────────────┘
                                    │  REST /v1 (HMAC + signed JWT identity)
                                    ▼
        ┌───────────────────────────────────────────────────────────┐
        │                 TICKETING PLATFORM (standalone)            │
        │  API Gateway ── AuthN/Z ── Rate limiter (per product)      │
        │        │                                                   │
        │  ┌─────▼──────┐  ┌───────────┐  ┌──────────────┐           │
        │  │ Ticket core│  │ Workflow  │  │ Notification │──► Email  │
        │  │ CRUD +     │  │ state     │  │ dispatcher   │──► WhatsApp│
        │  │ comments   │  │ machine   │  │ (channel abs)│──► Slack  │
        │  └─────┬──────┘  └─────┬─────┘  └──────────────┘           │
        │        │               │                                   │
        │  ┌─────▼───────────────▼─────┐   ┌────────────────────┐    │
        │  │ AI layer (async)          │   │ Access engine      │    │
        │  │ classify · suggest ·      │   │ T1 platform JIT +  │    │
        │  │ draft · summarise         │   │ T2 pre-auth link   │    │
        │  └───────────────────────────┘   └────────────────────┘    │
        │        │                                                   │
        │  ┌─────▼─────────────────────────────────────────────┐     │
        │  │ Postgres (RLS) + pgvector · Redis · Blob store     │     │
        │  │ Append-only audit log                             │     │
        │  └───────────────────────────────────────────────────┘     │
        │  Admin portal (React) ── platform-native support identity  │
        └────────────────────────────────────────────────────────────┘
        * webhook receiver only needed at the low/full-code tier
```

Async work (AI, notifications) runs off a queue so the synchronous API stays fast and failures retry rather than drop.

---

## 3. Technology stack

| Layer | Choice | Why |
|---|---|---|
| API + services | **Python / FastAPI** | One runtime shared with the AI layer; async-native; fast iteration. |
| Datastore | **PostgreSQL + pgvector** | RLS gives the isolation model (§10); pgvector holds ticket embeddings for similarity-based assignee suggestion and draft reply — no separate vector DB. |
| Queue / async | **Redis + Celery** | Notification fan-out, AI jobs, retries. |
| Object storage | **Azure Blob** | Attachments; geo-tagged containers for data residency. |
| Admin portal | **React** | Existing frontend competence. |
| Deploy | **Azure AKS + Helm** | Existing Azure footprint. |

**Assumption the stack rests on:** the platform lives inside existing Azure + Postgres + Python competence, so reusing that stack beats adding a new one.

---

## 4. Integration model — zero / low / full code *(headline feature)*

A product picks the depth of integration it needs. Higher tiers unlock more; none require rebuilding the ticketing flow.

| Tier | Product writes | Gets | Use when |
|---|---|---|---|
| **Zero-code** | One `<script>` snippet in the page | Raise a ticket, show confirmation + reference, branded widget, email/WhatsApp notifications handled by the platform | Product just needs a working support channel |
| **Low-code** | Snippet + paste a webhook URL and (optionally) mint a pre-auth link at raise (a few lines using existing auth) | Everything above + webhook state events + **runtime scoped support access via the pre-auth link (§9)** | Product wants ticket events back and support-into-product access |
| **Full-code** | Snippet + backend SDK/API + server-to-server grant/revoke callback | Everything above + push-based access revocation + deep automation | Product wants full programmatic control |

Design rule: **each tier is additive and self-contained.** The zero-code path is genuinely code-free on the product side because the widget, identity handoff, notifications, and ticket tracking are all platform-hosted. The differentiating access feature (§9) is reachable at the **low-code** tier — the product mints a link, it does not build a grant service.

### 4.1 The contract (low/full-code tiers)

**REST/JSON over HTTPS + outbound webhooks, versioned by URL path (`/v1`), per-product HMAC credentials.**

| Option | Verdict | Reason |
|---|---|---|
| **REST + webhooks** | **Chosen** | Lowest integration cost across the widest set of products; trivial to stub, log, replay; webhooks push state changes without polling. |
| GraphQL | Rejected as the contract | Adds schema/runtime burden on every integrator for a small stable operation set; harder to version for external integrators. Fine internally, not at the boundary. |
| Signed event bus | Rejected as the contract | Forces each product to run a consumer + manage offsets — raises the integration floor, breaking the zero/low-code goal. Used internally for fan-out only. |

**Endpoints (v1):**
```
POST   /v1/tickets                 raise a ticket (may carry a pre-auth grant, §9)
GET    /v1/tickets/{id}            get a ticket
GET    /v1/tickets                 list + filter (status, tenant, category, severity, date)
POST   /v1/tickets/{id}/comments   add a comment
PATCH  /v1/tickets/{id}/status     change status (guarded by state machine)
GET    /v1/tickets/{id}/history    transitions + comments + access events
```

**Auth (product → platform):** per-product `client_id` + `client_secret`; each request carries an **HMAC-SHA256** signature over `(timestamp + body)` + timestamp header. Replays rejected outside ±5 min; nonces cached in Redis. Rate-limited per product. The secret never travels on the wire and doubles as the webhook-verification key.

**Webhooks (platform → product):** events `ticket.assigned`, `ticket.in_progress`, `ticket.resolved`, `ticket.closed`, `ticket.reopened`, `access.activated`, `access.revoked`, `access.revoke_failed`. HMAC-signed, event-id + timestamp, at-least-once with exponential-backoff retries, dead-lettered to the admin portal on exhaustion.

**Versioning:** URL-path major version; additive changes never bump major; breaking changes only in a new major; contract tests in CI fail the build on accidental v1 breakage.

---

## 5. Embeddable raise-ticket widget (zero-code)

- **One script tag** mounts an iframe (isolated from host CSS/JS): `<script src="…/widget.js" data-product-key="pub_…"></script>`.
- Uses a **publishable key** (not the secret) + the signed identity JWT from the host (§6). The publishable key permits ticket creation only, for that product.
- Captures description, category, severity, attachments; renders with the **product's branding** from per-product config.
- **Per-product configurable server-side:** fields shown, defaults, available categories — changeable without a product redeploy.
- On submit: posts through the platform API, shows confirmation + ticket reference. A second product with different branding embeds the same widget against the same platform.

---

## 6. SSO and identity federation

**Signed short-lived JWT handoff as primary; OIDC as an enterprise option; SAML not primary.**

- The product already authenticated the user. It mints a **short-lived JWT** (≈5-min TTL) signed with its private key: `sub` (opaque product user id), `product_tenant_id`, name, email, scope. The platform verifies against the product's published **JWKS** and maps `(product_id, sub)` → ticket-raiser identity. No re-auth, no shared user store.

| Option | Verdict | Reason |
|---|---|---|
| **Signed JWT handoff** | **Chosen** | The product already authenticated the user; a redirect flow re-solves a solved problem and adds latency inside an embedded widget. Lowest integration cost. |
| OIDC | Offered, not default | Correct when a product wants the platform to *drive* login. |
| SAML | Not primary | Heavier XML tooling and redirect friction inside an iframe; no advantage here. Add only if an integrator mandates it. |

**IdP-down fallback:** raiser identity (name, email, refs) is **cached on the ticket** at raise time, so existing tickets stay viewable and workable by support even if the product's IdP is down. A down IdP only blocks *new* SSO raises; an optional per-product "email-verified raise" break-glass path covers that, off by default.

---

## 7. Core data model

Postgres; every product-scoped row carries `product_id`.

- **product** — API credentials (hashed), webhook URL, JWKS URL, signing keys, config (queues, SLAs, severities, routing rules, widget fields, `grant_scope_kind`, callback URL if full-code), API version pin.
- **ticket** — `id`, `product_id`, `product_tenant_id`, `raised_by_ref`, `raiser_identity` (cached), `category`, `severity`, `status`, `queue_id`, `assignee_id`, timestamps (`raised_at`, `first_response_at`, `assigned_at`, `resolved_at`, `closed_at`), `ai_classification` (json + confidences), `summary`, `rating`, `rating_comment`, `sentiment`, `preauth_grant_ref`.
- **comment** — `ticket_id`, `author_type` (raiser | assignee | system), `author_ref`, `body`, `created_at`, `is_internal`.
- **attachment** — `ticket_id`, blob ref, filename, content-type, size, uploaded_by.
- **support_user** — platform-native identity (not from products). Roles, product/customer scopes, workload counters. **No standing access to ticket payloads** — access is JIT via `access_grant` (§9).
- **access_grant** — `ticket_id`, `support_user_id`, `layer` (`platform` | `product`), `scope`, `mechanism` (`preauth_link` | `callback`), `granted_at`, `activation_response`, `revoke_due_at`, `revoked_at`, `revoke_response`, `state` (granted | revoke_pending | revoked | revoke_failed). One assignment creates two rows (one per layer); both revoke on resolve; reopen re-issues both.
- **preauth_token** — `ticket_id`, opaque product-minted capability, `scope_kind`, `resource_ref`, `max_ttl`, `bound_support_user_id` (null until activation), `state` (inert | active | expired | revoked).
- **audit_event** — append-only: actor, action, entity, before/after, timestamp, request id, source ip. Never updated or deleted.
- **sla_clock** — per ticket: accumulated business-time, pause segments (§13).

Ticket status: `open → assigned → in_progress → resolved → closed`; re-open path `resolved/closed → open` (audited).

---

## 8. Core ticketing workflow

```
        self-assign / manager-assign / auto-assign
  open ───────────────────────────────────────────► assigned
   ▲                                                    │ pick up
   │ reopen (audited)                                   ▼
   │                                              in_progress
   │                                                    │ resolve
   │                                                    ▼
   └──────────────── reopen ───────────────────────  resolved
                                                        │ raiser rates (1–5 ★, optional comment)
                                                        │ + auto-close after N days if no reopen
                                                        ▼
                                                      closed
```

- **Assignment** — three paths: self-assign, manager-assign, AI-suggested auto-assign (§12). Unassigned tickets sit in the triage queue. **Assignment fires the dual JIT grant** (§9); resolve revokes both; reopen re-issues both.
- **Comments** — both sides, author + timestamp; internal notes flagged `is_internal` (never sent to raiser or product).
- **Rating** — on resolution the raiser rates 1–5 ★ + optional comment before close; feeds performance analytics and CSAT.
- **Email/queue routing** — per-product config maps `(category, severity, tenant)` → queue → support user(s).

---

## 9. Runtime access — dual JIT grant + client-minted pre-authorized link *(the differentiator)*

Support users hold **zero standing access** to ticket data or product resources. Assignment grants access on two layers just-in-time; resolve revokes both.

### 9.1 T1 — Platform access (platform-owned, RLS)

On assignment, the platform activates `access_grant(layer='platform')` and RLS opens **that ticket's data** (comments, attachments, raiser identity, history) to **that user only**. On resolve it deactivates. No callback, no trust gap — the platform enforces its own data directly.

### 9.2 T2 — Product access via a pre-authorized link (primary, low-code)

Instead of the product building a grant/revoke service, the **client app mints a pre-authorized access capability at ticket-raise time**, using the auth context it already has for the raiser's session. This token is **inert** — not bound to any person, not yet usable.

```
RAISE  (client app)  ── POST /v1/tickets  { …ticket…, preauth_grant: { token, scope_kind:section|file,
                          resource_ref, max_ttl } }          token is opaque + product-signed, INERT

ASSIGN (platform)    ── T1: activate platform RLS grant for assignee
                     └─ T2: bind preauth_token to the assignee's identity → issue launch link in ticket UI
                            (state inert → active); notify product via access.activated webhook (full-code)
                            OR product validates lazily on first use (low-code, no webhook)

USE    (assignee)    ── opens launch link → product's existing auth middleware checks:
                          product signature valid · not expired · ticket still open · identity == bound user
                          → grants scoped session (only that section / file)

RESOLVE (platform)   ── T1 revoked (RLS closes ticket) ; T2 token state → revoked + revoke_due enforced
                          product's next validation fails; max_ttl caps it regardless

REOPEN               ── fresh token minted (or reactivated within max_ttl); both layers re-issued; audited
```

**The security property that makes this worth building:** the platform **never holds the power to grant access on its own**. It can only *relay and time-box* a capability the client app minted and signed. The platform never sees the product's signing key. So even a fully compromised platform cannot fabricate access into a product — it can only replay a product-minted, product-scoped capability, which the product still validates on use.

### 9.3 T2 — Server-to-server callback (advanced, full-code)

For products wanting push-based revocation: HMAC-signed `grant`/`revoke` callbacks to a product endpoint. Same lifecycle, but the product runs a receiver. Offered, not required — the pre-auth link covers most needs at lower cost.

### 9.4 Threat model

| Threat | Control |
|---|---|
| Leaked **inert** token (before assignment) | Useless — not bound to a subject, not active; activation requires the assignee's platform-authenticated identity. |
| Leaked **active** launch link | Bound to one assignee identity (product checks identity, ideally re-auth via SSO on open) + single ticket scope + short `max_ttl`. Not a standalone bearer secret. |
| Forged capability | Product-signed; platform can't forge (never holds the product key). |
| Over-broad access | `scope_kind` + `resource_ref` baked in by the product at mint time — never full admin. |
| Access outlives ticket | `max_ttl ≤ SLA target`; platform revokes on resolve; product re-checks ticket status on use. |
| Product fails to honour revoke (callback path) | Retry with backoff + `access.revoke_failed` webhook + admin red flag + optional Slack page. Pre-auth path self-expires via `max_ttl`, so it degrades safely even with no revoke. |
| Assignee reads another ticket's data | T1 RLS predicate is `(user, ticket)`-specific; no query path to another ticket without an active grant. |

**Why the platform owns T1 but only relays T2:** the platform *can* enforce its own data, so it does (RLS). It *cannot* know a product's ACLs, so it never tries to own them — it relays a product-minted capability. This preserves "any product" portability and yields the compromise-resistant property above.

---

## 10. Multi-product data isolation

**PostgreSQL Row-Level Security on `product_id`, plus application-layer scope checks — defence in depth.**

| Option | Verdict | Reason |
|---|---|---|
| **RLS + app-layer checks** | **Chosen** | One schema, simple ops; DB enforces isolation even if an app query forgets a predicate — failure mode is "no rows," not "another product's rows." App checks add an earlier, readable gate. |
| Schema-per-product | Rejected | N schemas in lockstep; cross-product analytics becomes a union over N schemas. |
| Database-per-product | Rejected | Strongest isolation, heaviest ops; kills single-pane cross-product analytics. |

Every DB session sets `app.current_product_scope` and `app.current_support_user`. RLS filters every statement to the actor's scope. Admin "see everything" is a distinct policy, not a bypass.

### 10.1 Three access tiers for support users (zero standing access)

| Tier | Grants | When | Enforced by |
|---|---|---|---|
| **T0 — Queue metadata** | Summary, category, severity, age of *unassigned* tickets in a scoped product — enough to pick/triage. No comments, attachments, or raiser PII. | Standing (scoped users) | RLS on a restricted view |
| **T1 — Platform ticket access** | Full ticket data in the platform | On assignment; auto-revoked on resolve | RLS: active `access_grant(platform)` |
| **T2 — Product scoped access** | Section / file / dataset *inside the product* | On assignment via pre-auth link; auto-revoked on resolve | Product validates the capability (§9) |

---

## 11. Notifications — Email + WhatsApp

All channels sit behind one `NotificationChannel` abstraction; a product enables the set it wants per event.

### 11.1 Email
Per-product routing config → queue/support user; templated; raiser and assignee notified on relevant transitions. Standard transactional email.

### 11.2 WhatsApp
*(Facts below: source type = BSP/vendor blogs corroborating Meta's official WhatsApp Business Platform pricing docs — secondary. Verify against Meta's pricing page before budgeting.)*

- **What it is:** WhatsApp Business Platform **Cloud API**. No platform subscription; **you pay per delivered *template* message**, priced by category and recipient country (per-message model since 1 July 2025).
- **Categories:** marketing / utility / authentication / service. **Ticket lifecycle alerts are business-initiated → pre-approved *utility* templates** (e.g., "Ticket #{{id}} assigned to {{agent}}"). Utility is cheap, sub-cent in India.
- **24-hour service window:** a raiser-initiated inbound opens a 24h window where free-form replies are currently free — **but from 1 October 2026 Meta begins charging for in-window utility templates and free-form replies.** Treat WhatsApp as "per lifecycle notification," not "free after first inbound."
- **Provider:** **BSP (Gupshup / Wati / AiSensy / 360dialog / Twilio) recommended for v1** — managed template approval, delivery retries, opt-in handling, India local-currency billing; per-message markup. **Direct Cloud API** in a later phase (lower cost, more work) behind the same abstraction.
- **Specifics:** opt-in mandatory (store consent per raiser; no consent → email only); fixed small set of pre-approved utility templates (assigned, status-changed, resolved, SLA-breach-to-raiser); each message deep-links to the ticket; per-product + per-event configurable; default off until a product configures a sender.
- **Assumption:** recipients predominantly in India / low-cost markets, so per-notification cost is negligible. Re-check economics before enabling anything marketing-category for high-rate markets (Germany, UAE); utility stays cheap regardless.

---

## 12. AI layer

Built after the workflow exists (no data structure to predict on otherwise). All AI is **suggestive, never autonomous** on customer-facing actions.

### 12.1 Capabilities
- **Auto-classify** ticket → product, category, severity from description text.
- **Suggest assignee** — a transparent weighted score per candidate, not a black box:
  - **Domain fit** — similarity of the ticket to the user's past *resolved* tickets (pgvector) + category match.
  - **Track record** — the user's **average rating (CSAT)** and rating trend on similar tickets (first-class factor).
  - **Speed** — average TAT on this category (faster ranks higher).
  - **Availability** — current open workload (heavier load penalises the score).
  - Output: ranked candidates with per-factor contribution shown, so a manager sees *why*. Weights are per-product config. Suggestion only.
- **Draft initial response** from similar resolved tickets — **human-reviewed, never auto-sent.** Hard rule.
- **One-line summary** per ticket for the queue view.
- Training data: **synthetic / anonymised only — never real customer data.**

*Inference, not fact:* weighting ratings heavily optimises CSAT but can starve lower-rated agents of the tickets they need to improve. Cap the availability penalty and reserve a share of tickets for development, or the bottom-performer view in §14 has no path up.

### 12.2 Classification confidence handling
Two numbers per prediction: top confidence `p1` and margin `p1 − p2`.

| Condition | Action |
|---|---|
| `p1 ≥ 0.80` **and** margin `≥ 0.25` | **Auto-route** to suggested product/queue. |
| `0.50 ≤ p1 < 0.80`, or margin `< 0.15` | **Soft-route** to suggested queue, flagged "AI-uncertain" for triage confirmation. |
| `p1 < 0.50` | **Unclassified → human triage queue.** |

**Worked example — 60% Product X vs 35% Product Y:** `p1 = 0.60`, margin `0.25` → middle band → **soft-route to Product X, flagged AI-uncertain**, surfaced in triage. Not auto-routed (confidence too low), not dumped as unclassified (clear leader exists). Both probabilities logged so misclassifications are explainable.

Thresholds are **config, not code** — tunable per product once real volume accrues.

---

## 13. TAT and SLA

**Three TAT metrics, measured explicitly:**
1. **Time-to-first-response** — `raised_at → first_response_at` (first support comment visible to the raiser).
2. **Time-to-resolution** — `raised_at → resolved_at`.
3. **Assignment-to-resolution** — `assigned_at → resolved_at`.

**Two deliberately different clocks:**
- **SLA clock** — business-hours only. Pauses outside the product's business calendar (overnight, weekends, holidays) and whenever status is "waiting on raiser" (a pause sub-state of `in_progress`). This is what SLA compliance % measures.
- **Customer-facing TAT** — wall-clock, no pauses.

Reporting both side by side prevents the "your SLA says 4h but I waited 3 days" argument. `sla_clock` stores accumulated business-time + every pause segment, so any number is reconstructable and auditable.

- **SLA compliance %** over 7 / 30 / 90 days, per product / category / severity.
- Definitions (business calendar, pause rules, severity→SLA map) live in **per-product config**.

---

## 14. Admin portal and analytics

**Operational views:** live counters (open/assigned/in-progress/resolved/closed, click-through to filtered lists); filter+search (product, tenant, category, severity, status, assignee, raised-by, date); ticket detail with full history (transitions, comments, attachments, **access grant/revoke events**, audit trail); open-issues view (high-severity + SLA breaches across products); unassigned/triage queue (incl. AI-uncertain); support-user management (add/remove/role/scope, workload); per-product config (queues, SLAs, severities, routing, pre-auth/callback settings, widget fields, notification channels).

**TAT + performance views:** TAT distributions (p50/p90, not just averages) per product/category/severity; SLA compliance % over 7/30/90 days; **top and bottom performers** by avg rating, resolution count, TAT (faster better), SLA compliance; per-support-user profile (resolved count, avg rating, avg TAT, workload, common categories, rating trend); CSAT trend over time per product.

---

## 15. Audit trail

Append-only `audit_event`. Every API call, state transition, assignment, comment, config change, and access grant/revoke logged with actor, timestamp, request id, before/after. No update, no delete — compliance-grade.

---

## 16. Build phases

Phase 1 front-loads the core workflow **and** the differentiating access model, so the hardest/most valuable integration boundary is proven first.

1. **Phase 1 — Core + access boundary**
   - Core platform, data model, RLS isolation, ticket state machine, audit trail.
   - Integration contract (REST + HMAC + webhooks + versioning) and the zero/low/full-code tiers.
   - Embeddable widget + signed-JWT SSO (two branded sample products).
   - **Runtime access: dual JIT grant (T1 platform RLS) + client-minted pre-authorized link (T2), full grant→use→resolve→revoke cycle with the compromise-resistant property (§9).**
2. **Phase 2 — Notifications:** email, then WhatsApp (BSP).
3. **Phase 3 — Admin portal:** operational views, then TAT/performance views.
4. **Phase 4 — AI layer:** classification (confidence routing) → summary → assignee scoring → draft reply.
5. **Phase 5 — Stretch:** multi-language, sentiment→manager flag, KB auto-suggest, bulk ops, customer portal, third-party integrator to prove portability.

---

## 17. Success-criteria mapping

| Criterion | Where satisfied |
|---|---|
| Standalone platform | §1–§3 |
| Integration API | §4 |
| Embeddable widget | §5 |
| SSO integration | §6 |
| Access flow | §9 — dual JIT grant + pre-auth link, grant→use→resolve→revoke |
| Admin portal | §14 |
| TAT + performance | §13–§14 |
| AI classification (≥7/10) | §12 |
| Audit trail | §15 |
| No security holes | §10 (RLS + tiers), §9 (compromise-resistant access), §6 (scoped identity) |

---

## 18. Open decisions

1. **Access revoke timing** — set to **`resolved`** (T1 + T2 both revoked; reopen re-issues). Confirm, or hold through the rating window until `closed`.
2. **First-response definition** — set to "first support comment visible to raiser." Alternative: first move to `assigned`.
3. **Pre-auth `max_ttl`** — cap the capability at the ticket's SLA target vs. a fixed ceiling (e.g., 72h). Default: ≤ SLA target.
4. **WhatsApp provider** — BSP recommended. If a WABA/BSP contract already exists, name it to pin the channel.
5. **Auto-close window** — resolved→closed after N days without reopen. Default N = 3 business days.
6. **AI hosting** — self-hosted SLM (data-residency friendly) vs. hosted API. Assumed self-hosted.

---

## Sources (WhatsApp facts, §11)

All secondary — vendor/BSP blogs corroborating Meta's official WhatsApp Business Platform pricing documentation. Primary source is Meta's own pricing page; verify there before budgeting.

- Authgear, *WhatsApp API Pricing Explained (2026)* — per-message model, July 2025 change, India rates.
- Zernio / EngageLab / SetSmart / Blueticks (2026) — 1 Oct 2026 change to in-window utility + free-form billing; BSP list; category rules.

*Fact vs. inference:* the pricing figures and the Oct 2026 change are reported facts (confirm against Meta). The provider recommendation, the utility-template mapping, and the India-cost assumption are design choices.
