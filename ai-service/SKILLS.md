# SKILLS.md — ai-service

**Stateless inference.** Takes text in, returns predictions out. Classification, embeddings, assignee scoring, drafts, summaries, retrieval.

> Read [/SKILLS.md](../SKILLS.md) first.

| | |
|---|---|
| **Stack** | Python 3.12 · FastAPI · pydantic v2 · sentence-transformers · scikit-learn · structlog |
| **Port** | 5000 — **internal only** |
| **Callers** | `worker` (all async jobs) · `core-service` (rare, synchronous only) |

---

## 1. Non-negotiables

### 🔒 This service never opens a database connection

No `psycopg`, no `sqlalchemy`, no connection string in the environment. Ever.

**Why:** RLS is applied per-session by `core-service`. A second connection is a second, unpoliced path to the data — and one forgotten `product_id` predicate in a similarity query leaks another product's ticket text into an assignee suggestion. That is the exact failure the whole isolation design exists to prevent.

**Need neighbours for retrieval?** Call back:

```python
neighbours = await core_client.post("/internal/tickets/similar", json={
    "embedding": vec, "product_id": product_id, "k": 5,   # core-service applies RLS
})
```

The extra hop is the price of having exactly one enforcement point. Pay it.

### 🔒 Stateless

No local cache of ticket data, no session state, no writes to disk except model weights loaded at boot. Any instance can serve any request; killing one loses nothing.

### 🔒 AI is suggestive, never autonomous

Every response is a *suggestion* with a confidence. This service never triggers a state change, never sends anything to a customer. **Deflection** (a user gets an answer and never files a ticket) is allowed; **auto-resolution** (closing an open ticket) is not. See [ui-spec-deltas §1.1](../docs/ui-spec-deltas.md).

### 🔒 Synthetic or anonymised training data only

Never real customer data. Seeds live in `infra/seed/`. This is an explicit requirement in the brief.

---

## 2. Folder map

| Folder | Owns |
|---|---|
| `src/api/` | FastAPI app, routers, pydantic request/response models |
| `src/classification/` | Category / severity / product classifier + confidence bands |
| `src/embeddings/` | Vector generation — shared by classification, retrieval, dedup |
| `src/assignee-scoring/` | Transparent weighted scoring |
| `src/retrieval/` | KB + past-ticket search for deflection and drafts |
| `src/draft-response/` | Human-reviewed draft generation |
| `src/summarization/` | One-line queue summaries |
| `src/stretch/` | Sentiment, anomaly detection, vision. **Not core** |
| `eval/` | Held-out sets + scoring harness. **A deliverable, not a test** |

---

## 3. API shape

Every endpoint is a pure function: same input → same output. No side effects.

| Endpoint | Returns |
|---|---|
| `POST /classify` | product, category, severity, each with `p1`, `p2`, `margin`, `decision` |
| `POST /embed` | `vector(384)` — returned to core-service for storage, never stored here |
| `POST /summarize` | one line, ≤ 120 chars |
| `POST /score-assignees` | ranked candidates **with per-factor contributions** |
| `POST /draft-response` | draft text + the source tickets it drew from |
| `POST /retrieve` | ranked KB articles / past tickets with scores |

```python
class ClassifyResponse(BaseModel):
    category: LabelPrediction
    severity: LabelPrediction
    product:  LabelPrediction
    model_version: str          # ALWAYS returned — stored on the ticket for explainability

class LabelPrediction(BaseModel):
    label: str
    p1: float
    p2: float
    margin: float               # p1 - p2
    runner_up: str
    decision: Literal["auto_route", "soft_route", "triage"]
```

**Always return `model_version`.** `core-service` persists it. Without it, "why did it classify this way in March?" is unanswerable after a model swap.

---

## 4. Confidence bands — the decision the brief asks us to defend

Two numbers, never one. A prediction that is 60% confident and 2% ahead of second place is a completely different thing from one that is 60% confident and 30% ahead.

| Condition | `decision` |
|---|---|
| `p1 ≥ 0.80` **and** `margin ≥ 0.25` | `auto_route` |
| `0.50 ≤ p1 < 0.80` **or** `margin < 0.15` | `soft_route` — flagged AI-uncertain |
| `p1 < 0.50` | `triage` — human |

**The brief's worked example, 60% X / 35% Y:** `p1=0.60`, `margin=0.25` → `soft_route`. Not auto-routed (below the 0.80 bar); not dumped as unclassified (a clear leader exists, and discarding it makes a human redo work the model already did).

> **Thresholds are config, not code.** They arrive in the request from `product.config.ai_thresholds`. Never hardcode `0.80` in a module — a per-product tuning knob that requires a deploy is not a knob.

---

## 5. Assignee scoring — transparency is the feature

```python
{"support_user_id": "su_01JQ", "score": 0.82, "factors": {
    "domain_fit": {"value": 0.91, "weight": 0.40, "contribution": 0.364},
    "csat":       {"value": 0.94, "weight": 0.25, "contribution": 0.235},
    "speed":      {"value": 0.71, "weight": 0.20, "contribution": 0.142},
    "availability":{"value": 0.39,"weight": 0.15, "contribution": 0.059}}}
```

**Always return the factor breakdown.** A manager who cannot interrogate a suggestion will not trust it, and an untrusted suggestion is dead weight.

> ### ⚠️ Deliberate fairness cap
> Weighting CSAT heavily optimises short-term satisfaction but **starves lower-rated agents of the work they need to improve** — and then the "bottom performers" view in the admin portal has no path upward, which makes it a trap rather than a coaching tool.
> **Cap the availability penalty and reserve a share of tickets for development.** This is a design choice, not an oversight — say so if asked.

---

## 6. The eval harness is a deliverable

```powershell
python eval/run_eval.py --set demo10     # must print >= 7/10 — a scored criterion
python eval/run_eval.py --set full       # regression set, run before every model change
```

- **Build it before the model.** Eval-first means every subsequent change is measurable instead of vibes.
- Prints per-field accuracy **and a confusion matrix** — "which intents are we worst at" is more actionable than a single number, and it feeds the AI Insights page's *Top Misclassified Intents* panel.
- **The live AI Insights page reads from this same code.** One accuracy definition, not two that disagree.
- It runs in the demo (§4 of [demo-script.md](../docs/demo-script.md)). A reproducible number beats a claim.

---

## 7. Operational rules

| Rule | Why |
|---|---|
| Load models **once at startup**, never per request | Cold-loading a transformer per request is a 3 s response |
| Return `503 service_unavailable` while models load | Fail honestly; the worker retries |
| **Timeout every call** (default 10 s) | A hung inference must not hold a worker slot |
| Batch embeddings when the caller sends many | 10× throughput on the same hardware |
| Pin every dependency in `requirements.txt` | A transformer minor bump silently changes vectors, and stored vectors stop matching new ones |
| Log `request_id` on every line | Traces the classification back to the ticket |
| Never log raiser text at info level | Ticket bodies contain customer PII |

**Degradation contract:** if this service is down, tickets still raise and land unclassified in triage. The workflow never depends on AI being up — that is a design property worth protecting in every change.

---

## 8. Common mistakes

| ❌ Don't | ✅ Do |
|---|---|
| Add a DB client "just for similarity search" | `POST /internal/tickets/similar` on core-service |
| Hardcode confidence thresholds | Take them from the request payload |
| Return only the top label | Return `p1`, `p2`, `margin`, `runner_up`, `decision` |
| Return a bare score for an assignee | Return the factor breakdown |
| Load a model inside a handler | Load at startup, into app state |
| Skip `model_version` | Always return it — explainability depends on it |
| Train on real ticket data | Synthetic/anonymised only. This is in the brief |
| Let a stretch feature (vision, anomaly) block core | `src/stretch/` is genuinely optional |

---

## 9. Definition of done

- [ ] No DB driver imported anywhere in this service
- [ ] Endpoint is a pure function; no side effects, no persisted state
- [ ] pydantic models for request **and** response
- [ ] Thresholds/weights read from the request, not hardcoded
- [ ] `model_version` returned
- [ ] `eval/run_eval.py --set demo10` still ≥ 7/10
- [ ] Deps pinned; `requirements.txt` updated
- [ ] Structured logs with `request_id`; no PII at info level
