import {
  AppError,
  DEFAULT_AI_THRESHOLDS,
  DEFAULT_CORE_CATEGORIES,
  DEFAULT_IMPACTS,
  DEFAULT_ISSUE_TYPES,
  SEVERITIES,
  isSupportedFeature,
  notFound,
  type AIFeature,
  type AIImageInput,
  type AIInputRequest,
  type AIInputResponse,
  type AIResultRequest,
  type AIResultResponse,
  type AITaxonomy,
  type AIThresholds,
  type ClassificationDecision,
} from '@iris/shared/types';
import { withScope, withSystemScope, type ScopeContext } from '../db/with-scope.js';
import { writeAudit } from '../audit/index.js';
import { logger } from '../logger.js';
import type { ProductConfig } from '../products/product.repo.js';
import { claimExecution, completeExecution } from './ai.repo.js';
import { validateClassification } from './classification.validator.js';
import { validateSummary } from './summary.validator.js';
import { validateScreenshot } from './screenshot.validator.js';
import { attachmentIdFromPayload, resolveScreenshotImage } from './screenshot.input.js';
import { classificationSourceFor } from './classification.rules.js';
import { applyClassification, applySummary } from '../tickets/ticket.repo.js';

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
  /** The outbox payload Core wrote. Authoritative, like every field above. */
  payload: Record<string, unknown>;
}

interface OutboxIdentityRow {
  product_id: string | null;
  aggregate: string;
  aggregate_id: string | null;
  event_type: string;
  request_id: string | null;
  payload: Record<string, unknown> | null;
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
              e.payload, p.config
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
    /**
     * Phase 19. CORE'S OWN COPY of what the event said, read back from the row
     * Core wrote inside the linking transaction.
     *
     * The screenshot path needs an attachment id, and this is where it comes
     * from — never from the worker, never from the queue payload, never from
     * anything a caller could influence. `AIJob` has no attachment field at
     * all, so there is nothing to spoof: the only caller-supplied value in the
     * whole flow is the event id in the URL, exactly as it was before.
     */
    payload: row.payload ?? {},
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
    // Phase 4. Platform defaults when the product configures none, so an
    // unconfigured product still classifies rather than failing every job —
    // deliberately generic, because classification quality follows taxonomy
    // quality and a product that cares should supply its own.
    issue_types: config.issue_types ?? [...DEFAULT_ISSUE_TYPES],
    impacts: config.impacts ?? [...DEFAULT_IMPACTS],
  };
}

/**
 * The categories whose breakage blocks a core workflow.
 *
 * CORE-ONLY. It feeds the deterministic priority engine and is deliberately
 * NOT part of the taxonomy sent to Python — the inference service cannot use
 * it, so sending it would widen the data boundary for nothing.
 */
function coreCategoriesFor(config: ProductConfig): readonly string[] {
  return config.core_categories ?? DEFAULT_CORE_CATEGORIES;
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
  /**
   * Phase 4: what Core DECIDED from the validated signals. Present only for
   * features that change ticket state; `noop` never sets it.
   */
  decision?: ClassificationDecision;
}

/**
 * What a validator is allowed to consult besides the payload.
 *
 * Passed rather than looked up so validators stay pure and testable — and so
 * the taxonomy a classification is checked against is provably the same one
 * Core resolved for this product, not a second read that could disagree.
 */
export interface ValidationContext {
  taxonomy: AITaxonomy;
  thresholds: AIThresholds;
  coreCategories: readonly string[];
}

/**
 * One validator per feature.
 *
 * Phase 4 filled in `classification`, and the prediction the Phase 1 comment
 * here made held: taxonomy membership, threshold bands and the deterministic
 * rules slotted in, and the surrounding plumbing did not change. The only
 * signature change was adding the context a classifier needs to check output
 * against the product's own vocabulary.
 */
const FEATURE_VALIDATORS: Record<
  AIFeature,
  (data: Record<string, unknown>, ctx: ValidationContext) => FeatureValidation
> = {
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
    /**
     * Re-checks every enum against CORE's taxonomy — Python having accepted
     * the payload is not a security property — then runs the deterministic
     * engine Python is never allowed to run.
     */
    classification: (data, ctx) => {
      const result = validateClassification(data, ctx);
      if (!result.ok) return { ok: false, code: result.code, message: result.message };
      return { ok: true, value: { ...result.value }, decision: result.decision };
    },
    /**
     * Phase 5. Informational enrichment: it returns a bounded string and
     * nothing else, so there is no path from here to any business decision.
     * Core still validates independently — Python accepting a payload has
     * never been a security property.
     */
    summary: (data) => {
      const result = validateSummary(data);
      if (!result.ok) return { ok: false, code: result.code, message: result.message };
      return { ok: true, value: { ...result.value } };
    },
    // Declared so the map stays exhaustive over AIFeature. Unreachable today:
    // verifyClaims rejects anything outside SUPPORTED_AI_FEATURES first.
    sentiment: notImplemented('sentiment'),
    keywords: notImplemented('keywords'),
    /**
     * ⚠️ Phase 13 BUILT it, and it still must never arrive here.
     *
     * RAG is a synchronous step inside a search request: its own client, its
     * own validation, no execution row, no persistence. Reaching this branch
     * means a queue job claimed `feature: "rag"` — a bug, or an attempt to
     * route a generated answer through the ticket-decision pipeline.
     *
     * `verifyClaims` already rejects it, because `rag` is deliberately absent
     * from SUPPORTED_AI_FEATURES. This is the second lock on the same door.
     */
    rag: () => ({
      ok: false,
      code: 'unsupported_feature',
      message: 'rag does not travel on the AI job queue',
    }),
    /**
     * ⚠️ NOT "not yet built" — embedding IS built, and must never arrive here.
     *
     * It runs on its own path (/internal/embeddings/*) with its own validator,
     * its own idempotency key and its own persistence. Reaching this branch
     * means a queue job claimed `feature: "embedding"`, which is either a bug
     * or an attempt to route a vector through the ticket-decision pipeline.
     *
     * `verifyClaims` rejects it before this point because `embedding` is
     * deliberately absent from SUPPORTED_AI_FEATURES. This entry is the second
     * lock on the same door, and it exists because the map is exhaustive over
     * AIFeature: without it, the compiler would have accepted nothing at all
     * here, and the eventual default would have been silence.
     */
    embedding: () => ({
      ok: false,
      code: 'unsupported_feature',
      message: 'embedding does not travel on the AI job queue',
    }),
    /**
     * ⚠️ Like `embedding`: built, but must never arrive here.
     *
     * Reranking is a synchronous step inside a search request, with its own
     * client, its own validation and no persistence at all. Reaching this
     * branch means a queue job claimed `feature: "reranking"` — a bug, or an
     * attempt to route a retrieval ordering through the ticket-decision
     * pipeline.
     *
     * `verifyClaims` already rejects it, because `reranking` is deliberately
     * absent from SUPPORTED_AI_FEATURES. This is the second lock on the same
     * door, and it exists because the map is exhaustive over AIFeature.
     */
    reranking: () => ({
      ok: false,
      code: 'unsupported_feature',
      message: 'reranking does not travel on the AI job queue',
    }),
    /**
     * ⚠️ Copilot must never arrive here, and this branch matters more than the
     * others.
     *
     * The queue path APPLIES results to tickets. A draft reply is text for a
     * human to review — if it ever reached a result handler it would be one
     * step from being written somewhere. It runs inside an authenticated admin
     * request, returns to a browser, and persists nothing.
     *
     * `verifyClaims` already rejects it, because `copilot` is deliberately
     * absent from SUPPORTED_AI_FEATURES. This is the second lock.
     */
    copilot: () => ({
      ok: false,
      code: 'unsupported_feature',
      message: 'copilot does not travel on the AI job queue',
    }),
    /**
     * Phase 19. The FIRST feature added to this map since Phase 5 that is a
     * real queue participant rather than a second lock on a closed door.
     *
     * ⚠️ IT RETURNS NO `decision`. Only `classification` does, and only
     * `classification` may: a `decision` is what the persistence step below
     * reads to change a ticket's category, severity or routing. Screenshot
     * output is evidence, so it produces a validated value and nothing that
     * the ticket-update step will act on. The absence of that field is the
     * decision boundary, expressed where it is enforced.
     */
    screenshot: (data) => {
      const result = validateScreenshot(data);
      if (!result.ok) return { ok: false, code: result.code, message: result.message };
      return { ok: true, value: { ...result.value } };
    },
  };

/**
 * The one comparable scalar a feature defines, if it defines one.
 *
 * `classification` is handled by its composite above. `summary` and `noop`
 * return null because neither produces a comparable number and inventing one
 * would be fabrication. `screenshot` returns the model's own self-reported
 * confidence, already range-checked by its validator.
 */
function featureConfidence(
  feature: AIFeature,
  validated: Record<string, unknown> | null,
): number | null {
  if (feature !== 'screenshot' || !validated) return null;
  const c = validated.confidence;
  return typeof c === 'number' && Number.isFinite(c) ? c : null;
}

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

    /**
     * ── Phase 19: the screenshot image ────────────────────────────────
     *
     * Resolved from CORE'S OWN outbox payload, authorized against the ticket
     * and product Core resolved from the same row, and bounded before a single
     * byte is handed to the worker. The worker never names an attachment.
     */
    let image: AIImageInput | undefined;
    if (feature === 'screenshot') {
      const outcome = await resolveScreenshotImage({
        ticketId: event.ticketId,
        productId: event.productId,
        payload: event.payload,
        requestId: event.correlationId,
      });

      if (!outcome.ok) {
        /**
         * ⚠️ TERMINATED HERE, NOT THROWN.
         *
         * Every screenshot input failure is permanent — a wrong tenant, an
         * ineligible type, an oversized image and bytes that are not the image
         * they claim to be all return the same answer on every retry. Throwing
         * a 4xx would be classified by the worker as permanent too, but it
         * would leave the execution row `running` until the reaper swept it,
         * reporting a real, explainable outcome as abandoned work.
         *
         * So the execution is completed as `failed` with its own code, in this
         * transaction, and the worker is told the same thing it is told about a
         * duplicate: this is terminal, do not call the AI service. That reuses
         * the existing short-circuit rather than widening the response contract
         * for a case that means exactly what the existing arm means — there is
         * nothing left to do and no model call to make.
         */
        await completeExecution(tx, {
          eventId: event.eventId,
          feature,
          status: 'failed',
          provider: null,
          model: null,
          modelVersion: null,
          promptVersion: null,
          confidence: null,
          latencyMs: null,
          result: null,
          fallbackUsed: false,
          errorCode: outcome.code,
          errorMessage: outcome.message,
        });

        logger.info(
          { eventId, feature, executionId: execution.id, code: outcome.code },
          'screenshot input rejected — terminal, AI service will not be called',
        );

        return {
          status: 'already_applied',
          feature,
          correlation_id: event.correlationId,
          execution_id: execution.id,
          execution_status: 'failed',
        };
      }

      image = outcome.image;
    }

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
      ...(image ? { image } : {}),
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
  // Hoisted so the persistence step below can read the DECISION the validator
  // made. Only classification sets it; `noop` leaves it null and writes nothing.
  let validation: FeatureValidation | null = null;
  let errorCode: string | null = null;
  let errorMessage: string | null = null;

  if (req.result.status === 'failed') {
    // Python already declared failure. Record it as-is; the retry decision was
    // the worker's and has already been made by the time we see this.
    status = 'failed';
    errorCode = req.result.error?.code ?? 'ai_failed';
    errorMessage = req.result.error?.message ?? null;
  } else {
    const thresholds = thresholdsFor(event.productConfig);
    validation = FEATURE_VALIDATORS[feature](req.result.data, {
      taxonomy: taxonomyFor(event.productConfig),
      thresholds,
      coreCategories: coreCategoriesFor(event.productConfig),
    });
    if (validation.ok) {
      status = 'succeeded';
      /**
       * `ai_execution.result` is the IMMUTABLE record of this execution, so it
       * carries the DECISION alongside the signals — priority, severity,
       * routing band, the score breakdown, and the thresholds that were in
       * force at the time.
       *
       * Thresholds especially: they are per-product configuration and can be
       * edited later, so a stored decision without them cannot be re-derived
       * or defended afterwards. "Why did this auto-route in March?" must be
       * answerable from the row, not from today's config.
       */
      /**
       * Phase 19. The attachment id is stamped onto the validated screenshot
       * result HERE, re-derived from the event payload Core wrote.
       *
       * ⚠️ RE-DERIVED, NOT REMEMBERED. Carrying it from the input step in
       * process memory would not survive a restart between the two calls, and
       * the two calls are separated by a provider round trip. Reading it back
       * from the same authoritative row makes the value identical and the code
       * stateless.
       *
       * ⚠️ AND NOT TAKEN FROM THE MODEL. `screenshot_attachment_id` is not an
       * accepted key in the screenshot schema, so a model returning one is
       * rejected as an unexpected field. This value can only come from Core.
       */
      if (feature === 'screenshot' && validation.ok && validation.value) {
        const attachmentId = attachmentIdFromPayload(event.payload);
        if (attachmentId) {
          validation = {
            ...validation,
            value: { ...validation.value, screenshot_attachment_id: attachmentId },
          };
        }
      }

      validatedResult = validation.decision
        ? {
            ...(validation.value ?? {}),
            decision: validation.decision,
            thresholds_applied: thresholds,
          }
        : (validation.value ?? {});
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
      /**
       * ⚠️ CORE'S COMPOSITE, NOT THE MODEL'S — and not `req.result.confidence`,
       * which is always null by design.
       *
       * `features.py` deliberately returns `confidence=None` for every feature:
       * "the weakest-link composite is computed by CORE, from these same
       * numbers. Reporting one here too would be a second source of truth for a
       * value Core must own." Taking that null and storing it left the column
       * empty in all 12,787 historical rows while the real value sat one level
       * down in `result.decision`.
       *
       * So the column now carries the FEATURE-LEVEL SCALAR where the feature
       * defines one:
       *
       *   classification -> compositeConfidence(), the MINIMUM of the four
       *                     field confidences the model reported
       *   summary, noop  -> NULL. Neither produces a comparable scalar, and
       *                     inventing one would be fabrication.
       *
       * ⚠️ IT IS NOT A PROBABILITY OF CORRECTNESS. It is the model's own
       * self-reported signal, uncalibrated — which is precisely why
       * `auto_route_p1 = 1.01` disables unattended routing. Per-field values
       * remain in `result` for anyone who needs them; this is the one number
       * that is comparable across executions of the same feature.
       */
      /**
       * Phase 19 extends the same rule rather than bending it: `screenshot`
       * DOES define a feature-level scalar — one `confidence` field — so the
       * column carries it and screenshot executions stay comparable to each
       * other in the operational view.
       *
       * Taken from the VALIDATED value, never from `req.result.confidence`, so
       * the stored number is one Core range-checked itself. It is the model's
       * self-report and nothing here or downstream may present it as accuracy.
       */
      confidence: validation?.decision?.composite_confidence ?? featureConfidence(feature, validatedResult),
      latencyMs: req.result.latency_ms ?? null,
      result: validatedResult,
      fallbackUsed: req.result.fallback_used ?? false,
      errorCode,
      /**
       * ⚠️ SANITISED BEFORE IT BECOMES GOVERNANCE TELEMETRY — finding G-13.
       *
       * This field is about to be read by people rather than only by whoever
       * is debugging right now, and its content is not ours: `ai-client.ts`
       * puts up to 500 characters of the AI service's response body here, and
       * that body can carry a provider message that quotes the prompt. Azure's
       * content-filter rejection, for instance, echoes part of what it
       * refused. Observed max today is 78 characters, but the schema allows
       * 2,000 and the ceiling is what matters for a durable store.
       */
      errorMessage: sanitiseErrorMessage(errorMessage),
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
     * PHASE 4: the ticket is written, conditionally.
     *
     * `noop` still touches nothing — that is what keeps "an AI failure leaves
     * the ticket unchanged" a testable assertion. Classification writes, but
     * only into a ticket nobody has classified yet.
     *
     * THE GUARD IS THE `WHERE` CLAUSE, not a prior read. A check-then-write
     * would race a product classifying the same ticket; the conditional UPDATE
     * makes Postgres the arbitrator, exactly as everywhere else in this
     * pipeline. Zero rows matched is a normal outcome, not an error: the
     * execution still succeeded, it simply had nothing to apply.
     */
    let ticketUpdated = false;

    /**
     * PHASE 5: the summary is written to its own derived column.
     *
     * `ticket.summary` has never had a human author — nothing in the platform
     * wrote it before this — so there is no override rule to apply and nothing
     * of anyone else's to overwrite. It is unconditionally the AI's field,
     * which is exactly why the summary went there rather than anywhere near
     * `description`.
     *
     * A re-run legitimately replaces it: the summary is the CURRENT derived
     * value, and every historical one remains in ai_execution.result.
     */
    if (status === 'succeeded' && feature === 'summary' && validatedResult) {
      ticketUpdated = await applySummary(tx, {
        ticketId: event.ticketId,
        summary: String(validatedResult.summary),
      });
    }

    if (status === 'succeeded' && validation?.decision && validatedResult) {
      const d = validation.decision;
      ticketUpdated = await applyClassification(tx, {
        ticketId: event.ticketId,
        category: String(validatedResult.category),
        severity: d.severity,
        sentiment: typeof validatedResult.sentiment === 'string' ? validatedResult.sentiment : null,
        classificationSource: classificationSourceFor(d.routing_decision),
        aiClassification: { ...validatedResult, decision: d, execution_id: row.id },
      });
    }

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
        /**
         * Phase 4: WHY the ticket got the priority it did, in the audit trail
         * rather than only in ai_execution.result. Numbers and machine values
         * only — no ticket text, no rationale prose, no model output.
         */
        ...(validation?.decision
          ? {
              priority: validation.decision.priority,
              severity: validation.decision.severity,
              routing_decision: validation.decision.routing_decision,
              composite_confidence: validation.decision.composite_confidence,
              score_breakdown: validation.decision.score_breakdown,
            }
          : {}),
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

/**
 * Bound and clean a failure message before it is stored — finding G-13.
 *
 * `ai_execution.error_message` becomes a Phase 17 governance surface, and its
 * content originates outside IRIS: the worker forwards up to 500 characters of
 * the AI service's response body, which may in turn carry a provider message
 * that quotes the prompt it refused.
 *
 * ⚠️ WHAT THIS DOES NOT DO: it does not try to detect ticket content. There is
 * no reliable way to recognise a customer's own words in a provider string, and
 * a filter that pretended to would be the keyword-matching mistake Phase 15
 * already measured failing. It reduces the SURFACE — length, structure,
 * anything that looks like a credential — and the real control stays where it
 * belongs: this field is not exposed by any API, and Phase 17 must not expose
 * it either.
 *
 * ⚠️ IT DOES NOT DESTROY DIAGNOSTICS. 240 characters comfortably holds every
 * message the platform generates today (the longest observed is 78), and the
 * machine-readable reason lives in `error_code`, which is untouched.
 */
export function sanitiseErrorMessage(raw: string | null): string | null {
  if (raw === null) return null;

  const cleaned = raw
    // Control characters render as noise in a log or a table.
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    // Anything shaped like a bearer token, API key or long opaque secret. A
    // provider that echoes a credential into an error string must not turn
    // this column into the place it is durably stored.
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer [redacted]')
    /**
     * A long opaque token — but only one that MIXES letters and digits.
     *
     * ⚠️ The first version of this rule was `[A-Za-z0-9_-]{40,}` with no
     * variety requirement, and it redacted any long run of a single character.
     * A truncation test caught it turning a 240-character diagnostic into
     * "[redacted]". Real credentials have entropy; a long word does not, and
     * destroying a diagnostic to protect against a secret that was never there
     * is a bad trade.
     */
    .replace(/\b(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{40,}\b/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim();

  if (cleaned.length === 0) return null;
  return cleaned.length > ERROR_MESSAGE_MAX_CHARS
    ? `${cleaned.slice(0, ERROR_MESSAGE_MAX_CHARS - 1)}…`
    : cleaned;
}

/**
 * Long enough for every message the platform produces (longest observed: 78),
 * short enough that a provider cannot use this column as a transcript.
 */
export const ERROR_MESSAGE_MAX_CHARS = 240;
