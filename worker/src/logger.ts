import pino from 'pino';
import { config } from './config.js';

/**
 * Structured logs with a correlation id on every line — /SKILLS.md section 3.2.
 *
 * The redaction list is not optional decoration. Ticket descriptions are
 * customer PII and internal keys are capability tokens; neither may appear in
 * a log line, and the safest place to enforce that is the logger itself rather
 * than every call site.
 */
export const logger = pino({
  level: config.LOG_LEVEL,
  base: { service: 'worker' },
  redact: {
    paths: [
      'input.description',
      'input.subject',
      'ticket.description',
      'ticket.subject',
      'headers["x-internal-key"]',
      'headers["x-iris-signature"]',
      'config.AI_WORKER_HMAC_SECRET',
      'config.AI_SERVICE_HMAC_SECRET',
      'AI_WORKER_HMAC_SECRET',
      'AI_SERVICE_HMAC_SECRET',
    ],
    censor: '[redacted]',
  },
  transport:
    config.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
      : undefined,
});
