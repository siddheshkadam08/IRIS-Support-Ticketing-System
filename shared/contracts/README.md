# Contracts

The machine-readable definition of everything that crosses a service boundary.

| File | What |
|---|---|
| [`openapi/iris-v1.yaml`](openapi/iris-v1.yaml) | **The `/v1` REST API.** Authoritative — [docs/api-contract.md](../../docs/api-contract.md) is its prose companion |
| [`webhooks/webhook-event.schema.json`](webhooks/webhook-event.schema.json) | The envelope of every webhook and access callback, plus the responses a product returns |
| [`events/outbox-event.schema.json`](events/outbox-event.schema.json) | Internal outbox rows. **Not** part of the integration contract |

## Why this is not decorative

A spec nobody validates against is a wish. Three layers keep it honest:

| Check | Where | Proves |
|---|---|---|
| Structure, `$ref` resolution, operationIds, every operation documents a failure | `contracts.test.ts` — `npm test` | The document itself is coherent |
| Spec enums equal the TypeScript constants (which mirror the DB `CHECK` constraints) | `contracts.test.ts` | The published contract cannot disagree with what the database will accept |
| **Live gateway responses validate against the schemas** | `scripts/smoke-contract.mjs` — `npm run test:contract` | The running service actually matches the spec |

The third is the one that matters. If someone renames a field or changes a status code without touching the spec, that suite goes red.

```bash
npm test                 # includes the structural + enum checks
npm run test:contract    # live responses (needs the stack running)
```

Both of the first two already caught real problems while being written: two endpoints documented no failure responses at all.

## Changing the contract

Rules from [api-contract.md §9](../../docs/api-contract.md):

- **The spec changes in the same PR as the code.** A spec updated "later" is a spec that is already wrong. This is a merge blocker, not a nicety.
- **Additive only within v1** — new optional request fields, new response fields, new enum members, new endpoints, new webhook event types.
- **Everything else is v2** — removing or renaming a field, narrowing a type, changing what a status code means, or adding a required request field. All of those break integrators who did nothing wrong.
- Clients must **tolerate additive change**: ignore unknown response fields, and log-and-skip unrecognised event types rather than failing.

## Viewing it

The YAML is plain OpenAPI 3.1 — paste it into any viewer, or:

```bash
npx @redocly/cli preview-docs shared/contracts/openapi/iris-v1.yaml
```

Client generation works from the same file (`openapi-generator`, `openapi-typescript`, `datamodel-code-generator` for pydantic), which is the point of keeping one authoritative document rather than hand-written types per language.

---

<div align="center"><sub>Powered by Elevate - X.</sub></div>
