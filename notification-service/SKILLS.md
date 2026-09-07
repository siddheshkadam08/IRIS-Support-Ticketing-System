# SKILLS.md — notification-service

**One outbound dispatcher, four transports.** Email, WhatsApp, Slack, and **product webhooks** — because they share every hard part: signed payload, retry with backoff, dead-letter, delivery ledger, per-product enablement.

> Read [/SKILLS.md](../SKILLS.md) first.

| | |
|---|---|
| **Stack** | Node 22 · TypeScript · BullMQ consumer + a thin Fastify app |
| **Port** | 5100 — **internal only**. Health + admin test-send/template-preview only |
| **Primary mode** | Queue consumer, not an HTTP service |

---

## 1. Non-negotiables

### 🔒 This service decides *how* to deliver, never *whether* to fire

`core-service` emits domain events. This service dispatches them. It must never contain a rule like *"only notify if severity is high"* — that is per-product config, evaluated upstream.

### 🔒 Ticket operations never block on delivery

Everything here is async, off the queue. A dead SMTP server, a rate-limited BSP, or a product webhook timing out must never slow or fail a ticket write. That separation is the reason this is its own service.

### 🔒 One retry policy, one delivery ledger, all four channels

Every attempt writes a `delivery_log` row (via `core-service/internal`): channel, target, `event_id`, attempt number, status code, response body, timestamp. **The ledger is the answer to "did the customer actually get told?"** — and to "did the product receive the revoke?"

---

## 2. Channel abstraction

```ts
export interface NotificationChannel {
  readonly name: 'email' | 'whatsapp' | 'slack' | 'webhook';
  isEnabled(product: ProductConfig, event: EventType): boolean;
  send(payload: DispatchPayload): Promise<DeliveryResult>;   // never throws; returns a result
}
```

Add a channel by implementing this and registering it. **Never** add a channel-specific branch in the dispatcher — an `if (channel === 'whatsapp')` in shared code is how the abstraction dies.

`send()` **returns** a `DeliveryResult` rather than throwing. Retry classification is the dispatcher's job, not the channel's.

---

## 3. Webhooks to products — the mandated channel

Signature (Stripe-style, familiar to integrators):

```
X-IRIS-Signature: t=1774486800,v1=<hmac_sha256(webhook_secret, `${t}.${raw_body}`)>
```

**Verified test vector** — must reproduce exactly ([api-contract.md §6.3](../docs/api-contract.md)):

```
secret=whsec_7Kp2mXqR8vNtJdLwEaZbYcHgFuSi  t=1774486800
body={"event_id":"evt_01JQZ8X4M2","event":"ticket.assigned","occurred_at":"2026-03-26T09:00:00Z","data":{"ticket_id":"tkt_01JQZ7YB3K","status":"assigned"}}
→ 700a642079f3141d0215ce07b0113ad9a885606706f08b3bc909aeba0bf81500
```

> ### ⚠️ Sign the exact bytes you send
> Serialise the body **once**, sign those bytes, send those bytes. Re-serialising between signing and sending changes key order or whitespace and every signature fails verification on the product side — with no useful error anywhere.

| Rule | Detail |
|---|---|
| Delivery | At-least-once. Products dedupe on `event_id` — say so in the docs and mean it |
| Timeout | 5 s. A product that needs longer must 202 and process async |
| Retries | `1s → 5s → 25s → 2m → 10m`, then DLQ |
| Don't retry 4xx | Their endpoint rejected the payload; retrying 5× just delays the alert |
| DLQ | Surfaces as a red banner in the admin portal |
| Never follow redirects | A 302 to an attacker-controlled host is SSRF with our signature attached |
| Validate the URL at registration | HTTPS, public host, **no internal/loopback/link-local addresses** |

**`access.revoke_failed` is not a normal delivery failure** — it is a security incident. Alert loudly.

---

## 4. Email

Templated (MJML → HTML + a plain-text alternative, always both). Per-product routing config maps `(category, severity, tenant)` → queue → recipients.

- Templates in `src/templates/`, one per event, with per-product branding tokens.
- **Never** put a pre-auth token, launch URL, or ticket body containing PII in an email. Link to the ticket; the recipient authenticates there.
- Set `List-Unsubscribe` on non-transactional mail; ticket lifecycle mail is transactional.
- Local dev uses MailHog — never a real SMTP relay from a dev machine.

---

## 5. WhatsApp

Via a **BSP** (Gupshup / Wati / AiSensy / 360dialog) for v1 — managed template approval, delivery retries, opt-in handling, local billing. Direct Cloud API later, behind the same interface.

| Rule | Why |
|---|---|
| **Pre-approved *utility* templates only** | Ticket lifecycle alerts are business-initiated. Utility is the correct category and is sub-cent in India |
| **Opt-in is mandatory** — store consent per raiser | No consent → email only. Not a preference; a platform requirement |
| Small fixed template set | assigned · status-changed · resolved · SLA-breach. Each deep-links to the ticket |
| **Off by default** | Until a product configures a sender |
| Treat as per-notification cost | The 24 h free-form window is narrowing — from 1 Oct 2026 Meta bills in-window utility templates and free-form replies. Don't design around "free after first inbound" |

---

## 6. Slack

Internal escalation only — never customer-facing. Used for SLA breach paging and `access.revoke_failed` alerts. Incoming webhook per product config; failures are logged but never retried aggressively (a paging channel that spams is a paging channel people mute).

---

## 7. Common mistakes

| ❌ Don't | ✅ Do |
|---|---|
| Decide *whether* to notify | Dispatch what core-service emitted |
| Re-serialise the body after signing | Sign and send the same bytes |
| Retry a 4xx | Fail fast, alert |
| Follow redirects on a webhook POST | Never — SSRF risk with our signature attached |
| Accept an internal-IP webhook URL | Validate at registration |
| Put PII or a token in an email | Link to the ticket |
| Send WhatsApp without stored consent | Check opt-in every time |
| Add `if (channel === ...)` in the dispatcher | Implement the interface |
| Let a failed revoke log quietly | Red flag — it is a security incident |
| Block a ticket write on delivery | Everything here is async |

---

## 8. Definition of done

- [ ] Implements `NotificationChannel`; no channel branch in shared code
- [ ] Every attempt writes a `delivery_log` row
- [ ] Retry + DLQ configured; 4xx does not retry
- [ ] Webhook signature reproduces the §3 test vector
- [ ] Timeouts set; redirects disabled; URL validated
- [ ] No PII, token, or secret in any payload or log
- [ ] Per-product enablement respected; new channels default **off**
- [ ] `request_id` propagated end to end
