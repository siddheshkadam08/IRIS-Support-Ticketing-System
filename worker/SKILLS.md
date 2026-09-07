# SKILLS.md — worker

**The async engine.** Consumes BullMQ jobs off the outbox stream, orchestrates AI calls, drives access grants and revokes, evaluates automation rules.

> Read [/SKILLS.md](../SKILLS.md) first.

| | |
|---|---|
| **Stack** | Node 22 · TypeScript · BullMQ · `ioredis` |
| **Port** | None. It is a consumer, not a server |
| **Talks to** | Redis · `core-service:4100/internal/*` · `ai-service:5000` |

---

## 1. Non-negotiables

### 🔒 No database credential

All reads and writes go through `core-service/src/internal/`. See [/SKILLS.md §1](../SKILLS.md) — a second DB connection is a second, unpoliced path around RLS.

### 🔒 Every job is idempotent

The outbox publisher is **at-least-once**. Duplicates are normal operation, not an error condition.

```ts
export async function handleClassify(job: Job<ClassifyPayload>) {
  const { event_id, ticket_id, request_id } = job.data;
  if (await alreadyProcessed(event_id)) return;      // Redis SET NX, 24h TTL
  const result = await aiClient.classify({ ticket_id, request_id });
  await coreClient.patchClassification(ticket_id, result, { request_id });
  await markProcessed(event_id);
}
```

Guard on `event_id`, not on job id — a re-published outbox row gets a new job id but keeps its event id.

### 🔒 A killed worker leaves the job re-runnable

Never half-apply. If a job does two things, either make it one atomic call to `core-service`, or make each step independently idempotent. On `SIGTERM`: stop taking new jobs, finish in-flight (max 15 s), close connections.

---

## 2. Queues

| Queue | Trigger | Does | Priority |
|---|---|---|---|
| `access.grant` | `ticket.assigned` | Invoke product callback **or** bind the pre-auth token | 🔴 **Highest** |
| `access.revoke` | `ticket.resolved` / `closed` | Invoke revoke callback; mark token revoked | 🔴 **Highest** |
| `ai.classify` | `ticket.created` | Classify + embed + summarise, write back | 🟠 |
| `ai.suggest_assignee` | classification complete | Rank candidates | 🟡 |
| `automation.evaluate` | any lifecycle event | Match rules, apply actions | 🟡 |

**Access jobs get a dedicated queue and worker concurrency.** A backlog of AI classification must never delay a revoke — that is the difference between a slow demo and a security failure.

---

## 3. Retry policy

```ts
{ attempts: 5, backoff: { type: 'exponential', delay: 1000 } }   // 1s → 5s → 25s → 2m → 10m
```

| Failure | Handling |
|---|---|
| 5xx / timeout from a product callback | Retry per the schedule |
| **4xx from a product callback** | **Do not retry** — a 400 means our payload is wrong, and 5 identical retries just delay the alert |
| `ai-service` unavailable | Retry. Ticket stays unclassified in triage; the workflow is unaffected |
| Retries exhausted on `ai.*` | DLQ, warning banner |
| **Retries exhausted on `access.revoke`** | **DLQ + `state='revoke_failed'` + `access.revoke_failed` webhook + red flag in the portal.** Treat and style this as a security incident, not a delivery warning |

> **A dead-lettered revoke is the most serious failure this system can produce.** Access outliving a ticket is exactly the criterion we claim to satisfy. It must be loud.
>
> The pre-auth mechanism degrades safely here — it self-expires via `max_ttl` even if nothing is ever delivered. That asymmetry is a reason to prefer it.

---

## 4. Automation rules

Evaluated here, **never inline in the request path** — a slow or looping rule must never delay a ticket write.

> ### ⚠️ Loop protection is mandatory
> An action that mutates a ticket emits an event that can re-trigger a rule that mutates the ticket again.
> - Every automation-originated mutation carries `actor_type='automation'`
> - Rule evaluation **skips events whose actor is an automation**
> - A chain is capped at **3 executions**; exceeding it logs an error and stops
>
> Without this, one badly-configured rule saturates the queue and takes the demo down.

Keep it a fixed catalogue of triggers and actions. **No general-purpose rule engine.**

---

## 5. Operational rules

| Rule | Why |
|---|---|
| Propagate `request_id` from job data into every downstream call | The cross-service trace is the audit story |
| **Timeout every outbound call** (AI 10 s, callbacks 10 s, core 5 s) | One hung call must not hold a worker slot forever |
| Concurrency per queue, not global | Access jobs must never queue behind AI jobs |
| Log job start, end, duration, attempt number | "Which attempt succeeded" is the first debugging question |
| Never log payload bodies containing raiser text or tokens | PII and capability leakage |
| Keep handlers thin — orchestration only | Business logic belongs in `core-service` |

---

## 6. Common mistakes

| ❌ Don't | ✅ Do |
|---|---|
| Open a DB connection | Call `core-service/internal/*` |
| Assume a job runs once | Guard on `event_id` |
| Retry a 4xx from a product callback | Fail fast — our payload is wrong |
| Put access and AI jobs on one queue | Separate queues, separate concurrency |
| Let a revoke failure log quietly | DLQ + webhook + red flag |
| Write business logic in a handler | Orchestrate; logic lives in core-service |
| Call without a timeout | Always bound |
| Ignore `SIGTERM` | Drain, then exit |

---

## 7. Definition of done

- [ ] Handler is idempotent, guarded on `event_id`
- [ ] Retry policy set; 4xx does not retry
- [ ] Every outbound call has a timeout
- [ ] `request_id` propagated
- [ ] Failure path defined — DLQ, alert, or both
- [ ] No DB driver imported
- [ ] Graceful shutdown honoured
- [ ] New queue registered with its own concurrency
