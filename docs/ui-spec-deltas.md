# UI Mockup Reconciliation — deltas against the HLD

> ## ✅ Superseded — folded into the HLD on 2026-07-26
>
> **This is no longer a live spec.** Every decision below has been folded into [HLD.md](HLD.md) (see §6 of this document for the map), the API gaps are closed in [api-contract.md](api-contract.md), and the three most contested decisions now have their own ADRs: [009](adr/009-deflection-is-not-auto-resolution.md), [010](adr/010-automations-fixed-catalogue.md), [011](adr/011-live-chat-deferred.md).
>
> **[HLD.md](HLD.md) is the single authoritative baseline.** Where this document and the HLD disagree, **the HLD now wins.**
>
> This file is retained as the **rationale record** — it holds the reasoning for *why* the HLD says what it now says, particularly the three contradictions in §1. Read it for background, not for instructions.

**Source:** `docs/images/Image.jpg` (Admin Panel, 9 pages) · `docs/images/Image (1).jpg` (AI Support Widget)
**Original purpose:** the mockups introduced capabilities the HLD did not describe, and in three places *contradicted* it. Every delta was listed here with a decision so nobody built against a stale assumption.

---

## 1. Contradictions — resolve these first

### 1.1 🔴 "Auto Resolved: 742" vs "AI is never autonomous"

The dashboard shows an **Auto Resolved** counter and a **Deflection Rate** of 22%. HLD §15 states a hard rule: *AI is suggestive, never autonomous on anything customer-facing; drafts are never auto-sent.* The brief agrees: *"must be reviewed by a human before sending, never auto-sent."*

These are reconcilable, but only if we are precise about which is which:

| Concept | Definition | Allowed? |
|---|---|---|
| **Deflection** | The user asks the widget a question, gets a KB/AI answer, and **never files a ticket**. No ticket exists, so nothing was auto-resolved. | ✅ **Yes** — this is the 22% |
| **Auto-resolution** | An AI response is sent on an **open ticket**, and the ticket is moved to `resolved` without a human | ❌ **No** — violates the brief |

**Decision:** the counter is renamed **"Self-Served"** (or "Deflected"), and it counts widget conversations that closed without a ticket. It never counts tickets. The metric card links to the deflection log, not to a ticket list.

> If a judge sees "Auto Resolved" next to a claim that AI never auto-sends, that is a credibility hit we do not need to take. Rename it.

### 1.2 🟠 Ticket statuses: mockup shows `On Hold`, has no `assigned`

Mockup statuses: `Open`, `In Progress`, `Resolved`, `On Hold`. HLD §10: `open → assigned → in_progress → waiting_on_raiser → resolved → closed`.

**Decision — keep the HLD state machine, map it for display:**

| Stored status | Displayed as | Note |
|---|---|---|
| `open` | Open | |
| `assigned` | Open · *assigned* | Assignment is a **fact about the ticket** (`assignee_id`), not a display status. The Assignee column already shows it. |
| `in_progress` | In Progress | |
| `waiting_on_raiser` | **On Hold** | This is the mockup's "On Hold". SLA clock pauses here (HLD §14) |
| `resolved` | Resolved | |
| `closed` | Closed | |

`assigned` stays in the state machine because it is the trigger for the dual JIT grant (HLD §13) — collapsing it would destroy the access model. It simply is not a filter chip in the UI.

### 1.3 🟠 "Priority" (UI) vs "severity" (brief, API, DB)

The mockup's Tickets table has a **Priority** column with High/Medium/Low. The brief and API say **severity**.

**Decision:** `severity` is the stored and API name — it is what the brief asks us to defend and what the contract publishes. **"Priority" is a display label only.** One mapping constant in `admin-panel/src/lib/labels.ts`; nowhere else. Do not introduce a second field.

---

## 2. New first-class modules the mockups introduce

### 2.1 🆕 Knowledge Base — was a stretch goal, now a core page

Mockup page 5: articles with Category, Views, Helpful %, Status (Published/Draft).

| | |
|---|---|
| **New module** | `core-service/src/knowledge-base/` |
| **Data** | `kb_article` (product_id, title, body, category, status, views, helpful_yes/no, embedding vector(384)) |
| **Why it graduated** | It is the engine behind widget deflection (§2.4). Without KB content there is nothing to deflect *to*, and the 22% metric is unreachable. |
| **Scope guard** | Article CRUD + search + helpful-vote. **AI-suggested new articles from resolved tickets stays a stretch goal.** |

### 2.2 🆕 Automations — a rules engine, in neither the brief nor the HLD

Mockup page 6: `Automation Name / Trigger / Action / Status` with rows like *High Priority Auto Escalation*, *SLA Breach Alert*, *Sentiment Escalation*, *Auto Assign by Category*, *Auto Close Resolved*.

| | |
|---|---|
| **New module** | `core-service/src/automations/` |
| **Model** | `automation_rule` (product_id, name, trigger, conditions jsonb, action, action_config jsonb, is_active) |
| **Execution** | Rules evaluate **off the outbox event stream** in `worker`, never inline in the request path. A slow or looping rule must never delay a ticket write. |
| **Scope guard — important** | Build it as a **fixed catalogue of ~6 trigger types and ~5 action types with a toggle and simple conditions.** Do **not** build a general-purpose visual rule builder. That is a product in itself and it will consume the whole build. |

**Loop protection is mandatory:** an action that mutates a ticket emits an event that can re-trigger a rule. Every automation-originated mutation carries `actor_type='automation'` and rule execution skips events whose actor is an automation. Cap at 3 rule executions per event chain.

### 2.3 🆕 Agent skills

Mockup page 4 has a **Skills** column per agent (ERP, Reports, XBRL, Data, Access, Performance, Infra).

**Decision:** add `support_user_skill (support_user_id, skill, proficiency)`. This feeds the *domain fit* factor in assignee scoring (HLD §15.1) as an explicit signal alongside the learned embedding similarity — and unlike the embedding, a manager can see and edit it. Good for trust, cheap to build.

### 2.4 🔺 Widget scope expansion — the biggest delta

HLD §6 describes a **raise-ticket form**. The mockup is a **conversational AI support assistant**: Ask a Question · Create a Ticket · Search Docs · My Tickets · Upload Screenshot · Live Chat · AI Suggestions · Announcements, with an intent → KB search → answer → handoff pipeline.

This is roughly 4× the original widget. Ranked by value-to-cost:

| Capability | Verdict | Reasoning |
|---|---|---|
| **Create a Ticket** | ✅ **P0** | The mandated core. Never at risk. |
| **My Tickets** | ✅ **P0** | Trivial — one list call against an existing endpoint |
| **Ask a Question / Search Docs** | ✅ **P1** | This *is* deflection, and it is the innovation the mockup is selling. Retrieval over KB + resolved tickets, both already embedded for other reasons — high reuse, low marginal cost |
| **AI Suggestions** (pre-submit) | ✅ **P1** | Same retrieval pipeline as above, shown before submit. Also a brief stretch goal. Near-free once P1 exists |
| **Upload Screenshot** | 🟡 **P2** | Attachment upload is P0 anyway; *vision understanding* of it is the stretch. Ship upload, add vision only if time |
| **Announcements** | 🟡 **P2** | Simple per-product message list. Cheap, low value. Cut without hesitation |
| **Live Chat** | 🔴 **P3 — stub it** | A realtime subsystem: WebSocket transport, presence, agent routing, typing state, transcript persistence, reconnect. **This is the single largest scope risk in the mockup.** Ship the button; it converts the conversation into a ticket and says "an agent will pick this up." Real-time chat is a post-hackathon feature. |

> **The brief's own warning applies here:** *"skipping the core to chase stretch goals is not [fine]."* The widget mockup is aspirational UI. Build P0 and P1; stub P3 honestly rather than half-building it.

**Context-awareness** ("understands the product you're in") is already free — the publishable key identifies the product, and `metadata` on the raise call carries the page/route (api-contract §5.1).

---

## 3. New analytics the mockups require

The **AI Insights** page (mockup page 3) is genuinely useful and mostly free, because HLD §15.3 already mandates an eval harness:

| Metric | Source | Note |
|---|---|---|
| AI Classification Accuracy (91.2%) | `ai-service/eval/` scored against human-corrected classifications | Same harness as the 7/10 criterion. **Feed the live page from the same code that prints the demo score.** |
| Avg Confidence Score (87%) | mean `p1` over the window | |
| Auto-Routing Rate (68%) | share landing in the `p1 ≥ 0.80 ∧ margin ≥ 0.25` band | Directly visualises the HLD §15.2 thresholds |
| Deflection Rate (22%) | widget conversations closed without a ticket | See §1.1 — not "auto resolved" |
| Confidence Distribution (High/Med/Low) | histogram of `p1` | Maps 1:1 to the three routing bands |
| **Top Misclassified Intents** | corrections made in triage | 🌟 The best thing on the page. It closes the loop: a human fixes a label, the system learns which intents it is worst at. Show this to judges. |

**SLA Health** adds an **At Risk** state (`On Track / At Risk / Breached`) that the HLD does not have. Add a warning threshold — **at risk = ≥ 80% of the SLA target consumed and not yet resolved** — because a breach dashboard that only shows breaches is a post-mortem tool, not an operational one.

---

## 4. Smaller items

| # | Mockup shows | Decision |
|---|---|---|
| 1 | Ticket ids `#TCK-10248` (global prefix) | **Use a per-product prefix** — `CARB-1042`, `EDU-2087`. A global sequence leaks cross-product volume to any customer who can see two references, and per-product reads better in a multi-product platform. Keep `tkt_…` as the API id. |
| 2 | "Requester" | Display label for `raised_by` / raiser. API name unchanged. |
| 3 | Three products embedded (ERP, HRMS, Finance) | The brief requires **two** sample products. Build two; the third is a mockup flourish. |
| 4 | "3 Incidents Detected" | Anomaly detection — **stretch goal**, `ai-service/src/stretch/`. Do not build in the core phases. |
| 5 | Settings → AI Model Settings | Already exists as `product.config.ai_thresholds` (HLD §8.2). Just build the screen. |
| 6 | Settings → Integrations | The per-product config screen (HLD §12.5). Same thing, different label. |
| 7 | Agent "Availability: Available / Busy" | Add `support_user.availability`. Feeds the availability factor in assignee scoring — and lets an agent mute themselves, which the scoring model needs anyway. |
| 8 | Audit Logs page filters by User + Action | Already supported by the `audit_event` schema. Index `(product_id, occurred_at desc)` and `(actor_ref, occurred_at desc)`. |

---

## 5. Impact on the build plan

Two modules and one widget expansion were added. Nothing was removed. Re-fit into HLD §18 without displacing core work:

| Phase | Change |
|---|---|
| 0–3 | **Unchanged.** Foundations, contract, access boundary, widget-P0 + SSO. These are the scored criteria and they stay first. |
| 4 (Admin portal) | Now 9 pages instead of 5. **Build in mockup order and stop when time runs out:** Dashboard → Tickets → Ticket Detail → Agents → Audit Logs → AI Insights → Analytics → Settings → KB → Automations. Ticket Detail still gets the most polish — it alone answers four success criteria. |
| 5 (Notifications) | Unchanged |
| 6 (AI) | Add **retrieval** (`ai-service/src/retrieval/`) for KB + past-ticket search. Reuses the embedding pipeline already built for classification — genuinely incremental |
| **6.5 (new)** | Knowledge Base CRUD + widget deflection (P1). Do this **only after** every §5 success criterion demonstrably passes |
| **7 (new)** | Automations — fixed catalogue, toggles only |
| Stretch | Live Chat, vision-on-screenshots, anomaly detection, AI-suggested KB articles |

> **Rule for the whole team:** a mockup is a promise about the *finished* product. The hackathon deliverable is the **scored** product. Where the two compete, the [demo-script.md](demo-script.md) criteria map wins — every time.

---

## 6. Amendment map — all complete

Every item below was folded into the HLD on 2026-07-26. This table is now a record of where each decision landed.

| HLD § | Amendment | Status |
|---|---|---|
| §2 | Traceability — added a "beyond the brief" table marking these as additions, not requirements | ✅ Done |
| §3.6 | **New** — the three contradictions and their resolutions, keeping §3 as the single "what changed and why" narrative | ✅ Done |
| §6.1 | **New** — widget P0–P3 capability table replacing the raise-ticket-form description | ✅ Done |
| §8.1 | Data model — added `kb_article`, `automation_rule`, `support_user_skill`, `widget_conversation`; `availability` on `support_user` | ✅ Done |
| §8.2 | Config — added `knowledge_base`, `automations`, `deflection` keys | ✅ Done |
| §10.1 | **New** — stored vs displayed status, incl. `waiting_on_raiser` → "On Hold" | ✅ Done |
| §11.2 | Added the `automation.evaluate` queue | ✅ Done |
| §12 | Admin portal — 5 views became 9 pages with the build-order and stop-when-time-runs-out rule | ✅ Done |
| §12.1 | **New** — Automations as a fixed catalogue, incl. mandatory loop protection | ✅ Done |
| §14 | SLA — added the **At Risk** state (≥ 80% consumed) | ✅ Done |
| §15 | Restated the autonomy boundary as an explicit deflection vs auto-resolution table | ✅ Done |
| §15.4 | **New** — retrieval and deflection pipeline | ✅ Done |
| §15.5 | **New** — AI Insights, reading from the same code as the eval harness | ✅ Done |
| §18 | Build plan — inserted phases 6.5 (KB + deflection) and 7 (Automations); stretch became phase 8 | ✅ Done |
| §19 | Risk register — added widget scope expansion and automation loop risks | ✅ Done |
| Appendix A | ADR index expanded from 8 to 11, all written | ✅ Done |

**Also closed:** [api-contract.md](api-contract.md) gained `POST /v1/widget/ask` (§5.8), `GET /v1/kb/articles` (§5.9), the corrected publishable-key scope (§3.4), new error codes and a deflection rate-limit bucket, and an informational §11 marking `/admin/*` as outside the integration contract.
