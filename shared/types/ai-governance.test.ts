import { describe, expect, it } from 'vitest';
import {
  GOVERNANCE_CORPUS_SQL,
  GOVERNANCE_FEATURES,
  GOVERNANCE_UNMEASURABLE,
  SUPPORTED_AI_FEATURES,
  TEST_ARTIFACT_ERROR_CODES,
  isGovernanceExecution,
} from './index.js';

/**
 * The governance corpus rule — findings G-5 and G-6.
 *
 * The property under test: a governance metric must measure AI, not the test
 * suite. Two thirds of `ai_execution` is `noop` fault injection and test
 * fixtures, so the rule that removes them is the difference between an honest
 * number and a meaningless one.
 */

const row = (feature: string, error_code: string | null = null) => ({ feature, error_code });

describe('⚠️ what the corpus admits', () => {
  it.each([
    ['classification', null],
    ['classification', 'retries_exhausted'],
    ['classification', 'ai_http_422'],
    ['classification', 'provider_content_filter'],
    ['summary', null],
    ['summary', 'invalid_ai_output'],
  ] as const)('includes real AI work: %s / %s', (feature, code) => {
    expect(isGovernanceExecution(row(feature, code))).toBe(true);
  });

  it('⚠️ INCLUDES `abandoned` — it is a real operational outcome', () => {
    /**
     * The finding that nearly went the other way. 1,486 `abandoned` rows looked
     * like test data, but the production reaper writes that code
     * (ai-reaper.ts:369); tests merely write it too. Excluding it would delete
     * the only signal that an execution was stranded and had to be closed.
     *
     * Once `noop` is gone only 12 remain, all carrying the reaper's own
     * message.
     */
    expect(isGovernanceExecution(row('classification', 'abandoned'))).toBe(true);
    expect(isGovernanceExecution(row('summary', 'abandoned'))).toBe(true);
  });

  it('includes `retries_exhausted` — BullMQ giving up is a real failure', () => {
    expect(isGovernanceExecution(row('summary', 'retries_exhausted'))).toBe(true);
  });
});

describe('⚠️ what the corpus excludes', () => {
  it('⚠️ EXCLUDES noop, whatever its status', () => {
    /**
     * The single most important exclusion. `noop` is the Phase 1 stub with an
     * injected ~40% failure rate: 8,492 executions, 5,069 "failed". Admitting
     * it would make every platform-wide rate a measurement of the reliability
     * tests.
     */
    for (const code of [null, 'retries_exhausted', 'abandoned', 'ai_http_422']) {
      expect(isGovernanceExecution(row('noop', code)), `noop/${code}`).toBe(false);
    }
  });

  it.each(TEST_ARTIFACT_ERROR_CODES)('excludes the test-only code %s', (code) => {
    // Written only by ai-ops.test.ts and ai-reaper.test.ts; no production writer.
    expect(isGovernanceExecution(row('classification', code))).toBe(false);
    expect(isGovernanceExecution(row('summary', code))).toBe(false);
  });

  it('excludes features that are not queue AI work', () => {
    // Synchronous features write no execution row at all; if one ever appeared
    // here it would be a bug, and the corpus must not silently absorb it.
    for (const f of ['copilot', 'rag', 'reranking', 'embedding', 'suggested_assignees']) {
      expect(isGovernanceExecution(row(f)), f).toBe(false);
    }
  });
});

describe('the rule is stated once', () => {
  it('⚠️ the SQL and the TypeScript agree', () => {
    /**
     * Two copies of a rule can disagree; a test that they do not is cheap. The
     * SQL is the one used by queries, the predicate is used by tests and
     * in-memory checks, and this pins them together.
     */
    for (const f of GOVERNANCE_FEATURES) expect(GOVERNANCE_CORPUS_SQL).toContain(f);
    for (const c of TEST_ARTIFACT_ERROR_CODES) expect(GOVERNANCE_CORPUS_SQL).toContain(c);
    expect(GOVERNANCE_CORPUS_SQL).not.toContain("'noop'");
    expect(GOVERNANCE_CORPUS_SQL).not.toContain('abandoned');
  });

  it('carries no bind parameters, so it composes with a caller’s scoping', () => {
    expect(GOVERNANCE_CORPUS_SQL).not.toMatch(/\$\d/);
  });

  it('⚠️ never stands in for product isolation', () => {
    // The corpus decides what is measurable, never who may see it. If this
    // ever mentions product_id, someone has confused the two.
    expect(GOVERNANCE_CORPUS_SQL).not.toContain('product_id');
    expect(GOVERNANCE_CORPUS_SQL).not.toContain('app_scope');
  });

  it('governance features are a strict subset of the supported queue features', () => {
    for (const f of GOVERNANCE_FEATURES) {
      expect(SUPPORTED_AI_FEATURES as readonly string[]).toContain(f);
    }
    expect(GOVERNANCE_FEATURES.length).toBeLessThan(SUPPORTED_AI_FEATURES.length);
    expect(GOVERNANCE_FEATURES as readonly string[]).not.toContain('noop');
  });
});

describe('⚠️ what remains unmeasurable is stated, not implied', () => {
  it('names cost, accuracy and correction rate explicitly', () => {
    // Filtering the population makes rates honest; it does not conjure signals
    // that were never captured. Phase 17 must say so rather than approximate.
    expect(GOVERNANCE_UNMEASURABLE).toContain('cost');
    expect(GOVERNANCE_UNMEASURABLE).toContain('token_usage');
    expect(GOVERNANCE_UNMEASURABLE).toContain('accuracy');
    expect(GOVERNANCE_UNMEASURABLE).toContain('human_correction_rate');
    expect(GOVERNANCE_UNMEASURABLE).toContain('per_attempt_failure_reason');
  });
});
