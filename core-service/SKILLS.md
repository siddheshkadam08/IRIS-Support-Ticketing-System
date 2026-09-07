# SKILLS.md — core-service

**The platform's brain.** Owns the ticket state machine, access grants, support users, per-product config, SLA clocks, the audit trail, and **all SQL**.

> Read [/SKILLS.md](../SKILLS.md) first. This service carries three of the four platform invariants.

| | |
|---|---|
| **Stack** | Node 22 · TypeScript · Fastify · `pg` (raw SQL, no ORM) · zod |
| **Port** | 4100 — **internal only**, never publicly bound |
| **Callers** | `gateway` (all external traffic) · `worker` (via `/internal/*`) |
| **Owns** | The only Postgres credential in the system |

---

## 1. Non-negotiables

### 🔒 This service holds the only DB credential

If another service needs data, it gets an endpoint under `src/internal/`. Never a second connection string. See [/SKILLS.md §1](../SKILLS.md).

### 🔒 All database access goes through `withScope()`

```ts
// src/db/with-scope.ts — the ONLY way to reach Postgres
export async function withScope<T>(ctx: ScopeContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // SET LOCAL — scoped to this transaction, cannot leak across pooled connections
    await client.query('SELECT set_config($1,$2,true)', ['app.product_scope',   ctx.productScope.join(',')]);
    await client.query('SELECT set_config($1,$2,true)', ['app.support_user_id', ctx.supportUserId ?? '']);
    await client.query('SELECT set_config($1,$2,true)', ['app.role',            ctx.role]);
    await client.query('SELECT set_config($1,$2,true)', ['app.request_id',      ctx.requestId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}
```

**Usage — there is no other pattern:**

```ts
const ticket = await withScope(ctx, async (tx) => {
  const { rows } = await tx.query('SELECT * FROM ticket WHERE id = $1', [ticketId]);
  return rows[0] ?? null;   // RLS already filtered by product scope — no manual check needed
});
```

> ### ⚠️ Two footguns that make the security claim silently false
>
> **1. `SET` instead of `SET LOCAL`.** `SET` persists for the life of the *connection*. With a pool, request A's product scope leaks into request B — a cross-tenant read with no visible defect. Always `set_config(..., true)` (the `true` means local) inside an explicit transaction.
>
> **2. Connecting as the table owner.** In Postgres, **table owners bypass RLS by default** — every policy becomes decorative, with no error anywhere. The app connects as `iris_app` (non-owner); DDL runs as `iris_migrator`. Every product-scoped table must have **both**:
> ```sql
> ALTER TABLE ticket ENABLE ROW LEVEL SECURITY;
> ALTER TABLE ticket FORCE  ROW LEVEL SECURITY;  -- applies to the owner too
> ```
> A migration that adds a table without both lines fails CI.

**Enforced structurally:** nothing outside `src/db/` may import `pool` or call `pool.connect()`. ESLint rule `no-restricted-imports` fails the build otherwise.

### 🔒 Every state change writes an audit event *in the same transaction*

```ts
await withScope(ctx, async (tx) => {
  await tx.query('UPDATE ticket SET status=$2 WHERE id=$1', [id, next]);
  await writeAudit(tx, ctx, { action: 'ticket.status_changed', entity: 'ticket', entityId: id,
                              before: { status: prev }, after: { status: next } });
  await emitEvent(tx, ctx, 'ticket.resolved', { ticket_id: id });   // outbox — same tx
});
```

Three writes, one transaction. Either all happened or none did.

---

## 2. Folder map

| Folder | Owns | Notes |
|---|---|---|
| `src/db/` | Pool, `withScope`, migration runner, RLS helpers | **The only place `pg` is imported** |
| `src/tickets/` | State machine, CRUD, comments, ratings | State machine is one file, not scattered |
| `src/access/` | Dual JIT grant: T1 RLS + T2 callback + T2 pre-auth | The differentiator — highest care |
| `src/users/` | Support users, roles, scopes, skills, workload | Platform-native identity only |
| `src/products/` | Onboarding, credentials, per-product config | |
| `src/sla/` | TAT clocks, business calendar, pause segments | Two clocks — see §6 |
| `src/audit/` | Append-only writer | Write-only API; no update/delete path exists |
| `src/events/` | Transactional outbox + publisher | §4 |
| `src/storage/` | Attachment adapter (MinIO local / Azure Blob prod) | One interface, two impls |
| `src/knowledge-base/` | KB articles, search, helpful votes | Added per [ui-spec-deltas §2.1](../docs/ui-spec-deltas.md) |
| `src/automations/` | Rule catalogue + evaluation | Fixed catalogue only — see §7 |
| `src/internal/` | Endpoints for `worker` / `ai-service` | **Never routed publicly by nginx** |

**Module shape** — every domain folder looks the same:

```
tickets/
  ticket.routes.ts      HTTP only: parse, validate, call service, shape response
  ticket.service.ts     Business logic. Where the thinking lives
  ticket.repo.ts        SQL. Takes a `tx`, never opens its own
  ticket.schema.ts      zod schemas — request, response, domain types
  state-machine.ts      Transitions in one place
  *.test.ts             Colocated
```

**Layer rule:** routes → service → repo. Never routes → repo. Never repo → service.

---

## 3. The ticket state machine

One file, one table, no transition logic anywhere else.

```ts
const TRANSITIONS = {
  open:              ['assigned', 'closed'],
  assigned:          ['in_progress', 'open', 'resolved'],
  in_progress:       ['waiting_on_raiser', 'resolved'],
  waiting_on_raiser: ['in_progress', 'resolved'],
  resolved:          ['closed', 'open'],       // reopen
  closed:            ['open'],                 // reopen
} as const;
```

| Transition | Side effects — **all in the same transaction** |
|---|---|
| `→ assigned` | Issue **two** `access_grant` rows (T1 platform, T2 product); stamp `assigned_at`; emit `ticket.assigned` |
| `→ in_progress` | Emit `ticket.in_progress` |
| `→ waiting_on_raiser` | **Pause the SLA clock**; emit event. Displays as "On Hold" |
| `→ resolved` | **Revoke both grants**; stamp `resolved_at`; stop SLA clock; request rating; emit `ticket.resolved` |
| `→ closed` | Idempotent re-assert of revoke; emit `ticket.closed` |
| `→ open` (reopen) | **Re-issue both grants**; restart SLA clock; audited; emit `ticket.reopened` |

**`first_response_at`** is stamped on the **first non-internal comment authored by a support user**. Locked — do not reinterpret it. It is the definition every TAT number depends on.

**Illegal transitions** throw `InvalidStateTransition`, which the error middleware renders as `409` with `details.allowed[]`.

---

## 4. Transactional outbox

**Never enqueue a job after committing.** If the process or Redis dies in between, the job is lost forever — and a lost `access.revoke` means access outlives the ticket, silently.

```ts
// Inside the transaction, always
await emitEvent(tx, ctx, 'ticket.resolved', { ticket_id: id });
// → INSERT INTO event_outbox (id, product_id, event_type, payload, request_id, created_at)
```

A publisher (LISTEN/NOTIFY + a 1 s safety poll) moves unpublished rows to BullMQ and stamps `published_at`. At-least-once — **consumers must be idempotent on `event_id`**.

---

## 5. Access grants — highest-care code in the repo

One assignment writes **two rows**:

| Layer | Mechanism | Enforcement |
|---|---|---|
| `platform` | `rls` | Synchronous, in-transaction. The RLS predicate opens exactly that ticket to exactly that user |
| `product` | `callback` or `preauth_link` | Async via worker. Per `product.config.access.mechanism` |

**Rules:**
- Revoke at `resolved`, idempotent re-assert at `closed`. Never later.
- `expires_at` = `min(sla_target, product.config.access.max_ttl_seconds, 72h)`.
- **Every grant and revoke writes an audit event with the product's actual response body and latency.** That is what the History tab renders and what proves the cycle to a judge.
- A revoke that exhausts retries is a **security incident**: `state='revoke_failed'`, DLQ, red flag in the portal, `access.revoke_failed` webhook.
- **Pre-auth tokens are opaque.** Store encrypted at rest, never log, never return in an API response. The platform cannot read or mint them — that is the whole point.

---

## 6. SLA — two clocks, never conflated

| Clock | Pauses | Used for |
|---|---|---|
| **SLA clock** | Outside the product's business calendar (timezone, working days/hours, holidays) **and** during `waiting_on_raiser` | Compliance %, breach alerts, agent performance |
| **Customer TAT** | Never — wall clock | What we show the raiser |

`sla_clock.segments` stores every run/pause span as `{from, to, state}`. **Never store only a total** — a total cannot be audited or recomputed when a calendar changes.

**At Risk** = ≥ 80% of target consumed and not resolved. Added per [ui-spec-deltas §3](../docs/ui-spec-deltas.md); a breach-only dashboard is a post-mortem tool, not an operational one.

Report **p50 and p90, never averages**. A mean hides the tail that matters.

---

## 7. Automations — keep it a catalogue

Fixed trigger types and action types with toggles and simple conditions. **Do not build a visual rule builder** — that is a product in itself.

Rules evaluate in `worker` off the outbox stream, **never inline in the request path**.

> **Loop protection is mandatory.** An action that mutates a ticket emits an event that can re-trigger a rule. Every automation-originated mutation sets `actor_type='automation'`, rule evaluation skips automation-authored events, and a chain is capped at 3 executions.

---

## 8. Common mistakes

| ❌ Don't | ✅ Do |
|---|---|
| `pool.query(...)` directly | `withScope(ctx, tx => tx.query(...))` |
| `SET app.product_scope` | `set_config('app.product_scope', v, true)` inside a transaction |
| Add a table without `FORCE ROW LEVEL SECURITY` | Both `ENABLE` and `FORCE`, every time |
| Enqueue a job after `COMMIT` | `emitEvent(tx, ...)` inside the transaction |
| Manual `WHERE product_id = $1` as the *only* defence | Rely on RLS; app checks are the *second* layer, not the first |
| Throw `403` for another product's ticket | `404` — `403` confirms it exists |
| Business logic in `*.routes.ts` | Routes parse and delegate; logic lives in `*.service.ts` |
| An ORM | Raw parameterised SQL. RLS + `SET LOCAL` + `pgvector` fight every ORM |
| Log a pre-auth token or secret | Log the id, never the value |
| `is_internal` comments in a product-facing response | Filter at the repo layer so it cannot be forgotten upstream |

---

## 9. Testing

```powershell
npm test --workspace=core-service              # unit + integration (real Postgres via compose)
npm run test:security --workspace=core-service # ← the five negative tests
```

**The five security tests are the contract with the judges.** They live in `src/**/security.test.ts` and never get skipped:

1. Agent scoped to product B requests product A's ticket by id → `404`
2. Assigned agent requests a *different* ticket → comments/attachments absent
3. A revoked pre-auth/launch URL → denied
4. Replayed signed request → `nonce_replayed`; tampered body → `signature_invalid`
5. A query written *without* a `product_id` predicate returns **zero rows**, not other products' rows

Test 5 is the important one — it proves RLS is genuinely enforcing, not that our `WHERE` clauses happen to be correct today.

---

## 10. Definition of done

- [ ] All DB access via `withScope()`; nothing imports `pool` outside `src/db/`
- [ ] New tables have `product_id`, both RLS lines, and an index on `(product_id, …)`
- [ ] State change + audit event + outbox event in **one** transaction
- [ ] Errors use the standard envelope with a catalogued `code`
- [ ] Migration is forward-only and idempotent; seed still runs clean
- [ ] Contract change reflected in `shared/contracts/` in the same PR
- [ ] The five security tests pass
