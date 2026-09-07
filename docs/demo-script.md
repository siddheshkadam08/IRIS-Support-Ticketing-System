# IRIS Ticketing Platform — Demo Script & Runbook

| | |
|---|---|
| **Audience** | Hackathon judges |
| **Duration** | 12 minutes live + 3 minutes Q&A |
| **Format** | Two browser windows, one terminal, one admin portal — **no slides after minute 1** |
| **Goal** | Demonstrate all **10** success criteria, provably, in order |
| **Companion** | [HLD.md](HLD.md) · [api-contract.md](api-contract.md) · [port-mapping.md](port-mapping.md) |

---

## 0. The governing principle

> **Show the thing working. Do not describe the thing working.**

Judges scoring *Demo Quality* (15%) and *Implementation Readiness* (15%) are watching for evidence, not narration. Three rules:

1. **Every claim gets a visible artifact** — a row in the audit log, a `403`/`404` on screen, a printed eval score. If it cannot be shown, it does not get claimed.
2. **The negative tests are the demo.** Anyone can show a ticket being created. Showing that a scoped agent *cannot* read another product's ticket is what separates this from a CRUD app. Budget real time for §6.
3. **Never debug live.** If a step fails, move to the fallback (§10) in one sentence and keep going. A smooth demo with one skipped feature scores far above a stalled demo with all of them.

---

## 1. Pre-flight checklist — T-30 minutes

Run every item on the **actual demo machine**, not your dev laptop.

### 1.1 Environment

```powershell
docker --version                      # REQUIRED — currently NOT INSTALLED on the dev machine
docker compose version
node --version                        # v22.17.0 ✅
python --version                      # 3.12.4 ✅
```

> ⚠️ **Known gap:** Docker is not installed on the current dev machine. Docker Desktop + WSL2 backend is a hard prerequisite. Install and validate well before demo day — it is a slow install and a catastrophic day-of discovery.

### 1.2 Windows port reservations — check this, it silently eats ports

Hyper-V / WinNAT reserves dynamic TCP ranges that can swallow ports our services need, producing a bind failure that reads like a code bug:

```powershell
netsh int ipv4 show excludedportrange protocol=tcp
```

If `4000`, `4100`, `5000`, `5100`, or `6101` falls inside an excluded range:

```powershell
net stop winnat
docker compose up -d
net start winnat
```

### 1.3 Browser-blocked ports — already fixed, do not regress

Chrome and Firefox hard-refuse **port 6000** (`ERR_UNSAFE_PORT`, reserved for X11). The original plan put sample product A there; it has been moved to **6001**, and product B to **6101**. If anyone "helpfully" reverts this, product A becomes unreachable in a browser with an error that looks like a networking failure.

### 1.4 Clean boot and seed

```powershell
cd infra
docker compose down -v                       # wipe volumes — start from a known state
docker compose up -d --build
docker compose logs -f --tail=20             # wait for all healthchecks green
npm run migrate --workspace=core-service
npm run seed                                 # synthetic products, support users, historical tickets
```

Seed loads: 2 products (CARBON, iFile), 4 support users across the 4 roles, ~120 historical resolved tickets with ratings and TAT spread (so the analytics views have real distributions, not empty charts), and the AI training/eval sets.

### 1.5 Smoke test — all green before you present

```powershell
curl -s http://localhost:4000/health          # gateway
curl -s http://localhost:4000/v1/ping         # signed round-trip through to core
curl -s http://localhost:5000/health          # ai-service
curl -s http://localhost:5100/health          # notification-service
```

Confirm internal services are **not** publicly bound — this is itself a demo talking point:

```powershell
Test-NetConnection -ComputerName localhost -Port 5432   # Postgres: should FAIL from outside the compose network
```

### 1.6 Windows arrangement

| Window | Content | Pre-loaded to |
|---|---|---|
| **Browser A** | Sample product **CARBON** | `http://localhost:6001` — logged in as *Priya Nair* |
| **Browser B** | Sample product **iFile** | `http://localhost:6101` — logged in as a different user |
| **Browser C** | **Admin portal** | `http://localhost:3000` — logged in as *manager* |
| **Terminal 1** | Ready for curl + eval | in repo root |
| **Terminal 2** | `docker compose logs -f gateway core-service` | tailing, font size up |

Zoom to **150%** everywhere. Judges are watching a shared screen, and unreadable text costs more points than a missing feature.

---

## 2. Minute 0:00–1:00 — Frame the problem

> "IRIS runs multiple products. Every one of them needs support ticketing, and today it's email, or it's rebuilt per product. A customer with tickets in two products has two unrelated histories, and nobody has a single view of SLAs.
>
> We built ticketing as a **platform**, not a feature. One deployment, many products, one source of truth.
>
> The interesting problems aren't the ticket CRUD. They're at the integration boundary: how does a product raise a ticket without owning ticket data? How does an engineer get access *back into* that product to investigate — without the platform owning that product's permission model? And how does that access reliably go away afterwards?
>
> That's what I'm going to show you. Two real products, both integrated, neither one sharing a line of ticketing code."

**Do not** walk through an architecture diagram here. Show the running system; the architecture emerges from it.

---

## 3. Minute 1:00–3:00 — Zero-code integration, SSO, widget

> ✅ Criteria hit: **Embeddable widget · SSO integration · Integration API**

**Browser A — CARBON.** Point at the page.

> "This is CARBON, an existing product. Its entire ticketing integration is this."

Show the source — one line, on screen:

```html
<script src="http://localhost/widget.js" data-product-key="pub_live_carbon_8f2a" defer></script>
```

> "One script tag. No ticketing code in this product at all."

**Click the support button.** Widget opens, CARBON-branded.

> "Note: it already knows who I am. Priya is logged into CARBON — she is **not** re-authenticating. CARBON minted a 5-minute signed JWT and the platform verified it against CARBON's public JWKS. The platform owns no end-user accounts at all."

**Fill and submit:**

- Description: *"Cannot export the Q3 emissions report — the download button returns a 500."*
- Severity: **High** · Attachment: a screenshot

> "Confirmation, with reference **CARB-1042**."

**Immediately switch to Browser B — iFile.**

> "Second product. Different company, different branding, different fields — configured server-side, so the categories here are academic, not emissions. **Same widget bundle, same platform, and no code difference between the two integrations.** That's the portability claim, and that's it demonstrated."

Raise a quick ticket in iFile too (needed for the isolation test in §6).

---

## 4. Minute 3:00–4:30 — AI classification, live

> ✅ Criteria hit: **AI classification**

**Browser C — admin portal**, triage queue.

> "CARB-1042 arrived thirty seconds ago. Nobody classified it. The AI did — asynchronously, so the raise itself returned in under 300 milliseconds and never waited on a model."

Open the ticket. Point at the classification panel:

```
Category: bug          p1 = 0.91   margin = 0.44   →  AUTO-ROUTED
Severity: high         p1 = 0.88   margin = 0.31   →  AUTO-ROUTED
Summary:  "Q3 emissions report export returns HTTP 500 on download."
```

> "Two numbers, not one. Top confidence **and** margin over the runner-up. A prediction that's 60% confident but only 2% ahead of second place is a very different thing from one that's 60% confident and 30% ahead."

**Now show the interesting case.** Open the pre-seeded ambiguous ticket:

```
Category: billing      p1 = 0.60   margin = 0.25   →  SOFT-ROUTED, flagged AI-UNCERTAIN
                       runner-up: integration (0.35)
```

> "This is exactly the case the brief asks about — 60% Product X, 35% Product Y. We don't auto-route: 0.60 is below our 0.80 bar. But we don't throw it in the unclassified bin either — there's a clear leader, and discarding that makes a human redo work the model already did.
>
> So it soft-routes to the suggested queue, **flagged**, and a human confirms with one click. Both probabilities are stored, so every misclassification is explainable afterwards. And these thresholds are per-product config, not code."

**Run the eval live — Terminal 1:**

```powershell
python ai-service/eval/run_eval.py --set demo10
```

```
Ticket  Product   Category  Severity   Result
  1     ✅        ✅        ✅         PASS
  ...
  7     ✅        ❌        ✅         PARTIAL  (billing → integration, p1=0.52 flagged uncertain)
  ...
─────────────────────────────────────────────
Exact match (all 3 fields):  8/10  ✅  (bar: 7/10)
Per-field: product 10/10 · category 8/10 · severity 9/10
```

> "The criterion is 7 out of 10. That's a measured number, reproducible right now, not a claim."

---

## 5. Minute 4:30–7:30 — The access flow ⭐ *the centrepiece*

> ✅ Criteria hit: **Callback access flow · Audit trail**

This is the highest-value segment. Slow down. Do not rush it.

### 5.1 Before assignment — access does not exist

**Browser C**, logged in as **agent R. Iyer**. Show the queue.

> "R. Iyer can see this ticket exists — summary, category, severity, age. That's our T0 tier: enough metadata to triage. He **cannot** see the comments, the attachments, or the raiser's identity, because he isn't assigned. Support users hold **zero standing access** to ticket payloads."

**Browser A — CARBON, in a private window as R. Iyer's product account.** Navigate to the Q3 emissions report.

> "And here's CARBON. R. Iyer has no access to this customer's data. **Access denied.**"

Leave that denial visible for a beat. It is the "before" half of the proof.

### 5.2 Assignment fires the dual grant

**Browser C** — Manager assigns CARB-1042 to R. Iyer. *(Optionally show the AI's ranked suggestion first — with per-factor contributions visible: domain fit, CSAT, speed, availability. "A suggestion a manager can't interrogate is a suggestion they won't trust.")*

**Terminal 2** — the logs light up. Point at them:

```
[gateway]      req_01JQZ8X5N3  PATCH /admin/tickets/tkt_01JQZ7YB3K/assign  200
[core-service] ticket.assigned → outbox (same transaction as the status change)
[core-service] access_grant grt_A layer=platform mechanism=rls     state=granted
[core-service] access_grant grt_B layer=product  mechanism=callback state=grant_pending
[worker]       POST http://product-a:6001/iris/access-callback  X-IRIS-Signature: t=...,v1=...
[product-a]    signature verified ✅ → granting scoped access to carbon:report:8842 for su_01JQ
[worker]       ← 200 {"status":"granted","product_grant_ref":"carbon-grant-771"}
```

> "One assignment, **two** grants, on two different layers.
>
> **Layer one** is inside our platform: Postgres row-level security just opened *that one ticket's* data to *that one user*. No network call, no trust gap — we enforce our own data directly.
>
> **Layer two** is inside CARBON. We invoked the callback CARBON registered. Note what we did *not* do: we didn't tell CARBON who's allowed to do what. **We don't own CARBON's permission model and we never try to.** We signalled it — HMAC-signed, timestamped, nonce'd — and CARBON decided."

### 5.3 Access now works — and is narrow

**Browser C** — R. Iyer refreshes. He now sees full ticket data: comments, attachment, raiser identity.

**Browser A** — refresh the previously-denied CARBON page. It now loads.

> "Same user, same URL, denied ninety seconds ago. What changed is a ticket assignment.
>
> And look at the **scope**: he has that one report. Not the customer's account, not other reports, not admin. The scope was chosen **by CARBON at grant time**, from `resource_ref`."

### 5.4 Resolve → revoke

**Browser C** — R. Iyer adds a comment, then **Resolve**.

**Terminal 2:**

```
[core-service] ticket.resolved → outbox (SAME TRANSACTION as the status change)
[core-service] access_grant grt_A state=revoked   ← T1: synchronous, in-transaction, zero delay
[worker]       POST http://product-a:6001/iris/access-callback {"event":"access.revoke_requested"...}
[product-a]    signature verified ✅ → revoking carbon-grant-771
[worker]       ← 200 {"status":"revoked"}  latency=412ms
```

**Browser A** — refresh the CARBON report page. **Access denied again.**

> "That's the full cycle: raised → assigned → callback → scoped access granted → resolved → revoke callback → access genuinely gone.
>
> One detail that matters more than it looks: the status change and the revoke event are written **in the same database transaction**, via a transactional outbox. Without that, a Redis blip between 'ticket resolved' and 'enqueue revoke' means access outlives the ticket **forever**, silently. That's not a crypto failure — it's a two-phase-commit failure, and it's how this feature actually breaks in production."

### 5.5 The stronger variant — 45 seconds, this is the innovation

**Browser B — iFile.**

> "iFile does the same thing a different way, and it's the design I'd defend hardest.
>
> When the ticket was raised, **iFile minted the access capability itself** — signed with its own key, scoped to one resource, and completely **inert**: bound to nobody, usable by nobody. It handed us that sealed envelope.
>
> On assignment we did the only two things we're able to do: **bind it to the assignee and time-box it.** iFile validates it on use.
>
> Here's why that matters: **we never hold iFile's signing key.** So even if this entire platform were fully compromised — root on every container — an attacker still could not fabricate access into iFile. They could only replay a capability iFile already minted, already scoped, and still validates.
>
> The callback version can't claim that. A compromised platform can forge a correctly-signed grant for any user and any scope. We ship both because the brief asks for the callback, but this is the one that generalises — and it's reusable anywhere IRIS needs temporary access into a customer system."

### 5.6 The audit trail

Ticket detail → **History** tab.

> "Every one of those steps: state transitions, comments, both grants, both revokes — **with CARBON's actual responses and latencies**. Actor, timestamp, request id, before and after.
>
> Append-only, enforced at the database: the application role has `UPDATE` and `DELETE` revoked on this table. Even a compromised application cannot rewrite this history."

---

## 6. Minute 7:30–9:00 — Security: the negative tests

> ✅ Criteria hit: **No security holes · Multi-product isolation**

This segment is what makes the build credible. Run each test **live**.

### Test 1 — cross-product isolation

Logged in as an agent scoped to **iFile only**. Request the CARBON ticket by its exact id:

```powershell
curl -s -H "Authorization: Bearer $IFILE_AGENT_TOKEN" `
     http://localhost:4000/admin/tickets/tkt_01JQZ7YB3KX8M2N4P6R8T0V2W4 | ConvertFrom-Json
```

```json
{ "error": { "code": "ticket_not_found", "message": "No ticket with that identifier is visible to this credential.", "request_id": "req_..." } }
```

> "**404, not 403** — and that's deliberate. A 403 would confirm the ticket exists, which leaks that CARBON has a ticket with that id. 404 for both 'doesn't exist' and 'not yours' leaks nothing.
>
> And this isn't an `if` statement in our code. It's a **row-level security policy in Postgres**. If a developer forgets a `product_id` filter in a query, the failure mode is 'zero rows' — never 'another product's rows.'"

*If asked how you know RLS is genuinely on:* the app connects as a **non-owner** role, and every table is `FORCE ROW LEVEL SECURITY` — because in Postgres, table owners bypass RLS silently by default. That single missing keyword is how this exact demo would be a lie.

### Test 2 — assignee cannot reach a second ticket

As R. Iyer, assigned to CARB-1042, request a *different* CARBON ticket he isn't assigned to → comments and attachments are absent.

> "T1 access is `(user, ticket)`-specific. Being assigned one ticket grants nothing about the next one."

### Test 3 — revoked access is genuinely revoked

Take the exact launch URL that worked in §5.3 and open it again post-resolve → denied.

> "Not hidden in the UI. Denied by CARBON, on the server."

### Test 4 — replay attack

Re-send a previously valid, correctly-signed request verbatim:

```json
{ "error": { "code": "nonce_replayed", "message": "..." } }
```

Then tamper one byte of the body and re-send:

```json
{ "error": { "code": "signature_invalid", "message": "..." } }
```

> "Timestamp window is ±5 minutes, nonces are cached, and the signature covers the method and path — so a captured request can't even be replayed against a different endpoint."

### Test 5 — the database is not reachable

> "And the one that actually bites hackathon demos: Postgres, Redis, core-service and the AI service have **no published ports**. The only things on the host's public interface are nginx and the two demo products. The API surface is `/v1/*` on the gateway and nothing else."

---

## 7. Minute 9:00–11:00 — Admin portal, TAT, and per-product config

> ✅ Criteria hit: **Admin portal · TAT and performance views · Standalone platform**

### 7.1 Cross-product single pane

Dashboard: live counters across **both** products, click-through to filtered lists.

> "One support team, one view, every product. This is the thing that doesn't exist when ticketing is rebuilt per product."

Filter by product / tenant / severity / assignee / date. Open the **SLA breaches and high-severity** view.

> "This is the view a support lead actually opens in the morning. We deliberately didn't build ornate CRUD forms for things admins touch twice a year."

### 7.2 TAT — the two clocks

Analytics view.

> "TAT looks simple and isn't. We measure three things — raise to first response, raise to resolution, assignment to resolution — and we report **two different clocks side by side**.
>
> The **SLA clock** pauses: outside business hours, on weekends and holidays per that product's calendar, and whenever we're waiting on the raiser. The **customer-facing clock** never pauses — it's wall time.
>
> Both numbers are true and they measure different things. Reporting only the first gets you 'your SLA says four hours, I waited three days.' Reporting only the second punishes a team for a customer who replied on Monday.
>
> And these are **p50 and p90, not averages** — a mean hides exactly the tail you need to see."

Point at a paused ticket and show the reconstructed segment timeline.

### 7.3 Team performance

> "Top performers by rating, resolution count, TAT, SLA compliance — and **bottom performers too**, which the brief specifically asks for. That's for coaching, not punishment.
>
> One design caution we built in deliberately: our assignee scoring weights CSAT heavily, which would naturally starve lower-rated agents of the work they need to improve. So we **cap the availability penalty and reserve a share of tickets for development** — otherwise this bottom-performers list has no path upward and becomes a trap."

### 7.4 Per-product config — the zero-code proof

Product configuration → CARBON → add a category, change the widget's primary colour, **Save**.

**Browser A — reload CARBON, open the widget.** The new category and colour are there.

> "No CARBON deploy. No CARBON code change. Not even a restart. That's what makes 'zero-code' an actual claim rather than marketing — the widget's definition lives here, server-side."

---

## 8. Minute 11:00–12:00 — Close

> "Ten success criteria, all demonstrated:
>
> Standalone platform · integration API · embeddable widget in two products · SSO with no re-auth · full callback access cycle with revoke · cross-product admin portal · TAT and performance analytics · AI classification at 8 of 10 · compliance-grade audit trail · and the negative security tests you just watched fail correctly.
>
> Three things I'd point at as the real work.
>
> **One — the contract.** Six REST endpoints, HMAC auth, signed webhooks, URL-path versioning. Published with a **verifiable test vector**, so an integrator self-checks their signing code before they ever call us. Everything else was easy because that was right.
>
> **Two — access that revokes itself.** Scoped, time-bounded, auto-revoking grants, where the platform never owns the product's permission model. And in the pre-auth variant, a **fully compromised platform still can't fabricate access**. That pattern is worth more than the ticketing system it's in.
>
> **Three — isolation we can prove.** Enforced in the database, not in application `if` statements, so a forgotten filter returns zero rows instead of someone else's data. You watched it deny me live.
>
> This runs on one docker compose command. It's ready for the next IRIS product tomorrow."

---

## 9. Criteria coverage map

Every criterion, and the exact minute it is proven.

| # | Success criterion | Segment | Visible proof |
|---|---|---|---|
| 1 | Standalone platform | §7.1 | Own DB, own portal, two unrelated products integrated |
| 2 | Integration API | §3, §6 | Live widget → REST → webhook; signed curl in terminal |
| 3 | Embeddable widget | §3 | Two products, different branding, one bundle |
| 4 | SSO integration | §3 | Priya raises a ticket with **no re-auth**; identity carried in |
| 5 | Callback access flow | §5.2–5.4 | Full cycle in logs + two live access denials bracketing it |
| 6 | Admin portal | §7.1 | Cross-product counters, filters, ticket detail, user mgmt, config |
| 7 | TAT + performance | §7.2–7.3 | p50/p90 distributions, SLA %, top **and bottom** performers |
| 8 | AI classification | §4 | Live eval run: 8/10, with the 60/35 case explained |
| 9 | Audit trail | §5.6 | History tab with actor/timestamp/before-after, DB-enforced append-only |
| 10 | No security holes | §6 | Five live negative tests |

---

## 10. Fallback plans

Rehearse these. The recovery matters more than the failure.

| If this breaks | Say this, then do this |
|---|---|
| **AI service down / slow** | *"Classification is async by design — the ticket raised fine without it. Here's a pre-classified one."* Open a seeded ticket. **Never wait on a spinner in front of judges.** |
| **Access callback times out** | *"And this is the failure path — five retries with backoff, then dead-letter, then a red flag in the portal, because a failed revoke is a security incident."* Show the DLQ banner. **This failure is a feature demo.** |
| **Widget won't load in product A** | Switch to product B. *"Same bundle, second product — which also happens to prove portability."* |
| **A container is unhealthy** | `docker compose restart <svc>` in Terminal 2 and keep talking through the architecture. Do **not** watch the logs in silence. |
| **Eval score comes in under 7** | *"Below our bar on this run — and here's why that's survivable: low-confidence tickets route to human triage rather than route wrongly. The system degrades to manual, not to incorrect."* Then show the confusion matrix. **Honesty scores better than a rerun.** |
| **Everything is down** | Fall back to the recorded 3-minute screen capture (record it the night before — non-negotiable) and narrate over it. |
| **Running long at minute 9** | Cut §7.3 (team performance) and §7.4 (config). **Never cut §5 or §6.** |

---

## 11. Q&A preparation

Judges will probe the six decisions the brief says must be defended. One-breath answers:

| Question | Answer |
|---|---|
| **Why REST, not GraphQL?** | Six stable endpoints. GraphQL puts schema and runtime burden on every integrator and makes external versioning harder, not easier. REST is debuggable with curl by anyone in any language — that's what makes the zero-code tier honest. Rejected a signed event bus for the same reason: it forces every product to run a consumer. |
| **What stops a forged grant request?** | HMAC-SHA256 under a per-product secret, ±300 s window, nonce cache, signature covering method and path. And the honest limit: that trusts the platform. Which is exactly why we also built the pre-auth link, where the platform holds no signing key and **cannot** forge a grant even if fully compromised. |
| **Why JWT handoff and not OIDC/SAML?** | The product authenticated the user seconds ago. A redirect flow re-solves a solved problem, adds round-trips, and breaks in an iframe with third-party cookie blocking. OIDC is supported for products that want us to drive login. SAML we rejected — XML-DSig friction, no capability gain. |
| **What if the product's IdP goes down?** | Existing tickets stay fully viewable and workable — we snapshot raiser identity onto the ticket at raise time, so we depend on the IdP only at that instant. Only *new* SSO raises block. There's an optional email-verified break-glass path, off by default, and tickets raised that way are flagged with lower identity assurance. |
| **Why RLS over schema-per-tenant?** | If a query forgets a `product_id` filter, RLS makes the failure "zero rows," not "another tenant's rows." Schema-per-tenant means N schemas migrating in lockstep and cross-product analytics becomes a UNION regenerated on every onboarding — which kills the single-pane value. DB-per-tenant kills it outright. |
| **60% X vs 35% Y — what happens?** | Middle band: soft-route to X, flagged AI-uncertain, human confirms. Not auto-routed — 0.60 is under our 0.80 bar. Not dumped as unclassified — there's a clear leader and discarding it wastes information. We branch on **margin as well as confidence**, and both probabilities persist so misclassification is explainable. Thresholds are per-product config. |
| **Does the TAT clock pause?** | Two clocks. The SLA clock pauses outside business hours, on weekends and holidays per that product's calendar, and while waiting on the raiser. The customer-facing clock never pauses. We report both, because reporting either alone produces an argument. |
| **What's the weakest part?** | The callback mechanism trusts us — a compromised platform can forge a grant. We know, we documented it, and the pre-auth link is the answer. Second: Postgres is a single point of failure in this deployment. Production needs HA and read replicas; we didn't fake that. |
| **How long to onboard a new IRIS product?** | Zero-code: one script tag and a config entry — under an hour. Low-code with webhooks and pre-auth access: a day. Nothing on the platform side changes at all. |
| **Why polyglot — Node and Python?** | It parallelises the team, and Python is genuinely better for the AI layer. We capped the cost with one rule: **exactly one process holds a database credential.** The AI service is stateless and never opens a DB connection — which also means it can't accidentally bypass the RLS that our whole isolation story depends on. |

---

## 12. Rehearsal checklist

- [ ] Full run-through on the **demo machine**, timed, ≥ 3 times
- [ ] 3-minute backup screen recording captured and playable offline
- [ ] `docker compose down -v && up` from cold, timed — know how long a full reset takes
- [ ] Every browser tab pre-logged-in; sessions confirmed not to expire mid-demo
- [ ] Screen zoom at 150%; terminal font enlarged
- [ ] Notifications, Slack, and email silenced on the demo machine
- [ ] Seed data checked: analytics views have real distributions, not three data points
- [ ] Eval run confirmed ≥ 7/10 on the demo set
- [ ] All five negative tests confirmed failing **correctly**
- [ ] Fallback for each of §10 practised out loud
- [ ] Laptop on mains power; sleep and screensaver disabled
