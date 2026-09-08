/**
 * AI contracts — every type that crosses a process boundary in the AI pipeline.
 *
 *   Core dispatcher --AIJob-->            BullMQ 'ai.jobs' --> worker
 *   worker --AIInputRequest-->            Core --AIInputResponse--> worker
 *   worker --AIExecuteRequest-->          Python --AIResult--> worker
 *   worker --AIResultRequest-->           Core --AIResultResponse--> worker
 *
 * Field names are snake_case because these are WIRE types, not internal ones.
 * The repo already draws that line: `ScopeContext.productScope` is camelCase
 * because it never leaves the process, while `TicketDTO.product_tenant_id` is
 * snake_case because it does. Keeping it means the JSON Schema in
 * shared/contracts/ai/ is a literal description of these types, Python gets
 * idiomatic names for free, and there is no boundary-conversion layer to get
 * wrong. See /SKILLS.md section 2.
 */

/**
 * Every AI capability that will ever share the single `ai.jobs` queue.
 *
 * Declaring the whole set now is what makes ONE queue viable: the queue is
 * generic and `feature` is the discriminator. Adding a capability later is a
 * new entry here plus a handler — not a new queue, worker or deployment.
 */
export const AI_FEATURES = [
  'noop', // Phase 1 stub. Proves the pipeline; touches no ticket state.
  'classification', // Phase 4 — controlled enablement
  'sentiment', // Phase 9
  'keywords', // Phase 9
  'summary', // Phase 5 — informational enrichment, no business authority
  /**
   * Phase 13. Declared since Phase 1; implemented now. Like `embedding` and
   * `reranking` it is deliberately ABSENT from SUPPORTED_AI_FEATURES below:
   * grounding is a synchronous step inside a search request and never travels
   * on the ai.jobs queue.
   */
  'rag',
  /**
   * Phase 10. Present here because the worker's structural AIResult check and
   * the /v1/execute contract are shared by every capability — but deliberately
   * ABSENT from SUPPORTED_AI_FEATURES below, because embedding does not travel
   * on the ai.jobs queue at all. See shared/types/embedding.ts for why.
   */
  'embedding',
  /**
   * Phase 12. Present here for the same reason `embedding` is — the worker's
   * structural AIResult check and the /v1/execute contract are shared by every
   * capability — and absent from SUPPORTED_AI_FEATURES for the same reason
   * too: reranking is a synchronous step inside a search request and never
   * travels on ai.jobs.
   */
  'reranking',
] as const;
export type AIFeature = (typeof AI_FEATURES)[number];

/**
 * Features Core will actually ACCEPT today — deliberately narrower than
 * AI_FEATURES. A job naming a declared-but-unbuilt feature is a PERMANENT
 * error, not something to retry five times.
 */
/**
 * PHASE 4: `classification` is ENABLED, for CONTROLLED REVIEW.
 *
 * Validated against the real provider (Azure OpenAI, deployment gpt-4.1):
 * 23/24 calls succeeded, p95 5218ms inside the 6s gate, zero invented taxonomy
 * values, and Core's deterministic engine proven authoritative in both
 * directions — a ticket shouting "URGENT CRITICAL EMERGENCY" was scored Low,
 * and one insisting it was a "minor issue" while 500 users were locked out was
 * scored High.
 *
 * ⚠️ ENABLED DOES NOT MEAN AUTO-ROUTING.
 *
 * The model's confidence is SELF-REPORTED and uncalibrated: it returned >=0.95
 * on most tickets, which put 21 of 23 into AUTO_ROUTE under the default
 * thresholds. High measured accuracy is not evidence that the confidence
 * SIGNAL discriminates — those are different claims, and only the second would
 * justify unattended routing.
 *
 * So the initial rollout raises `ai_thresholds.auto_route_p1` above 1.0 per
 * product, making AUTO_ROUTE unreachable while the whole pipeline still runs.
 * Every classification persists as `ai_uncertain` for human review. That uses
 * the per-product configuration that already existed rather than adding a
 * shadow-mode flag, table or service.
 *
 * Lower it once real accept/reject data shows the thresholds separate correct
 * classifications from incorrect ones.
 */
/**
 * ⚠️ NEITHER `embedding` NOR `reranking` IS HERE, and that is a security
 * decision rather than an oversight.
 *
 * This list gates what `/internal/ai/jobs/:eventId/result` will accept. The
 * embedding path has its own route, its own validator and its own idempotency
 * key (a content fingerprint, not an event id). Listing it here would let a
 * queue job claim `feature: "embedding"` and reach a result handler that has
 * no validator for it — a permanent error at best, and at worst a shape nobody
 * checked being written somewhere. Phase 10 tests assert it stays absent.
 */
export const SUPPORTED_AI_FEATURES: readonly AIFeature[] = ['noop', 'classification', 'summary'];

export function isSupportedFeature(v: unknown): v is AIFeature {
  return typeof v === 'string' && (SUPPORTED_AI_FEATURES as readonly string[]).includes(v);
}

/** The one and only AI queue (ADR-003). Adding a second is an architecture change. */
export const AI_QUEUE_NAME = 'ai.jobs';

/**
 * Which outbox events produce which AI jobs.
 *
 * The dispatcher consults exactly this map, so the set of events that can ever
 * reach the AI pipeline is one readable constant rather than a condition spread
 * across a query. Phase 1 wires ticket.created to the stub and nothing else.
 */
export const AI_EVENT_FEATURES: Readonly<Record<string, readonly AIFeature[]>> = {
  /**
   * A new ticket fans out to every AI capability at once.
   *
   * They succeed or fail INDEPENDENTLY — UNIQUE(event_id, feature) keys them
   * apart, so each gets its own execution row, retry budget, audit trail and
   * replay. A summary failure cannot cost a ticket its classification, and
   * neither can disturb the Phase 1 pipeline proof.
   *
   * This is why Phase 5 added a feature rather than two fields on the
   * classification payload: shared failure was the thing to avoid.
   */
  'ticket.created': ['noop', 'classification', 'summary'],
};

// ─────────────────────────────────────────────────────────────────────────
// Core dispatcher -> BullMQ -> worker
// ─────────────────────────────────────────────────────────────────────────

/**
 * The queue payload. Identity and context ONLY — never the ticket itself.
 *
 * The ticket is deliberately absent: Redis is not a place to park customer
 * text, and a job that carries a snapshot goes stale the moment the ticket is
 * edited. The worker fetches fresh, authorized input from Core instead.
 */
export interface AIJob {
  /**
   * `aij_<ULID>`. Identity of THIS dispatch attempt; also passed to BullMQ as
   * its explicit jobId so payload and queue agree.
   *
   * NOT stable across re-dispatch, and never an authorization input.
   */
  job_id: string;
  /**
   * `evt_<ULID>` — the event_outbox row Core wrote inside the ticket
   * transaction. The durable business fact, STABLE across every retry, and the
   * only caller-supplied value Core will use as a lookup key.
   */
  event_id: string;
  feature: AIFeature;
  /** Copied from event_outbox.product_id. A CLAIM: Core re-derives and compares. */
  product_id: string;
  /** Copied from event_outbox.aggregate_id. A CLAIM: Core re-derives and compares. */
  ticket_id: string;
  /** event_outbox.request_id — threads widget/gateway/core/worker/python/audit. */
  correlation_id: string;
  requested_at: string;
  /** 1-based. The dispatcher seeds 1; the worker sends attemptsMade + 1. */
  attempt: number;
}

// ─────────────────────────────────────────────────────────────────────────
// worker -> Core internal API
// ─────────────────────────────────────────────────────────────────────────

/**
 * What the worker ASSERTS about the job it is holding.
 *
 * The `claimed_` prefix is load-bearing, not decoration: it makes the security
 * property visible at every call site. Core verifies these against its own
 * outbox row and NEVER uses them to look anything up. The only key is the
 * eventId in the URL path.
 */
export interface AIJobClaims {
  job_id: string;
  feature: AIFeature;
  attempt: number;
  correlation_id: string;
  claimed_product_id: string;
  claimed_ticket_id: string;
}

export type AIInputRequest = AIJobClaims;

/** The only ticket fields that may cross into the AI pipeline. */
export interface AITicketInput {
  /** Opaque ULID. A correlation handle for logs; identifies no tenant. */
  ticket_id: string;
  subject: string | null;
  description: string;
}

/**
 * The product's own label set, sent from Core so the taxonomy is never
 * duplicated inside Python.
 */
export interface AITaxonomy {
  categories: Array<{ value: string; label: string }>;
  severities: string[];
  /**
   * Phase 4 classification vocabularies. Always populated by Core — the
   * product's own values, or the platform defaults when it configures none.
   *
   * `core_categories` is deliberately NOT here: it feeds Core's deterministic
   * priority engine and Python cannot use it, so it never crosses the boundary.
   */
  issue_types: string[];
  impacts: string[];
}

/** From product.config.ai_thresholds merged over the ADR-005 defaults. */
export interface AIThresholds {
  auto_route_p1: number;
  auto_route_margin: number;
  triage_floor: number;
}

/**
 * Discriminated on `status` so the duplicate arm cannot structurally carry
 * ticket data — a caller that ignores the flag still gets nothing to leak.
 */
export type AIInputResponse =
  | {
      status: 'ready';
      feature: AIFeature;
      correlation_id: string;
      ticket: AITicketInput;
      taxonomy: AITaxonomy;
      thresholds: AIThresholds;
    }
  | {
      status: 'already_applied';
      feature: AIFeature;
      correlation_id: string;
      execution_id: string;
      execution_status: 'succeeded' | 'failed';
    };

// ─────────────────────────────────────────────────────────────────────────
// worker -> Python  (THE data boundary)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Exactly what crosses into the AI service — the narrowest useful payload.
 *
 * This type exists so the "what may cross" rule is expressible in code rather
 * than in a review comment. The worker must NEVER forward an AIInputResponse
 * verbatim: that would send ticket_id for no reason.
 *
 * Never present, and never to be added without a written decision:
 * product_id, product_tenant_id, raised_by_ref, raiser_identity, email,
 * identity_assurance, reference, assignee_id, metadata, comments, attachments,
 * any secret, any token, any database handle.
 */
export interface AIExecuteRequest {
  feature: AIFeature;
  /** == correlation_id. Python's only identifier, used for log correlation. */
  request_id: string;
  input: {
    subject: string | null;
    description: string;
    /** Only for features that classify. Absent for `noop`. */
    taxonomy?: AITaxonomy;
    thresholds?: AIThresholds;
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Python -> worker -> Core
// ─────────────────────────────────────────────────────────────────────────

/**
 * `kind` alone carries retryability. There is deliberately no separate
 * `retryable` boolean — two fields that must agree eventually disagree.
 *
 *   temporary -> the same call might succeed later    (BullMQ retries)
 *   permanent -> the same call returns the same answer (fail fast)
 */
export interface AIError {
  kind: 'temporary' | 'permanent';
  /** Stable machine code: 'provider_timeout', 'unsupported_feature', ... */
  code: string;
  /** Human-readable. Never ticket text, never a secret. */
  message: string;
}

/**
 * What the model produced. UNTRUSTED until Core's per-feature validator
 * accepts it — `data` is deliberately typed as an opaque record so no caller
 * can pretend it has been checked.
 */
export interface AIResult {
  feature: AIFeature;
  status: 'succeeded' | 'failed';
  data: Record<string, unknown>;
  confidence?: number | null;
  provider?: string | null;
  model?: string | null;
  model_version?: string | null;
  prompt_version?: string | null;
  latency_ms?: number | null;
  fallback_used?: boolean;
  error?: AIError | null;
}

export interface AIResultRequest extends AIJobClaims {
  result: AIResult;
}

export interface AIResultResponse {
  execution_id: string;
  status: 'succeeded' | 'failed';
  /** false => a duplicate of an already-terminal execution. Nothing was written. */
  applied: boolean;
  /** Always false in Phase 1: `noop` proves the pipeline without touching state. */
  ticket_updated: boolean;
}

// ─────────────────────────────────────────────────────────────────────────
// Phase 1 stub payload
// ─────────────────────────────────────────────────────────────────────────

/**
 * The only `data` shape Phase 1 accepts.
 *
 * Trivial on purpose, but it gives Core's validation boundary something REAL
 * to reject — a response missing `ok` is a permanent validation failure, which
 * is exactly what the malformed-response tests send.
 */
export interface NoopData {
  ok: true;
  received_chars: number;
}

/**
 * ADR-005. Used when product.config.ai_thresholds is absent — which it is on
 * every seeded product today, so these defaults do all the work in Phase 1.
 */
export const DEFAULT_AI_THRESHOLDS: AIThresholds = {
  auto_route_p1: 0.8,
  auto_route_margin: 0.25,
  triage_floor: 0.5,
};
