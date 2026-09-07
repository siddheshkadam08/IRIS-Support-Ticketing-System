import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AI_FEATURES } from '@iris/shared/types';
import { getAIInput, submitAIResult } from './ai.service.js';

/**
 * The AI worker's only door into Core.
 *
 * Two things about this namespace are worth stating explicitly, because both
 * are inherited rather than built here:
 *
 *   1. AUTHENTICATION is already applied. server.ts has an onRequest hook that
 *      rejects every non-/health request without a matching x-internal-key.
 *      No new auth mechanism was introduced for the AI pipeline.
 *
 *   2. REACHABILITY. The gateway proxies /v1/* and /admin/api/* only, and
 *      core-service binds to 127.0.0.1. /internal/* is therefore unreachable
 *      from the internet by construction, not by a rule someone must remember.
 *
 * These handlers parse and delegate. All logic lives in ai.service.ts —
 * core-service/SKILLS.md section 2: routes -> service -> repo, never
 * routes -> repo.
 */

const Feature = z.enum(AI_FEATURES);

/**
 * The worker's claims about the job it holds. `claimed_` is not cosmetic:
 * ai.service.ts verifies these against Core's own outbox row and never uses
 * them to look anything up.
 */
const Claims = z.object({
  job_id: z.string().min(1).max(80),
  feature: Feature,
  attempt: z.number().int().min(1).max(100),
  correlation_id: z.string().min(1).max(200),
  claimed_product_id: z.string().min(1).max(80),
  claimed_ticket_id: z.string().min(1).max(80),
});

const ErrorBody = z.object({
  kind: z.enum(['temporary', 'permanent']),
  code: z.string().min(1).max(80),
  message: z.string().max(2000),
});

const ResultBody = Claims.extend({
  result: z.object({
    feature: Feature,
    status: z.enum(['succeeded', 'failed']),
    // Deliberately unstructured here. Shape is the feature validator's job in
    // ai.service.ts; a zod schema at the edge would imply it had been checked.
    data: z.record(z.unknown()),
    confidence: z.number().min(0).max(1).nullish(),
    provider: z.string().max(80).nullish(),
    model: z.string().max(120).nullish(),
    model_version: z.string().max(80).nullish(),
    prompt_version: z.string().max(80).nullish(),
    latency_ms: z.number().int().min(0).nullish(),
    fallback_used: z.boolean().optional(),
    error: ErrorBody.nullish(),
  }),
});

const EventParam = z.object({ eventId: z.string().min(1).max(80) });

export async function aiInternalRoutes(app: FastifyInstance): Promise<void> {
  // ── POST /internal/ai/jobs/:eventId/input ──────────────────────────────
  // eventId is the ONLY caller-supplied value used as a lookup key, and only
  // Core can create one — inside the ticket transaction.
  app.post<{ Params: { eventId: string } }>(
    '/internal/ai/jobs/:eventId/input',
    async (req) => {
      const { eventId } = EventParam.parse(req.params);
      const body = Claims.parse(req.body);
      return getAIInput(eventId, body);
    },
  );

  // ── POST /internal/ai/jobs/:eventId/result ─────────────────────────────
  app.post<{ Params: { eventId: string } }>(
    '/internal/ai/jobs/:eventId/result',
    async (req) => {
      const { eventId } = EventParam.parse(req.params);
      const body = ResultBody.parse(req.body);
      return submitAIResult(eventId, body);
    },
  );
}
