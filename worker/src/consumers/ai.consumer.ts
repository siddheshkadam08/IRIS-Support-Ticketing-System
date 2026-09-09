import { z } from 'zod';
import {
  AI_FEATURES,
  type AIExecuteRequest,
  type AIJob,
  type AIJobClaims,
  type AIResultResponse,
} from '@iris/shared/types';
import { executeAI } from '../ai-client.js';
import { fetchAIInput, submitAIResult } from '../core-client.js';
import type { FetchLike } from '../core-client.js';
import { PermanentJobError } from '../errors.js';
import { logger } from '../logger.js';

/**
 * The AI job handler. Orchestration only — this is the whole of it.
 *
 *   validate job -> ask Core for input -> call Python -> hand result to Core
 *
 * What it deliberately does NOT do: open a database connection, apply ticket
 * business rules, evaluate RLS, write audit, decide priority/severity/routing,
 * hold a taxonomy, or interpret model output. Every one of those belongs to
 * core-service. If this file starts growing logic, the logic is in the wrong
 * place.
 */

const JobSchema = z.object({
  job_id: z.string().min(1),
  event_id: z.string().min(1),
  feature: z.enum(AI_FEATURES),
  product_id: z.string().min(1),
  ticket_id: z.string().min(1),
  correlation_id: z.string().min(1),
  requested_at: z.string().min(1),
  attempt: z.number().int().min(1),
});

export interface HandleOptions {
  /** BullMQ's attempt counter, so ai_execution.attempt reflects reality. */
  attempt?: number;
  /** Injectable transports — the tests exercise real branching, not mocks. */
  coreFetch?: FetchLike;
  aiFetch?: FetchLike;
}

export type HandleOutcome =
  | { outcome: 'already_applied'; execution_id: string }
  | { outcome: 'submitted'; result: AIResultResponse };

export async function handleAIJob(
  raw: unknown,
  opts: HandleOptions = {},
): Promise<HandleOutcome> {
  // A job that does not parse can never parse. Permanent, so BullMQ does not
  // burn five attempts on a malformed envelope.
  const parsed = JobSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PermanentJobError(
      'invalid_job',
      JSON.stringify(parsed.error.flatten().fieldErrors),
    );
  }
  const job: AIJob = parsed.data;
  const attempt = opts.attempt ?? job.attempt;

  const log = logger.child({
    request_id: job.correlation_id,
    event_id: job.event_id,
    job_id: job.job_id,
    feature: job.feature,
    attempt,
  });
  log.info('AI job started');

  /**
   * The worker asserts what it believes; Core verifies it against its own
   * outbox row. Naming them `claimed_` keeps that visible at the call site —
   * these are not lookup keys and cannot widen access.
   */
  const claims: AIJobClaims = {
    job_id: job.job_id,
    feature: job.feature,
    attempt,
    correlation_id: job.correlation_id,
    claimed_product_id: job.product_id,
    claimed_ticket_id: job.ticket_id,
  };

  const input = await fetchAIInput(job.event_id, claims, opts.coreFetch);

  // Idempotency short-circuit. A redelivery of already-applied work costs zero
  // model invocations because Core answers before Python is ever contacted.
  if (input.status === 'already_applied') {
    log.info({ execution_id: input.execution_id }, 'AI job already applied — nothing to do');
    return { outcome: 'already_applied', execution_id: input.execution_id };
  }

  /**
   * THE DATA BOUNDARY.
   *
   * Built field by field rather than forwarding `input`, so nothing crosses
   * into the AI service by accident. `taxonomy` and `thresholds` go only to
   * features that classify; the stub needs neither, and sending data a feature
   * cannot use is how boundaries erode.
   */
  const executeRequest: AIExecuteRequest = {
    feature: input.feature,
    request_id: input.correlation_id,
    input: {
      subject: input.ticket.subject,
      description: input.ticket.description,
      /**
       * Phase 19. `screenshot` gets the image and NEITHER taxonomy NOR
       * thresholds.
       *
       * It classifies nothing, so a vocabulary would be data it cannot use —
       * and sending data a feature cannot use is exactly how a boundary erodes.
       * The subject and description stay: a screenshot read without knowing what
       * the customer said about it is a caption exercise, and the ticket text
       * already crosses for every other feature.
       *
       * ⚠️ THE WORKER DOES NOT RESOLVE THE IMAGE. It forwards what Core
       * returned, having never seen an attachment id — `AIJob` has no field for
       * one. The worker is a courier here exactly as it is on the embedding
       * path.
       */
      ...(input.feature === 'screenshot'
        ? input.image
          ? { image: input.image }
          : {}
        : input.feature === 'noop'
          ? {}
          : { taxonomy: input.taxonomy, thresholds: input.thresholds }),
    },
  };

  /**
   * Core promised an image for a screenshot job and did not deliver one. That
   * is a Core-side contract break rather than a provider problem, and calling
   * the model with no image would produce a confident interpretation of
   * nothing. Permanent: the same request returns the same missing field.
   */
  if (input.feature === 'screenshot' && !executeRequest.input.image) {
    throw new PermanentJobError(
      'invalid_input',
      'screenshot job received no image from Core',
    );
  }

  const result = await executeAI(executeRequest, opts.aiFetch);

  // Core validates the content, applies business rules and decides whether
  // anything happens to the ticket. The worker only carries the envelope.
  const applied = await submitAIResult(
    job.event_id,
    { ...claims, result },
    opts.coreFetch,
  );

  log.info(
    {
      execution_id: applied.execution_id,
      status: applied.status,
      applied: applied.applied,
      ticket_updated: applied.ticket_updated,
    },
    'AI job finished',
  );
  return { outcome: 'submitted', result: applied };
}
