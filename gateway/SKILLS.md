# SKILLS.md — gateway

**The only publicly reachable API process.** Verifies who is calling, throttles them, and proxies to `core-service`. It is deliberately thin.

> Read [/SKILLS.md](../SKILLS.md) first.

| | |
|---|---|
| **Stack** | Node 22 · TypeScript · Fastify · `ioredis` · `jose` (JWT/JWKS) |
| **Port** | 4000 — **public**, `/v1/*` and `/admin/*` only |
| **Proxies to** | `core-service:4100` |

---

## 1. The one rule that defines this service

### 🔒 The gateway knows about credentials. It never knows about tickets.

It may know what a product is, what a valid signature is, what a rate limit is. It must **never** know what a ticket is, which statuses exist, when access is granted, or what an SLA is.

**Why:** "core-service is unreachable from outside" is a security boundary only while the gateway is a boundary. The moment a business rule lands here, it becomes a deployment detail — and the rule now exists in two places, which is how they drift apart.

**The test:** if a change requires importing a domain type or reading a ticket field, it belongs in `core-service`. No exceptions, including "it's just one field for a nicer error message."

---

## 2. Request pipeline — order matters

```
1. request-id      mint or accept X-Request-Id            → every downstream log carries it
2. body-capture    keep the RAW bytes                     → signature verify needs them, pre-parse
3. rate-limit      per product, per bucket class          → cheapest rejection first
4. authn           HMAC (product) or session (support user)
5. identity        verify X-IRIS-Identity JWT via JWKS    → only when present
6. idempotency     replay stored response on repeat key
7. proxy           forward to core-service with resolved context headers
8. error-envelope  normalise everything to the standard shape
```

**Rate limiting sits before authentication on purpose** — an unauthenticated flood must be rejected before it costs a signature verification or a Redis lookup for credentials.

Resolved context is forwarded as trusted internal headers (`X-IRIS-Product-Id`, `X-IRIS-Support-User-Id`, `X-IRIS-Role`, `X-IRIS-Scope`, `X-Request-Id`). **`core-service` trusts these only because it is not publicly reachable** — which is exactly why it must never be published in compose.

---

## 3. HMAC verification

Canonical string, joined with `\n`, no trailing newline:

```
v1 \n METHOD \n PATH_WITH_QUERY \n TIMESTAMP \n NONCE \n sha256_hex(RAW_BODY)
```

```ts
const expected = crypto.createHmac('sha256', secret).update(canonical, 'utf8').digest('hex');
if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided))) throw new SignatureInvalid();
```

**Order of checks** (cheapest first, all must pass):

1. `client_id` exists and is active
2. `|now − timestamp| ≤ 300s` → `timestamp_out_of_window`
3. Nonce unseen — `SET NX EX 600` → `nonce_replayed`
4. Constant-time signature compare → `signature_invalid`

> ### ⚠️ The raw body is the signature input
> If Fastify parses JSON before you hash it, re-serialising changes whitespace and key order, and **every signature fails** with no obvious cause. Capture raw bytes in an `onRequest` hook and hash those. This is the single most common integration bug on both sides.

**Test vector** — the implementation must reproduce this exactly. It is published in [api-contract.md §3.3](../docs/api-contract.md) and integrators self-check against it:

```
secret=sk_test_51H9xQmKvB2nRtYwLpZaCdEfG  POST /v1/tickets  ts=1774483200
nonce=5f2b8c1a-9d3e-4a7b-8c6f-2e1d0a9b8c7d
→ 194eb588b7ad9e06cc477a5de3df4c06ae875d3c558dfa70d6465d65e1a293fb
```

Signing/verifying code lives in [`shared/hmac-utils/`](../shared/SKILLS.md) — **imported, never reimplemented here.** The gateway and the sample products must run the same code, or a divergence becomes a mystery instead of a failing test.

---

## 4. Identity JWT (end user)

Verified against the product's **JWKS URL**.

| Check | Reject with |
|---|---|
| `alg` is RS256 or ES256 | `identity_token_invalid` |
| `iss` ∈ product's registered issuers | `identity_token_invalid` |
| `aud` = `iris-ticketing` | `identity_token_invalid` |
| `exp − iat ≤ 300s`, not expired | `identity_token_invalid` |
| `jti` unseen (replay cache) | `identity_token_invalid` |
| `sub` and `product_tenant_id` present | `identity_token_invalid` |

> ### ⚠️ Reject symmetric algorithms explicitly
> Pass an **allowlist** of `['RS256','ES256']` to the verifier. `alg: none` and HS256-confusion (signing with the public key as an HMAC secret) are the two classic JWT breaks, and a permissive verifier accepts both.

**JWKS caching:** honour `Cache-Control`, refetch on an unknown `kid`, but **rate-limit the refetch** (max 1 per key per 60 s) — otherwise a stream of bogus `kid`s becomes a DoS amplifier against the product's IdP.

**Never** forward the raw JWT downstream. Forward the resolved claims as internal headers.

---

## 5. Rate limiting

Token bucket in Redis, per product, per bucket class. Limits are per-product config, defaults in [api-contract.md §2.7](../docs/api-contract.md).

| Bucket | Default |
|---|---|
| `/v1/*` overall | 600/min, burst 100 |
| `POST /v1/tickets` | 60/min, burst 20 |
| Publishable key per `(product, IP)` | 20 / 10 min |
| Publishable key per `(product, sub)` | 5/min |

Always return `X-RateLimit-Limit`, `-Remaining`, `-Reset`; `429` carries `Retry-After`.

**Degradation:** if Redis is unavailable, **fail closed for publishable keys** (they are the abuse vector) and **fail open for authenticated server credentials** (a paying integration should not break because our cache blinked). Log loudly either way.

---

## 6. Publishable keys (widget)

A `pub_live_…` key is scrapeable from any page — it must not be load-bearing.

Permits exactly: `POST /v1/tickets`, and reads of tickets raised by the accompanying identity JWT. Anything else → `403 credential_scope_exceeded`.

Additionally enforced: **origin allowlist** (`Origin` must match the product's registered origins → `403 origin_not_allowed`), tight rate limits, and anonymous raise **off by default** per product.

---

## 7. Common mistakes

| ❌ Don't | ✅ Do |
|---|---|
| Parse JSON before hashing the body | Capture raw bytes first |
| `sig === expected` | `crypto.timingSafeEqual` |
| Accept any JWT `alg` | Explicit `['RS256','ES256']` allowlist |
| Reimplement HMAC here | Import `shared/hmac-utils` |
| Read a ticket field to shape an error | Proxy the error from core-service |
| Forward the raw identity JWT | Forward resolved claims as internal headers |
| Cache credentials without a TTL | 60 s TTL — a rotated secret must take effect promptly |
| Publish port 4100 in compose | core-service stays internal |
| `catch { next() }` on a security check | Fail closed |

---

## 8. Definition of done

- [ ] No domain import, no ticket knowledge, no business rule
- [ ] Signature verified against raw bytes, compared in constant time
- [ ] The §3 test vector reproduces exactly
- [ ] JWT verified with an explicit algorithm allowlist
- [ ] Rate limit headers on every response
- [ ] `X-Request-Id` minted and forwarded
- [ ] Errors use the standard envelope; no internals leaked
- [ ] Security tests for replay, tamper, wrong-origin, and scope-exceeded all pass
