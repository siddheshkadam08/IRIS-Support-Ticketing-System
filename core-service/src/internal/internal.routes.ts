import type { FastifyInstance } from 'fastify';
import { AppError } from '@iris/shared/types';
import { aiInternalRoutes } from './ai.routes.js';
import { embeddingInternalRoutes } from './embedding.routes.js';
import { registerServiceAuth } from './service-auth.js';

/**
 * One registration point for the /internal namespace.
 *
 * server.ts gains a single register() call rather than one per future internal
 * module, and there is exactly one place to look to answer "what can the
 * worker reach?".
 *
 * SECURITY: this plugin is the SOLE gate for the /internal prefix. The global
 * x-internal-key hook in server.ts deliberately skips /internal/ (that key is
 * the gateway's, and the worker must not hold it), so every route registered
 * here MUST be inside this scope. A route added under /internal outside this
 * plugin would be unauthenticated — phase2.security.test.ts asserts an
 * unsigned request is rejected, which is what keeps that honest.
 */
export async function internalRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Scoped raw-body parser.
   *
   * HMAC signs sha256(raw request bytes), so verification must see the exact
   * bytes that arrived. Fastify's default parser hands back a parsed object and
   * discards the buffer; re-serialising it changes whitespace and key order and
   * every signature fails.
   *
   * Content-type parsers are ENCAPSULATED per plugin scope — verified
   * empirically before this was written, and asserted by
   * service-auth.test.ts. So this captures the buffer for /internal/* while
   * POST /v1/tickets and every other route keep the normal parsed-object
   * behaviour, untouched.
   */
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req, body, done) => {
      const buf = body as Buffer;
      req.rawBody = buf;
      const text = buf.toString('utf8').trim();
      if (!text) return done(null, {});
      try {
        done(null, JSON.parse(text));
      } catch {
        // Reached only by a caller who already passed signature verification,
        // so this is a malformed payload from a trusted service: 400, not 401.
        done(new AppError('invalid_request', 'Body is not valid JSON.'), undefined);
      }
    },
  );

  registerServiceAuth(app);

  await app.register(aiInternalRoutes);
  // Phase 10. Inside this scope, so it inherits the raw-body parser and
  // registerServiceAuth — see the SECURITY note above.
  await app.register(embeddingInternalRoutes);
}
