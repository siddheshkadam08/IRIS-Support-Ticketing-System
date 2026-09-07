/**
 * AI job retry policy — Phase 3 Step 3.
 *
 * WHY THIS LIVES IN shared/ RATHER THAN IN THE WORKER.
 *
 * The policy is split across two processes by BullMQ's design: Core's
 * dispatcher sets `attempts` and `backoff.type` when it enqueues, while the
 * worker supplies the strategy function that turns an attempt number into a
 * delay. Neither half is meaningful alone, and if they disagree the failure is
 * silent (wrong schedule) or fatal ("Unknown backoff strategy custom").
 *
 * Putting the constants here means the two halves import the SAME values and
 * cannot drift. The residual coupling is documented at AI_BACKOFF_TYPE.
 *
 * BullMQ remains the sole retry owner. Nothing here schedules, sleeps or
 * re-invokes anything — it is a pure function BullMQ calls to ask "how long?".
 */

/**
 * Total executions of a job, first attempt included.
 *
 * 6 attempts => BullMQ calls the backoff strategy 5 times, which is exactly the
 * number of entries in AI_RETRY_DELAYS_SECONDS. Its retry test is
 * `attemptsMade + 1 < attempts`, so the 6th execution is terminal and no delay
 * follows it. Verified against the installed bullmq 5.81.4 source, not assumed.
 *
 * This was 5 in the first cut of Step 3, which made the 600s tail unreachable
 * and capped the retry window at 151s. Six is the count the platform curve was
 * always sized for: n delays require n+1 attempts.
 */
export const AI_RETRY_ATTEMPTS = 6;

/**
 * The retry curve, in seconds, indexed by the attempt that just failed.
 *
 * Deliberately the same curve `core-service/src/events/publisher.ts` already
 * uses for access callbacks, so the platform has one documented schedule
 * rather than two. It is fast at the head (1s absorbs a momentary blip) and
 * long in the tail (a provider incident gets minutes, not milliseconds).
 *
 * ALL FIVE ENTRIES ARE REACHABLE AT 6 ATTEMPTS.
 *
 *   execution 1 fails -> strategy(1) -> 1s
 *   execution 2 fails -> strategy(2) -> 5s
 *   execution 3 fails -> strategy(3) -> 25s
 *   execution 4 fails -> strategy(4) -> 120s
 *   execution 5 fails -> strategy(5) -> 600s
 *   execution 6 fails -> TERMINAL, no delay
 *
 *   retry window = 1 + 5 + 25 + 120 + 600 = 751s (~12.5 min)
 *
 * ⚠️ PHASE 3 STEP 5 DEPENDENCY. Maximum job lifetime is derived from this
 * window, and the abandoned-execution reaper derives its stale threshold from
 * that lifetime. The Step 2 draft threshold of 45 minutes was computed against
 * the 151s window and is therefore STALE — Step 5 must recompute it from the
 * 751s window, not inherit the old number.
 */
export const AI_RETRY_DELAYS_SECONDS: readonly number[] = [1, 5, 25, 120, 600];

/**
 * ±20%. Spreads retries so a provider outage does not produce a synchronised
 * burst from every worker slot the instant the delay expires.
 *
 * Note this is TWO-SIDED. BullMQ's built-in jitter only ever shortens a delay
 * (`random * max * jitter + max * (1 - jitter)`), which is not what "±20%"
 * means, and is one reason this strategy is custom rather than built-in.
 */
export const AI_RETRY_JITTER = 0.2;

/**
 * The BullMQ backoff type the dispatcher stamps on every AI job.
 *
 * ⚠️ DEPLOYMENT COUPLING. `custom` means "look up `settings.backoffStrategy` on
 * the Worker". A worker that does not register one throws
 * `Unknown backoff strategy custom` on the FIRST failure — loudly, not
 * silently, which is the right failure mode. Core and worker ship from this
 * repository together, so the window is a deploy, not a version skew.
 */
export const AI_BACKOFF_TYPE = 'custom';

/**
 * How long to wait before the next attempt.
 *
 * Signature matches BullMQ's `BackoffStrategy`: it receives the number of the
 * attempt that just failed, 1-based (BullMQ passes `attemptsMade + 1`).
 *
 * @param attemptsMade 1-based number of the attempt that just failed.
 * @param random       Injectable for deterministic tests. Must return [0, 1).
 */
export function aiRetryDelayMs(attemptsMade: number, random: () => number = Math.random): number {
  // Clamp rather than throw: a backoff strategy that throws turns a retryable
  // failure into a crashed worker, which is strictly worse than a wrong delay.
  const index = Math.min(
    Math.max(Math.floor(attemptsMade) - 1, 0),
    AI_RETRY_DELAYS_SECONDS.length - 1,
  );
  const baseMs = AI_RETRY_DELAYS_SECONDS[index]! * 1000;

  // random() in [0,1) -> factor in [-1, 1) -> delta in [-20%, +20%).
  const delta = (random() * 2 - 1) * baseMs * AI_RETRY_JITTER;

  // Math.max guards the contract "never negative" even if a caller injects a
  // random() outside [0,1).
  return Math.max(0, Math.round(baseMs + delta));
}

/** Total retry window in ms with jitter at zero — used by tests and docs. */
export function aiRetryWindowMs(attempts: number = AI_RETRY_ATTEMPTS): number {
  let total = 0;
  // attempts - 1 delays: the final execution is terminal and is not followed
  // by a wait. n delays therefore require n + 1 attempts to all be reachable.
  for (let a = 1; a <= attempts - 1; a++) {
    const index = Math.min(a - 1, AI_RETRY_DELAYS_SECONDS.length - 1);
    total += AI_RETRY_DELAYS_SECONDS[index]! * 1000;
  }
  return total;
}
