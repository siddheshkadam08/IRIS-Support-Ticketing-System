# IRIS AI Integration — End-to-End Implementation Plan

**Document type:** Master implementation/context document  
**Project:** IRIS Intelligent Support Ticketing Platform  
**Purpose:** Long-term source of truth for understanding, designing, implementing, testing, and verifying the AI capabilities being integrated into IRIS.

---

## 1. Purpose of This Document

This document is the working memory for the IRIS AI implementation.

The goal is **not** to copy the reference application's implementation. The goal is to:

1. Understand each completed reference capability deeply.
2. Audit what IRIS already has.
3. Identify what can be reused.
4. Identify gaps.
5. Design the IRIS-native architecture.
6. Discuss trade-offs before implementation.
7. Implement one phase at a time.
8. Test and verify each phase end-to-end.
9. Record architectural decisions so future work does not lose context.

### Working principle

> **AI predicts/extracts. IRIS decides.**

The AI layer must not become the owner of authentication, tenant isolation, business rules, audit, or critical ticket decisions.

---

# 2. Scope

This document covers **AI integration only**.

It includes:

- AI foundation
- AI service architecture
- Core ↔ AI contracts
- BullMQ orchestration
- AI service authentication
- AI reliability
- Ticket classification
- Sentiment
- Keywords/tags
- AI conclusion/summary
- Next-step recommendations
- Confidence
- Deterministic priority/severity/routing
- Embeddings
- Hybrid retrieval
- Reranking
- RAG
- Similar tickets
- Agent copilot
- Assignee recommendation
- AI governance and analytics

It does **not** become the master roadmap for unrelated IRIS product features such as the complete SLA/automation/notification/product roadmap.

---

# 3. Current IRIS Architecture Baseline

## 3.1 Destination project

The destination is the actual IRIS Node.js/TypeScript product.

It is **not .NET Core**.

### Runtime

- Node.js >= 22
- TypeScript 5.9.3
- ESM
- `tsx`
- Backend has no separate build step

### Backend

- Fastify 5.10
- Gateway
- Core Service
- `@fastify/cors`
- `@fastify/multipart`
- `@fastify/static`
- `zod`
- `pino`
- `jose`
- `pg`
- `ioredis`

### Database

- PostgreSQL 17
- pgvector extension
- pg_trgm
- pgcrypto
- Raw SQL
- No ORM
- Hand-written forward-only migrations

### Queue/cache

- Redis 7
- BullMQ will be introduced for AI processing
- Redis currently exists primarily for rate limiting
- Redis persistence is currently disabled

### Frontend

Widget:

- Vanilla TypeScript
- Zero runtime dependencies
- Vite
- Plain CSS custom properties

Admin:

- React 18.3.1
- React Router 7.18
- TanStack Query 5.101
- Vite
- Handwritten CSS

### Security

Existing infrastructure includes:

- Authentication
- JWT/JWKS
- RLS
- HMAC utilities
- encrypted tenant secrets
- audit logging
- transactional outbox
- request validation
- structured logging/redaction
- timing-safe cryptographic operations

---

# 4. Existing IRIS AI-Relevant Foundation

The destination repository is intentionally ahead of its AI implementation.

Existing reusable pieces include:

- ticket AI-related columns
- `classification_source`
- ticket summary plumbing
- sentiment-related schema
- AI threshold configuration declaration
- vector columns
- pgvector extension
- existing search using FTS + pg_trgm
- event outbox
- outbox attempt tracking
- audit JSONB
- `withScope`
- `writeAudit`
- `emitEvent`
- HMAC utilities
- tenant/product configuration
- ticket creation hooks
- ticket assignment/comment hooks

### Important

Do **not** recreate these mechanisms simply because the reference project has separate implementations.

Extend IRIS's existing foundations where appropriate.

---

# 5. Reference Project Capability Audit

The reference project contains real AI capabilities. It is a source of functional behavior and lessons, not a codebase to copy blindly.

## 5.1 Completed capabilities

The reference project has completed:

1. Ticket intake and attachments
2. Multi-provider authentication/JWT/session audit
3. Ticket lifecycle/status/assignment/comments/internal notes/history
4. JIT access grants
5. Append-only audit
6. Attachment storage
7. Transactional outbox and SMTP worker except `agent_reply`
8. Admin hierarchy
9. OData query surface
10. DB-backed operations dashboard
11. AI ticket classification with 14 fields
12. Deterministic priority engine over extracted factors
13. Deterministic severity/team routing with confidence-gated routing
14. AI one-line summary
15. RAG draft replies with three tones and cited sources
16. Hybrid assignee ranking with explainable factors
17. Two-stage retrieval: pgvector then cross-encoder reranking
18. RAG corpus indexing of resolved tickets and KB articles
19. Graceful degradation with heuristic fallback and kill switch

## 5.2 Partial capabilities

The reference project has partial implementation for:

- Email notifications: 7/8 events; `agent_reply` broken
- CSAT: works but token is optional/forgeable
- Image attachment AI: endpoint exists, but backend does not populate `AttachmentContext`
- AI field correction: captured in audit but consumed by nothing
- KB ingest API: complete, but no UI to author/manage
- RLS policies: correct but neutralized at runtime
- Product configuration API: complete, UI unrouted

## 5.3 Placeholder/fake capabilities

These must **not** be treated as completed AI capabilities:

- Ask a Question = PostgreSQL FTS + trigram
- AI Suggestions = same search path
- Upload Screenshot/Get AI Help = file picker only
- Self-service metric = lexical threshold, not true AI success
- Some analytics are fabricated/deterministic:
  - correction rate
  - per-field average confidence
  - confidence last 7 days
  - TAT percentiles
- pgvector exists but was not actually used end-to-end:
  - extension exists
  - vector columns exist
  - no vectors written/read
  - no ANN index
  - no real similarity search pipeline

## 5.4 Reference testing limitations

Reference testing includes strong deterministic AI-core tests, but significant plumbing remains untested:

- AI HTTP endpoints
- repositories
- real model clients
- .NET backend integration
- frontends
- some AI services
- summary service
- end-to-end production paths
- CI

Therefore reference behavior must still be independently validated when recreated in IRIS.

---

# 6. Frozen Architecture Decisions

## ADR-001 — Separate Python AI Service

**Decision:** Use a separate Python AI service.

### Why

- Python ecosystem is strong for AI/ML
- Keeps model/provider concerns outside the Node Core
- Allows future embedding/reranker/local-model integration
- Separates AI failure from core ticketing
- Keeps the core service focused on domain/business logic

### Non-negotiable rule

> Python AI Service must not connect directly to PostgreSQL.

Core owns database access.

---

## ADR-002 — Event + BullMQ

**Decision:** Use asynchronous event processing through BullMQ.

### Target flow

```text
Ticket API
   ↓
Core Service
   ↓
DB transaction
   ├── Ticket
   ├── Audit
   └── Outbox event
          ↓
      Outbox dispatcher
          ↓
        BullMQ
          ↓
      AI Worker
          ↓
   Python AI Service
          ↓
      AI result
          ↓
      Core Service
          ↓
 Validation + rules + audit
          ↓
      PostgreSQL
```

### Why

Ticket creation must not depend on:

- LLM latency
- provider availability
- model rate limits
- AI network failures
- AI service restarts

A ticket should be created even when AI is temporarily unavailable.

---

## ADR-003 — One AI Queue Initially

Start with **one AI queue**.

The job envelope must include a `feature` field.

Example future features:

```text
classification
summary
embedding
sentiment
rag
similar_ticket
assignee_recommendation
```

This avoids prematurely creating multiple queues while preserving the ability to split queues later if workload characteristics require it.

---

## ADR-004 — Separate Current AI State and AI Execution History

Reuse existing ticket AI columns for the ticket's current state.

Introduce a dedicated AI execution/audit model for execution history.

Conceptually:

```text
Ticket
 └── current AI state

AI Execution History
 ├── execution 1
 ├── retry
 ├── execution 2
 ├── fallback
 ├── human override
 └── reclassification
```

This supports traceability and future governance without turning the ticket table into an execution log.

---

## ADR-005 — Confidence-Gated AI

High-confidence fields may be auto-applied.

However:

> Business-critical decisions such as priority and routing remain controlled by deterministic IRIS rules.

AI produces signals.

IRIS business rules convert those signals into operational decisions.

---

## ADR-006 — Python Deployment

Python AI Service will initially run as a **separate Podman container on the same VPS**.

The service should communicate over a private internal network.

This gives us:

- process isolation
- deployment isolation
- no direct public exposure required
- easy future migration to another server

The architecture should not depend on the service remaining on the same VPS.

---

## ADR-007 — Provider Strategy

The initial provider/model should follow the model/provider used by the reference project.

Provider abstraction must be created so that the provider can later be changed without rewriting feature/business logic.

Do not hard-wire classification directly to one provider.

---

# 7. Target Architecture

```text
                         ┌──────────────────┐
                         │      Widget      │
                         └────────┬─────────┘
                                  │
                                  ▼
                         ┌──────────────────┐
                         │     Gateway      │
                         └────────┬─────────┘
                                  │
                                  ▼
                         ┌──────────────────┐
                         │   Core Service   │
                         │                  │
                         │ Auth             │
                         │ RLS              │
                         │ Domain rules     │
                         │ Audit            │
                         │ Outbox           │
                         │ PostgreSQL       │
                         └────────┬─────────┘
                                  │
                            Outbox Event
                                  │
                                  ▼
                         ┌──────────────────┐
                         │      BullMQ      │
                         └────────┬─────────┘
                                  │
                                  ▼
                         ┌──────────────────┐
                         │    AI Worker     │
                         │     Node.js      │
                         └────────┬─────────┘
                                  │
                           Internal HTTP
                                  │
                                  ▼
                     ┌────────────────────────┐
                     │   Python AI Service    │
                     │                        │
                     │ Classification         │
                     │ Summarization          │
                     │ Sentiment              │
                     │ Embeddings             │
                     │ Retrieval              │
                     │ Reranking              │
                     │ Generation             │
                     │ Provider abstraction   │
                     └───────────┬────────────┘
                                 │
                       Model / Provider APIs
                                 │
                                 ▼
                         External AI Models
```

---

# 8. Core Architectural Principle

## AI predicts/extracts. IRIS decides.

Example:

```text
Ticket
   ↓
AI
   ↓
category = Network
issue_type = Connectivity
confidence = 0.94
severity_signal = High
   ↓
Core validation
   ↓
IRIS deterministic rules
   ├── final severity
   ├── priority
   └── team routing
```

Never trust raw model output directly.

Required validation sequence:

```text
LLM output
   ↓
Schema validation
   ↓
Allowed-value validation
   ↓
Business validation
   ↓
Deterministic rules
   ↓
Persist
```

---

# 9. End-to-End Implementation Phases

## Phase 0 — AI Foundation and Readiness

### Objective

Prepare IRIS to execute AI safely without implementing a real AI feature yet.

### Tasks

- Confirm existing ticket AI schema
- Confirm event outbox behavior
- Fix/widen outbox dispatching where required
- Decide AI execution/audit schema
- Decide internal API namespace
- Add/verify vector ANN foundation later when embeddings begin
- Review product scope/RLS behavior
- Review current test seams
- Establish AI configuration model

### Deliverable

A technically ready foundation with no production AI dependency yet.

### Acceptance criteria

- AI architecture documented
- security boundary documented
- event flow documented
- AI execution lifecycle documented
- no direct Python → DB access
- existing security/audit mechanisms reused

---

# 10. Phase 1 — Core ↔ AI Contract

**This is the first design/implementation milestone.**

Before coding, answer:

1. What data crosses Core → Worker → Python?
2. What data must never cross?
3. What is the AI job envelope?
4. What is the classification request?
5. What is the classification response?
6. How is tenant/product context represented?
7. How are `eventId`, `jobId`, `ticketId`, and `correlationId` related?
8. How is idempotency represented?
9. How are model/provider metadata represented?
10. How are errors represented?

### Preliminary job envelope

```text
AIJob
├── jobId
├── eventId
├── feature
├── productId
├── ticketId
├── correlationId
├── requestedAt
└── attempt
```

This is conceptual until contract design is finalized.

### Preliminary classification input

```text
ClassificationInput
├── ticket identity/context
├── subject
├── description
├── allowed taxonomy/context
└── feature-specific metadata
```

Exact fields must be decided before implementation.

### Preliminary classification output

```text
ClassificationResult
├── extracted fields
├── confidence
├── model
├── provider
├── model version
├── prompt version
├── processing metadata
└── fallback/status information
```

Exact fields must be mapped from reference behavior to the IRIS domain model.

### Security rule

Do not send unnecessary tenant data or secrets to the AI service.

---

# 11. Phase 2 — AI Service Authentication

> **Status: 🟢 COMPLETED** (2026-09-07). Implementation record in §43B.
> Every acceptance criterion below is met and verified on the running system.
> Scope note: the boundaries hardened were Worker → Core and Worker → Python.
> `Python → Core` does not exist in the implementation — the worker is the sole
> orchestrator — so there was nothing to secure there.

## Objective

Secure Worker/Core → Python AI Service communication.

### Requirements

- Service-to-service authentication
- Request integrity
- Replay protection where appropriate
- Timestamp validation
- Correlation IDs
- Product/tenant context
- Structured security logging

### Existing IRIS capability to evaluate/reuse

Existing HMAC utilities.

Do not introduce another authentication mechanism without a concrete requirement.

### Acceptance criteria

- Unauthorized requests rejected
- Tampered requests rejected
- stale/replayed requests handled
- secrets never logged
- service identity auditable

---

# 12. Phase 3 — Reliability Foundation

## Objective

Make AI processing resilient.

### Required capabilities

- timeout
- retry
- exponential/backoff strategy
- maximum attempts
- permanent failure state
- dead-letter/failed-job handling
- graceful degradation
- kill switch
- idempotency

### Failure categories

#### Temporary

Examples:

- network failure
- model timeout
- provider 429
- temporary provider outage

Action:

```text
retry
```

#### Permanent

Examples:

- invalid request
- invalid model output
- unsupported taxonomy
- schema violation that cannot be corrected by retry

Action:

```text
fail safely
```

### Core requirement

AI failure must not prevent normal ticket operations.

---

# 13. Phase 4 — BullMQ AI Worker

## Objective

Build the Node orchestration layer.

### Worker responsibilities

```text
Receive BullMQ job
   ↓
Validate job envelope
   ↓
Obtain AI-safe input from Core
   ↓
Call Python AI Service
   ↓
Validate response
   ↓
Send result to Core
   ↓
Core applies business rules
   ↓
Persist + audit
```

### Worker must NOT

- contain LLM prompts
- contain model-specific logic
- connect directly to PostgreSQL
- bypass Core authorization
- make business-critical ticket decisions

---

# 14. Phase 5 — Python AI Service Foundation

## Objective

Create a clean AI service that can grow from classification into RAG/copilot.

Initial conceptual structure:

```text
ai-service/
├── app/
│   ├── api/
│   ├── schemas/
│   ├── services/
│   ├── providers/
│   ├── prompts/
│   ├── config/
│   └── ...
├── tests/
└── main.py
```

Do not create unnecessary modules before their responsibility is understood.

### Responsibilities

Python service owns:

- AI request validation
- prompts
- provider invocation
- model response normalization
- AI-specific processing
- embeddings
- reranking
- generation

Core owns:

- authorization
- tenant isolation
- ticket state
- business rules
- persistence
- audit
- event lifecycle

---

# 15. Phase 6 — Provider Abstraction

## Objective

Allow provider/model changes without changing feature logic.

Concept:

```text
Classification
      ↓
   LLM Port
      ↓
Provider Adapter
 ┌────┼─────┐
 ▼    ▼     ▼
Model A Model B Model C
```

Do not write:

```text
classification.py
    ↓
specific provider SDK everywhere
```

Instead isolate provider-specific code.

Future provider changes should primarily affect adapters/configuration.

---

# 16. Phase 7 — Ticket Classification

## Objective

First real end-to-end AI feature.

### Flow

```text
Ticket Created
     ↓
DB transaction
     ├── ticket
     ├── audit
     └── outbox
            ↓
      BullMQ
            ↓
       AI Worker
            ↓
      Python AI
            ↓
          LLM
            ↓
 structured result
            ↓
      Worker/Core
            ↓
 schema validation
            ↓
 business validation
            ↓
 persist AI state
            ↓
 audit
```

### Important

Reference classification has 14 fields.

We will **map those fields to IRIS requirements** instead of blindly recreating them.

For each field document:

- purpose
- source
- allowed values
- confidence behavior
- persistence target
- whether auto-apply is allowed
- whether deterministic rules depend on it

### Acceptance criteria

- real ticket can trigger AI classification
- job is asynchronous
- AI outage does not block ticket creation
- valid AI output is persisted
- invalid output is rejected safely
- execution is auditable
- retry is idempotent
- tenant isolation is preserved
- agent can still operate when AI fails

---

# 17. Phase 8 — Deterministic Priority, Severity and Routing

## Objective

Convert AI-extracted signals into IRIS operational decisions.

Architecture:

```text
AI signals
   ↓
Core deterministic rules
   ├── priority
   ├── severity
   └── team routing
```

### Reference behavior to study

- deterministic priority engine
- deterministic severity
- team routing
- confidence-gated routing
- routing decision
- priority/margin behavior

### Rule

LLM output is an input to business logic, not the final authority.

### Acceptance criteria

- same input + same rules = deterministic result
- rule decisions are testable without LLM
- AI confidence thresholds are configurable
- critical decisions are auditable
- human overrides remain possible

---

# 18. Phase 9 — Additional AI Signals

Implement after classification foundation is stable.

## 18.1 Sentiment

```text
ticket → sentiment
```

## 18.2 Keywords/tags

```text
ticket → keywords
```

## 18.3 AI conclusion/summary

Short, useful ticket summary.

## 18.4 Next-step recommendation

Recommended action for the agent.

## 18.5 Composite confidence

Do not assume one model confidence number represents the reliability of every field.

Document field-level confidence semantics.

---

# 19. Phase 10 — Embedding Infrastructure

## Objective

Turn the existing pgvector foundation into a real embedding pipeline.

Current foundation:

- pgvector installed
- vector columns exist
- vectors currently remain NULL
- no ANN index
- no real vector retrieval

### Target

```text
Text
 ↓
Embedding provider
 ↓
Embedding vector
 ↓
PostgreSQL/pgvector
```

### Work

- select initial embedding model/provider based on reference
- create provider abstraction
- define dimensions
- populate vectors
- define normalization strategy if required
- create ANN index
- create similarity query
- test retrieval quality

### Corpus

Reference dependency order indicates the retrieval corpus should be seeded before meaningful retrieval testing.

Reference corpus included approximately:

- 89 resolved tickets
- 182 KB chunks

These numbers are reference-project context, not a requirement to copy blindly into IRIS.

---

# 20. Phase 11 — Hybrid Retrieval

## Objective

Combine existing lexical search with semantic search.

Target:

```text
Query
 ├── PostgreSQL FTS
 ├── pg_trgm
 └── vector similarity
          ↓
      candidates
```

Existing IRIS lexical search should be reused rather than discarded.

### Candidate retrieval

Possible flow:

```text
lexical candidates
+
semantic candidates
      ↓
merge/deduplicate
      ↓
rank
```

Exact scoring strategy will be designed during this phase.

---

# 21. Phase 12 — Reranking

## Objective

Improve candidate ordering after broad retrieval.

Reference uses:

```text
pgvector retrieval
      ↓
cross-encoder reranker
      ↓
best candidates
```

Implement a provider abstraction for reranking so the model can change later.

### Acceptance criteria

- retrieval returns relevant candidates
- reranker improves ordering against baseline test set
- latency is measured
- fallback exists when reranker fails

---

# 22. Phase 13 — RAG

## Objective

Use retrieved IRIS knowledge to generate grounded responses.

Target:

```text
Question
   ↓
Hybrid retrieval
   ↓
Reranking
   ↓
Relevant sources
   ↓
LLM
   ↓
Answer + citations
```

Potential capabilities:

- Ask a Question
- AI Suggestions
- Draft Reply
- Recommended Resolution

These must replace current lexical placeholders only after real retrieval is available.

### Grounding rules

The model should be instructed to use retrieved sources and avoid unsupported claims.

### Citation requirement

Generated answers should preserve source references where applicable.

---

# 23. Phase 14 — Similar Tickets

## Objective

Find historical tickets relevant to the current ticket.

Target:

```text
Current ticket
   ↓
Embedding
   ↓
Vector search
   ↓
Optional lexical search
   ↓
Reranker
   ↓
Similar resolved tickets
```

Use cases:

- identify known issues
- reuse successful resolutions
- improve agent speed
- support duplicate investigation

Advanced duplicate automation is deferred until the retrieval foundation is trustworthy.

---

# 24. Phase 15 — Agent Copilot

Combine multiple AI capabilities around the ticket:

```text
Ticket
 ├── Classification
 ├── Summary
 ├── Sentiment
 ├── Similar tickets
 ├── KB recommendations
 ├── Next action
 ├── Draft response
 └── Resolution assistance
```

The copilot should assist rather than silently change important ticket state.

---

# 25. Phase 16 — Assignee Recommendation

Reference ranking includes explainable factors.

Potential factors include:

- skill/domain fit
- historical track record
- speed
- current context/load
- previous successful resolution patterns

The recommendation should be explainable.

Example concept:

```text
Recommended Agent
   ↓
Why?
   ├── domain fit
   ├── similar resolved tickets
   ├── historical success
   └── response speed
```

Final assignment remains subject to IRIS authorization/business rules.

---

# 26. Phase 17 — AI Governance and Analytics

Track AI execution separately from current ticket AI state.

Conceptual execution record:

```text
AI Execution
├── execution_id
├── ticket_id
├── product_id
├── feature
├── event_id
├── correlation_id
├── provider
├── model
├── model_version
├── prompt_version
├── status
├── confidence
├── latency
├── token/cost metadata where available
├── fallback_used
├── retry_count
├── error information
├── created_at
└── completed_at
```

Potential analytics:

- AI accuracy
- human correction rate
- confidence distribution
- fallback rate
- provider failure rate
- latency
- cost
- recommendation acceptance
- human overrides
- field-level performance

### Important

Do not fabricate analytics from deterministic placeholders.

Every metric must have a defensible source.

---

# 27. Testing Strategy

Every phase must follow the same lifecycle.

```text
Architecture
   ↓
Implementation
   ↓
Unit tests
   ↓
Integration tests
   ↓
Failure/retry tests
   ↓
Security/tenant tests
   ↓
Running-system verification
   ↓
Documentation
```

## 27.1 Unit tests

Test:

- schemas
- deterministic rules
- thresholds
- transformations
- provider adapters
- retry classification
- idempotency helpers

## 27.2 Integration tests

Test real seams:

- Core → outbox
- outbox → BullMQ
- Worker → Python
- Python → provider abstraction
- Worker → Core result update
- audit
- database persistence

## 27.3 Security tests

Test:

- cross-tenant access
- invalid service authentication
- replay/stale requests where applicable
- unauthorized internal calls
- secret leakage
- RLS behavior
- product context enforcement

## 27.4 Failure tests

Test:

- Python unavailable
- provider timeout
- provider 429
- invalid model output
- malformed AI response
- BullMQ retry
- worker crash/reprocessing
- duplicate event
- partial processing
- outbox retry

## 27.5 End-to-end test

At minimum:

```text
create ticket
 ↓
ticket persisted
 ↓
outbox event persisted
 ↓
job queued
 ↓
worker processes
 ↓
Python processes
 ↓
AI response returned
 ↓
Core validates
 ↓
rules execute
 ↓
ticket updated
 ↓
audit created
```

---

# 28. Idempotency Strategy

BullMQ jobs can be executed more than once.

Therefore every AI operation must tolerate duplicate execution.

Example:

```text
eventId = E123
```

If worker processes E123 twice:

```text
Attempt 1 → success
Attempt 2 → detected/already applied
```

Do not produce duplicate logical AI state or duplicate execution side effects.

The exact database uniqueness/idempotency strategy will be finalized in Phase 1.

---

# 29. Outbox Strategy

Ticket mutation and AI event creation should happen in one database transaction.

Correct:

```text
BEGIN

INSERT ticket
INSERT audit
INSERT outbox event

COMMIT
```

Then:

```text
outbox dispatcher
      ↓
BullMQ
```

Incorrect:

```text
INSERT ticket
COMMIT

bullmq.add()
```

because a process crash can leave a ticket without an AI job.

---

# 30. AI Data Boundary

The AI service should receive only what it needs.

Potentially allowed:

- ticket subject
- ticket description
- necessary classification metadata
- taxonomy information
- relevant non-sensitive context
- feature-specific context

Never send:

- database credentials
- service secrets
- unrelated tenant data
- unnecessary personal/security information
- unrestricted database queries
- raw authorization tokens unless explicitly required by the service-auth design

The exact classification payload must be finalized before implementation.

---

# 31. Internal API Strategy

There is currently no finalized `/internal` namespace.

A controlled internal namespace should be introduced for AI-worker interactions.

Conceptual endpoints:

```text
POST /internal/ai/tickets/classification-input
POST /internal/ai/tickets/classification-result
```

These are examples only.

The final contract must be designed before files are created.

Core remains the gatekeeper.

---

# 32. Configuration Strategy

AI configuration should be centrally controlled.

Potential configuration areas:

```text
AI enabled/disabled
provider
model
temperature
token limits
timeout
retry limits
confidence thresholds
fallback behavior
embedding model
reranker model
```

Existing `product.config.ai_thresholds` should be reused/extended where appropriate.

Do not scatter AI constants throughout source files.

---

# 33. Graceful Degradation

IRIS must remain useful when AI is unavailable.

Example:

```text
AI unavailable
     ↓
Ticket remains Open
     ↓
Manual agent workflow continues
```

Depending on the feature, fallback can be:

- no AI result
- existing lexical search
- deterministic heuristic
- manual operation

The fallback must be explicitly labeled and auditable.

---

# 34. Human-in-the-Loop Policy

Initial policy:

> High-confidence fields may be auto-applied.

But:

> Business-critical decisions remain controlled by deterministic IRIS rules.

Human overrides must remain possible.

Where meaningful, record:

```text
AI value
Human value
Actor
Timestamp
Reason if available
```

Human correction data should eventually support governance/quality analytics.

---

# 35. Deployment Strategy

Initial topology:

```text
VPS
│
├── Gateway container
├── Core Service container
├── PostgreSQL container
├── Redis container
├── AI Worker container/process
└── Python AI Service container
```

Podman is the chosen container runtime.

Python AI Service should not need public exposure for normal Worker communication.

Future topology can move Python AI Service to another host without changing the logical architecture.

---

# 36. Dependency Order

The reference project's dependency chain is important.

Recommended order:

```text
Taxonomy
   ↓
Ticket intake
   ↓
LLM field extraction
   ↓
Priority
   ↓
Severity
   ↓
Team routing
```

Additional signals:

```text
Extraction
 ├── sentiment
 ├── keywords
 ├── conclusion
 └── composite confidence
```

Retrieval:

```text
Embedding corpus
   ↓
Similar tickets
   ↓
Subject grounding
   ↓
Recommendation
   ↓
KB grounding
   ↓
Draft replies
   ↓
Reranker
```

Historical intelligence:

```text
Agent history
   ↓
track record
   ↓
speed
   ↓
assignee ranking
```

Resolution corpus:

```text
Resolved tickets
      ↓
Corpus indexing
      ↓
Retrieval
```

---

# 37. Features Explicitly Deferred

Unless requirements change, defer:

- SLA engine
- advanced auto-close
- advanced duplicate automation
- WhatsApp integration
- Teams integration
- full outbound webhooks
- voice
- advanced workflow automation
- advanced AI analytics before reliable source data exists

These are not part of the initial AI implementation sequence.

---

# 38. Reference-to-IRIS Decision Matrix

Every reference feature must receive an explicit IRIS decision:

| Reference capability | Reference status | IRIS decision |
|---|---|---|
| Ticket classification | Completed | Rebuild natively |
| Deterministic priority | Completed | Rebuild using IRIS rules |
| Severity/routing | Completed | Rebuild using IRIS rules |
| Summary | Completed | Rebuild |
| Sentiment | Completed/AI capability | Rebuild after classification |
| Keywords/tags | AI capability | Rebuild |
| RAG draft reply | Completed | Rebuild after retrieval |
| Hybrid retrieval | Completed | Rebuild using IRIS search + vector |
| Reranking | Completed | Rebuild after retrieval |
| Similar tickets | Completed | Rebuild |
| Assignee ranking | Completed | Rebuild later |
| KB ingest | Partial | Evaluate IRIS-native authoring |
| AI correction analytics | Partial | Rebuild after reliable audit data |
| Screenshot AI | Partial | Redesign based on IRIS attachment architecture |
| Ask a Question | Placeholder | Replace lexical placeholder with real RAG |
| AI Suggestions | Placeholder | Replace lexical placeholder with real AI |
| Self-service metric | Placeholder | Rebuild metric definition |
| pgvector | Foundation only | Implement real embedding/retrieval |
| AI analytics | Partially fabricated | Rebuild from real execution/audit data |
| CSAT | Partial | Separate product decision |

This table is a living artifact and must be updated as phases are analyzed.

---

# 39. What Must NOT Be Recreated

Do not rebuild these from scratch unless a concrete gap is discovered:

- RLS architecture
- existing tenant isolation
- authentication
- audit foundation
- outbox foundation
- HMAC utilities
- ticket state machine
- credential/secrets handling
- existing configuration merge behavior
- existing lexical search
- existing API gateway security

AI should integrate with these capabilities.

---

# 40. Implementation Method — Mandatory Working Loop

For every phase:

## Step 1 — Understand

Explain the business purpose.

## Step 2 — Reference study

Study how the reference project actually implements it.

## Step 3 — IRIS audit

Inspect the destination implementation.

## Step 4 — Gap analysis

Document:

```text
Reference has
IRIS has
IRIS lacks
```

## Step 5 — Design

Design the IRIS-native approach.

## Step 6 — Trade-offs

Discuss alternatives.

## Step 7 — Decision

Freeze the architecture/behavior.

## Step 8 — Implement

Only now modify code.

## Step 9 — Test

Run unit/integration/security/failure tests.

## Step 10 — Verify

Verify against the running application.

## Step 11 — Document

Record:

- files changed
- schema changes
- API changes
- decisions
- tests
- verification
- known limitations

---

# 41. Phase Status Model

Use this status model throughout the document:

```text
⬜ Not Started
🟡 In Design
🔵 In Development
🟣 Testing
🟢 Verified
🔴 Blocked
```

A phase is not `🟢 Verified` merely because code exists.

It must pass the agreed completion criteria.

---

# 42. Phase Completion Definition

Every phase must satisfy:

- [ ] Business behavior understood
- [ ] Reference behavior studied
- [ ] Existing IRIS implementation audited
- [ ] Gap documented
- [ ] Architecture decided
- [ ] Implementation completed
- [ ] Unit tests completed
- [ ] Integration tests completed where applicable
- [ ] Failure/retry tests completed where applicable
- [ ] Security/tenant tests completed where applicable
- [ ] Running-system verification completed
- [ ] Documentation updated
- [ ] Known limitations documented
- [ ] Status changed to `🟢 Verified`

---

# 43. Current Progress

## Architecture decisions

- [x] AI-only scope
- [x] Separate Python AI Service
- [x] Event + BullMQ
- [x] One AI queue initially
- [x] `feature` in job envelope
- [x] Separate AI execution/audit history
- [x] Existing ticket AI columns reused where appropriate
- [x] Confidence-gated AI
- [x] Deterministic priority/routing decisions
- [x] Python in separate Podman container on same VPS
- [x] Initial provider follows reference project
- [x] Provider abstraction required
- [x] Phase completion/testing discipline agreed
- [x] Reference features classified as completed/partial/placeholder

## Current phase

**Phase 1 — AI Foundation (Core ↔ AI Contract)**

Status: `🟢 Verified` — implemented, tested and verified end-to-end on the
running system, 2026-09-07. Full record in §43A below.

**Phase 2 — Service-to-Service HMAC Security**

Status: `🟢 COMPLETED` — implemented and verified on the running system,
2026-09-07. Full record in §43B below. It closed a verified privilege
escalation: the worker held the gateway's platform-wide INTERNAL_API_KEY, which
core-service accepts on every route.

**Phase 3 — Reliability Foundation**

Status: `🟡 In Progress`
  · Step 1 audit: complete (3 P1, 5 P2, 3 P3 found)
  · Step 2 design freeze: complete
  · **Step 3 retry hardening: 🟢 COMPLETE** — see §43C
  · Step 4 terminal-failure reporting: not started
  · Step 5 abandoned-execution reaper: not started
  · Step 6 timeout hardening: not started

**Next:** Phase 3 Step 4 — Terminal Failure Reporting.

---

# 44. Immediate Next Work

> **Superseded.** The Core ↔ AI contract below was designed, frozen, implemented
> and verified in Phase 1 — see §43A. Every question in the list is answered
> there. The next task is **Phase 2 — AI Service Authentication**.
>
> One item is deliberately still open and must be settled before Phase 7:
> **the initial provider/model is never named in this document.** ADR-007 says
> "follow the reference project", but no provider or model appears anywhere
> here, and `ai-service/SKILLS.md` describes a discriminative classifier with
> calibrated `p1`/`p2`/`margin` rather than an LLM — which have different
> confidence semantics. Phase 1 runs no model, so this blocks nothing yet.

The original task was to design and freeze the **Core ↔ AI contract**.

Questions to resolve:

1. Exact AI job envelope
2. Exact classification input
3. Exact classification output
4. Data allowed across the boundary
5. Data forbidden across the boundary
6. Tenant/product context
7. Correlation IDs
8. Event/job/request relationships
9. Idempotency
10. Internal API endpoints
11. Worker authentication
12. Error contract
13. Timeout/retry ownership
14. AI execution/audit record
15. Human override representation

Only after these are frozen should implementation begin.

---

---

# 43A. Phase 1 — AI Foundation

## Status: 🟢 VERIFIED

Completed and verified end-to-end on the running system, 2026-09-07.

The objective was **not** AI classification. It was to prove the production-safe
pipeline works — boundaries, security, retry, idempotency and observability —
with a `noop` stub standing in for the model. That is done, and the real
classification work in Phase 7 now plugs into a pipeline that is already tested.

```text
POST /v1/tickets                                    (UNCHANGED code path)
  └─ ONE transaction: ticket + audit + event_outbox
        ↓
core-service/src/events/ai-dispatcher.ts            reads outbox, enqueues
        ↓
BullMQ  ai.jobs                                     ONE queue, `feature` field
        ↓
worker/src/consumers/ai.consumer.ts                 thin orchestration
        ↓
POST /internal/ai/jobs/:eventId/input               Core resolves identity
        ↓
POST /v1/execute  (Python, noop stub)               text in, prediction out
        ↓
POST /internal/ai/jobs/:eventId/result              Core validates + decides
        ↓
ai_execution + audit_event                          TICKET UNCHANGED in Phase 1
```

---

## 43A.1 Contracts

Authoritative artifact: **`shared/contracts/ai/ai-contracts.schema.json`** — one
file, internal `$defs` only, no external `$ref`. TypeScript (`shared/types/ai.ts`)
and Python (`ai-service/src/api/schemas.py`) are both *validated against it* by
their own suites using the shared fixtures in
`shared/contracts/ai/fixtures/cases.json`. This mirrors how
`shared/hmac-utils/vectors.json` already keeps the two HMAC implementations
honest: the contract is expressed once and checked twice.

Wire types use `snake_case` field names, matching `TicketDTO` and /SKILLS.md §2,
so the schema is a literal description of the TypeScript type and Python needs no
mapping layer.

| Contract | Direction | Purpose |
|---|---|---|
| `AIJob` | dispatcher → BullMQ → worker | Identity/context only. **Never the ticket.** |
| `AIJobClaims` / `AIInputRequest` | worker → Core | What the worker *asserts*; Core verifies it |
| `AIInputResponse` | Core → worker | `ready` (minimal input) or `already_applied` |
| `AIExecuteRequest` | worker → Python | **The data boundary** |
| `AIResult` / `AIError` | Python → worker → Core | Untrusted until Core validates |
| `AIResultRequest` / `AIResultResponse` | worker ↔ Core | Application outcome |

### Features

`AI_FEATURES` declares `noop`, `classification`, `sentiment`, `keywords`,
`summary`, `rag`. `SUPPORTED_AI_FEATURES` is `['noop']` — a job naming a
declared-but-unbuilt feature is a **permanent** error, not a retry.
`AI_EVENT_FEATURES` maps `ticket.created → ['noop']` and is the only thing that
decides which events can reach the pipeline.

### `job_id` ≠ `event_id`

- `event_id` (`evt_…`) is the outbox row Core wrote inside the ticket
  transaction. **Stable across every retry.** The only caller-supplied value
  Core uses as a lookup key, and a worker cannot forge one into existence.
- `job_id` (`aij_…`) is minted **fresh on every dispatch** and is deliberately
  not derived from `event_id`. BullMQ owns *work*; the outbox owns the *fact*.

---

## 43A.2 Database — migration 013

`infra/migrations/013_ai_execution.sql`. One table, applied and verified.

```sql
ai_execution (
  id, product_id, ticket_id, feature, event_id, job_id, correlation_id,
  status CHECK IN ('running','succeeded','failed'), attempt,
  provider, model, model_version, prompt_version,
  confidence, latency_ms, result jsonb, fallback_used,
  error_code, error_message, created_at, completed_at,
  UNIQUE (event_id, feature)          -- the durable idempotency key
)
```

- `ENABLE` **and** `FORCE ROW LEVEL SECURITY`, policy on `product_id` —
  verified live: `relrowsecurity=t, relforcerowsecurity=t`.
- `GRANT SELECT, INSERT, UPDATE` to `iris_app`; **`REVOKE DELETE`** — verified
  live, the grant list is exactly those three. Execution history is the
  governance record; the same reasoning that makes `audit_event` append-only.
- Index `(product_id, ticket_id, created_at DESC)` — leads with `product_id`
  because RLS adds that predicate to every query.
- Keyed on `(event_id, feature)` rather than `event_id` alone so Phase 9 can fan
  one event out to several independent features **with no migration**.

**No other schema change.** No AI database. No new ticket column.

---

## 43A.3 Core responsibilities

Core owns identity, isolation and validation — in that order.

**Identity.** `resolveAIEvent()` looks up `event_outbox` by `event_id` under
`withSystemScope`. That narrow exception is the same one `product.repo.ts`
already relies on: resolving *which* tenant is involved is what establishes the
scope, so it cannot itself be scoped without being circular. It is safe because
`event_id` is `UNIQUE` (at most one row, cannot widen visibility) and it reads
routing metadata, never ticket content.

**Isolation.** The scope is built from `event.productId` — never from the
request body. Every byte of ticket data is then read inside `withScope`, so RLS
applies. Role is `'none'`, which maps to `actor_type='system'` in `writeAudit`:
the honest description of an AI pipeline actor.

**Validation.** `FEATURE_VALIDATORS[feature]` is where "never trust raw model
output" lives. For `noop` it requires `ok === true` and a non-negative integer
`received_chars`. A rejected result is recorded as a permanent execution failure
and answered **HTTP 200, not 4xx** — the worker's message was well-formed, the
*model* was wrong, and a 4xx would send the worker into a pointless retry loop.

### Internal endpoints

Both under `/internal/ai/jobs/:eventId/…`, already authenticated by the existing
`x-internal-key` hook in `server.ts` and unreachable from the internet because
the gateway proxies only `/v1/*` and `/admin/api/*`. **No new auth mechanism was
built.**

| Data | Crosses to Python? |
|---|---|
| `subject`, `description` | ✅ the feature itself |
| `taxonomy` (from `product.config`) | ✅ so Python never duplicates it |
| `thresholds` (ADR-005 defaults ⊕ product config) | ✅ config, not code |
| `correlation_id` | ✅ log correlation |
| `product_id`, `product_tenant_id`, `raised_by_ref`, `raiser_identity`, email, `identity_assurance`, `reference`, `assignee_id`, `metadata`, comments, attachments, any secret, any token, any DB handle | ❌ **never** |

Enforced structurally, not by review: the repo's `SELECT` list is only
`id, subject, description`, so forbidden columns are never in memory; and
`additionalProperties:false` plus pydantic `extra='forbid'` make an accidental
extra field a **test failure** in both languages.

### The ticket is not modified

`noop` writes `ai_execution` + one `audit_event` row and nothing else.
`ticket_updated` is always `false`. This is deliberate: it makes "an AI failure
leaves the ticket unchanged" a *provable* assertion, and it means a
product-supplied category can never be silently overwritten. Phase 7 adds the
ticket write at the marked seam in `ai.service.ts`, after the deterministic IRIS
rules run.

Audit rows are anchored `entity_type='ticket'`, `entity_id=<ticket_id>`, so AI
executions appear in `GET /v1/tickets/:id/history` with **zero changes to that
endpoint**. The `after` blob carries model metadata only — no ticket text.

---

## 43A.4 Worker responsibilities

`receive AIJob → validate → Core input → Python → validate → Core result`

Roughly 60 lines of orchestration. It holds **no database credential**, contains
no prompts, no model logic, no taxonomy, and makes no business decision. If it
starts growing logic, the logic is in the wrong place.

It builds `AIExecuteRequest` field by field rather than forwarding
`AIInputResponse`, so nothing crosses into Python by accident — and it omits
`taxonomy`/`thresholds` for features that cannot use them.

---

## 43A.5 Python responsibilities

FastAPI + pydantic v2 + uvicorn + structlog. **Every version pinned.** No
`sentence-transformers`, no `scikit-learn`, no provider SDK, no LLM — none of
that belongs to Phase 1.

`GET /health` (liveness only, checks nothing), `GET /health/ready`,
`POST /v1/execute` (dispatches on `feature` through a one-entry registry).

`noop` returns `{ok: true, received_chars: len(description)}`. Trivial, but
**verifiable**: a green pipeline proves the description actually travelled
Core → worker → Python → back, rather than proving two services can exchange an
empty 200.

**No database credential, and the absence is enforced.** `src/config.py` refuses
to boot if any `*DATABASE_URL*` is present (ADR-007 wants the absence, not a
wrong value), and `tests/test_isolation.py` asserts no DB driver is imported, is
in `requirements.txt`, or — inside the container — is even installed.

---

## 43A.6 Idempotency

Anchored on `UNIQUE(event_id, feature)` in Postgres. **Never in Redis** — a
guard living only in Redis evaporates exactly when duplicates happen.

| Situation | What happens |
|---|---|
| Normal run | `claimExecution` inserts `running`; `completeExecution` transitions it |
| Worker crashes after Python, before Core | Row stays `running`, `completed_at` null. **Nothing half-applied.** The row is itself the signal |
| BullMQ retry (new `job_id`, same `event_id`) | Row still `running` → input returns `ready`, work resumes, `attempt` bumped |
| Redelivery after success | Input returns `already_applied`. **Python is never called** — a duplicate costs zero model invocations |
| Duplicate result posted anyway | `UPDATE … WHERE status='running'` matches 0 rows → `applied:false`, no audit row, no ticket change |

**Dispatcher ordering:** `queue.add()` first, `UPDATE published_at` second. A
crash between them leaves the row unpublished so the next tick re-dispatches it —
a duplicate job, which the constraint absorbs. The opposite order loses the job
permanently and nothing notices. This is why no separate reconciliation sweep
exists.

---

## 43A.7 Retry model

**BullMQ is the only job-level retry owner.** `attempts: 5`, exponential backoff.
Core is idempotent and never retries. **Python has no retry logic at all** — a
retry there would multiply with BullMQ's five into 25 provider calls.

| Temporary → retry (plain `Error`) | Permanent → no retry (`UnrecoverableError`) |
|---|---|
| Core/AI unreachable, timeout | Core 4xx (bad claims, missing event, bad key) |
| Core 5xx, AI 5xx/503 (models loading) | Unsupported feature |
| `AIError.kind = 'temporary'` | Malformed Python response |
| | `result.data` fails Core's validator |
| | `AIError.kind = 'permanent'` |

Exhausting five attempts leaves the job in BullMQ's failed set with its reason,
and `ai_execution` at `running` — a visible, queryable state. **Verified live.**

---

## 43A.8 Security model

```text
worker ──x-internal-key──► core :4100 (127.0.0.1 only; gateway proxies /v1/* and
                                       /admin/api/* ONLY)
                              ↓  eventId from the URL path
              withSystemScope → event_outbox WHERE event_id = $1  (UNIQUE)
                              ↓  AUTHORITATIVE product_id, ticket_id
                    verify claimed_* == authoritative   (else 400)
                              ↓
              ScopeContext { productScope: [authoritative product_id] }
                              ↓  withScope() → SET LOCAL GUCs
                        PostgreSQL — RLS
```

A worker claiming another tenant is stopped **twice, independently**:

1. Verification rejects the mismatch (400).
2. Even with verification removed, the scope is built from the event row, so RLS
   returns **zero rows** — never another tenant's rows. This is asserted
   directly in `ai.security.test.ts` by building a product-B scope by hand and
   reading a product-A ticket.

The claims are a consistency check, never an authorization input — which is why
they are named `claimed_*` at every call site.

**Secrets:** the worker's pino logger redacts `x-internal-key`, `AI_SERVICE_KEY`,
`INTERNAL_API_KEY`, and ticket `subject`/`description`. Python never logs ticket
text. Redis connection strings are password-redacted before logging. Audit rows
carry model metadata only — asserted by test.

---

## 43A.9 Podman changes

| Change | Why |
|---|---|
| **Redis AOF on** (`--appendonly yes`, `--appendfsync everysec`) + `iris_redisdata` volume | Redis now holds queued AI jobs, not just rate-limit counters. **Not the idempotency mechanism** — that is Postgres. AOF protects queued *work*; Postgres protects *correctness*. Verified live: `appendonly yes`. |
| **`iris-ai-service`** container, `127.0.0.1:5000` | ADR-006. **No database env var of any kind.** |
| **`iris-worker`** container, `profiles: ["vps"]` | Defined for the target topology but **not started locally**, for a concrete reason: `core-service` binds to `127.0.0.1`, so a containerised worker genuinely cannot reach it. On the VPS core is a container too and only `CORE_SERVICE_URL` changes. |
| `worker` added to `scripts/dev.mjs` | Locally the worker runs on the host beside core and gateway. |

---

## 43A.10 Files

**Created (39)**

```
infra/migrations/013_ai_execution.sql
shared/types/ai.ts
shared/contracts/ai/ai-contracts.schema.json
shared/contracts/ai/fixtures/cases.json
shared/contracts/ai-contracts.test.ts
core-service/src/internal/ai.repo.ts
core-service/src/internal/ai.service.ts
core-service/src/internal/ai.routes.ts
core-service/src/internal/internal.routes.ts
core-service/src/internal/ai.internal.test.ts
core-service/src/internal/ai.security.test.ts
core-service/src/events/ai-dispatcher.ts
worker/package.json
worker/Containerfile
worker/.dockerignore
worker/src/config.ts
worker/src/logger.ts
worker/src/errors.ts
worker/src/core-client.ts
worker/src/ai-client.ts
worker/src/index.ts
worker/src/consumers/ai.consumer.ts
worker/src/consumers/ai.consumer.test.ts
ai-service/requirements.txt
ai-service/main.py
ai-service/Containerfile
ai-service/.dockerignore
ai-service/src/config.py
ai-service/src/__init__.py
ai-service/src/api/__init__.py
ai-service/src/api/app.py
ai-service/src/api/schemas.py
ai-service/src/api/features.py
ai-service/tests/conftest.py
ai-service/tests/test_execute.py
ai-service/tests/test_contracts.py
ai-service/tests/test_isolation.py
scripts/smoke-ai.mjs
pytest.ini
```

**Modified (11)**

```
package.json                  worker workspace, bullmq, dev:worker, test:ai
tsconfig.json                 worker/src in `include`
shared/types/index.ts         export ai.js
shared/types/ids.ts           ID_PREFIX += aiExecution:'aix', aiJob:'aij'
core-service/package.json     bullmq, ioredis
core-service/src/config.ts    REDIS_URL, AI_* (kill switch + watermark)
core-service/src/server.ts    register internalRoutes; start/stop AI dispatcher
infra/podman-compose.yml      Redis AOF; ai-service; worker (vps profile)
scripts/dev.mjs               worker joins the local stack
.env / .env.example           AI_* variables
```

**Deliberately NOT modified:** `events/publisher.ts`, `events/outbox.ts`,
`tickets/ticket.routes.ts`, `tickets/ticket.repo.ts`, `db/with-scope.ts`,
`audit/index.ts`, `http/context.ts`, and every existing migration. Ticket
creation is byte-for-byte unchanged.

---

## 43A.11 Tests

**229 automated tests: 228 pass locally, plus 1 that is container-only and
passes inside the container (6/6 in `test_isolation.py` with
`AI_SERVICE_ISOLATED_ENV=1`). 154 of these are new in Phase 1.**

| Suite | Count | Covers |
|---|---|---|
| `shared/contracts/ai-contracts.test.ts` | 59 | Schema coherence, schema↔TS enum drift, every fixture, and 22 data-boundary cases proving forbidden fields are refused |
| `worker/src/consumers/ai.consumer.test.ts` | 29 | Envelope validation, claims, boundary construction, `already_applied` short-circuit, full retry classification, malformed responses |
| `core-service/src/internal/ai.internal.test.ts` | 26 | Real Postgres: input, taxonomy, thresholds, rejections, validation, ticket-unchanged snapshots, all idempotency paths, audit |
| `core-service/src/internal/ai.security.test.ts` | 13 | Auth, claim tampering, **RLS zero-rows**, cross-tenant write refusal, DELETE denied, gateway surface |
| `ai-service/tests/` | 27 (1 container-only) | Health, stub, permanent failures, data boundary, auth, contract validation, DB isolation |
| Pre-existing suites | 75 | `contracts.test.ts` 23, `hmac.test.ts` 17, `state-machine.test.ts` 10, plus smoke |

Transports are stubbed in the worker suite; **nothing else is mocked**. Core
tests run against real Postgres with RLS genuinely enforcing, Python tests run
the real FastAPI app, and `smoke-ai.mjs` stubs nothing at all.

---

## 43A.12 Running-system verification

Executed against the live stack, not inferred.

| # | Check | Result |
|---|---|---|
| 1 | `npx tsc --noEmit` | ✅ clean |
| 2 | `npx vitest run` | ✅ 177 passed / 7 files |
| 3 | `npm run test:py` | ✅ 51 passed, 1 skipped |
| 4 | Migration 013 applies; re-run is idempotent | ✅ |
| 5 | RLS/grants/index verified in `pg_class`, `pg_policy`, `information_schema` | ✅ forced; SELECT/INSERT/UPDATE only |
| 6 | Postgres + Redis healthy; **Redis `appendonly=yes`** | ✅ |
| 7 | core-service starts; AI dispatcher starts with watermark | ✅ |
| 8 | gateway starts | ✅ |
| 9 | worker starts, connects to Redis, listens on `ai.jobs` | ✅ |
| 10 | ai-service container healthy; `/health/ready` → `features: ["noop"]` | ✅ |
| 11 | Real ticket created (`CARB-1081`) | ✅ 201 |
| 12 | `ticket.created` in `event_outbox`, correct product | ✅ |
| 13 | Dispatcher published to BullMQ; `published_at` stamped | ✅ |
| 14 | Worker processed it | ✅ |
| 15 | Python `noop` executed; `received_chars` == description length | ✅ |
| 16 | `ai_execution` succeeded, provider/model/version recorded | ✅ |
| 17 | Exactly one audit row, actor `system`, no ticket text | ✅ |
| 18 | **Ticket unchanged** — status, category, severity, `classification_source`, `ai_classification`, `summary`, `sentiment`, subject, description | ✅ |
| 19 | Duplicate delivery: `already_applied`, `applied:false`, one row, one audit row, result not overwritten | ✅ |
| 20 | Tenant isolation: tampered product/ticket claims rejected, nothing leaked | ✅ |
| 21 | Neither ai-service nor worker holds a DB connection (`pg_stat_activity`) | ✅ |
| 22 | Container isolation suite with `AI_SERVICE_ISOLATED_ENV=1` | ✅ 6 passed — no DB driver installed |
| 23 | **Watermark**: the 5 pre-existing historical `ticket.created` rows — 0 dispatched, 0 executions | ✅ |
| 24 | **AI outage**: ticket created 201 while ai-service stopped; ticket untouched; worker classified `permanent:false` and retried; retries exhausted → BullMQ failed set with reason, `ai_execution` left `running` | ✅ |
| 25 | Pre-existing suites still pass: `smoke.mjs` 43, `smoke-admin.mjs` 61, `smoke-contract.mjs` 9 | ✅ |
| 26 | `scripts/smoke-ai.mjs` end-to-end | ✅ **42/42** |

---

## 43A.13 Problems found and fixed

1. **`newId()` takes prefix *values*, not keys.** `newId('aiJob')` compiled
   against an unfixed `ID_PREFIX` but produced `aiJob_…` ids. Caught by
   `tsc`, and confirmed in live data before the fix. Now `newId('aij')` /
   `newId('aix')`; verified in the database after restart.
2. **Stale processes hid the fix.** The running core-service still held pre-fix
   code, which is how the wrong prefix reached the database at all. All services
   were restarted and the pipeline re-verified.
3. **Python env set too late.** `src/config.py` builds its Config at import
   time, so setting `AI_SERVICE_KEY` in a fixture left every authenticated
   request 401. Moved to module scope in `conftest.py`.
4. **DB-driver check was untestable on the dev machine.** One global interpreter
   is shared with other projects that install `psycopg2`. The installed-package
   assertion now runs only inside the container (`AI_SERVICE_ISOLATED_ENV=1`),
   where it is meaningful; the source-import, requirements and boot-guard checks
   run everywhere.
5. **`smoke-ai.mjs` allowlist was wrong**, flagging the legitimate
   `iris-gateway` connection. The gateway holds a narrow, documented read-only
   credential. The check now asserts its real intent: no connection from
   ai-service or worker.
6. **Fastify logger generic.** `buildServer()` returns a type narrowed by the
   concrete pino instance — the clash `http/errors.ts` already documents. Fixed
   with `Awaited<ReturnType<typeof buildServer>>` rather than `any`.

### Pre-existing issues found, not introduced

- **`npm run test:py` was already broken.** A globally installed
  `pytest-asyncio` crashes collecting `shared/hmac-utils/py`
  (`'Package' object has no attribute 'obj'`). Confirmed on that path alone.
  Fixed with `pytest.ini` (`-p no:asyncio`); neither suite uses asyncio.
- `npm audit` reports fastify and react-router advisories. Both predate this
  work and are untouched — fixing them changes unrelated behaviour.
- `.env.example` declares `MIGRATOR_DATABASE_URL` / role `iris_migrator`, while
  the code uses `ADMIN_DATABASE_URL` and migration 001 never creates that role.
  Left alone; noted so the new AI variables did not inherit the inconsistency.

---

## 43A.14 Operating the pipeline

The dispatcher is **off by default and fails closed twice**:

```bash
AI_DISPATCH_ENABLED=true                 # kill switch
AI_DISPATCH_FROM=2026-09-07T11:38:06Z    # watermark; unset ⇒ dispatch nothing
```

Without the watermark the dispatcher logs a warning and dispatches nothing,
rather than guessing a start point and flooding the queue with historical
events. Turning `AI_DISPATCH_ENABLED` off returns the platform to exactly
today's behaviour: tickets, audit and outbox unaffected.

---

## 43A.15 Remaining Phase 1 work

None. The Phase 1 objectives are complete and verified.

Carried forward deliberately, each a later phase rather than an omission:

- **Service authentication is a shared key**, reusing the existing
  `x-internal-key` pattern. **Phase 2** replaces it with HMAC —
  `shared/hmac-utils` already ships in both TypeScript and Python, vector-tested
  against each other, so no new crypto is introduced then either.
- **No provider abstraction.** There is nothing to abstract over a stub; ADR-007
  places it in Phase 6.
- **Initial provider/model is still unnamed.** ADR-007 says "follow the
  reference project", but this document never names one, and
  `ai-service/SKILLS.md` describes a discriminative classifier (calibrated
  `p1`/`p2`/`margin`) rather than an LLM — different confidence semantics.
  **This must be decided before Phase 7.** It does not block Phase 1, which
  runs no model.
- **`ai_thresholds` is null on every seeded product**, so the ADR-005 defaults
  do all the work today. Per-product tuning needs no code change.
- **Ticket mutation is a documented seam** in `ai.service.ts`, currently a no-op.

---

---

# 43B. Phase 2 — Service-to-Service HMAC Security

## Status: 🟢 COMPLETED

Implemented and verified on the running system, 2026-09-07.

Phase 2 is an authentication layer around the calls Phase 1 already made.
**No Phase 1 contract, envelope, queue, table or business rule changed.**

---

## 43B.1 The vulnerability this phase existed to fix

Phase 1 authenticated the worker with `INTERNAL_API_KEY`. Three facts combined
into a real, exploitable escalation:

1. core-service accepted that key on **every** route, not just `/internal/*`.
2. `resolveCaller` and `resolveAdminCaller` trust `x-iris-product-id`,
   `x-iris-role` and `x-iris-support-user-id` as **plain headers, with no
   lookup** — a deliberate, documented property of the gateway↔core boundary.
3. Phase 1 handed that key to the **worker** — the process most exposed to
   untrusted input, since it parses AI-service responses.

Demonstrated against the running stack during analysis:

```
GET /v1/tickets   x-internal-key: <worker's key>  x-iris-product-id: prod_ifile
  → 200  IFIL-1030 | acme-corp | "Cannot sign in to the portal"

GET /admin/api/tenants   + x-iris-support-user-id: su_forged
                         + x-iris-role: super_admin
  → 200  carbon, esg, ideal, ifile
```

The trust model was coherent while exactly one process (the gateway) held the
key. Phase 1 broke that assumption.

**The fix is separation first, signatures second.** The worker now holds two
narrow directional secrets and no bearer token that works anywhere else.

---

## 43B.2 Trust boundaries after Phase 2

| Boundary | Mechanism | Changed |
|---|---|---|
| client → Gateway | HMAC on product `client_id` | no |
| Gateway → Core | `x-internal-key` + context headers | **no — out of scope, see §43B.9** |
| Worker → Core `/internal/ai/*` | **HMAC**, `AI_WORKER_HMAC_SECRET` | **new** |
| Worker → Python `/v1/execute` | **HMAC**, `AI_SERVICE_HMAC_SECRET` | **new** |
| Core → Product callback | HMAC webhook (`signWebhook`) | no |
| Python → Core | *does not exist* | no |

---

## 43B.3 The HMAC contract

**The canonical string, header semantics, signature format and published
vectors are UNCHANGED.** They are an integrator contract
(`docs/api-contract.md` §3.3, `shared/hmac-utils/vectors.json`); changing them
would be a breaking change, not a refactor. `service-auth.test.ts` asserts the
published vector still reproduces byte-for-byte.

```
canonical = "v1" \n METHOD \n PATH_WITH_QUERY \n TIMESTAMP \n NONCE \n sha256_hex(RAW_BODY)
signature = "v1=" + hex(hmac_sha256(secret, canonical))
```

Headers — three already existed; `X-IRIS-Service-Id` is the only addition:

```http
X-IRIS-Service-Id: worker
X-IRIS-Timestamp: 1788780762
X-IRIS-Nonce: 5f2b8c1a-9d3e-4a7b-8c6f-2e1d0a9b8c7d
X-IRIS-Signature: v1=194eb588…
X-Request-Id: req_…              ← correlation only, OUTSIDE the signature
```

**`X-IRIS-Service-Id` is deliberately not in the canonical string.** It selects
the secret, so substituting it makes verification use a different key and fail
— bound implicitly, without touching the published vectors.

**`X-Request-Id` is outside the signature** because it is a logging hint; the
authoritative `correlation_id` comes from Core's own outbox row.

### Worker → Core

`POST /internal/ai/jobs/:eventId/input` · `POST /internal/ai/jobs/:eventId/result`
Secret `AI_WORKER_HMAC_SECRET`. `x-internal-key` is neither sent nor accepted.

### Worker → Python

`POST /v1/execute`. Secret `AI_SERVICE_HMAC_SECRET`. Verified with the shared
`iris_hmac` package — the same canonical string and vectors as the TypeScript
side, so signer and verifier cannot drift.

---

## 43B.4 Secret model

| Secret | Gateway | Core | Worker | Python |
|---|---:|---:|---:|---:|
| `INTERNAL_API_KEY` | YES | YES | **NO** ← the fix | NO |
| `AI_WORKER_HMAC_SECRET` | NO | YES *(verify)* | YES *(sign)* | NO |
| `AI_SERVICE_HMAC_SECRET` | NO | NO | YES *(sign)* | YES *(verify)* |
| `AI_SERVICE_KEY` | — | — | — | **removed** |

Two secrets rather than one shared "service secret" because they protect
different directions: leaking the Python-facing credential must not grant
access to Core. **Verified live in both directions.**

**Enforced, not trusted.** `ai-service/src/config.py` refuses to boot if
`INTERNAL_API_KEY` or `AI_WORKER_HMAC_SECRET` is present in its environment —
the same fail-at-boot approach ADR-007 uses for database credentials.
`signing.test.ts` asserts the worker's resolved config has no
`INTERNAL_API_KEY` and no `AI_SERVICE_KEY`.

**Production hardening.** Core, worker and Python all refuse to start in
production on a dev placeholder or a secret under 32 characters. Development
keeps documented placeholders — the convention `INTERNAL_API_KEY` already uses
— so a fresh clone still runs its tests. Secret **names** are reported on
failure, never values.

---

## 43B.5 Authentication flow

Two hooks, deliberately split:

```
onRequest   (no body touched — cheap rejections first)
  1. X-IRIS-Service-Id present and in the known-services map   else 401
  2. X-IRIS-Timestamp present, integer, |now-ts| <= 300s       else 401
  3. X-IRIS-Nonce present and well-formed                      else 401
  4. X-IRIS-Signature parses as v1=<64 hex>                    else 401
        ↓
scoped content-type parser: capture raw Buffer + parse JSON
        ↓
preHandler  (raw body available)
  5. verifyRequest(secret, {method, req.url, ts, nonce, rawBody})  else 401
  6. nonce check-and-record (600s, in memory)                      else 401
  7. req.serviceId = 'worker'
        ↓
════════ AUTHENTICATION ENDS · AUTHORIZATION BEGINS ════════
        ↓
eventId → event_outbox → authoritative product_id / ticket_id
claimed_* verified · ScopeContext from Core's data · RLS
feature validator · business rules · ai_execution · audit
```

**The nonce is recorded only after the signature verifies**, so an attacker
cannot poison the cache with guessed values and lock out the real worker.
Asserted by a test.

**A valid signature is not authorization.** A perfectly signed request with a
forged `claimed_product_id` returns **400, not 401** — the caller is authentic,
the claim is not. That distinction is the whole point of keeping the two
separate, and it is asserted directly.

---

## 43B.6 Raw-body requirement

HMAC signs `sha256(raw request bytes)`, so Core must verify the exact bytes
received. `JSON.parse` → `JSON.stringify` changes whitespace and key order, and
every signature then fails — the single most common HMAC integration bug.

A **scoped** content-type parser inside the `/internal` plugin keeps the
original buffer. Fastify content-type parsers are encapsulated per plugin
scope, verified empirically before the design was fixed and asserted by test:
`POST /v1/tickets` still receives a normally parsed object.

Proven by four tests that would fail against a re-serialisation: unusual key
ordering, pretty-printed whitespace, whitespace after colons/commas, and a
non-ASCII body where UTF-8 byte length exceeds character length.

Worker and Python both **serialise once**: `signedHeaders()` takes an
already-serialised string, so the API shape makes "sign what you send" the only
possible usage.

---

## 43B.7 Replay protection

**Worker → Core:** in-memory nonce cache, 600s TTL, mirroring the gateway's
existing `rememberNonce`. Sufficient because Core runs as one process, and
because this is defence in depth: a replayed AI result is already absorbed by
`UNIQUE(event_id, feature)`, and a replayed input re-claims a running execution
harmlessly. Correctness lives in Postgres; this bounds the HTTP request.

**Worker → Python: timestamp window only, no nonce store — deliberately.**
`/v1/execute` is a pure function with no side effects; a replay recomputes an
answer it already gave. A cache would break the stateless invariant and
horizontal scaling to prevent nothing. Asserted by a test that documents the
reasoning in its name.

**No new table, no migration, no Redis structure.**

---

## 43B.8 Failure and retry model

**BullMQ remains the only retry owner.** No retry logic was added to Core or
Python. Auth failures are 401 → the *existing* `errorForStatus` maps 4xx to
`PermanentJobError`, so an authentication fault can never become a model retry
loop. Confirmed live: with the AI service stopped, the worker still classified
the failure as `permanent: false` and retried — auth failures and transient
failures remain correctly distinguished.

| Condition | Status | Retryable |
|---|---|---|
| Missing/unknown service id, timestamp, nonce or signature | 401 | ❌ |
| Invalid signature; body, path or method tampered | 401 | ❌ |
| Expired or future timestamp | 401 | ❌ |
| Replayed nonce (Core only) | 401 | ❌ |
| Malformed body after auth | 400 | ❌ |
| Python 5xx / unreachable / timeout | — | ✅ |

**No new error codes.** `unauthenticated`, `signature_invalid`,
`timestamp_out_of_window` and `nonce_replayed` all already existed.

**Auth failures are logged, never audited.** `audit_event` is for attributed
business facts; a row per failed signature would let an unauthenticated caller
grow the audit table at will. Both sides log `service_id`, `method`, `path`,
`reason` and request id — and nothing else. Verified: zero audit rows from
authentication failures, and zero secrets or signatures in any log.

The failure **response** is identical for every cause; only the log carries the
reason, so an attacker cannot learn whether the timestamp or the signature was
the problem. Asserted by test.

---

## 43B.9 Explicitly out of scope

**Gateway → Core is unchanged.** `resolveAdminCaller` still accepts
`x-iris-support-user-id` and `x-iris-role` with no database lookup. HMAC would
not materially improve that boundary — it is loopback, and an attacker holding
the key can mint fresh requests anyway — and it is the platform's
highest-traffic path. Now that the worker no longer holds the key, the blast
radius is "gateway compromise", which is a coherent trust model. It deserves
its own review; it is recorded here rather than silently accepted.

---

## 43B.10 Files

**Created (5)**

```
core-service/src/internal/service-auth.ts          verification hooks + nonce cache
core-service/src/internal/service-auth.test.ts     32 tests
core-service/src/internal/phase2.security.test.ts  10 regression tests (2 failed before the fix)
worker/src/signing.ts                              one signing helper for both clients
worker/src/signing.test.ts                         22 tests
scripts/smoke-hmac.mjs                             live security verification
```

**Modified (15)**

```
core-service/src/server.ts               global x-internal-key hook skips /internal/
core-service/src/internal/internal.routes.ts  scoped raw-body parser + auth hooks
core-service/src/config.ts               +AI_WORKER_HMAC_SECRET, production guard
core-service/src/logger.ts               redact new secret names
worker/src/config.ts                     +2 HMAC secrets, −INTERNAL_API_KEY, −AI_SERVICE_KEY
worker/src/core-client.ts                sign; serialise once
worker/src/ai-client.ts                  sign with the OTHER secret; serialise once
worker/src/logger.ts                     redact x-iris-signature + new secrets
worker/src/consumers/ai.consumer.test.ts auth assertion converted to HMAC (+1 test)
ai-service/src/config.py                 AI_SERVICE_HMAC_SECRET; foreign-credential guard
ai-service/src/api/app.py                verify_request over await request.body()
ai-service/Containerfile                 repo-root context; COPY iris_hmac
ai-service/tests/{conftest,test_execute,test_contracts}.py   sign; +11 auth tests
core-service/src/internal/{ai.internal,ai.security}.test.ts  sign (business assertions kept)
scripts/smoke-ai.mjs                     sign internal calls (+2 checks)
infra/podman-compose.yml, .env, .env.example, package.json   secrets, build scripts
```

**Unchanged — explicitly:** `shared/hmac-utils/**` and `vectors.json` (the
whole point) · `shared/types/ai.ts`, `shared/contracts/ai/**` ·
`core-service/src/internal/{ai.service,ai.repo,ai.routes}.ts` ·
`events/{ai-dispatcher,publisher,outbox}.ts` · `db/with-scope.ts` ·
`audit/index.ts` · `tickets/**` · **all of `gateway/`** · every migration ·
`worker/src/{errors,index,consumers/ai.consumer}.ts` (logic) ·
`ai-service/src/api/{schemas,features}.py`.

**Dependencies: 0 new npm packages, 0 new Python packages, 0 new tables, 0 new
migrations, 0 new Redis structures, 0 new services, 0 new containers, 0 new
ports.** Python's `hmac`/`hashlib` are stdlib and `iris_hmac` is repo-local.

---

## 43B.11 Phase 1 compatibility

Every item verified unchanged:

| Component | Status |
|---|---|
| BullMQ queue `ai.jobs` | ✅ |
| `AIJob` envelope — `job_id`, `event_id`, `feature`, `product_id`, `ticket_id`, `correlation_id`, `requested_at`, `attempt` | ✅ |
| `AIInputRequest/Response`, `AIExecuteRequest`, `AIResult`, `AIError`, `AIResultRequest/Response` | ✅ |
| JSON Schema, fixtures, drift tests | ✅ |
| `ai_execution`, migration 013, `UNIQUE(event_id, feature)` | ✅ no new migration |
| `already_applied` short-circuit | ✅ |
| Outbox dispatcher, watermark, kill switch | ✅ |
| Worker orchestration order | ✅ |
| BullMQ as sole retry owner | ✅ |
| AI-outage behaviour | ✅ verified live |
| Event lookup → claims → scope → RLS → audit | ✅ |
| `noop` stub and `received_chars` | ✅ |
| Python statelessness | ✅ |
| Ticket creation, outbox, audit, RLS | ✅ |

---

## 43B.12 Tests

**301 automated tests — 300 pass, 1 container-only (passes in the container).
149 are new or converted in Phase 2.**

| Suite | Tests |
|---|---|
| `service-auth.test.ts` (real server, real Postgres) | 32 |
| `signing.test.ts` (worker) | 22 |
| `phase2.security.test.ts` (regression) | 10 |
| `ai.consumer.test.ts` | 30 |
| `ai.internal.test.ts` | 26 |
| `ai.security.test.ts` | 13 |
| `ai-contracts.test.ts` | 59 |
| `contracts.test.ts` | 23 |
| `hmac.test.ts` | 17 |
| `state-machine.test.ts` | 10 |
| **vitest total** | **242 in 10 files** |
| `ai-service/tests/` | 34 (+1 container-only) |
| `shared/hmac-utils/py` | 25 |
| **pytest total** | **59 + 1 skipped** |

Coverage includes every case in the specification: valid signature, wrong
secret, body/path/method/timestamp/nonce tampering, all missing and malformed
headers, unknown service, expired and future timestamps, replay, nonce-not-burned
on failure, four raw-body cases, parser isolation, and the published-vector lock.

---

## 43B.13 Running-system verification

| Check | Result |
|---|---|
| `tsc --noEmit` | ✅ clean |
| `vitest run` | ✅ 242/242, 10 files |
| `npm run test:py` | ✅ 59 passed, 1 skipped |
| `smoke.mjs` | ✅ 43 |
| `smoke-admin.mjs` | ✅ 61 |
| `smoke-contract.mjs` | ✅ 9 |
| `npm run test:ai` (end-to-end pipeline) | ✅ **44/44** |
| `npm run test:hmac` (live security) | ✅ **15/15** |
| Ticket → outbox → BullMQ → worker → Python → Core → `ai_execution` + audit | ✅ |
| Ticket unchanged by `noop` | ✅ |
| Duplicate delivery idempotent | ✅ |
| AI outage: ticket created, untouched, retried as `permanent:false` | ✅ |
| Recovery after AI restart: `succeeded`, attempt 1 | ✅ |
| Secrets/signatures in logs | ✅ **zero occurrences** across all four services |
| Audit rows from auth failures | ✅ **zero** |

**Live security verification (`npm run test:hmac`), all passing:**

```
worker signature authenticates to Core                      ✓
worker signature authenticates to Python                    ✓
cannot read /v1/tickets with a forged product header        ✓ 401
cannot reach /admin/api/tenants as a forged super_admin     ✓ 401
unsigned /internal is 401                                   ✓
/internal with only INTERNAL_API_KEY is 401                 ✓  ← the Phase 1 hole
Core rejects a tampered body                                ✓
Python rejects a tampered body                              ✓
Core rejects a stale timestamp                              ✓
a nonce is accepted once / replay rejected (nonce_replayed) ✓
Python accepts a repeated nonce (stateless, by design)      ✓
the Core secret does NOT work against Python                ✓
the Python secret does NOT work against Core                ✓
```

---

## 43B.14 Known issue found during implementation

**`podman-compose build` cannot build these images on Windows.** podman-compose
1.6.0 parses `build.dockerfile` correctly — visible in `podman-compose config`
— but does not pass `-f` through to podman, so any Containerfile outside the
context root fails with *"no Containerfile or Dockerfile specified or found in
context directory"*. Both images need a repo-root context (ai-service to copy
`shared/hmac-utils/py`, worker to copy `shared/`), so both hit it.

This is a tooling limitation, not a design fault: `podman build -f … .` works
correctly and produces the same images. Use:

```bash
npm run images:build     # podman build -f ai-service/Containerfile -t … .
npm run infra:up
```

The `build:` blocks remain in the compose file for the target topology and
newer tooling. Documented in the compose header.

---

## 43B.15 Remaining work

None for Phase 2. Carried forward deliberately:

- **Gateway → Core header trust** (§43B.9) — needs its own review.
- **Secret rotation is redeploy-based.** Adequate at this scale; a rotation
  window would mean accepting two secrets briefly, which is a config change
  rather than infrastructure.
- **Provider/model still unnamed** — unchanged from Phase 1, and still required
  before Phase 7.

---

---

# 43C. Phase 3 Step 3 — Retry Hardening

## Status: 🟢 COMPLETE

Implemented and verified on the running system, 2026-09-07.

Scope was deliberately narrow: **retry behaviour only.** Terminal-failure
reporting (Step 4), the reaper (Step 5) and timeout hardening (Step 6) are NOT
implemented — an exhausted job still leaves `ai_execution` at `running`, which
is expected until Step 4/5.

## 43C.1 What was wrong

`[CODE]` The dispatcher configured `backoff: { type: 'exponential', delay: 1000 }`,
which BullMQ computes as `2^(n-1) * 1000` → **1s, 2s, 4s, 8s ≈ a 15-second
retry window**. The comment beside it claimed "1s, 5s, 25s, 2m, 10m".

`[LIVE]` Confirmed twice during Phases 1–2: a ~30-second AI-service restart
exhausted all 5 attempts and dead-lettered every in-flight job.

`[CODE]` Separately, `errorForStatus` mapped **all** 4xx to permanent —
including **429**, the most common transient failure an LLM provider produces.
A rate-limit window would have dead-lettered every job instead of waiting.

## 43C.2 The policy now

| Property | Value |
|---|---|
| Attempts | **5** (unchanged) |
| Curve | **1s, 5s, 25s, 120s, 600s** — the same array `publisher.ts` already uses |
| Jitter | **±20%, two-sided** |
| Reachable window at 5 attempts | **151 s (~2.5 min)** |
| Retry owner | **BullMQ, still the only one** |

### ⚠️ Only four of the five delays are reachable

`[CODE][TEST][LIVE]` BullMQ retries while `attemptsMade + 1 < attempts`, so with
5 attempts the strategy is called with 1, 2, 3, 4 and the 5th execution is
terminal:

```
execution 1 fails -> 1s     execution 4 fails -> 120s
execution 2 fails -> 5s     execution 5 fails -> TERMINAL
execution 3 fails -> 25s
                            window = 151s
```

The 600s entry is retained but **unreachable**. Reaching the ~12.5-minute window
described in the Step 2 design requires `AI_RETRY_ATTEMPTS = 6`, which was
explicitly frozen at 5. Raising it is a one-constant change and is asserted by
test — but it also raises maximum job lifetime, which the Step 5 reaper
threshold is derived from, so it is a deliberate decision rather than a default.

**This is a documented deviation from the Step 2 design, which asserted both
"5 attempts" and "~12.5 min". Those two cannot both hold. 5 attempts won.**

### Classification

| Failure | Class |
|---|---|
| 408, 429 | **temporary** — timing, not correctness |
| other 4xx (400/401/403/404/409/422) | permanent |
| 5xx (500/502/503/504) | temporary |
| network, ECONNREFUSED/RESET, timeout | temporary |
| `AIError.kind='temporary'` | temporary |
| malformed job/schema, unsupported feature, unknown event, claim mismatch, invalid HMAC, invalid AI output, missing config | permanent |

`Retry-After` is **deliberately ignored** (Phase 3 freeze). Honouring it would
create a second authority over retry timing beside BullMQ. If it is ever
honoured the constraint is `effective Retry-After <= max backoff < reaper
threshold`.

## 43C.3 Where the policy lives

`shared/types/ai-retry.ts` — because BullMQ splits the policy across two
processes: the Core dispatcher sets `attempts` and `backoff.type`, the worker
supplies the strategy function. Importing one module is what stops them
drifting.

**Deployment coupling:** `backoff: { type: 'custom' }` means "ask the Worker
`settings.backoffStrategy`". A worker without one throws `Unknown backoff
strategy custom` — `[TEST]` verified it surfaces on the worker `error`
channel, so the failure is loud, not silent. Core and worker ship together from
this repository.

## 43C.4 A bug this found

`[LIVE]` `job.attemptsMade` means **different things in different places**:

```
processor      : 0 on the first run  -> attempt = attemptsMade + 1
'failed' event : already incremented -> attempt = attemptsMade
```

The first version of the retry logging used `+1` in the failed handler, which
logged "attempt 6" for a 5-attempt job and declared retries exhausted one step
early. Caught by reading a live log rather than by a test, then pinned by one.
BullMQ documents neither reading.

## 43C.5 Files

**Created (4):** `shared/types/ai-retry.ts` · `shared/types/ai-retry.test.ts` ·
`worker/src/errors.test.ts` · `worker/src/retry.integration.test.ts`

**Modified (5):** `shared/types/index.ts` · `worker/src/errors.ts` (408/429) ·
`worker/src/ai-client.ts` (routed onto the single classifier) ·
`worker/src/index.ts` (strategy + retry logging) ·
`core-service/src/events/ai-dispatcher.ts` (job opts + corrected comment)

**Unchanged:** `shared/hmac-utils/**` · AI contracts · `ai_execution` and every
migration · outbox · audit · RLS · Core internal API · Python service.

**No schema change, no new dependency, no new infrastructure.**

## 43C.6 Verification

| Check | Result |
|---|---|
| `tsc --noEmit` | ✅ clean |
| vitest | ✅ **317 passed**, 13 files (+75 new) |
| pytest | ✅ 59 passed, 1 skipped |
| `test:ai` / `test:hmac` | ✅ 44/44 · 15/15 |
| `smoke` / `-admin` / `-contract` | ✅ 43 · 61 · 9 |

`[LIVE]` **Measured retry curve** with the AI service stopped:

```
attempt 1  14:13:49
attempt 2  14:13:50   +1s     [curve 1s   ±20%]
attempt 3  14:13:55   +5s     [curve 5s   ±20% = 4-6s]
attempt 4  14:14:19   +24s    [curve 25s  ±20% = 20-30s]
attempt 5  14:16:18   +119s   [curve 120s ±20% = 96-144s]
TOTAL 149s (nominal 151s, jitter band 121-181s) — exactly 5 executions
```

`retry_in_ms` logged 1175 / 5479 / 22952 / 102942 — every value inside its ±20%
band. Recovery after restarting the AI service: `succeeded` on attempt 1.

`[TEST]` Against real BullMQ + Redis: temporary → exactly 5 executions;
permanent → exactly 1; strategy invoked with 1,2,3,4 (never 5); missing strategy
errors loudly; a success is never re-executed; gap ratios hold the 1:5:25 shape
at 1/10 scale.

`[TEST]` HMAC unchanged — every attempt still signs a fresh timestamp, nonce and
signature; no headers are cached across attempts.

## 43C.7 Deferred to later Phase 3 steps

Terminal-failure reporting (Step 4) · reaper (Step 5) · Python inference
timeout, `statement_timeout`, `lock_timeout`, `lockDuration`, bounded shutdown
drain (Step 6) · reliability test suite (Step 7) · operator query and safe
replay (Step 8) · `Retry-After` · duplicate-inference prevention.

---

# 45. Future Implementation Checklist

## Foundation

- [x] AI config — core config.ts, kill switch + watermark
- [x] AI execution/audit schema — migration 013, `ai_execution`
- [x] internal API namespace — `/internal/ai/jobs/:eventId/{input,result}`
- [x] outbox dispatch support — `events/ai-dispatcher.ts`
- [x] BullMQ setup — one queue, `ai.jobs`
- [x] AI worker — `worker/` workspace
- [x] Python AI service — FastAPI skeleton + `noop` stub
- [x] service authentication — HMAC (Phase 2); key separation enforced at boot
- [x] retry/timeout/idempotency — BullMQ owns retry; `UNIQUE(event_id, feature)`
- [x] kill switch — `AI_DISPATCH_ENABLED`

## Classification

- [ ] taxonomy mapping
- [ ] classification contract
- [ ] provider adapter
- [ ] prompt/version management
- [ ] structured model output
- [ ] validation
- [ ] persistence
- [ ] audit
- [ ] confidence thresholds
- [ ] end-to-end tests

## Business decisions

- [ ] priority rules
- [ ] severity rules
- [ ] team routing
- [ ] routing confidence
- [ ] human override

## AI signals

- [ ] sentiment
- [ ] keywords/tags
- [ ] summary
- [ ] next-step recommendation
- [ ] composite confidence

## Retrieval

- [ ] embedding provider
- [ ] embedding generation
- [ ] vector population
- [ ] ANN index
- [ ] similarity search
- [ ] hybrid retrieval
- [ ] reranker
- [ ] corpus indexing

## RAG/Copilot

- [ ] grounded answer
- [ ] citations
- [ ] Ask a Question
- [ ] AI Suggestions
- [ ] draft reply
- [ ] similar tickets
- [ ] copilot
- [ ] assignee recommendation

## Governance

- [ ] execution history
- [ ] model tracking
- [ ] prompt version tracking
- [ ] confidence analytics
- [ ] correction analytics
- [ ] fallback analytics
- [ ] latency
- [ ] cost
- [ ] human override analytics

---

# 46. Core Principles to Preserve

These principles should remain visible throughout implementation.

### Principle 1

> **AI predicts/extracts. IRIS decides.**

### Principle 2

> **AI must not become a dependency for basic ticket creation.**

### Principle 3

> **Python AI Service must not connect directly to PostgreSQL.**

### Principle 4

> **Tenant isolation belongs to Core, not the AI model.**

### Principle 5

> **LLM output is untrusted input until validated.**

### Principle 6

> **Important AI decisions must be auditable.**

### Principle 7

> **Retries must be safe and idempotent.**

### Principle 8

> **Reference implementation is a source of behavior and lessons, not code to copy blindly.**

### Principle 9

> **Existing IRIS security/domain infrastructure should be reused rather than duplicated.**

### Principle 10

> **No phase is complete until it is tested and verified in the running system.**

---

# 47. Change Log

## Initial version

Established:

- AI-only scope
- separate Python AI service
- BullMQ asynchronous architecture
- one AI queue
- feature-based job envelope
- separate AI execution history
- confidence-gated AI
- deterministic business decisions
- Podman deployment topology
- provider abstraction
- reference capability classification
- phase-by-phase implementation methodology
- testing and verification requirements

Future changes must record:

```text
Date
Decision/change
Reason
Impact
Affected phase
```

---

# 48. Final Target

The end state is not simply "an LLM connected to IRIS."

The target is a production-grade AI-assisted ticketing platform:

```text
                    IRIS
                      │
        ┌─────────────┴─────────────┐
        │                           │
   Core Platform                 AI Platform
        │                           │
 Auth / RLS                    Classification
 Tickets                       Summary
 Audit                         Sentiment
 Rules                         Embeddings
 Outbox                        Retrieval
 Search                        Reranking
 Configuration                 RAG
        │                       Copilot
        └───────────┬───────────────┘
                    │
             Human-in-the-loop
                    │
                    ▼
             Better ticket
             resolution
```

The AI layer should make IRIS more intelligent **without weakening the foundations that make IRIS reliable and secure**.

---

## Change log — Phase 1

```text
Date      2026-09-07
Change    Phase 1 — AI Foundation implemented and verified end-to-end.
Reason    Establish a production-safe AI execution pipeline before any model
          work, so classification lands on tested boundaries rather than
          creating them.
Impact    +1 migration (ai_execution). New: worker workspace, Python AI
          service, /internal/ai endpoints, ai.jobs queue, AI dispatcher.
          Redis AOF enabled. Ticket creation, outbox, audit and RLS unchanged.
          229 tests passing; 42/42 running-system checks.
Phase     Phase 1 — status 🟢 Verified. Next: Phase 2 (HMAC service auth).
```

---

## Change log — Phase 2

```text
Date      2026-09-07
Change    Phase 2 — Service-to-Service HMAC Security implemented and verified.
Reason    Phase 1 gave the worker INTERNAL_API_KEY, the gateway's platform-wide
          credential, which core-service accepts on EVERY route. Combined with
          the header-trust model on /v1/* and /admin/api/*, a compromised
          worker could read any tenant's tickets and reach the admin API as
          super_admin — demonstrated against a running stack.
Impact    Worker → Core and Worker → Python are now HMAC authenticated with two
          separate directional secrets. Worker no longer holds INTERNAL_API_KEY
          or AI_SERVICE_KEY. shared/hmac-utils, the canonical string and the
          published vectors are UNCHANGED. No new dependency, table, migration,
          queue, service or port. Phase 1 contracts and pipeline unchanged.
          301 tests; 44/44 pipeline and 15/15 live security checks.
Phase     Phase 2 — status 🟢 COMPLETED. Next: Phase 3 (Reliability).
```

---

## Change log — Phase 3 Step 3

```text
Date      2026-09-07
Change    Retry hardening. Backoff moved from exponential(1000) to the
          platform curve 1s/5s/25s/120s/600s with +/-20% two-sided jitter;
          408 and 429 reclassified temporary; the two worker HTTP clients
          routed onto one classifier; the false backoff comment corrected.
Reason    The runtime window was ~15s, not the ~12.5min the comment claimed.
          A 30-second AI restart dead-lettered every in-flight job, observed
          twice. 429 - the commonest transient LLM provider failure - was
          classified permanent.
Impact    Retry window 15s -> 151s at 5 attempts. Policy centralised in
          shared/types/ai-retry.ts so dispatcher and worker cannot drift.
          One live-found bug fixed: attemptsMade is 0-based in the processor
          but already incremented in the 'failed' event.
          317 vitest + 60 pytest; 44/44 pipeline, 15/15 security.
          No schema change, no new dependency, no new infrastructure.
Deviation The Step 2 design asserted BOTH "5 attempts" and "~12.5 min". Only
          four delays are reachable at 5 attempts, so the window is 151s.
          5 attempts was the explicit freeze and won; the 600s entry is
          retained and unreachable. AI_RETRY_ATTEMPTS=6 would unlock it.
Phase     Phase 3 Step 3 - COMPLETE. Next: Step 4 (terminal failure reporting).
```
