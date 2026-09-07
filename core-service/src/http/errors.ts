import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { AppError, toEnvelope } from '@iris/shared/types';
import { logger } from '../logger.js';

/**
 * Passing a concrete pino instance as `loggerInstance` narrows Fastify's logger
 * generic away from FastifyBaseLogger, so the app type no longer matches a
 * plain FastifyInstance. Widening here is the least-bad option — the
 * alternative is threading five generics through every route module for no
 * behavioural gain.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyFastify = FastifyInstance<any, any, any, any, any>;

/**
 * One error handler at the edge. Handlers throw typed errors; nothing builds
 * an error response by hand. Internals (stack, SQL, paths) never reach a
 * response body — they go to the log, correlated by request_id.
 */
export function registerErrorHandler(app: AnyFastify): void {
  app.setErrorHandler((err, req, reply) => {
    const requestId = req.id as string;

    if (err instanceof AppError) {
      if (err.status >= 500) logger.error({ err, requestId }, err.message);
      else logger.debug({ code: err.code, requestId }, err.message);
      return reply.status(err.status).send(toEnvelope(err, requestId));
    }

    if (err instanceof ZodError) {
      const wrapped = new AppError('invalid_request', 'Request failed validation.', {
        fields: err.flatten().fieldErrors,
      });
      return reply.status(400).send(toEnvelope(wrapped, requestId));
    }

    if ((err as { statusCode?: number }).statusCode === 413) {
      const wrapped = new AppError('attachment_too_large', 'Attachment exceeds the size limit.');
      return reply.status(413).send(toEnvelope(wrapped, requestId));
    }

    logger.error({ err, requestId, url: req.url }, 'unhandled error');
    const wrapped = new AppError('internal_error', 'An unexpected error occurred.');
    return reply.status(500).send(toEnvelope(wrapped, requestId));
  });

  app.setNotFoundHandler((req, reply) => {
    const wrapped = new AppError('not_found', 'No such endpoint.');
    return reply.status(404).send(toEnvelope(wrapped, req.id as string));
  });
}
