import pino from 'pino';
import { config, isDev } from './config.js';

/**
 * Structured JSON logs. Never console.log.
 *
 * `redact` is not decoration — ticket bodies and raiser identity are customer
 * PII, and secrets/tokens must never reach a log line. Add to this list rather
 * than trusting call sites to remember.
 */
export const logger = pino({
  level: config.LOG_LEVEL,
  base: { service: 'core-service' },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers["x-iris-signature"]',
      'req.headers["x-iris-identity"]',
      'req.headers["x-internal-key"]',
      'req.headers["x-iris-service-id"]',
      '*.AI_WORKER_HMAC_SECRET',
      '*.AI_SERVICE_HMAC_SECRET',
      'AI_WORKER_HMAC_SECRET',
      'AI_SERVICE_HMAC_SECRET',
      '*.client_secret',
      '*.password',
      '*.token',
      '*.preauth_grant',
      '*.raiser_identity',
    ],
    censor: '[redacted]',
  },
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,service' },
        },
      }
    : {}),
});
