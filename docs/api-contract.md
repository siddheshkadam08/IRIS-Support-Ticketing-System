# IRIS Ticketing Platform — Integration API Contract v1

| | |
|---|---|
| **Base URL** | `https://support.iris.example` (demo: `http://localhost:4000`) |
| **Version** | `v1` — pinned in the URL path |
| **Transport** | HTTPS only. TLS 1.2+. Plain HTTP is refused, not redirected, on `/v1/*` |
| **Content type** | `application/json; charset=utf-8` (except attachment upload) |
| **Machine-readable spec** | [`shared/contracts/openapi/`](../shared/contracts/openapi/) |
| **Companion** | [HLD.md](HLD.md) · [demo-script.md](demo-script.md) |

> This is the platform's **only** external surface. The brief calls the integration contract *"the single most important design decision in the build."* Everything an integrating product can do, it does here.

---

## 1. The contract decision, defended

**Chosen: REST/JSON over HTTPS + outbound webhooks, versioned by URL path, authenticated with per-product HMAC credentials.**

| Option | Verdict | Reasoning |
|---|---|---|
| **REST + webhooks** | ✅ **Chosen** | Lowest integration cost across the widest set of products — every language has an HTTP client and every developer already knows the idiom. Trivial to stub, log, curl, and replay. Webhooks push state changes without the product polling. It is also the only option that makes the zero-code tier honest: the widget is just a REST client. |
| **GraphQL** | ❌ Rejected as the boundary | Imposes schema and runtime burden on *every* integrator for a small, stable operation set (six endpoints). Versioning for external consumers is harder, not easier — field deprecation across N unknown clients is worse than a URL major bump. Perfectly fine internally; wrong at a public boundary meant for low-effort adoption. |
| **Signed event bus** (Kafka/NATS) | ❌ Rejected as the boundary | Forces every integrating product to run a consumer, manage offsets, and handle rebalancing. That raises the integration floor above "paste a script tag," which breaks the zero/low-code goal outright. Used *internally* for fan-out (BullMQ), never exposed. |

**Consequence:** a product can complete a full integration with `curl`, and can debug it with server logs. That property is worth more than any elegance we would gain elsewhere.

---

## 2. Conventions

### 2.1 Integration tiers

| Tier | Product writes | Gets |
|---|---|---|
| **Zero-code** | One `<script>` tag | Raise ticket, confirmation + reference, branded widget, platform-sent notifications |
| **Low-code** | Script tag + a webhook URL + (optionally) mint a pre-auth grant at raise | Everything above + webhook state events + **runtime scoped support access** |
| **Full-code** | Script tag + backend REST + an access callback endpoint | Everything above + push-based grant/revoke + deep automation |

Each tier is **additive and self-contained** — adopting a higher tier never requires rewriting the lower one.

### 2.2 Identifiers

| Prefix | Meaning | Example |
|---|---|---|
| `tkt_` | Ticket (platform id, ULID) | `tkt_01JQZ7YB3KX8M2N4P6R8T0V2W4` |
| `cmt_` | Comment | `cmt_01JQZ7YC5M...` |
| `grt_` | Access grant | `grt_01JQZ7YD7N...` |
| `su_` | Support user | `su_01JQZ7YE9P...` |
| `evt_` | Webhook event | `evt_01JQZ8X4M2...` |
| `req_` | Request id | `req_01JQZ8X5N3...` |
| `att_` | Attachment | `att_01JQZ8Y6Q4...` |
| `kb_` | Knowledge base article | `kb_01JQZ8Z7R5...` |
| `cnv_` | Widget conversation (§5.8) | `cnv_01JQZ9A8S6...` |
| `aut_` | Automation rule (admin surface, §11) | `aut_01JQZ9B9T7...` |
| *(reference)* | Human-readable ticket ref, shown to end users | `CARB-1042` |

Both `tkt_…` and the human reference resolve on `GET /v1/tickets/{id}`.

Ticket references are **per-product** (`CARB-1042`, `EDU-2087`), never a global sequence — a global counter leaks cross-product volume to any customer who can see two references.

### 2.3 Standard headers

**Request:**

| Header | Required | Purpose |
|---|---|---|
| `X-IRIS-Key` | ✅ | Your `client_id` |
| `X-IRIS-Timestamp` | ✅ | Unix seconds. Must be within ±300 s of platform time |
| `X-IRIS-Nonce` | ✅ | UUIDv4, unique per request. Cached 600 s |
| `X-IRIS-Signature` | ✅ | `v1=<hex>` — see §3 |
| `X-IRIS-Identity` | conditional | The end-user JWT (§4). Required when acting on behalf of a raiser |
| `Idempotency-Key` | recommended | On all `POST`. See §2.6 |
| `X-Request-Id` | optional | Your correlation id; echoed back and stamped into our audit trail |

**Response:**

| Header | Always | Purpose |
|---|---|---|
| `X-Request-Id` | ✅ | Quote this in any support conversation — it reconstructs the full cross-service trace |
| `X-RateLimit-Limit` / `-Remaining` / `-Reset` | ✅ | §2.7 |
| `Retry-After` | on `429` / `503` | Seconds |

### 2.4 Error envelope

Every non-2xx response, without exception, has this exact shape. No bare strings, no HTML error pages.

```json
{
  "error": {
    "code": "ticket_not_found",
    "message": "No ticket with that identifier is visible to this credential.",
    "request_id": "req_01JQZ8X5N3",
    "details": {}
  }
}
```

`code` is a stable machine-readable string — **branch on `code`, never on `message`.** Messages are for humans and may be reworded without a version bump.

### 2.5 Error code catalogue

| HTTP | `code` | Meaning |
|---|---|---|
| 400 | `invalid_request` | Malformed JSON or failed schema validation. `details.fields[]` lists offenders |
| 400 | `unsupported_category` | Category not enabled for this product |
| 401 | `signature_invalid` | HMAC mismatch. Check §3 canonicalisation |
| 401 | `timestamp_out_of_window` | Clock skew > 300 s. **Sync your NTP** |
| 401 | `nonce_replayed` | This nonce was already used |
| 401 | `identity_token_invalid` | JWT signature, `iss`, `aud`, or expiry failed |
| 401 | `identity_provider_unreachable` | Could not fetch the product's JWKS. Existing tickets still readable (see §4.4) |
| 403 | `credential_scope_exceeded` | Publishable key attempted a non-permitted operation |
| 403 | `origin_not_allowed` | `Origin` not in the product's allowlist |
| 404 | `ticket_not_found` | Not found **or not visible to this credential** — deliberately indistinguishable |
| 409 | `invalid_state_transition` | e.g. `open → resolved`. `details.allowed[]` lists legal targets |
| 409 | `idempotency_key_reuse` | Same key, different payload |
| 413 | `attachment_too_large` | > 25 MB |
| 415 | `attachment_type_not_allowed` | Content type not on the allowlist (§7.2) |
| 422 | `preauth_grant_invalid` | Pre-auth grant object failed validation |
| 429 | `rate_limited` | See `Retry-After` |
| 403 | `knowledge_base_disabled` | KB is not enabled for this product (§5.9) |
| 500 | `internal_error` | Ours. `request_id` is the handle |
| 503 | `service_unavailable` | Dependency down. Retry with backoff |
| 503 | `deflection_unavailable` | The AI service is unavailable (§5.8). **Ticket creation is unaffected** — fall back to `POST /v1/tickets` |

> **Why `404` and not `403` for a cross-product read:** returning `403` confirms the ticket *exists*, leaking that another product has a ticket with that id. `404` for both "absent" and "not yours" leaks nothing. This is demonstrated live in the security segment of the demo.

### 2.6 Idempotency

Send `Idempotency-Key: <uuid>` on every `POST`. We store `(product_id, key) → response` for **24 hours**.

- Same key + same payload → the **original** response is replayed, with the original status code.
- Same key + different payload → `409 idempotency_key_reuse`.

This matters more than it looks: the widget runs on flaky client networks, and a retried `POST /v1/tickets` without an idempotency key creates a duplicate ticket that a human then has to merge.

### 2.7 Rate limits

Token bucket, per product, per bucket class. Exceeding returns `429` with `Retry-After`.

| Bucket | Default limit | Burst |
|---|---|---|
| `/v1/*` overall (server credential) | 600 req / min | 100 |
| `POST /v1/tickets` (server credential) | 60 / min | 20 |
| Publishable key (widget), per `(product, IP)` | 20 / 10 min | 5 |
| Publishable key, per `(product, raiser sub)` | 5 / min | 3 |
| `POST /v1/widget/ask`, per `(product, raiser sub)` | 10 / min | 3 |
| `GET` endpoints | 1200 / min | 200 |

`/v1/widget/ask` gets its own tighter bucket because it triggers model inference — it is materially more expensive than a ticket write, and it is reachable with a scrapeable publishable key.

Limits are per-product configuration and are raised on request.

### 2.8 Pagination

Cursor-based — offset pagination drifts when rows are inserted mid-scan, which is constant here.

```
GET /v1/tickets?limit=50&cursor=eyJyIjoiMjAyNi0wMy0yNlQwOTowMDowMFoifQ
```

```json
{ "data": [ ... ], "next_cursor": "eyJyIjoiMjAy...", "has_more": true }
```

`limit` max 200, default 50. When `has_more` is `false`, `next_cursor` is `null`.

---

## 3. Authentication: product → platform (HMAC-SHA256)

Per-product `client_id` + `client_secret`, issued at onboarding. **The secret never travels on the wire** — it signs requests, it is not transmitted. We store only an Argon2id hash of it. The same secret verifies our webhooks to you (§6.3).

### 3.1 Canonical string

Join these six lines with `\n` (LF, `0x0A`) — no trailing newline:

```
v1
{HTTP_METHOD}                 uppercase, e.g. POST
{PATH_WITH_QUERY}             exactly as sent, e.g. /v1/tickets?limit=50
{X-IRIS-Timestamp}            unix seconds
{X-IRIS-Nonce}                uuid v4
{sha256_hex(raw_request_body)} lowercase hex; sha256("") for GET/DELETE
```

Then `signature = hex(hmac_sha256(client_secret, canonical_string))`, sent as `X-IRIS-Signature: v1=<signature>`.

**Design notes:** we hash the body rather than signing it directly so large uploads stream and encoding never matters. Method and path are inside the signature, so a captured request **cannot be replayed against a different endpoint**.

### 3.2 Verification (platform side)

1. `client_id` exists and is active.
2. `|now − timestamp| ≤ 300 s` → else `timestamp_out_of_window`.
3. Nonce unseen in Redis (`SET NX EX 600`) → else `nonce_replayed`.
4. Recompute and compare in **constant time** (`crypto.timingSafeEqual`) → else `signature_invalid`.

### 3.3 Verifiable test vector

Implement against this and self-check before you call us. These values are real, not illustrative.

```
client_secret = sk_test_51H9xQmKvB2nRtYwLpZaCdEfG
method        = POST
path          = /v1/tickets
timestamp     = 1774483200
nonce         = 5f2b8c1a-9d3e-4a7b-8c6f-2e1d0a9b8c7d
body          = {"product_tenant_id":"acme-corp","description":"Cannot export the Q3 emissions report — the download button returns a 500.","category":"bug","severity":"high"}
                (161 bytes UTF-8)
```

```
sha256(body) = 3211c39bfe24338cf01e34cd42b53c72c62867f7fe1d6fca3010668655847058

canonical    = "v1\nPOST\n/v1/tickets\n1774483200\n5f2b8c1a-9d3e-4a7b-8c6f-2e1d0a9b8c7d\n3211c39bfe24338cf01e34cd42b53c72c62867f7fe1d6fca3010668655847058"

SIGNATURE    = 194eb588b7ad9e06cc477a5de3df4c06ae875d3c558dfa70d6465d65e1a293fb
```

<details>
<summary>Reference implementation — Node</summary>

```js
const crypto = require('crypto');

function sign({ secret, method, path, timestamp, nonce, body }) {
  const bodyHash = crypto.createHash('sha256').update(body ?? '', 'utf8').digest('hex');
  const canonical = ['v1', method.toUpperCase(), path, String(timestamp), nonce, bodyHash].join('\n');
  return crypto.createHmac('sha256', secret).update(canonical, 'utf8').digest('hex');
}
```
</details>

<details>
<summary>Reference implementation — Python</summary>

```python
import hashlib, hmac

def sign(secret: str, method: str, path: str, timestamp: int, nonce: str, body: str = "") -> str:
    body_hash = hashlib.sha256(body.encode()).hexdigest()
    canonical = "\n".join(["v1", method.upper(), path, str(timestamp), nonce, body_hash])
    return hmac.new(secret.encode(), canonical.encode(), hashlib.sha256).hexdigest()
```
</details>

Both live in [`shared/hmac-utils/`](../shared/hmac-utils/) and are the same code the gateway and the sample products use — so a divergence is a failing test, not a mystery.

### 3.4 Publishable keys (widget only)

The widget runs in a browser and **cannot hold a secret** — anything shipped to the page is public. So it carries a `pub_live_…` publishable key instead, which is deliberately low-privilege.

**Permits exactly four operations, all scoped to the bearer of the accompanying identity JWT:**

| Operation | Endpoint |
|---|---|
| Create a ticket | `POST /v1/tickets` |
| Read own tickets | `GET /v1/tickets`, `GET /v1/tickets/{id}` — **only** tickets raised by this identity |
| Ask a question / deflect | `POST /v1/widget/ask` (§5.8) |
| Search the knowledge base | `GET /v1/kb/articles` (§5.9) |

Plus `GET /v1/widget/config` for bootstrap.

- Enforced against the product's **origin allowlist**.
- Rate-limited far more tightly than a server credential (§2.7).
- **Cannot** list another raiser's tickets, change status, assign, read internal comments, access grants, or touch any configuration.

Any other endpoint returns `403 credential_scope_exceeded`.

A leaked publishable key is a nuisance (rate-limited spam), not a breach. That is the design intent, and it is why the key is never load-bearing.

---

## 4. Identity handoff: end user → platform (signed JWT)

The platform does not own end-user accounts. Your product already authenticated the user; it asserts that identity to us with a short-lived signed JWT.

### 4.1 Token requirements

| Claim | Required | Notes |
|---|---|---|
| `iss` | ✅ | Must match a registered issuer for your product |
| `aud` | ✅ | `"iris-ticketing"` |
| `sub` | ✅ | **Opaque, stable, immutable** product user id. Not an email |
| `iat` / `exp` | ✅ | `exp − iat ≤ 300 s`. Short-lived by contract |
| `jti` | ✅ | Unique; replay-cached for the token's lifetime |
| `product_tenant_id` | ✅ | Your customer tenant — the second tenancy layer |
| `name` / `email` | recommended | Cached onto the ticket (§4.4) |
| `email_verified` | optional | Affects `identity_assurance` |

Signed **RS256 or ES256**, with `kid` in the header. Symmetric algorithms are rejected — `alg: none` and `HS256` confusion are the two classic JWT breaks, so the platform accepts asymmetric only.

We verify against your published **JWKS URL**, cached per `Cache-Control` and refetched on an unknown `kid` (rate-limited to prevent a JWKS-flood DoS).

### 4.2 Identity mapping rule

The raiser is keyed on **`(product_id, iss, sub)`** — never on email. Emails change, and they are not guaranteed unique across your customer tenants. The tuple is immutable and owned by you, which makes the mapping reliable and consistent across every ticket that user ever raises.

### 4.3 Usage

```
POST /v1/tickets
X-IRIS-Key: ...
X-IRIS-Identity: eyJhbGciOiJSUzI1NiIsImtpZCI6...
```

### 4.4 What happens when your IdP goes down

Explicitly designed for, because the brief asks:

At raise time we **snapshot the raiser's identity onto the ticket** (`raiser_identity`: name, email, tenant, display refs). Therefore:

| | Behaviour during a full IdP outage |
|---|---|
| Existing tickets — viewable by support? | ✅ Yes. Fully. We depend on your IdP only at the instant of raise, never afterwards |
| Existing tickets — workable (comments, resolve)? | ✅ Yes |
| Existing tickets — viewable by the raiser? | ✅ Yes, if they still hold a valid session token; otherwise blocked until the IdP returns |
| **New** SSO raises | ❌ Blocked — we cannot verify who is asking |
| Break-glass for new raises | Optional per-product **email-verified raise** (magic link). **Off by default** — it is a weaker assertion, so it must be a conscious choice. Such tickets are flagged `identity_assurance: "email_verified"` so support can see the difference |

---

## 5. Endpoints

### 5.1 `POST /v1/tickets` — raise a ticket

```jsonc
// Request
{
  "product_tenant_id": "acme-corp",              // required — your customer
  "description": "Cannot export the Q3 emissions report — the download button returns a 500.",
  "subject": "Q3 export fails",                  // optional
  "category": "bug",                             // optional — AI classifies if omitted
  "severity": "high",                            // optional — AI classifies if omitted
  "attachments": ["att_01JQZ7..."],              // optional — pre-uploaded (§7)
  "metadata": { "app_version": "4.2.1", "page": "/reports/emissions" },  // opaque, echoed back
  "preauth_grant": {                             // optional — low-code T2 access (§8)
    "token": "eyJhbGciOiJFUzI1NiJ9.<product-signed opaque capability>",
    "scope_kind": "dataset",
    "resource_ref": "carbon:report:8842",
    "max_ttl_seconds": 86400,
    "launch_url_template": "https://carbon.example.com/support-access?grant={token}&actor={actor_ref}"
  }
}
```

```jsonc
// 201 Created
{
  "id": "tkt_01JQZ7YB3KX8M2N4P6R8T0V2W4",
  "reference": "CARB-1042",
  "status": "open",
  "product_tenant_id": "acme-corp",
  "raised_by": { "ref": "usr_9f21", "name": "Priya Nair", "email": "priya@acme.example" },
  "identity_assurance": "sso",
  "category": "bug",
  "severity": "high",
  "classification_source": "product",            // "product" | "ai_auto" | "ai_uncertain" | "unclassified"
  "summary": null,                               // populated asynchronously
  "raised_at": "2026-03-26T08:14:22Z",
  "sla": { "target_seconds": 14400, "due_at": "2026-03-26T14:14:22Z" },
  "preauth_grant": { "state": "inert" },
  "_links": { "self": "/v1/tickets/tkt_01JQZ7YB3K", "history": "/v1/tickets/tkt_01JQZ7YB3K/history" }
}
```

**Note the async boundary:** the response returns in < 300 ms and does **not** wait for AI. `summary` is `null` and `classification_source` may be `unclassified` at this instant; both are filled within ~10 s and announced via the `ticket.classified` webhook. If `category`/`severity` were supplied by you, they are authoritative and AI does not override them.

### 5.2 `GET /v1/tickets/{id}` — retrieve

Accepts either `tkt_…` or the human reference (`CARB-1042`). Returns the full ticket including `comments[]`, `attachments[]`, `assignee` (id + display name only — never the support user's internal record), `ratings`, and SLA state. Comments with `is_internal: true` are **never** included in any product-facing response.

### 5.3 `GET /v1/tickets` — list and filter

| Param | Example | Notes |
|---|---|---|
| `status` | `open,assigned` | CSV |
| `product_tenant_id` | `acme-corp` | |
| `category` / `severity` | `bug` / `high,critical` | CSV |
| `raised_by` | `usr_9f21` | Your `sub` |
| `raised_after` / `raised_before` | RFC 3339 | |
| `updated_after` | RFC 3339 | **Use this for incremental sync / webhook gap recovery** |
| `sort` | `-raised_at` | Default `-raised_at` |
| `limit` / `cursor` | | §2.8 |

Results are always scoped to the calling product. There is no parameter that widens scope — cross-product visibility exists only inside the admin portal, for authorised support users.

### 5.4 `POST /v1/tickets/{id}/comments` — add a comment

```jsonc
{ "body": "I've attached the failing request id: req_01JQZ8X5N3.", "attachments": ["att_01JQZ8..."] }
```

Author is derived from `X-IRIS-Identity` when present (author_type `raiser`), otherwise the product credential acts as `system`. Products **cannot** create `is_internal` comments — internal notes are a support-side concept and are never writable or readable across the boundary.

### 5.5 `PATCH /v1/tickets/{id}/status` — change status

```jsonc
{ "status": "closed", "reason": "Confirmed fixed in 4.2.2" }
```

Guarded by the state machine. Illegal transitions return `409 invalid_state_transition` with the legal set:

```json
{ "error": { "code": "invalid_state_transition", "message": "Cannot move from 'open' to 'resolved'.",
             "request_id": "req_...", "details": { "from": "open", "allowed": ["assigned", "closed"] } } }
```

Transitions available to a **product** credential are deliberately narrow: `reopen` and `close`. Assignment, `in_progress`, and `resolve` are support-side actions — a product cannot mark its own ticket resolved.

### 5.6 `GET /v1/tickets/{id}/history` — full timeline

Chronological merge of state transitions, comments, attachments, and **access grant/revoke events with the product's own responses**. This is the endpoint that makes the audit trail externally verifiable, not just internally logged.

```jsonc
{
  "data": [
    { "at": "2026-03-26T08:14:22Z", "type": "ticket.created",  "actor": { "type": "raiser", "ref": "usr_9f21" } },
    { "at": "2026-03-26T08:14:31Z", "type": "ticket.classified","actor": { "type": "system", "ref": "ai-service" },
      "detail": { "category": "bug", "severity": "high", "p1": 0.91, "margin": 0.44, "decision": "auto_route" } },
    { "at": "2026-03-26T09:02:10Z", "type": "ticket.assigned",  "actor": { "type": "support_user", "ref": "su_01JQ" } },
    { "at": "2026-03-26T09:02:11Z", "type": "access.granted",   "detail": { "grant_id": "grt_01JQ", "layer": "product",
      "mechanism": "callback", "scope": { "kind": "dataset", "resource_ref": "carbon:report:8842" },
      "expires_at": "2026-03-26T14:14:22Z", "product_response": { "status": "granted", "product_grant_ref": "carbon-grant-771" } } },
    { "at": "2026-03-26T11:40:03Z", "type": "ticket.resolved",  "actor": { "type": "support_user", "ref": "su_01JQ" } },
    { "at": "2026-03-26T11:40:04Z", "type": "access.revoked",   "detail": { "grant_id": "grt_01JQ",
      "product_response": { "status": "revoked" }, "latency_ms": 412 } }
  ]
}
```

### 5.7 `GET /v1/widget/config` — widget bootstrap

Authenticated by publishable key + `Origin`. Returns the server-side widget definition: visible fields, categories, severities, defaults, branding (logo, primary colour, corner radius), locale, which capabilities are enabled, and whether anonymous raise is permitted. **This is what makes zero-code true** — a product changes its widget by editing config in the admin portal, with no redeploy on its side.

### 5.8 `POST /v1/widget/ask` — ask a question (deflection)

Retrieval over the product's knowledge base and its **resolved** tickets, returning candidate answers before a ticket is filed.

> ### ⚠️ This endpoint never creates a ticket
>
> It returns no ticket id and takes no action on any ticket. It is **deflection** — a user getting an answer and choosing not to file — not auto-resolution. The distinction is a hard platform rule; see [ADR-009](adr/009-deflection-is-not-auto-resolution.md).

```jsonc
// Request — publishable key + X-IRIS-Identity
{
  "question": "Why is my Q3 emissions report failing to export?",
  "conversation_id": "cnv_01JQZ9A8S6",        // optional — omit to start a new conversation
  "context": { "page": "/reports/emissions", "app_version": "4.2.1" }   // optional
}
```

```jsonc
// 200 OK
{
  "conversation_id": "cnv_01JQZ9A8S6",
  "suggested_action": "answer",               // "answer" | "create_ticket"
  "answers": [
    { "type": "kb_article", "id": "kb_01JQZ8Z7R5", "title": "Fixing failed report exports",
      "excerpt": "Exports larger than 50 MB time out…", "score": 0.89,
      "url": "https://support.iris.example/kb/kb_01JQZ8Z7R5" },
    { "type": "resolved_ticket", "id": "tkt_01JQZ4M2N1", "title": "Q2 export returned 500",
      "excerpt": "Resolved by clearing the cached report definition.", "score": 0.74 }
  ],
  "prefill": {                                 // carried into POST /v1/tickets if the user proceeds
    "description": "Why is my Q3 emissions report failing to export?",
    "category": "bug", "severity": "medium"
  }
}
```

| Behaviour | Detail |
|---|---|
| `suggested_action` | `create_ticket` when the best score is below `product.config.deflection.min_score`. **A weak answer is worse than no answer** |
| Escalation | The client posts `POST /v1/tickets` with `conversation_id`; the platform attaches the transcript as the initial description |
| Recorded | Every conversation persists as `widget_conversation` with an `outcome` — the sole, auditable source of the Self-Served metric |
| AI unavailable | `503 deflection_unavailable`. **Ticket creation is unaffected** — the widget falls straight through to the ticket form |
| Rate limit | 10/min per `(product, raiser sub)` — §2.7 |

### 5.9 `GET /v1/kb/articles` — search the knowledge base

Direct search ("Search Docs"), as opposed to the conversational path in §5.8. Publishable-key scoped, read-only, product-scoped.

| Param | Example | Notes |
|---|---|---|
| `q` | `export failing` | Full-text + vector hybrid |
| `category` | `reports` | |
| `limit` / `cursor` | | §2.8, max 50 |

```jsonc
{ "data": [ { "id": "kb_01JQZ8Z7R5", "title": "Fixing failed report exports",
              "category": "reports", "excerpt": "…", "score": 0.89, "helpful_pct": 92 } ],
  "next_cursor": null, "has_more": false }
```

Only `status: published` articles in the product's public categories are ever returned. Returns `403 knowledge_base_disabled` when the product has not enabled KB.

`POST /v1/kb/articles/{id}/helpful` records a `yes`/`no` vote — the signal behind the *Helpful %* column and a ranking input.

---

## 6. Webhooks: platform → product

### 6.1 Event catalogue

| Event | Fires when | Mandated by brief |
|---|---|---|
| `ticket.created` | Ticket accepted | |
| `ticket.classified` | AI classification lands (async) | |
| `ticket.assigned` | Support user assigned | ✅ |
| `ticket.in_progress` | Assignee picks it up | ✅ |
| `ticket.comment_added` | New non-internal comment | |
| `ticket.resolved` | Resolved | ✅ |
| `ticket.closed` | Closed (rated or auto-closed) | ✅ |
| `ticket.reopened` | Reopened after resolve/close | |
| `ticket.rated` | Raiser submits 1–5★ | |
| `ticket.sla_breached` | SLA clock passes target | |
| `access.activated` | T2 grant became usable | |
| `access.revoked` | T2 grant revoked | |
| `access.revoke_failed` | Revoke exhausted all retries — **treat as a security incident** | |

### 6.2 Envelope

```jsonc
{
  "event_id": "evt_01JQZ8X4M2",
  "event": "ticket.assigned",
  "api_version": "v1",
  "occurred_at": "2026-03-26T09:00:00Z",
  "product_id": "prod_carbon",
  "data": { "ticket_id": "tkt_01JQZ7YB3K", "reference": "CARB-1042", "status": "assigned",
            "assignee": { "id": "su_01JQ", "display_name": "R. Iyer" } }
}
```

### 6.3 Signature verification (you verify us)

Header, Stripe-style so it is familiar:

```
X-IRIS-Signature: t=1774486800,v1=700a642079f3141d0215ce07b0113ad9a885606706f08b3bc909aeba0bf81500
```

Signed value is `"{t}.{raw_request_body}"` with HMAC-SHA256 under your `webhook_secret`. **Verify against the raw body bytes, before any JSON parsing** — re-serialising changes whitespace and key order and will break the comparison.

**Verifiable test vector:**

```
webhook_secret = whsec_7Kp2mXqR8vNtJdLwEaZbYcHgFuSi
t              = 1774486800
raw_body       = {"event_id":"evt_01JQZ8X4M2","event":"ticket.assigned","occurred_at":"2026-03-26T09:00:00Z","data":{"ticket_id":"tkt_01JQZ7YB3K","status":"assigned"}}

SIGNATURE v1   = 700a642079f3141d0215ce07b0113ad9a885606706f08b3bc909aeba0bf81500
```

Reject if `|now − t| > 300 s`. Compare in constant time.

### 6.4 Delivery semantics

**At-least-once.** You will occasionally receive a duplicate — **deduplicate on `event_id`**. Events for a single ticket are delivered in causal order under normal operation, but a retry can reorder across tickets; if strict ordering matters, sort on `occurred_at`.

| Attempt | Delay after previous |
|---|---|
| 1 | immediate |
| 2 | 1 s |
| 3 | 5 s |
| 4 | 25 s |
| 5 | 2 min |
| 6 (final) | 10 min |

Then dead-lettered and surfaced as a red banner in the admin portal. Respond **2xx within 5 s** — do the work asynchronously on your side. Any non-2xx, or a timeout, triggers a retry.

**Gap recovery:** if your receiver was down past the retry window, backfill with `GET /v1/tickets?updated_after=<last_seen>`. Webhooks are an optimisation over polling, never the only path to a state change.

---

## 7. Attachments

### 7.1 Two-step upload

1. `POST /v1/attachments` (multipart) → `{ "id": "att_01JQZ8...", "filename": ..., "size_bytes": ... }`
2. Reference the `id` in the ticket or comment payload.

Download is via a **short-lived pre-signed URL** (5 min) from `GET /v1/attachments/{id}/url`, issued only after the access check passes — so the JIT grant model applies to attachment *bytes*, not merely to metadata.

### 7.2 Restrictions and why

| Rule | Value | Reason |
|---|---|---|
| Max size | 25 MB | |
| Allowlist | `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `application/pdf`, `text/plain`, `text/csv`, `application/zip`, Office types | |
| **Blocked** | `image/svg+xml`, `text/html`, anything executable | An SVG or HTML attachment rendered inline in the admin portal executes script in an authenticated **super-admin** session — a full platform compromise delivered through a mandated feature |
| Serving | Separate origin, `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff` | Never rendered inline, under any circumstances |

---

## 8. Access grant contract (T2 — into your product)

Two mechanisms. A product picks one via `product.config.access.mechanism`. See [HLD.md §13](HLD.md) for the full threat model.

### 8.1 Mechanism A — server-to-server callback (full-code)

You register an `access_callback_url`. We POST to it, HMAC-signed exactly as §6.3.

**Grant** — sent on assignment:

```jsonc
{
  "event_id": "evt_01JQZ9...", "event": "access.grant_requested",
  "grant_id": "grt_01JQZ7YD7N",
  "ticket_id": "tkt_01JQZ7YB3K", "reference": "CARB-1042",
  "product_tenant_id": "acme-corp",
  "actor": { "support_user_id": "su_01JQ", "email": "r.iyer@iris.example", "display_name": "R. Iyer" },
  "scope": { "kind": "dataset", "resource_ref": "carbon:report:8842" },
  "expires_at": "2026-03-26T14:14:22Z"
}
```

Expected `200`:

```jsonc
{ "status": "granted", "product_grant_ref": "carbon-grant-771", "expires_at": "2026-03-26T14:14:22Z" }
// or
{ "status": "denied", "reason": "resource_not_found" }
```

**Revoke** — sent on `resolved`, and re-asserted idempotently on `closed`:

```jsonc
{ "event": "access.revoke_requested", "grant_id": "grt_01JQZ7YD7N", "product_grant_ref": "carbon-grant-771" }
```

Expected `200 { "status": "revoked" }`. A revoke that exhausts all retries emits `access.revoke_failed`, raises a red flag in the admin portal, and is treated as a security incident — not a delivery warning.

**What stops a forged grant request:** HMAC-SHA256 under a secret only you and the platform hold, plus a ±300 s timestamp window and a nonce cache. You must verify all three. Be aware of the honest limitation: this mechanism trusts the platform. A compromised platform *could* mint a valid-looking grant. That is precisely why mechanism B exists.

### 8.2 Mechanism B — client-minted pre-authorized link (low-code, recommended)

Instead of running a grant service, you mint an **inert capability** at raise time, using auth context you already have for the raiser's session, and hand it to us in `preauth_grant` (§5.1).

```
RAISE    you mint token — opaque, product-signed, INERT (bound to nobody, not yet usable)
ASSIGN   platform binds it to the assignee's identity → state inert→active → renders a launch link
USE      assignee opens the link → YOUR middleware validates:
           signature valid · not expired · ticket still open · identity == bound actor
         → scoped session, that resource only
RESOLVE  platform marks it revoked; your next validation fails; max_ttl caps it regardless
```

> **Why this is stronger:** the platform never holds your signing key, so it can only **relay and time-box** a capability *you* minted and *you* validate. **Even a fully compromised platform cannot fabricate access into your product.** Mechanism A cannot make that claim.

Three independent expiries protect the grant, and **any one surviving is sufficient**: the platform revokes at resolve; `max_ttl_seconds` caps the token; and you re-check ticket status on every use.

---

## 9. Versioning and deprecation

| Rule | Detail |
|---|---|
| **Version lives in the URL path** | `/v1/…`. Visible in every log line and every curl — no invisible header state |
| **Additive changes never bump the major** | New optional request fields, new response fields, new enum members, new endpoints, new webhook event types |
| **Clients must tolerate additive change** | Ignore unknown response fields; do not fail on an unrecognised `event` type — log and skip. A client that breaks on a new field is not v1-compliant |
| **Breaking changes only in a new major** | Removing/renaming a field, narrowing a type, changing a status code's meaning, adding a required request field, changing default behaviour |
| **Both majors run concurrently** | Minimum **6 months** overlap after `v2` GA |
| **Products are version-pinned** | `product.api_version_pin` — shipping `v2` cannot move an existing integration. A product opts in explicitly |
| **CI enforces it** | Contract tests in `shared/contracts/` run against every build; an accidental v1 break fails the pipeline, not a customer |

**Deprecation signalling:** deprecated endpoints return `Deprecation: true` and `Sunset: <RFC 1123 date>` headers for at least one full major-version cycle before removal.

---

## 10. Integration checklist

For a product adopting the platform:

**Zero-code**
- [ ] Add the `<script>` tag with your publishable key
- [ ] Register your origin in the admin portal
- [ ] Configure fields, categories, severities, branding — all server-side

**Low-code** (adds)
- [ ] Mint short-lived identity JWTs; publish your JWKS URL
- [ ] Register a webhook URL; verify signatures per §6.3 against the raw body
- [ ] Deduplicate on `event_id`; return 2xx within 5 s
- [ ] *(for T2 access)* Mint a `preauth_grant` at raise; validate it in your middleware on use

**Full-code** (adds)
- [ ] Implement HMAC request signing per §3; verify against the §3.3 test vector **before** your first live call
- [ ] Send `Idempotency-Key` on every POST
- [ ] Implement the `access_callback_url` grant/revoke handler per §8.1
- [ ] Implement gap recovery via `?updated_after=`
- [ ] Sync your clock via NTP — clock skew is the single most common integration failure

---

## 11. Admin surface — informational, not part of this contract

The platform also exposes `/admin/*` for the support team's own portal. It is documented here **only to make clear that it is not part of the integration contract**, so nobody specifies these under `/v1` later.

| Surface | Covers |
|---|---|
| `/admin/tickets/*` | Cross-product ticket views, assignment, internal comments, triage |
| `/admin/users/*` | Support users, roles, scopes, skills, availability |
| `/admin/products/*` | Per-product configuration, credentials, webhook and callback URLs |
| `/admin/kb/*` | Knowledge base article CRUD, publish state, categories |
| `/admin/automations/*` | Automation rule catalogue and toggles |
| `/admin/analytics/*` | TAT, SLA compliance, CSAT, AI insights |
| `/admin/audit/*` | Audit log search |

| Property | `/v1/*` (this contract) | `/admin/*` |
|---|---|---|
| **Consumer** | Integrating products | The IRIS support team's own portal |
| **Auth** | HMAC product credential, or publishable key + identity JWT | Platform-native support-user session ([HLD §7.3](HLD.md)) |
| **Stability** | Versioned, 6-month deprecation cycle, contract-tested | **Internal — changes without notice, ships with the portal** |
| **Documented for integrators** | Yes | No |

> **Products must never be given `/admin/*` access.** If an integrating product needs a capability that exists only there, that is a signal to add it to `/v1` as a versioned, contract-tested endpoint — not to widen an internal surface. Knowledge base *reading* is the example: it lives at `/v1/kb/articles` (§5.9) for products, while *authoring* stays at `/admin/kb/*`.
