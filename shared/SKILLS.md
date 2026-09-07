# SKILLS.md — shared

**The coordination artifact.** In a polyglot repo this is the only thing preventing the Node side and the Python side from drifting apart.

> Read [/SKILLS.md](../SKILLS.md) first.

| | |
|---|---|
| **Contents** | `contracts/` (OpenAPI, webhook + event schemas) · `hmac-utils/` (TS + Python) · `types/` (shared DTOs) |
| **Consumed by** | Every service, and the sample integrations |

---

## 1. Why this exists

The polyglot split is justified by one rule: **exactly one process holds a DB credential**, which shrinks the cross-language surface to a handful of HTTP calls. `shared/` is where that surface is written down.

**If it crosses a service boundary, it is defined here.** If it is internal to one service, it does not belong here — a `shared/` folder that accumulates convenience helpers becomes a dependency knot that couples everything to everything.

---

## 2. `contracts/` — the source of truth

| Folder | Holds |
|---|---|
| `openapi/` | The `/v1` REST spec. **Authoritative** — [api-contract.md](../docs/api-contract.md) is its prose companion |
| `webhooks/` | JSON Schema per outbound event payload |
| `events/` | JSON Schema per internal outbox event |

### Rules

- **The spec changes in the same PR as the code.** A contract updated "later" is a contract that is already wrong. This is a merge blocker, not a nicety.
- **Contract tests run in CI, both directions** — the gateway's responses validate against the spec, and the sample integrations' requests validate against it. An accidental v1 break fails the build, not a customer.
- **Additive changes only within a major.** New optional fields, new response fields, new enum members, new endpoints, new event types. Anything else is `v2`.
- **Generate, don't hand-write, the client types.** `npm run generate:types` produces TS from OpenAPI; `datamodel-code-generator` produces pydantic for `ai-service`. Hand-written duplicates drift within days.
- Every schema example must be **real and valid** — examples get copy-pasted by integrators.

---

## 3. `hmac-utils/` — one implementation, two languages

Both the gateway **and** the sample integrations import this. That is deliberate: if signing and verifying share code, a divergence is a failing test instead of a two-hour mystery at 2 a.m.

```
hmac-utils/
  ts/     canonical.ts, sign.ts, verify.ts, hmac.test.ts       17 tests
  py/     iris_hmac/{canonical,sign,verify}.py, test_hmac.py   25 tests
  vectors.json    ← shared test vectors, both languages assert against them
```

Both are wired into `npm test` (`test:ts` + `test:py`), so a divergence fails the
build rather than surfacing at an integrator's boundary. The Python module is
importable as `iris_hmac` and is what a Python integrating product — or
`ai-service`, if it ever calls the platform directly — would use.

### The vectors are the contract

```json
[{ "name": "request_v1", "secret": "sk_test_51H9xQmKvB2nRtYwLpZaCdEfG",
   "method": "POST", "path": "/v1/tickets", "timestamp": 1774483200,
   "nonce": "5f2b8c1a-9d3e-4a7b-8c6f-2e1d0a9b8c7d",
   "signature": "194eb588b7ad9e06cc477a5de3df4c06ae875d3c558dfa70d6465d65e1a293fb" },
 { "name": "webhook_v1", "secret": "whsec_7Kp2mXqR8vNtJdLwEaZbYcHgFuSi",
   "timestamp": 1774486800,
   "signature": "700a642079f3141d0215ce07b0113ad9a885606706f08b3bc909aeba0bf81500" }]
```

**Both language test suites assert against `vectors.json`.** If TS and Python ever disagree, CI fails immediately rather than at an integration boundary. These same vectors are published in [api-contract.md](../docs/api-contract.md) so integrators self-check before their first live call.

```bash
npm test              # runs both: vitest (17) + pytest (25)
npm run test:py       # Python only
```

### Implementation rules

| Rule | Why |
|---|---|
| **Constant-time comparison always** (`timingSafeEqual` / `compare_digest`) | `===` on a signature is a timing oracle |
| Hash the body, sign the hash | Large uploads stream; encoding never matters |
| **Method and path are inside the signature** | A captured request cannot be replayed against a different endpoint |
| Never log a secret, a canonical string, or a signature | The canonical string plus one known value leaks structure |
| Never add a "convenience" overload that skips a field | Someone will use it |

---

## 4. `types/`

Shared DTOs — ids, enums, the error envelope, event payload types.

- **Enums must match the database `CHECK` constraints exactly.** A status enum that drifts from the DB produces runtime failures the type system cheerfully approves of.
- TS is the source; Python equivalents are generated from the contracts, not hand-mirrored.
- **Never** put business logic here. Types and constants only. A shared module with behaviour becomes a shared module everyone must redeploy together.

---

## 5. Common mistakes

| ❌ Don't | ✅ Do |
|---|---|
| Update code now, spec later | Same PR, always |
| Hand-write types that OpenAPI can generate | Generate them |
| Reimplement HMAC in a service | Import from here |
| Let TS and Python signing diverge | Both assert against `vectors.json` |
| Put a helper here because two services *might* need it | Wait until two services *do* |
| Add business logic to `types/` | Types and constants only |
| Break v1 "because nobody uses it yet" | The sample integrations do — that is the point |
| Add a required request field in a minor | Required fields are breaking. `v2` |

---

## 6. Definition of done

- [ ] OpenAPI / JSON Schema updated in the same PR as the code
- [ ] Generated types regenerated and committed
- [ ] Contract tests pass in both directions
- [ ] New HMAC behaviour has a vector in `vectors.json`, asserted in **both** languages
- [ ] Change is additive, or it is a new major version
- [ ] Examples in the spec are real and valid
