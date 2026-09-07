import {
  AppError,
  DEFAULT_AI_THRESHOLDS,
  SEVERITIES,
  isSupportedFeature,
  notFound,
  type AIFeature,
  type AIInputRequest,
  type AIInputResponse,
  type AIResultRequest,
  type AIResultResponse,
  type AITaxonomy,
  type AIThresholds,
} from '@iris/shared/types';
import { withScope, withSystemScope, type ScopeContext } from '../db/with-scope.js';
import { writeAudit } from '../audit/index.js';
import { logger } from '../logger.js';
import type { ProductConfig } from '../products/product.repo.js';
import { claimExecution, completeExecution } from './ai.repo.js';

/**
 * The Core half of the AI pipeline. This is where "AI predicts, IRIS decides"
 * is actually enforced.
 *
 * Three responsibilities, in order:
 *
 *   1. IDENTITY. Establish who this job is really for, from Core-owned data.
 *      The worker's claims are checked, never believed.
 *   2. ISOLATION. Build the RLS scope from that authoritative identity and do
 *      every ticket read inside it.
 *   3. VALIDATION. Treat the model output as untrusted input until a
 *      per-feature validator has accepted it.
 *
 * What this file is NOT responsible for: prompts, models, providers, retries,
 * or queue mechanics. Those live in the worker and the Python service.
 */

// ─────────────────────────────────────────────────────────────────────────
// 1. Identity — resolved from Core's own outbox row
// ─────────────────────────────────────────────────────────────────────────

interface ResolvedAIEvent {
  eventId: string;
  eventType: string;
  /** AUTHORITATIVE. Read from event_outbox, never from the request body. */
  productId: string;
  /** AUTHORITATIVE. event_outbox.aggregate_id for a ticket aggregate. */
  ticketId: string;
  correlationId: string;
  productConfig: ProductConfig;
}

interface OutboxIdentityRow {
  product_id: string | null;
  aggregate: string;
  aggregate_id: string | null;
  event_type: string;
  request_id: string | null;
  config: ProductConfig | null;
}

/**
 * Resolve a job to the tenant and ticket Core itself recorded when the ticket
 * was created.
 *
 * withSystemScope is used for exactly this lookup and nothing else. It is the
 * same narrow exception product.repo.ts already relies on: resolving WHICH
 * tenant is involved is what establishes the scope, so the query cannot itself
 * be scoped without being circular. Two properties keep it safe —
 *
 *   - event_outbox.event_id is UNIQUE, so this can match at most one row and
 *     cannot widen anybody's visibility;
 *   - it reads routing metadata and product config, never ticket content.
 *
 * Every byte of ticket data is read later, under a normal product scope.
 */
async function resolveAIEvent(eventId: string): Promise<ResolvedAIEvent> {
  const row = await withSystemScope(`ai-resolve:${eventId}`, async (tx) => {
    const { rows } = await tx.query<OutboxIdentityRow>(
      `SELECT e.product_id, e.aggregate, e.aggregate_id, e.event_type, e.request_id,
              p.config
         FROM event_outbox e
         LEFT JOIN product p ON p.id = e.product_id
        WHERE e.event_id = $1`,
      [eventId],
    );
    return rows[0] ?? null;
  });

  // Deliberately the same 404 the rest of the API uses for "not visible".
  // A worker cannot forge an event_id into existence — only Core writes them,
  // inside the ticket transaction.
  if (!row) throw notFound('No such AI event.');

  if (row.aggregate !== 'ticket' || !row.aggregate_id || !row.product_id) {
    throw new AppError('invalid_request', 'Event is not a ticket-aggregate AI event.');
  }

  return {
    eventId,
    eventType: row.event_type,
    productId: row.product_id,
    ticketId: row.aggregate_id,
    correlationId: row.request_id ?? eventId,
    productConfig: row.config ?? {},
  };
}

/**
 * Check the worker's claims against the authoritative event.
 *
 * The claims are a CONSISTENCY CHECK, never an authorization input. Even if
 * this function were deleted, the scope below is still built from
 * `event.productId`, so RLS would return zero rows rather than another
 * tenant's rows. This is the loud first layer; RLS is the silent second.
 */
function verifyClaims(
  event: ResolvedAIEvent,
  claims: { feature: string; claimed_product_id: string; claimed_ticket_id: string },
): AIFeature {
  if (!isSupportedFeature(claims.feature)) {
    // Covers both an undeclared feature and one declared for a later phase.
    // Permanent by nature: retrying cannot make the feature exist.
    throw new AppError('invalid_request', 'Unsupported AI feature.', {
      feature: claims.feature,
    });
  }
  if (claims.claimed_product_id !== event.productId) {
    // No detail about the real product — a mismatch must not become an oracle.
    throw new AppError('invalid_request', 'Claimed product does not match the event.');
  }
  if (claims.claimed_ticket_id !== event.ticketId) {
    throw new AppError('invalid_request', 'Claimed ticket does not match the event.');
  }
  return claims.feature;
}

// ─────────────────────────────────────────────────────────────────────────
// 2. Isolation — the scope is built from Core data only
// ─────────────────────────────────────────────────────────────────────────

/**
 * Role 'none' maps to actor_type 'system' in writeAudit, which is the honest
 * description of an AI pipeline actor: it is not the product, not a raiser and
 * not a support user. Tenant isolation comes from productScope, which is set
 * from the authoritative event and nothing else.
 */
function aiScope(event: ResolvedAIEvent): ScopeContext {
  return {
    productScope: [event.productId],
    role: 'none',
    requestId: event.correlationId,
  };
}

function taxonomyFor(config: ProductConfig): AITaxonomy {
  return {
    categories: config.categories ?? [],
    severities: config.severities?.map((s) => s.value) ?? [...SEVERITIES],
  };
}

/** ADR-005 defaults, overridden per product where configured. */
function thresholdsFor(config: ProductConfig): AIThresholds {
  return { ...DEFAULT_AI_THRESHOLDS, ...(config.ai_thresholds ?? {}) };
}

// ─────────────────────────────────────────────────────────────────────────
// 3. Validation — model output is untrusted until it passes a validator
// ─────────────────────────────────────────────────────────────────────────

export interface FeatureValidation {
  ok: boolean;
  code?: string;
  message?: string;
  /** The validated, narrowed payload that is safe to persist. */
  value?: Record<string, unknown>;
}

/**
 * One validator per feature. Phase 7 adds `classification` here — taxonomy
 * membership, threshold bands, then the deterministic IRIS rules — and the
 * surrounding plumbing does not change.
 */
const FEATURE_VALIDATORS: Record<AIFeature, (data: Record<string, unknown>) => FeatureValidation> =
  {
    noop: (data) => {
      if (data.ok !== true) {
        return { ok: false, code: 'invalid_ai_output', message: 'noop.data.ok must be true' };
      }
      const chars = data.received_chars;
      if (typeof chars !== 'number' || !Number.isInteger(chars) || chars < 0) {
        return {
          ok: false,
          code: 'invalid_ai_output',
          message: 'noop.data.received_chars must be a non-negative integer',
        };
      }
      return { ok: true, value: { ok: true, received_chars: chars } };
    },
    // Declared so the map is exhaustive over AIFeature. Unreachable in Phase 1:
    // verifyClaims rejects anything outside SUPPORTED_AI_FEATURES first.
    classification: notImplemented('classification'),
    sentiment: notImplemented('sentiment'),
    keywords: notImplemented('keywords'),
    summary: notImplemented('summary'),
    rag: notImplemented('rag'),
  };

function notImplemented(feature: string) {
  return (): FeatureValidation => ({
    ok: false,
    code: 'feature_not_implemented',
    message: `${feature} is not implemented in this phase`,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Endpoint: input
// ─────────────────────────────────────────────────────────────────────────

interface TicketInputRow {
  id: string;
  subject: string | null;
  description: string;
}

/**
 * Hand the worker the minimum the AI service needs, having first proved the
 * job is real and established the tenant scope.
 *
 * Returns `already_applied` when a previous attempt already reached a terminal
 * state. That short-circuit is why a redelivery storm costs ZERO model calls:
 * the duplicate is caught before the worker ever contacts Python.
 */
export async function getAIInput(
  eventId: string,
  req: AIInputRequest,
): Promise<AIInputResponse> {
  const event = await resolveAIEvent(eventId);
  const feature = verifyClaims(event, req);
  const scope = aiScope(event);

  return withScope(scope, async (tx) => {
    const execution = await claimExecution(tx, {
      productId: event.productId,
      ticketId: event.ticketId,
      feature,
      eventId: event.eventId,
      jobId: req.job_id,
      correlationId: event.correlationId,
      attempt: req.attempt,
    });

    if (execution.status !== 'running') {
      logger.info(
        { eventId, feature, executionId: execution.id, status: execution.status },
        'duplicate AI job — already applied, AI service will not be called',
      );
      return {
        status: 'already_applied',
        feature,
        correlation_id: event.correlationId,
        execution_id: execution.id,
        execution_status: execution.status,
      };
    }

    // The SELECT list IS the data boundary. Columns that must never reach the
    // AI service — raiser_identity, raised_by_ref, product_tenant_id,
    // reference, metadata — are not fetched, so they are never in memory to
    // leak. RLS has already constrained this to the resolved product.
    const { rows } = await tx.query<TicketInputRow>(
      `SELECT id, subject, description FROM ticket WHERE id = $1`,
      [event.ticketId],
    );
    const ticket = rows[0];

    // Zero rows means RLS said no, or the ticket is gone. Indistinguishable on
    // purpose — a 403 here would confirm that a ticket with that id exists.
    if (!ticket) throw notFound('No such ticket is visible for this AI job.');

    return {
      status: 'ready',
      feature,
      correlation_id: event.correlationId,
      ticket: {
        ticket_id: ticket.id,
        subject: ticket.subject,
        description: ticket.description,
      },
      taxonomy: taxonomyFor(event.productConfig),
      thresholds: thresholdsFor(event.productConfig),
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Endpoint: result
// ─────────────────────────────────────────────────────────────────────────

/**
 * Apply an AI result.
 *
 *   validate request  (zod, at the route)
 *   -> resolve + verify identity
 *   -> validate the model output against the feature validator
 *   -> transition ai_execution, conditionally on status='running'
 *   -> write audit
 *   -> update the ticket ONLY where the feature is permitted to
 *
 * Note what a rejected model output is NOT: it is not a 4xx. The worker's
 * message was well-formed; the MODEL was wrong. Retrying an identical call
 * cannot change that, so it is recorded as a permanent execution failure and
 * answered 200. A 4xx here would send the worker into a pointless retry loop.
 */
export async function submitAIResult(
  eventId: string,
  req: AIResultRequest,
): Promise<AIResultResponse> {
  const event = await resolveAIEvent(eventId);
  const feature = verifyClaims(event, req);
  const scope = aiScope(event);

  if (req.result.feature !== feature) {
    throw new AppError('invalid_request', 'Result feature does not match the job feature.');
  }

  // Decide the outcome BEFORE opening the transaction, so the transaction is
  // short and contains only writes.
  let status: 'succeeded' | 'failed';
  let validatedResult: Record<string, unknown> | null = null;
  let errorCode: string | null = null;
  let errorMessage: string | null = null;

  if (req.result.status === 'failed') {
    // Python already declared failure. Record it as-is; the retry decision was
    // the worker's and has already been made by the time we see this.
    status = 'failed';
    errorCode = req.result.error?.code ?? 'ai_failed';
    errorMessage = req.result.error?.message ?? null;
  } else {
    const validation = FEATURE_VALIDATORS[feature](req.result.data);
    if (validation.ok) {
      status = 'succeeded';
      validatedResult = validation.value ?? {};
    } else {
      // Untrusted output rejected. This is the "never trust raw LLM output"
      // rule doing its job.
      status = 'failed';
      errorCode = validation.code ?? 'invalid_ai_output';
      errorMessage = validation.message ?? null;
      logger.warn({ eventId, feature, code: errorCode }, 'AI result rejected by validation');
    }
  }

  return withScope(scope, async (tx) => {
    const row = await completeExecution(tx, {
      eventId: event.eventId,
      feature,
      status,
      provider: req.result.provider ?? null,
      model: req.result.model ?? null,
      modelVersion: req.result.model_version ?? null,
      promptVersion: req.result.prompt_version ?? null,
      confidence: req.result.confidence ?? null,
      latencyMs: req.result.latency_ms ?? null,
      result: validatedResult,
      fallbackUsed: req.result.fallback_used ?? false,
      errorCode,
      errorMessage,
    });

    // Zero rows updated: the execution was already terminal. This is a
    // duplicate delivery. Write nothing — no audit row, no ticket change —
    // and say so, so the caller can assert on it.
    if (!row) {
      const existing = await tx.query<{ id: string; status: 'succeeded' | 'failed' }>(
        `SELECT id, status FROM ai_execution WHERE event_id = $1 AND feature = $2`,
        [event.eventId, feature],
      );
      const prior = existing.rows[0];
      if (!prior) throw notFound('No such AI execution.');
      logger.info(
        { eventId, feature, executionId: prior.id },
        'duplicate AI result suppressed — execution already terminal',
      );
      return {
        execution_id: prior.id,
        status: prior.status,
        applied: false,
        ticket_updated: false,
      };
    }

    /**
     * PHASE 1: the ticket is not touched.
     *
     * `noop` exists to prove the pipeline, and proving it must not perturb
     * business state — that is what makes "an AI failure leaves the ticket
     * unchanged" a testable assertion rather than a hope. Phase 7 adds the
     * ticket write here, after the deterministic IRIS rules run, and only for
     * features permitted to apply.
     */
    const ticketUpdated = false;

    // entity_type 'ticket' with the ticket's own id so the execution appears
    // in GET /v1/tickets/:id/history with no change to that endpoint — it
    // already selects WHERE entity_id = $1. Model metadata only: no ticket
    // text, no PII.
    await writeAudit(tx, scope, {
      action: status === 'succeeded' ? 'ai.execution_succeeded' : 'ai.execution_failed',
      entityType: 'ticket',
      entityId: event.ticketId,
      productId: event.productId,
      after: {
        execution_id: row.id,
        feature,
        status,
        attempt: row.attempt,
        provider: row.provider,
        model: row.model,
        model_version: row.model_version,
        confidence: row.confidence,
        latency_ms: row.latency_ms,
        fallback_used: row.fallback_used,
        error_code: row.error_code,
        ticket_updated: ticketUpdated,
      },
    });

    return {
      execution_id: row.id,
      status,
      applied: true,
      ticket_updated: ticketUpdated,
    };
  });
}
