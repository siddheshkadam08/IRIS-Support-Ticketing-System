# Database Schema

Every table in the IRIS Ticketing Platform, in detail.

| | |
|---|---|
| **Engine** | PostgreSQL 17 + `pgvector` 0.8.5 (`vector`, `pg_trgm`, `pgcrypto`) |
| **Migrations** | `infra/migrations/` — forward-only, numbered, idempotent |
| **Authority** | This document describes the schema **as migrated**. Tables designed but not yet created are listed separately in [§9](#9-designed-but-not-yet-migrated) so nothing here reads as fiction |
| **Companions** | [HLD.md §8](HLD.md) · [ADR-004](adr/004-isolation-row-level-security.md) · [ADR-008](adr/008-dual-access-mechanism.md) |

**14 tables migrated in 001–006** (platform + widget), **4 more in 007–009** (admin portal + access grants) = **18 tables**.

---

## 1. How to read this

### Conventions

| Rule | Detail |
|---|---|
| Table names | `snake_case`, **singular** — `access_grant`, not `access_grants` |
| Primary keys | Prefixed ULIDs as `text` — `tkt_01JQZ…`. ULIDs sort chronologically, which makes cursor pagination and log reading far easier than UUIDs |
| Timestamps | Always `timestamptz`, never `timestamp`. Stored UTC, rendered in the product's timezone only at the point of display |
| Durations | Integer seconds, column suffixed `_seconds` |
| Enums | `CHECK` constraints rather than PG enum types — adding a value is a one-line migration, not a type rewrite |
| Money | None in this system |
| Soft deletes | None, except where a table is explicitly append-only |

### Every product-scoped table has four things

Omitting any one silently breaks tenant isolation, so CI rejects a migration that creates a product-scoped table without all of them:

```sql
product_id text NOT NULL REFERENCES product(id)        -- 1. the tenant column
CREATE INDEX ... ON tbl (product_id, ...)              -- 2. every index LEADS with product_id
ALTER TABLE tbl ENABLE ROW LEVEL SECURITY;             -- 3.
ALTER TABLE tbl FORCE  ROW LEVEL SECURITY;             -- 4. applies to the owner too
CREATE POLICY tbl_isolation ON tbl USING (...);        --    the policy itself
```

> **Why `FORCE` matters.** In PostgreSQL a table **owner is exempt from RLS** unless forced. Without it, every policy below is decorative — with no error message anywhere. The application additionally connects as the non-owner `iris_app` role, so we are protected twice.

### The RLS session contract

Every query runs inside a transaction that first sets these, via `core-service/src/db/with-scope.ts`:

| Session variable | Meaning |
|---|---|
| `app.product_scope` | Comma-joined product ids the actor may see |
| `app.role` | `product` · `raiser` · `agent` · `manager` · `product_admin` · `super_admin` |
| `app.raiser_ref` | The end user's opaque `sub`, when `role = 'raiser'` |
| `app.support_user_id` | The support user's id, when staff |
| `app.request_id` | Correlation only |

Set with `SET LOCAL` (`set_config(..., true)`) **inside a transaction** — a plain `SET` persists for the life of a pooled connection and would leak one request's scope into the next.

**Unset variables fail closed.** `current_setting(…, true)` returns NULL → `string_to_array` returns NULL → `= ANY(NULL)` is NULL → the policy denies. A background job that forgets to establish scope sees **zero rows**, never everything.

Four helper functions read them: `app_scope()`, `app_role()`, `app_raiser()`, `app_support_user()`.

---

## 2. Entity overview

```
                        ┌───────────┐
                        │  product  │  the tenant root
                        └─────┬─────┘
        ┌─────────────────────┼──────────────────────┬─────────────────┐
        │                     │                      │                 │
   ┌────▼─────┐        ┌──────▼──────┐      ┌────────▼────────┐  ┌─────▼──────┐
   │  ticket  │        │ kb_article  │      │widget_          │  │announcement│
   └────┬─────┘        └─────────────┘      │  conversation   │  └────────────┘
        │                                    └─────────────────┘
   ┌────┴────┬──────────────┬────────────────┐
   │         │              │                │
┌──▼────┐ ┌──▼───────┐ ┌────▼───────┐ ┌──────▼────────┐
│comment│ │attachment│ │access_grant│ │ preauth_token │
└───────┘ └──────────┘ └─────┬──────┘ └───────────────┘
                              │ support_user_id
                    ┌─────────▼──────────┐
                    │    support_user    │──┬─ support_user_scope ──→ product
                    └────────────────────┘  └─ support_user_skill
                                                                    
   cross-cutting:  audit_event · event_outbox · delivery_log
                   idempotency_key · request_nonce · schema_migration
```

---

## 3. Products and tenancy

### `product` — the tenant root

One row per integrating product. **This is the platform tenant**, and the primary security boundary.

| Column | Type | Notes |
|---|---|---|
| `id` | `text` PK | `prod_carbon` |
| `slug` | `text` UNIQUE | `carbon` |
| `name` | `text` | Display name |
| `ref_prefix` | `text` **unique** | `CARB` → ticket `CARB-1042`. **Per-product, never a global sequence** — a global counter leaks cross-tenant volume to anyone who sees two references. Unique since `011`: the sequence restarts per product, so two tenants sharing a prefix would make `CARB-1042` name two different tickets, and the ambiguity is unrepairable once references are quoted in email |
| `ticket_seq` | `integer` | Reference counter, incremented atomically on raise |
| `client_id` | `text` UNIQUE | Server credential id |
| `client_secret_hash` | `text` | SHA-256, for cheap equality checks |
| `client_secret_enc` | `text` | **AES-256-GCM ciphertext.** HMAC is *symmetric* — verifying an inbound signature needs the secret itself, which a hash cannot give back. Hashing alone was the wrong primitive |
| `publishable_key` | `text` UNIQUE | `pub_live_…` — public by design, low privilege |
| `webhook_url` / `webhook_secret_hash` / `webhook_secret_enc` | `text` | Outbound webhooks |
| `access_callback_url` | `text` | Where grant/revoke callbacks are POSTed |
| `access_mechanism` | `text` | `callback` \| `preauth` \| `both` — see [ADR-008](adr/008-dual-access-mechanism.md) |
| `jwks_url` | `text` | For verifying the product's identity JWTs |
| `jwks_inline` | `jsonb` | A statically registered JWK, so an integrator need not run a JWKS endpoint |
| `allowed_issuers` | `text[]` | Accepted JWT `iss` values |
| `allowed_origins` | `text[]` | Origin allowlist for the widget. `['*']` is local dev only |
| `api_version_pin` | `text` | `v1` — shipping v2 cannot move an existing integration |
| `config` | `jsonb` | Everything tunable without a deploy — see below |
| `is_active` | `boolean` | |
| `created_at` | `timestamptz` | |

**`config` jsonb** — categories, severities, default severity, business calendar, routing rules, `widget` (title, subtitle, greeting, colours, enabled capabilities, suggestions, field visibility, anonymous raise), `knowledge_base`, `deflection` (min score, max suggestions), `access` (max TTL, scope kind), `ai_thresholds`, `assignee_weights`, `auto_close_days`.

> Editing `config` changes a live integration **with no redeploy on the product's side**. That is what makes the zero-code tier literal rather than marketing.

**RLS** — `id = ANY(app_scope()) OR app_role() = 'super_admin'`. Writes restricted to admins; `ticket_seq` is separately grantable so the runtime can allocate references without full write access.

---

## 4. Support users and access

### `support_user` — platform-native staff identity

Support users are **never** sourced from integrating products.

| Column | Type | Notes |
|---|---|---|
| `id` | `text` PK | `su_01JQZ…` |
| `email` | `text` UNIQUE | Login identity |
| `display_name` | `text` | |
| `password_hash` | `text` | `scrypt$N$r$p$salt$hash`. Memory-hard, standard library, parameters travel with the hash so they can be raised later without invalidating existing passwords |
| `role` | `text` | `super_admin` \| `product_admin` \| `manager` \| `agent` |
| `availability` | `text` | `available` \| `busy` \| `away` — feeds assignee scoring and lets an agent mute themselves |
| `is_active` | `boolean` | |
| `must_change_password` | `boolean` | Set on admin-created accounts |
| `failed_login_count` | `integer` | |
| `locked_until` | `timestamptz` | 10 consecutive failures → 15-minute lock. **This, not the per-IP rate limit, is the real credential-stuffing defence** |
| `last_login_at` | `timestamptz` | |

> **Zero standing access to ticket payloads.** A role says *what* a user may do; it does not by itself open ticket data. That requires an `access_grant` (§6).

### `support_user_scope` — the tenant-wise assignment ⭐

**This is the table that makes the platform multi-tenant on the support side.** One row = "this user may work tickets for this product."

| Column | Type | Notes |
|---|---|---|
| `support_user_id` | `text` PK/FK | |
| `product_id` | `text` PK/FK | |
| `product_tenant_id` | `text` | Optional narrowing to one customer tenant inside the product. NULL = the whole product |
| `granted_at` / `granted_by` | | Audit of who granted access |

> **A `super_admin` has NO rows here**, and that absence means *all tenants*. It is resolved as a policy branch rather than stored as a wildcard row, so there is no magic value to leak or mistype.

**RLS** — a `super_admin` sees everything; a `product_admin`/`manager` sees only scope rows for tenants they themselves hold (they cannot enumerate another tenant's staffing); anyone may read their own.

### `support_user_skill`

`(support_user_id, skill, proficiency 1–5)`. An explicit, **human-editable** domain signal alongside the learned embedding similarity — which is what makes an assignee suggestion trustworthy rather than a black box.

---

## 5. Tickets

### `ticket`

| Column | Type | Notes |
|---|---|---|
| `id` | `text` PK | `tkt_01JQZ…` |
| `product_id` | `text` FK | Tenant |
| `reference` | `text` | `CARB-1042`, UNIQUE per product |
| `product_tenant_id` | `text` | The product's own customer — **opaque to us**, we record but never authenticate it |
| `raised_by_ref` | `text` | The end user's opaque `sub`. Keyed on `(product, iss, sub)`, **never email** — emails change and are not unique across a product's customers |
| `raiser_identity` | `jsonb` | **Snapshot** of name/email/tenant at raise time. This is what lets existing tickets stay viewable and workable when the product's IdP is down (ADR-003) |
| `identity_assurance` | `text` | `sso` \| `email_verified` \| `anonymous` |
| `subject`, `description` | `text` | |
| `category`, `severity` | `text` | `severity` is the stored name. The admin UI labels the column "Priority" — a display mapping only, never a second field |
| `status` | `text` | `open` \| `assigned` \| `in_progress` \| `waiting_on_raiser` \| `resolved` \| `closed` |
| `classification_source` | `text` | `product` \| `ai_auto` \| `ai_uncertain` \| `unclassified` |
| `ai_classification` | `jsonb` | Both probabilities + margin + model version, so every misclassification stays explainable after a model swap |
| `summary` | `text` | One-line queue summary |
| `assignee_id` | `text` FK | |
| `conversation_id` | `text` | Links back to the widget conversation that produced it |
| `rating`, `rating_comment` | | 1–5 ★ |
| `embedding` | `vector(384)` | Column exists; populated when `ai-service` is built |
| `metadata` | `jsonb` | Opaque product data, echoed back |
| `raised_at` | `timestamptz` | |
| `first_response_at` | `timestamptz` | **First non-internal comment by a support user.** Locked definition — anything looser makes every TAT number arguable (ADR-006) |
| `assigned_at`, `resolved_at`, `closed_at`, `updated_at` | | |
| `search_tsv` | `tsvector` GENERATED | `subject + description`, backs full-text search |

**Indexes** — all lead with `product_id`: `(product_id, raised_at DESC)`, `(product_id, status)`, `(product_id, raised_by_ref, raised_at DESC)`, `(product_id, updated_at DESC)`, plus a GIN index on `search_tsv`.

**RLS** — product scope, **and** for `role = 'raiser'` additionally `raised_by_ref = app_raiser()`. A widget user can only ever see their own tickets, enforced by the database rather than an application check. That is why a scraped publishable key is a nuisance and not a breach.

### `comment`

`author_type` ∈ `raiser` \| `assignee` \| `system`; `is_internal boolean`.

**RLS is tiered:**

| Role | Sees |
|---|---|
| `super_admin`, `product_admin`, `manager` | All comments in scope |
| `agent` | **Only with an active platform `access_grant` on that ticket** |
| `product`, `raiser` | Non-internal only; a raiser additionally only on their own tickets |

> `is_internal` is filtered **at the database**, not just in the API layer. Filtering it only in application code is how an internal note eventually reaches a customer.

### `attachment`

`blob_key`, `filename`, `content_type`, `size_bytes`, `scan_status`. Content lives on disk locally (S3/Azure Blob behind the same adapter in production).

> SVG and HTML are blocked at upload, and every download is served `Content-Disposition: attachment` from a separate origin. An SVG rendered inline in an authenticated admin session is stored XSS — a full platform compromise delivered through a mandated feature.

---

## 6. Access grants — the differentiator

Support users hold **zero standing access**. Assignment grants on two layers; resolve revokes both.

### `access_grant`

**One assignment writes TWO rows.**

| Column | Type | Notes |
|---|---|---|
| `id` | `text` PK | `grt_01JQZ…` |
| `product_id`, `ticket_id`, `support_user_id` | FK | |
| `layer` | `text` | `platform` \| `product` |
| `mechanism` | `text` | `rls` \| `callback` \| `preauth_link` |
| `scope_kind`, `resource_ref` | `text` | **Chosen by the product**, never invented by us |
| `state` | `text` | `grant_pending` \| `granted` \| `revoke_pending` \| `revoked` \| `grant_failed` \| `revoke_failed` |
| `granted_at`, `expires_at`, `revoke_due_at`, `revoked_at` | | `expires_at = min(SLA target, product max_ttl, 72h)` |
| `product_grant_ref` | `text` | The product's own handle, returned by its callback |
| `activation_response`, `revoke_response` | `jsonb` | **The product's actual response bodies** — this is what the Ticket Detail timeline renders |
| `attempt_count`, `last_error` | | Retry state |

| Layer | Mechanism | Enforcement |
|---|---|---|
| **T1 `platform`** | `rls` | Synchronous, in the same transaction as the assignment. No network, no callback, no trust gap — we enforce our own data directly |
| **T2 `product`** | `callback` or `preauth_link` | Asynchronous. We do **not** own the product's permission model; we signal it |

**Hot-path index** — `(support_user_id, ticket_id, state) WHERE state = 'granted'`. Every comment and attachment read hits this through `has_active_grant()`.

### `preauth_token`

The client-minted capability ([ADR-008](adr/008-dual-access-mechanism.md) mechanism B). The product mints it at raise time and it arrives **inert** — bound to nobody, usable by nobody. The platform can only *bind it to an assignee and time-box it*.

> **We never hold the product's signing key.** So even a fully compromised platform cannot fabricate access into that product — it can only replay a capability the product already minted, scoped, and still validates. A signed-callback design cannot make that claim.

`token_ciphertext` is encrypted at rest and never logged or returned by any API.

### `delivery_log`

Every outbound attempt — webhooks and access callbacks: `attempt`, `status_code`, `ok`, `response_body`, `error`, `latency_ms`.

This is the ledger that answers *"did the product actually receive the revoke?"*

---

## 7. Widget and knowledge base

### `kb_article`

`title`, `body`, `category`, `status` (`draft`\|`published`), `is_public`, `views`, `helpful_yes/no`, `embedding vector(384)`.

`search_tsv` is a **weighted** generated column — `setweight(title,'A') || setweight(body,'B')` — so a title match outranks a passing body mention. Indexed with GIN plus a trigram index on `title` for short or typo'd queries.

**RLS** — staff see drafts; products and raisers see only `status='published' AND is_public`.

### `widget_conversation` — the Self-Served metric

| Column | Notes |
|---|---|
| `turns` | `jsonb` array of question/answer turns |
| `outcome` | `self_served` \| `ticket_created` \| `abandoned` |
| `ticket_id` | Set when a conversation escalates |

> **`outcome='self_served'` means no ticket was ever created.** This table counts conversations, never tickets. Deflection is not auto-resolution — see [ADR-009](adr/009-deflection-is-not-auto-resolution.md). The dashboard metric is labelled "Self-Served" for exactly this reason.

### `announcement`

`title`, `body`, `kind` (`info`\|`maintenance`\|`incident`\|`release`), `is_active`.

---

## 8. Audit and events

### `audit_event` — append-only, enforced by the database

| Column | Notes |
|---|---|
| `actor_type` | `raiser` \| `support_user` \| `product` \| `system` \| `automation` |
| `actor_ref`, `action`, `entity_type`, `entity_id` | |
| `before`, `after` | `jsonb` |
| `request_id`, `source_ip`, `occurred_at` | |

```sql
REVOKE UPDATE, DELETE ON audit_event FROM iris_app;
```

> The application **cannot rewrite history**, even if fully compromised. Compliance-grade by construction rather than by policy. Every state change writes its audit row *in the same transaction* as the change itself.

### `event_outbox` — the transactional outbox

Written in the **same transaction** as the state change it describes.

> **Never enqueue after `COMMIT`.** If the process or the broker dies in between, the job is lost forever — and a lost `access.revoke` means access outlives its ticket, silently. That is a two-phase-commit failure, not a crypto failure, and it is how this feature actually breaks in production.

`next_attempt_at` and `attempt_count` drive the `1s → 5s → 25s → 2m → 10m` backoff before dead-lettering.

### `idempotency_key`

`(product_id, key)` → stored response, 24h. A retried `POST /v1/tickets` on a flaky mobile network would otherwise create a duplicate a human then has to merge.

### `request_nonce`

HMAC replay defence when Redis is unavailable.

### `schema_migration`

Applied filenames. Forward-only; migrations are never edited after being committed.

### RLS coverage

**16 of 18 tables have RLS enabled and forced.** The two without it hold no tenant data by design:

| Table | No RLS because |
|---|---|
| `request_nonce` | An opaque random string with no product association |
| `schema_migration` | A list of filenames |

> Writing this document meant auditing every table's RLS status against the live database rather than against the design. That found two tables carrying scoped data with **no policy at all** — `idempotency_key` (which stores response bodies keyed by product) and `support_user_skill`. Neither was reachable through any current code path, but "unreachable today" is how a gap survives long enough to become reachable tomorrow. Both were fixed in `010_close_rls_gaps.sql`.

---

## 9. Designed but not yet migrated

Specified in [HLD.md §8](HLD.md) and **deliberately not created** — nothing depends on them yet, and an unused table is a liability:

| Table | Waiting on | Purpose |
|---|---|---|
| `queue` | Routing rules | `(category, severity, tenant)` → queue → support users |
| `sla_clock` | Analytics page | Accumulated business-time plus every pause/run segment, so any TAT number is reconstructable and auditable |
| `automation_rule` | Automations page | Fixed catalogue of trigger→action rules ([ADR-010](adr/010-automations-fixed-catalogue.md)) |

---

## 10. Migration history

| File | Adds |
|---|---|
| `001_extensions_and_roles.sql` | `vector`, `pg_trgm`, `pgcrypto`; the non-owner `iris_app` role |
| `002_core_tables.sql` | `product`, `support_user`, `support_user_skill`, `ticket`, `comment`, `attachment` |
| `003_kb_and_widget.sql` | `kb_article`, `announcement`, `widget_conversation` |
| `004_audit_and_events.sql` | `audit_event`, `event_outbox`, `idempotency_key`, `request_nonce`, `schema_migration` |
| `005_rls.sql` | Helper functions and every isolation policy |
| `006_grants.sql` | `iris_app` privileges; **revokes UPDATE/DELETE on `audit_event`** |
| `007_admin_auth_and_scopes.sql` | **`support_user_scope`**, auth columns, encrypted secret columns |
| `008_access_grants.sql` | `access_grant`, `preauth_token`, `delivery_log`; **tightens comment/attachment RLS to require a grant** |
| `009_outbox_retry.sql` | `next_attempt_at`, `attempt_count` for backoff |
| `010_close_rls_gaps.sql` | RLS on `idempotency_key` and `support_user_skill` — gaps found auditing the live schema while writing this document |
| `011_tenant_ref_prefix_unique.sql` | `UNIQUE (ref_prefix)` on `product` — the admin portal would otherwise onboard a second tenant with an existing ticket prefix |

## 11. Verifying isolation yourself

```bash
podman exec -it iris-postgres psql -U iris_app -d iris
```

```sql
-- No scope set: fails closed.
SELECT count(*) FROM ticket;                       -- 0

BEGIN;
SELECT set_config('app.product_scope','prod_carbon',true),
       set_config('app.role','product',true);
SELECT count(*) FROM ticket;                       -- 40
COMMIT;

-- Scoped to another tenant: Carbon's rows are invisible, not forbidden.
BEGIN;
SELECT set_config('app.product_scope','prod_esg',true),
       set_config('app.role','product',true);
SELECT count(*) FROM ticket WHERE product_id = 'prod_carbon';   -- 0
COMMIT;

-- A raiser sees only their own.
BEGIN;
SELECT set_config('app.product_scope','prod_carbon',true),
       set_config('app.role','raiser',true),
       set_config('app.raiser_ref','usr_seed_1',true);
SELECT count(DISTINCT raised_by_ref) FROM ticket;  -- 1
COMMIT;

-- History cannot be rewritten.
DELETE FROM audit_event;                           -- ERROR: permission denied
```

`npm run test:security` asserts all of the above automatically.

---

<div align="center"><sub>Powered by Elevate - X.</sub></div>
