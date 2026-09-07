import { z } from 'zod';
import { loadRootEnv } from '@iris/shared/types';

loadRootEnv();

/**
 * Validated at boot. A service that starts with a missing config value and
 * fails on the first job is worse than one that refuses to start.
 *
 * Note what is ABSENT and must stay absent:
 *
 *   - any database URL. The worker reaches data only through
 *     core-service/internal/*. A connection string here would be a second,
 *     unpoliced path around RLS — /SKILLS.md invariant 1.
 *   - INTERNAL_API_KEY and AI_SERVICE_KEY. Both were bearer tokens; the first
 *     was platform-wide. Replaced in Phase 2 by two narrow HMAC secrets.
 */
const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.string().default('info'),

  REDIS_URL: z.string().min(1),
  AI_QUEUE_NAME: z.string().default('ai.jobs'),
  /** Jobs processed at once. Deliberately low: one queue, modest concurrency. */
  AI_WORKER_CONCURRENCY: z.coerce.number().default(4),

  CORE_SERVICE_URL: z.string().url().default('http://localhost:4100'),
  /**
   * Signs requests to Core /internal/ai/*. Valid on NO other route.
   *
   * INTERNAL_API_KEY is deliberately ABSENT from this config. It is the
   * gateway's credential, which core-service accepts on every route — and
   * because resolveCaller/resolveAdminCaller trust x-iris-product-id,
   * x-iris-role and x-iris-support-user-id as plain headers, holding it let a
   * compromised worker read any tenant's tickets and reach the admin API as
   * super_admin. Do not add it back.
   */
  AI_WORKER_HMAC_SECRET: z.string().min(16).default('dev_ai_worker_hmac_secret_change_me'),
  /** Core is a local, fast hop. A hung call must not hold a worker slot. */
  CORE_TIMEOUT_MS: z.coerce.number().default(5000),

  AI_SERVICE_URL: z.string().url().default('http://localhost:5000'),
  /**
   * Signs requests to the Python AI service. Separate from the Core secret on
   * purpose: leaking the Python-facing credential must not grant access to
   * Core.
   */
  AI_SERVICE_HMAC_SECRET: z.string().min(16).default('dev_ai_service_hmac_secret_change_me'),
  /** Inference is slower than Core, but still bounded. */
  AI_TIMEOUT_MS: z.coerce.number().default(10_000),

  /**
   * Phase 3 Step 6 — how long SIGTERM waits for in-flight jobs before exiting.
   *
   * A HARD DEADLINE, not a target. `worker.close()` waits for current jobs
   * indefinitely (`[CODE]` bullmq worker.js:803 — `whenCurrentJobsFinished`
   * with no bound), so an unattended shutdown can hang until the orchestrator
   * SIGKILLs it, which is strictly worse than exiting deliberately.
   *
   * 8s is chosen against the container's termination grace period, not against
   * the job: podman-compose defaults to 10s and `iris-worker` sets no
   * `stop_grace_period`, so 8s leaves 2s to close Redis and exit cleanly.
   *
   * A worst-case attempt is ~20s (5 + 10 + 5), so a job caught mid-flight will
   * NOT finish inside the window. That is deliberate and safe: the job keeps
   * its lock, the lock expires after LOCK_DURATION_MS
   * (index.ts), and BullMQ's stalled check re-runs it. Idempotency (`UNIQUE(event_id, feature)`) makes the
   * re-run free.
   */
  AI_WORKER_DRAIN_MS: z.coerce.number().int().min(1000).default(8000),
});

const parsed = Env.safeParse(process.env);
if (!parsed.success) {
  console.error('[worker] invalid environment:\n', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
