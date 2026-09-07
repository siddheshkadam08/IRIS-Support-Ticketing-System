/**
 * Fixed internal safety limits — Phase 3 Step 6.
 *
 * These are CONSTANTS rather than configuration on purpose. Each is derived
 * from the timeouts either side of it, so an operator tuning one in isolation
 * would break a relationship rather than fix anything. Configuration is for
 * values a deployment legitimately needs to differ on; these are not that.
 *
 * They live in their own module so tests can assert on them without importing
 * index.ts, which starts a real BullMQ worker on import.
 */

/**
 * Phase 3 Step 6 — how long BullMQ considers this worker's claim on a job
 * valid without a renewal.
 *
 * A CONSTANT, not configuration: it is a fixed internal safety limit derived
 * from the timeouts either side of it, and an operator tuning it in isolation
 * would break the relationship rather than fix anything.
 *
 * A worst-case attempt is bounded at ~20s by the HTTP timeouts it is made of:
 *
 *     Core /input   5s   (CORE_TIMEOUT_MS)
 *   + Python        10s  (AI_TIMEOUT_MS)
 *   + Core /result  5s   (CORE_TIMEOUT_MS)
 *   = 20s
 *
 * `[CODE]` BullMQ's default lockDuration is 30_000 (worker.js:34), which left
 * only ~10s of headroom — a single GC pause or a slow event loop could let the
 * lock lapse on a job that was progressing normally, and a lapsed lock means a
 * stall recovery and a duplicate execution. 60s restores 40s of headroom
 * without touching the retry curve, which is frozen.
 *
 * `[CODE]` lockRenewTime is deliberately left unset: BullMQ defaults it to
 * lockDuration / 2 (worker.js:63-64), i.e. 30s here — comfortably below the
 * lock and above the renewal cost.
 *
 * THE LOCK IS NOT A TIMEOUT. It does not stop slow work; it only says how long
 * BullMQ waits before assuming this process died. Bounding the work is the job
 * of the HTTP and database timeouts, never of this number.
 */
export const LOCK_DURATION_MS = 60_000;
