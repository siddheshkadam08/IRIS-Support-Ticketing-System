import { z } from 'zod';
import { loadRootEnv } from '@iris/shared/types';

loadRootEnv();

/**
 * Validated at boot. A service that starts with a missing config value and
 * fails on the first request is worse than one that refuses to start.
 */
const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.string().default('info'),
  CORE_PORT: z.coerce.number().default(4100),
  CORE_DATABASE_URL: z.string().min(1),
  ADMIN_DATABASE_URL: z.string().min(1).optional(),
  INTERNAL_API_KEY: z.string().min(8).default('dev_internal_key_change_me'),
  // Signs support-user session tokens.
  SESSION_SECRET: z.string().min(16).default('dev_session_secret_change_me_please'),
  // Encrypts product client/webhook secrets at rest (AES-256-GCM).
  SECRET_ENCRYPTION_KEY: z.string().min(16).default('dev_secret_encryption_key_change_me'),
  // Where the in-process outbox drainer posts access callbacks from.
  PUBLIC_BASE_URL: z.string().default('http://localhost:4000'),
  STORAGE_DRIVER: z.enum(['local']).default('local'),
  STORAGE_LOCAL_PATH: z.string().default('./.data/attachments'),
  MAX_ATTACHMENT_BYTES: z.coerce.number().default(26_214_400),

  // ── AI foundation (Phase 1) ──────────────────────────────────────────
  // Redis is where the AI dispatcher enqueues. Optional: without it the
  // dispatcher simply never starts and ticket creation is unaffected — AI
  // must never be a dependency for basic ticketing.
  REDIS_URL: z.string().optional(),
  AI_QUEUE_NAME: z.string().default('ai.jobs'),
  /**
   * Kill switch. Off means no AI job is ever enqueued; tickets, audit and the
   * outbox behave exactly as they do today. This is the graceful-degradation
   * lever, not a debug flag.
   */
  AI_DISPATCH_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  /**
   * Watermark. The outbox already holds historical ticket.created rows that
   * predate the AI pipeline (5 of them on the dev database at the time of
   * writing). Without an explicit floor, switching the dispatcher on would
   * immediately enqueue AI work for old tickets.
   *
   * Deliberately FAILS CLOSED: if this is unset the dispatcher dispatches
   * nothing and says so, rather than guessing a start point.
   */
  AI_DISPATCH_FROM: z.string().optional(),
  AI_DISPATCH_POLL_MS: z.coerce.number().default(1000),
  AI_DISPATCH_BATCH: z.coerce.number().default(20),

  /**
   * Phase 3 Step 5 — abandoned-execution reaper.
   *
   * Disabled by default, deliberately: it MUTATES business state, and the
   * platform convention for anything that does is explicit enablement (see
   * AI_DISPATCH_ENABLED). It is also the kill switch if it ever misbehaves.
   */
  AI_REAPER_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  /**
   * How long a `running` execution may sit before it is considered abandoned.
   *
   * Derived, not chosen. Worst-case job lifetime is ~18 minutes: 751s of retry
   * delays at the +20% jitter ceiling (901s), plus 6 attempts x 20s of HTTP
   * budget, plus one stall recovery (lockDuration 30s + stalledInterval 30s).
   * Add ~5 min of queue backlog and 1 min of poll granularity for a ~24 minute
   * floor; 45 gives 2.5x headroom over worst-case lifetime.
   *
   * The min(15) floor is a guard rail, not a preference: anything below the
   * ~18 minute worst case could reap work that is still legitimately running,
   * so the config layer refuses it rather than trusting the operator.
   */
  AI_REAPER_STALE_MINUTES: z.coerce.number().int().min(15).default(45),
  /**
   * Phase 2 — service-to-service HMAC.
   *
   * Verifies signatures on /internal/ai/*. This is NOT the gateway's
   * INTERNAL_API_KEY: the worker holds only this, and it is valid on no other
   * route. Key separation is the actual fix for the escalation Phase 2 closed
   * — signatures are the mechanism, not the point.
   *
   * A dev placeholder keeps a fresh clone runnable (the same convention
   * INTERNAL_API_KEY already uses); production refuses to boot on it.
   */
  AI_WORKER_HMAC_SECRET: z
    .string()
    .min(16)
    .default('dev_ai_worker_hmac_secret_change_me'),

  /**
   * Phase 11 — Core's OUTBOUND credential to the Python AI service.
   *
   * A THIRD secret, deliberately. Hybrid retrieval needs a query embedding on a
   * synchronous, user-facing request, and the worker is not on that path — so
   * Core needs its own edge to Python for the first time.
   *
   * It is NOT AI_SERVICE_HMAC_SECRET (the worker's Python-facing credential)
   * and NOT AI_WORKER_HMAC_SECRET (which Core uses to VERIFY the worker).
   * Three secrets, each valid in exactly one direction, none a superset of
   * another. Sharing one would mean leaking either grants the other's access,
   * which is precisely the escalation Phase 2 exists to prevent.
   */
  AI_CORE_HMAC_SECRET: z.string().min(16).default('dev_ai_core_hmac_secret_change_me'),

  /** Where the AI service listens. Same value the worker uses; not a secret. */
  AI_SERVICE_URL: z.string().url().default('http://localhost:5000'),

  /**
   * Bound on the query embedding, on a path where a USER IS WAITING.
   *
   * Deliberately much tighter than the worker's 10s. Phase 10 measured this
   * call at p50 347ms / p95 846ms, so 2500ms is roughly 3x the p95 — enough
   * that a normal slow call still succeeds, short enough that a dead provider
   * costs the user a fraction of a second before lexical results are returned
   * instead. Search degrades; it does not hang.
   */
  AI_QUERY_TIMEOUT_MS: z.coerce.number().int().min(250).max(10_000).default(2500),

  /**
   * Phase 12 — reranking, OFF BY DEFAULT.
   *
   * ⚠️ THIS DEFAULT IS A MEASUREMENT, NOT CAUTION. Reranking costs a chat
   * completion, and this deployment answers one at p50 ~1.7s / p95 ~2.1s
   * however few candidates it is given — the cost is the deployment's baseline,
   * not the input size, so the usual "send fewer candidates" lever buys
   * nothing. Phase 11 search is p50 488ms end to end, so turning this on makes
   * deflection roughly 4x slower.
   *
   * That is a real trade a product owner should make deliberately, not one a
   * default should make for them. Off, nothing changes: `rerank` returns the
   * Phase 11 ordering without a provider call.
   */
  RERANKING_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),

  /**
   * Hard bound on the reranking call, on a path where a user is waiting.
   *
   * 4000ms is ~2x the measured p95 (2149ms): generous enough that a normal slow
   * call still lands, short enough that a dead provider costs the user four
   * seconds before Phase 11 ordering is returned instead. Past it, search still
   * answers — it just answers with the ordering it already had.
   */
  RERANK_TIMEOUT_MS: z.coerce.number().int().min(500).max(15_000).default(4000),
});

const parsed = Env.safeParse(process.env);
if (!parsed.success) {
  console.error('[core-service] invalid environment:\n', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

/** Placeholders that must never reach production. Names are logged, never values. */
const DEV_PLACEHOLDERS = new Set([
  'dev_ai_worker_hmac_secret_change_me',
  'dev_ai_core_hmac_secret_change_me',
]);

/**
 * Fail fast in production on a known-value or weak signing secret. A secret
 * that ships in the repository is not a secret, and a short one is
 * brute-forceable offline once an attacker captures a single signed request.
 */
if (parsed.data.NODE_ENV === 'production') {
  const weak: string[] = [];
  // Every signing secret gets the same check. Adding one to the config without
  // adding it here would leave a placeholder shipping to production silently.
  const secrets: Array<[string, string]> = [
    ['AI_WORKER_HMAC_SECRET', parsed.data.AI_WORKER_HMAC_SECRET],
    ['AI_CORE_HMAC_SECRET', parsed.data.AI_CORE_HMAC_SECRET],
  ];
  for (const [name, s] of secrets) {
    if (DEV_PLACEHOLDERS.has(s)) weak.push(`${name} (dev placeholder)`);
    else if (s.length < 32) weak.push(`${name} (needs >= 32 chars)`);
  }
  if (weak.length) {
    console.error('[core-service] refusing to start in production with:', weak.join(', '));
    process.exit(1);
  }
}

export const config = parsed.data;
export const isDev = config.NODE_ENV === 'development';
