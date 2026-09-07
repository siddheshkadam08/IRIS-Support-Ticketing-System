import pino from 'pino';
import { config, isDev } from './config.js';

export const logger = pino({
  level: config.LOG_LEVEL,
  base: { service: 'gateway' },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers["x-iris-signature"]',
      'req.headers["x-iris-identity"]',
      'req.headers.cookie',
      '*.client_secret',
      '*.token',
      '*.password',
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
