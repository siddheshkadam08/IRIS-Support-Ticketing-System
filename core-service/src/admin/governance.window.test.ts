import { describe, expect, it } from 'vitest';
import { AppError } from '@iris/shared/types';
import { assertGovernedFeature, resolveWindow } from './governance.service.js';

/**
 * Window and feature validation — the two request-level decisions that can
 * silently corrupt a governance figure.
 *
 * A window that is closed at both ends double-counts every row landing on a
 * boundary, and every month-over-month comparison is then wrong by an amount
 * nobody can see. A feature outside the corpus returning an empty page reads as
 * "nothing happened" when the truth is "this is deliberately not measured".
 * Neither failure produces an error; both produce a confident, wrong answer.
 */

const iso = (s: string) => new Date(s).toISOString();

describe('⚠️ the window is half-open, [from, to)', () => {
  it('keeps from and to exactly as given', () => {
    const w = resolveWindow({ from: iso('2026-01-01T00:00:00Z'), to: iso('2026-02-01T00:00:00Z') });
    expect(w.from.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(w.to.toISOString()).toBe('2026-02-01T00:00:00.000Z');
    expect(w.days).toBe(31);
  });

  it('⚠️ adjacent windows share a boundary instant and must not both claim it', () => {
    /**
     * The property the SQL enforces with `>= from AND < to`, asserted here at
     * the contract level: January's upper bound and February's lower bound are
     * the same instant, so exactly one of them may contain a row created then.
     */
    const jan = resolveWindow({ from: iso('2026-01-01T00:00:00Z'), to: iso('2026-02-01T00:00:00Z') });
    const feb = resolveWindow({ from: iso('2026-02-01T00:00:00Z'), to: iso('2026-03-01T00:00:00Z') });
    expect(jan.to.getTime()).toBe(feb.from.getTime());
  });

  it('defaults to the last 30 days when nothing is given', () => {
    const w = resolveWindow({});
    expect(w.days).toBeCloseTo(30, 1);
    expect(w.to.getTime()).toBeGreaterThan(w.from.getTime());
  });

  it('defaults `to` to now when only `from` is given', () => {
    const w = resolveWindow({ from: iso('2026-01-01T00:00:00Z') });
    expect(w.from.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(w.to.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });
});

describe('windows that must be refused', () => {
  it('rejects from == to, which measures nothing', () => {
    const t = iso('2026-01-01T00:00:00Z');
    expect(() => resolveWindow({ from: t, to: t })).toThrow(AppError);
  });

  it('rejects a reversed range rather than quietly swapping it', () => {
    // Swapping would answer a question the caller did not ask.
    expect(() =>
      resolveWindow({ from: iso('2026-02-01T00:00:00Z'), to: iso('2026-01-01T00:00:00Z') }),
    ).toThrow(/strictly before/);
  });

  it('rejects a span beyond the cap', () => {
    expect(() =>
      resolveWindow({ from: iso('2020-01-01T00:00:00Z'), to: iso('2026-01-01T00:00:00Z') }),
    ).toThrow(/366/);
  });

  it('accepts exactly the cap', () => {
    const w = resolveWindow({ from: iso('2025-01-01T00:00:00Z'), to: iso('2026-01-02T00:00:00Z') });
    expect(w.days).toBe(366);
  });

  it('rejects an unparseable timestamp instead of silently using now', () => {
    expect(() => resolveWindow({ from: 'yesterday-ish', to: iso('2026-01-01T00:00:00Z') })).toThrow(
      AppError,
    );
  });
});

describe('⚠️ a feature outside the corpus is refused, not zeroed', () => {
  it('accepts the governed features', () => {
    expect(assertGovernedFeature('classification')).toBe('classification');
    expect(assertGovernedFeature('summary')).toBe('summary');
  });

  it('treats absence as "all governed features"', () => {
    expect(assertGovernedFeature(undefined)).toBeNull();
  });

  it('⚠️ REJECTS noop, and says why', () => {
    /**
     * The case this exists for. There are 8,656 `noop` executions — a stub with
     * an injected failure rate, built for the Phase 3 reliability tests. An
     * empty governance page for `feature=noop` would read as "no noop
     * executions happened". The truth is "these are deliberately not measured",
     * and only an error can say that.
     */
    let caught: unknown;
    try {
      assertGovernedFeature('noop');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe('invalid_request');
    expect((caught as AppError).message).toMatch(/outside the governance corpus/);
    // It must name what IS measured, or the operator is left guessing.
    expect((caught as AppError).message).toMatch(/classification/);
  });

  it('rejects features that write no execution row at all', () => {
    // Copilot, similar tickets and suggested assignees are synchronous and have
    // no `ai_execution` row. Accepting them here would return a confident zero.
    for (const f of ['copilot', 'similar_tickets', 'suggested_assignees', 'embedding']) {
      expect(() => assertGovernedFeature(f), f).toThrow(AppError);
    }
  });
});
