import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { EMBEDDING_DIM, EMBEDDING_SUBJECT_TYPES } from '@iris/shared/types';
import { applyEmbeddings, getPendingEmbeddings } from '../embeddings/embedding.service.js';

/**
 * The embedding path's two internal endpoints — Phase 10.
 *
 * Registered inside the same `internalRoutes` plugin as the AI job routes, so
 * they inherit the raw-body parser and `registerServiceAuth` unchanged. That
 * inheritance is the point: this adds no authentication mechanism, no new
 * credential and no new trusted caller. The worker already holds
 * AI_WORKER_HMAC_SECRET, which is valid on /internal/* and nowhere else.
 *
 * ⚠️ A ROUTE ADDED UNDER /internal OUTSIDE THIS PLUGIN WOULD BE
 * UNAUTHENTICATED — the global x-internal-key hook in server.ts deliberately
 * skips the /internal prefix. See internal.routes.ts.
 *
 * Handlers parse and delegate; every decision lives in embedding.service.ts.
 */

const SubjectType = z.enum(EMBEDDING_SUBJECT_TYPES as unknown as [string, ...string[]]);

const PendingBody = z.object({
  /** Bounded again in the service; a caller cannot ask for the whole corpus. */
  limit: z.number().int().min(1).max(32).default(16),
});

/**
 * The vector is validated STRUCTURALLY here and SEMANTICALLY in the service.
 *
 * Zod checks it is an array of the right length made of JSON numbers — enough
 * to reject a payload that would otherwise be walked element by element in the
 * service. It deliberately does NOT check finiteness: `JSON.parse` produces
 * `null` for a literal `NaN`, and a client sending a huge value produces
 * `Infinity`, neither of which is a zod concern. `validateEmbeddingVector` in
 * the service is the authority, and it is the one the tests target.
 *
 * The length cap also bounds the request: 32 items x 1536 floats is the most
 * this endpoint will parse.
 */
const ApplyBody = z.object({
  items: z
    .array(
      z.object({
        subject_type: SubjectType,
        subject_id: z.string().min(1).max(80),
        fingerprint: z.string().length(64),
        vector: z.array(z.number()).length(EMBEDDING_DIM),
        model: z.string().min(1).max(120),
      }),
    )
    .min(0)
    .max(32),
  /** Permanent provider failures from the same cycle. See migration 015. */
  failures: z
    .array(
      z.object({
        subject_type: SubjectType,
        subject_id: z.string().min(1).max(80),
        fingerprint: z.string().length(64),
        code: z.string().min(1).max(80),
      }),
    )
    .max(32)
    .default([]),
});

export async function embeddingInternalRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /internal/embeddings/pending
   *
   * POST rather than GET because the request is signed: the HMAC canonical
   * string covers the body, and a GET with no body would sign nothing but the
   * path — so two different requests would share a signature. Every other
   * signed route in this repo is a POST for the same reason.
   */
  app.post('/internal/embeddings/pending', async (req) => {
    const { limit } = PendingBody.parse(req.body ?? {});
    return getPendingEmbeddings(limit);
  });

  /**
   * POST /internal/embeddings/apply
   *
   * The worker asserts nothing that is taken on trust: the fingerprint is
   * re-checked against the row, the model against configuration, the vector
   * against its own contents, and the owning product is re-derived from the
   * subject id rather than accepted from the caller. The worker cannot name a
   * tenant here — there is no field for one.
   */
  app.post('/internal/embeddings/apply', async (req) => {
    const { items, failures } = ApplyBody.parse(req.body);
    return applyEmbeddings(
      items as Parameters<typeof applyEmbeddings>[0],
      failures as Parameters<typeof applyEmbeddings>[1],
    );
  });
}
