import { describe, expect, it } from 'vitest';
import {
  AI_BACKOFF_TYPE,
  AI_RETRY_ATTEMPTS,
  AI_RETRY_DELAYS_SECONDS,
  AI_RETRY_JITTER,
  aiRetryDelayMs,
  aiRetryWindowMs,
} from './ai-retry.js';

/**
 * The retry curve, tested deterministically.
 *
 * `aiRetryDelayMs` takes an injectable random source precisely so jitter is
 * testable without sampling: random()=0 is the floor, 0.5 the centre, and
 * values approaching 1 the ceiling. A curve that silently regressed to
 * exponential(1000) — the Phase 3 defect — fails the first block here.
 */

/** No jitter: random()=0.5 => delta = (0.5*2-1) * base * jitter = 0. */
const NO_JITTER = () => 0.5;
const FLOOR = () => 0;
const CEILING = () => 1 - Number.EPSILON;

describe('the curve', () => {
  it('is 1s, 5s, 25s, 120s, 600s', () => {
    expect(AI_RETRY_DELAYS_SECONDS).toEqual([1, 5, 25, 120, 600]);
  });

  it('is NOT exponential(1000) — the schedule Phase 3 replaced', () => {
    // 1,2,4,8 was the actual runtime behaviour before Step 3 and produced a
    // ~15s window. If someone reverts to it, this is the test that says so.
    const exponential = [1, 2, 4, 8].map((s) => s * 1000);
    const actual = [1, 2, 3, 4].map((a) => aiRetryDelayMs(a, NO_JITTER));
    expect(actual).not.toEqual(exponential);
  });

  it.each([
    [1, 1_000],
    [2, 5_000],
    [3, 25_000],
    [4, 120_000],
    [5, 600_000],
  ])('attempt %i waits %ims with jitter centred', (attempt, expected) => {
    expect(aiRetryDelayMs(attempt, NO_JITTER)).toBe(expected);
  });

  it('is monotonically increasing — each failure backs off further', () => {
    const delays = [1, 2, 3, 4, 5].map((a) => aiRetryDelayMs(a, NO_JITTER));
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]!).toBeGreaterThan(delays[i - 1]!);
    }
  });
});

describe('attempt count and the reachable window', () => {
  it('is 5 total attempts', () => {
    expect(AI_RETRY_ATTEMPTS).toBe(5);
  });

  it('reaches only the first four delays — the 5th entry is unreachable', () => {
    // BullMQ retries while `attemptsMade + 1 < attempts`, so with 5 attempts
    // the strategy is called with 1..4 and the 5th execution is terminal.
    // Verified against bullmq 5.81.4 source, and asserted here so raising
    // AI_RETRY_ATTEMPTS is a deliberate act with a visible consequence.
    expect(aiRetryWindowMs(5)).toBe((1 + 5 + 25 + 120) * 1000);
    expect(aiRetryWindowMs(5)).toBe(151_000);
  });

  it('a 6th attempt would unlock the 600s tail and a ~12.5 minute window', () => {
    expect(aiRetryWindowMs(6)).toBe((1 + 5 + 25 + 120 + 600) * 1000);
    expect(aiRetryWindowMs(6) / 60_000).toBeCloseTo(12.5, 1);
  });

  it('survives a far longer outage than the schedule it replaced', () => {
    const previousWindow = (1 + 2 + 4 + 8) * 1000; // exponential(1000)
    expect(aiRetryWindowMs()).toBeGreaterThan(previousWindow * 9);
  });
});

describe('jitter', () => {
  it('is +/-20%', () => {
    expect(AI_RETRY_JITTER).toBe(0.2);
  });

  it.each([1, 2, 3, 4, 5])('attempt %i floor is base - 20%%', (attempt) => {
    const base = AI_RETRY_DELAYS_SECONDS[attempt - 1]! * 1000;
    expect(aiRetryDelayMs(attempt, FLOOR)).toBe(Math.round(base * 0.8));
  });

  it.each([1, 2, 3, 4, 5])('attempt %i ceiling is base + 20%%', (attempt) => {
    const base = AI_RETRY_DELAYS_SECONDS[attempt - 1]! * 1000;
    expect(aiRetryDelayMs(attempt, CEILING)).toBeCloseTo(Math.round(base * 1.2), -1);
  });

  it('is two-sided — it both shortens and lengthens', () => {
    // BullMQ's built-in jitter only ever shortens. Two-sidedness is why this
    // strategy is custom rather than built-in.
    const base = 5_000;
    expect(aiRetryDelayMs(2, FLOOR)).toBeLessThan(base);
    expect(aiRetryDelayMs(2, CEILING)).toBeGreaterThan(base);
  });

  it('keeps every sampled delay inside +/-20% of base', () => {
    for (let attempt = 1; attempt <= 5; attempt++) {
      const base = AI_RETRY_DELAYS_SECONDS[attempt - 1]! * 1000;
      for (let i = 0; i < 500; i++) {
        const d = aiRetryDelayMs(attempt);
        expect(d).toBeGreaterThanOrEqual(Math.floor(base * 0.8));
        expect(d).toBeLessThanOrEqual(Math.ceil(base * 1.2));
      }
    }
  });

  it('actually varies — a fixed delay would defeat the purpose', () => {
    const seen = new Set(Array.from({ length: 200 }, () => aiRetryDelayMs(4)));
    expect(seen.size).toBeGreaterThan(50);
  });
});

describe('never returns a negative or nonsensical delay', () => {
  it.each([
    ['random() below range', () => -5],
    ['random() above range', () => 5],
    ['random() at exactly 0', () => 0],
  ])('%s still yields >= 0', (_label, rnd) => {
    for (let attempt = 1; attempt <= 5; attempt++) {
      expect(aiRetryDelayMs(attempt, rnd)).toBeGreaterThanOrEqual(0);
    }
  });

  it('clamps an out-of-range attempt instead of throwing', () => {
    // A backoff strategy that throws turns a retryable failure into a crashed
    // worker — strictly worse than a wrong delay.
    expect(() => aiRetryDelayMs(0, NO_JITTER)).not.toThrow();
    expect(() => aiRetryDelayMs(-3, NO_JITTER)).not.toThrow();
    expect(() => aiRetryDelayMs(99, NO_JITTER)).not.toThrow();
    expect(aiRetryDelayMs(0, NO_JITTER)).toBe(1_000);
    expect(aiRetryDelayMs(99, NO_JITTER)).toBe(600_000);
  });

  it('returns an integer number of milliseconds', () => {
    for (let attempt = 1; attempt <= 5; attempt++) {
      expect(Number.isInteger(aiRetryDelayMs(attempt))).toBe(true);
    }
  });
});

describe('the dispatcher/worker contract', () => {
  it('declares the custom backoff type both halves must agree on', () => {
    // The dispatcher stamps this on the job; the worker registers the matching
    // settings.backoffStrategy. Importing one constant is what stops them
    // drifting into "Unknown backoff strategy" at runtime.
    expect(AI_BACKOFF_TYPE).toBe('custom');
  });
});
