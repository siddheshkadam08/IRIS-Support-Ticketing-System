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
  'classification', // Phase 7
  'sentiment', // Phase 9
  'keywords', // Phase 9
  'summary', // Phase 9
  'rag', // Phase 13
] as const;
export type AIFeature = (typeof AI_FEATURES)[number];

/**
 * Features Core will actually ACCEPT today — deliberately narrower than
 * AI_FEATURES. A job naming a declared-but-unbuilt feature is a PERMANENT
 * error, not something to retry five times.
 */
export const SUPPORTED_AI_FEATURES: readonly AIFeature[] = ['noop'];

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
  'ticket.created': ['noop'],
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
