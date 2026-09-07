# ai-service — build TODO

**Status: not built.** This document is the contract. No Python exists yet, deliberately — the widget, gateway and core-service ship and work fully without this service, and everything below is additive.

> Read [ai-service/SKILLS.md](SKILLS.md) before writing code here, and [ADR-005](../docs/adr/005-ai-confidence-thresholds.md) / [ADR-007](../docs/adr/007-polyglot-topology-one-db-credential.md) / [ADR-009](../docs/adr/009-deflection-is-not-auto-resolution.md) for the decisions that constrain it.

| | |
|---|---|
| **Stack** | Python 3.12 · FastAPI · pydantic v2 · sentence-transformers · scikit-learn |
| **Available now** | `shared/hmac-utils/py` (`iris_hmac`) — already built and vector-tested, if this service ever needs to sign a call to the platform |
| **Port** | 5000 — internal only, never publicly bound |
| **Callers** | `worker` (async jobs) · `core-service` (synchronous, rare) |

---

## The two invariants that constrain every endpoint

### 🔒 1. No database credential. None.

No `psycopg`, no `sqlalchemy`, no connection string in the environment — not even a wrong one. The env var must be **absent**, so a mistake fails at boot rather than silently opening a second, unpoliced path to the data.

**Why it matters concretely:** RLS is applied per-session by `core-service`. A similarity query written here that forgets a `product_id` predicate would leak one product's ticket text into another product's customer-facing answer. That is the exact failure the whole isolation design exists to prevent, and it would not raise an error.

**Need neighbours?** Call back:

```python
neighbours = await core_client.post("/internal/tickets/similar", json={
    "embedding": vec, "product_id": product_id, "k": 5,
})   # core-service runs the query inside an RLS-scoped transaction
```

The extra hop is the price of one enforcement point. Pay it.

### 🔒 2. Thresholds and weights arrive in the request

Never hardcode `0.80` in a module. They come from `product.config.ai_thresholds` / `assignee_weights`, passed by the caller. A per-product tuning knob that needs a deploy is not a knob.

---

## Endpoints to build

### 1. `POST /classify` — category, severity, product

Used by `worker` on `ticket.created`. **Highest priority** — it is the scored criterion (≥7/10).

<details open>
<summary>Request</summary>

```json
{
  "request_id": "req_01JQZ8X5N3",
  "product_id": "prod_carbon",
  "text": "Cannot export the Q3 emissions report — the download button returns a 500.",
  "subject": "Q3 export fails",
  "candidate_categories": [
    {"value": "login_access", "label": "Login / Access"},
    {"value": "reports", "label": "Reports & Exports"},
    {"value": "data_mismatch", "label": "Data Mismatch"}
  ],
  "thresholds": { "auto_route_p1": 0.80, "auto_route_margin": 0.25, "triage_floor": 0.50 }
}
```
</details>

<details open>
<summary>Response</summary>

```json
{
  "category": {
    "label": "reports", "p1": 0.91, "p2": 0.05, "margin": 0.86,
    "runner_up": "data_mismatch", "decision": "auto_route"
  },
  "severity": {
    "label": "high", "p1": 0.88, "p2": 0.57, "margin": 0.31,
    "runner_up": "medium", "decision": "auto_route"
  },
  "product": {
    "label": "prod_carbon", "p1": 0.99, "p2": 0.01, "margin": 0.98,
    "runner_up": null, "decision": "auto_route"
  },
  "model_version": "clf-2026.07-a3f2c1",
  "latency_ms": 84
}
```
</details>

**`decision` is computed here, not by the caller**, from the thresholds in the request:

| Condition | `decision` |
|---|---|
| `p1 ≥ auto_route_p1` **and** `margin ≥ auto_route_margin` | `auto_route` |
| `p1 ≥ triage_floor` (but not the above), **or** `margin < 0.15` | `soft_route` |
| `p1 < triage_floor` | `triage` |

**Always return `model_version`.** `core-service` persists it on the ticket. Without it, "why did it classify this way in March?" is unanswerable after a model swap.

**Errors:** `503` while models load (worker retries) · `422` on empty text.

---

### 2. `POST /embed` — vectors

Called by `worker` after classification, and by `/retrieve`. The vector is **returned, never stored here** — `core-service` writes it to `ticket.embedding` / `kb_article.embedding` (both `vector(384)`, already migrated).

```jsonc
// Request
{ "request_id": "req_...", "texts": ["...", "..."], "kind": "ticket" }

// Response
{ "embeddings": [[0.0123, -0.0456, "…384 floats"]], "dimensions": 384,
  "model_version": "all-MiniLM-L6-v2", "latency_ms": 31 }
```

Batch when the caller sends many — roughly 10× throughput on the same hardware.

---

### 3. `POST /retrieve` — semantic search behind deflection

**This one has a live counterpart already.** `core-service` currently answers `/v1/widget/ask` with Postgres full-text (`tsvector` + trigram) ranking. This endpoint upgrades that ranking to hybrid; **the widget and the public API contract do not change.**

```jsonc
// Request
{ "request_id": "req_...", "product_id": "prod_carbon",
  "query": "why is my invoice not showing",
  "candidates": [                      // core-service supplies these, RLS-scoped
    { "id": "kb_01J...", "type": "kb_article", "title": "...", "text": "...",
      "embedding": [0.01, "…"], "lexical_score": 0.42 }
  ],
  "k": 4 }

// Response
{ "results": [ { "id": "kb_01J...", "type": "kb_article",
                 "score": 0.87, "lexical": 0.42, "semantic": 0.93 } ],
  "model_version": "all-MiniLM-L6-v2", "latency_ms": 22 }
```

> **Swap-in point:** `core-service/src/knowledge-base/kb.repo.ts` `searchArticles()` and `searchResolvedTickets()` currently rank on `ts_rank * 4 + similarity(title, q)`. When this endpoint exists, blend the semantic score in there — a single call site.

---

### 4. `POST /summarize` — one line for the queue view

```jsonc
// Request
{ "request_id": "req_...", "text": "…full ticket description…", "max_chars": 120 }

// Response
{ "summary": "Q3 emissions report export returns HTTP 500 on download.",
  "model_version": "sum-2026.07", "latency_ms": 140 }
```

Hard cap at `max_chars`; truncate on a word boundary, never mid-word.

---

### 5. `POST /score-assignees` — ranked, with reasons

```jsonc
// Request
{ "request_id": "req_...", "product_id": "prod_carbon",
  "ticket": { "category": "reports", "severity": "high", "embedding": [0.01, "…"] },
  "candidates": [
    { "support_user_id": "su_01J...", "skills": ["reports","xbrl"],
      "avg_csat": 4.7, "avg_tat_seconds": 11400, "open_workload": 12,
      "resolved_similar": 34, "past_resolved_embeddings": [[0.02, "…"]] }
  ],
  "weights": { "domain_fit": 0.40, "csat": 0.25, "speed": 0.20, "availability": 0.15 } }
```

```jsonc
// Response — the factor breakdown is REQUIRED, not optional
{ "ranked": [
    { "support_user_id": "su_01J...", "score": 0.82,
      "factors": {
        "domain_fit":   { "value": 0.91, "weight": 0.40, "contribution": 0.364 },
        "csat":         { "value": 0.94, "weight": 0.25, "contribution": 0.235 },
        "speed":        { "value": 0.71, "weight": 0.20, "contribution": 0.142 },
        "availability": { "value": 0.39, "weight": 0.15, "contribution": 0.059 }
      } } ],
  "model_version": "score-2026.07", "latency_ms": 12 }
```

**Always return `factors`.** A manager who cannot interrogate a suggestion will not trust it, and an untrusted suggestion is dead weight in the UI.

> ⚠️ **Deliberate fairness cap.** Weighting CSAT heavily optimises short-term satisfaction but starves lower-rated agents of the work they need to improve — and then the admin portal's "bottom performers" view has no path upward and becomes a trap. **Cap the availability penalty and reserve a share of tickets for development.** This is a design choice; say so if asked.

---

### 6. `POST /draft-response` — human-reviewed, never auto-sent

```jsonc
// Request
{ "request_id": "req_...", "ticket": { "subject": "...", "description": "..." },
  "similar_resolved": [ { "id": "tkt_...", "problem": "...", "resolution": "..." } ],
  "tone": "professional" }

// Response
{ "draft": "Hi Priya,\n\nThanks for flagging this…",
  "sources": ["tkt_01JQZ4M2N1", "kb_01JQZ8Z7R5"],
  "confidence": 0.74, "model_version": "draft-2026.07", "latency_ms": 890 }
```

**`sources` is mandatory** — a draft an agent cannot trace is a draft they must rewrite from scratch.

The response is **placed in an editor**. It is never sent, and this endpoint never transitions a ticket. See [ADR-009](../docs/adr/009-deflection-is-not-auto-resolution.md).

---

### 7. `GET /health` and `GET /health/ready`

`/health` is liveness only — do **not** check dependencies, or one slow model load takes the service out of rotation. `/health/ready` reports whether models are loaded.

---

## Cross-cutting requirements

| Requirement | Detail |
|---|---|
| **Load models once at startup** | Cold-loading a transformer per request is a 3-second response |
| **Return `503` while loading** | Fail honestly; the worker retries |
| **Every response carries `model_version` and `latency_ms`** | Explainability and performance tracking |
| **Timeout every call** | Callers use 10s; do not exceed it |
| **Pin every dependency** | A transformer minor bump silently changes vectors, and stored embeddings stop matching new ones |
| **Structured logs with `request_id`** | The cross-service trace is the audit story |
| **Never log ticket text at info level** | Descriptions contain customer PII |
| **Synthetic / anonymised training data only** | Explicit requirement in the brief. Seeds in `infra/seed/` |

**Degradation contract:** if this service is down, tickets still raise and land unclassified in triage, and `/v1/widget/ask` still returns lexical results. The workflow never depends on AI being up — protect that property in every change.

---

## `eval/` — a deliverable, not a test

```bash
python eval/run_eval.py --set demo10   # must print >= 7/10 — the scored criterion
python eval/run_eval.py --set full     # regression set, before every model change
```

- **Build this before the model.** Eval-first makes every subsequent change measurable instead of vibes.
- Print per-field accuracy **and a confusion matrix** — "which intents are we worst at" is more actionable than one number, and it feeds the admin portal's *Top Misclassified Intents* panel.
- **The live AI Insights page reads from this same code.** Two accuracy definitions will disagree, and the one on screen during the demo will be the wrong one.

## Build order

1. `eval/` harness + synthetic labelled set
2. `/health`, `/embed` — smallest useful surface
3. `/classify` — the scored criterion
4. `/summarize`
5. `/retrieve` — then blend into `kb.repo.ts`
6. `/score-assignees`
7. `/draft-response`
