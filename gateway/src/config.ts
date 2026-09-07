import { z } from 'zod';
import { loadRootEnv } from '@iris/shared/types';

loadRootEnv();

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.string().default('info'),
  GATEWAY_PORT: z.coerce.number().default(4000),
  CORE_SERVICE_URL: z.string().url().default('http://localhost:4100'),
  INTERNAL_API_KEY: z.string().min(8).default('dev_internal_key_change_me'),
  // Shared with core-service: it mints admin sessions, the gateway verifies them.
  SESSION_SECRET: z.string().min(16).default('dev_session_secret_change_me_please'),
  // Decrypts product signing secrets (HMAC is symmetric — a hash won't do).
  SECRET_ENCRYPTION_KEY: z.string().min(16).default('dev_secret_encryption_key_change_me'),
  ADMIN_DIST_PATH: z.string().default('./admin-panel/dist'),
  // The gateway needs to read product credentials to authenticate callers.
  // This is a narrow, read-only use — it never touches ticket data.
  CORE_DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().optional(),
  WIDGET_DIST_PATH: z.string().default('./widget/dist'),
  MAX_ATTACHMENT_BYTES: z.coerce.number().default(26_214_400),
  DEV_IDENTITY_ENDPOINT: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
});

const parsed = Env.safeParse(process.env);
if (!parsed.success) {
  console.error('[gateway] invalid environment:\n', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
export const isDev = config.NODE_ENV === 'development';

/** Dev identity minting is gated on BOTH the env flag and development mode. */
export const devIdentityEnabled = isDev && config.DEV_IDENTITY_ENDPOINT === true;
