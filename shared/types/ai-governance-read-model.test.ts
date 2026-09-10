import { describe, expect, it } from 'vitest';
import {
  AI_GOVERNANCE_VERSION,
  CONFIDENCE_BUCKET_COUNT,
  CONFIDENCE_DISCLAIMER,
  COPILOT_DISCLAIMER,
  CORRECTION_DISCLAIMER,
  DISCLAIMER_ATTRIBUTE,
  FAILURE_CATEGORIES,
  FAILURE_CATEGORY_LABEL,
  MAX_GOVERNANCE_WINDOW_DAYS,
  GOVERNANCE_UNMEASURABLE,
  MIN_SAMPLE_FOR_RATE,
  NO_ACCURACY_DISCLAIMER,
  OPERATIONAL_COUNTS_DISCLAIMER,
  POPULATION_LAYERS,
  PROHIBITED_CLAIM_TERMS,
  SAMPLE_STATES,
  assertsProhibitedClaim,
  confidenceBucketLabel,
  failureCategoryOf,
  sampleStateOf,
} from './index.js';

/**
 * Phase 17 — the pure half of the governance read model.
 *
 * Everything here is a decision about MEANING rather than about data: which
 * failure category a code belongs to, what a bucket is called, which words the
 * page may use to describe a number. Getting these wrong does not crash
 * anything — it produces a plausible page that says something untrue — so they
 * are pinned here, away from the database, where a change to them is visible.
 */

describe('the failure taxonomy', () => {
  it.each([
    ['provider_content_filter', 'provider_refused_content'],
    ['provider_http_429', 'provider_rate_limited'],
    ['provider_http_500', 'provider_error'],
    ['provider_http_503', 'provider_error'],
    ['ai_http_502', 'provider_error'],
    ['ai_service_timeout', 'timeout'],
    ['ai_service_unreachable', 'provider_unreachable'],
    ['provider_not_configured', 'provider_unreachable'],
    ['invalid_ai_output', 'output_rejected_by_iris'],
    ['malformed_ai_response', 'output_rejected_by_iris'],
    ['invalid_input', 'bad_request'],
    ['unsupported_feature', 'bad_request'],
    ['retries_exhausted', 'retries_exhausted'],
    ['abandoned', 'stranded'],
  ] as const)('maps %s to %s', (code, category) => {
    expect(failureCategoryOf(code)).toBe(category);
  });

  it('⚠️ an unrecognised code lands in `unclassified` rather than a guess', () => {
    /**
     * The one that matters most today: 264 of the 282 corpus failures carry
     * `ai_http_422`, the pre-G-3 collapse of everything the AI service refused.
     * Nothing about the number 422 says which of content-filter, invalid input
     * or malformed response fired, so nothing here pretends it does — and the
     * raw code travels alongside the category so the ambiguity stays visible.
     */
    expect(failureCategoryOf('ai_http_422')).toBe('unclassified');
    expect(failureCategoryOf('something_nobody_has_seen')).toBe('unclassified');
    expect(failureCategoryOf(null)).toBe('unclassified');
  });

  it('⚠️ 4xx is never silently promoted to a provider error', () => {
    // Only 5xx means "the provider broke". A 4xx means we asked wrongly, and
    // conflating them would send an operator hunting for an outage that is not
    // happening.
    expect(failureCategoryOf('ai_http_400')).toBe('unclassified');
    expect(failureCategoryOf('provider_http_404')).toBe('unclassified');
    expect(failureCategoryOf('ai_http_599')).toBe('provider_error');
  });

  it('every category has a human label', () => {
    for (const c of FAILURE_CATEGORIES) {
      expect(FAILURE_CATEGORY_LABEL[c], c).toBeTruthy();
    }
  });

  it('⚠️ no category label asserts a prohibited claim', () => {
    for (const c of FAILURE_CATEGORIES) {
      expect(assertsProhibitedClaim(FAILURE_CATEGORY_LABEL[c]), c).toBe(false);
      expect(assertsProhibitedClaim(c), c).toBe(false);
    }
  });
});

describe('confidence buckets', () => {
  it('labels ten contiguous buckets across [0,1]', () => {
    const labels = Array.from({ length: CONFIDENCE_BUCKET_COUNT }, (_, i) => confidenceBucketLabel(i));
    expect(labels).toHaveLength(10);
    expect(labels[0]).toBe('0.0–0.1');
    expect(labels[9]).toBe('0.9–1.0');
    // Contiguous: each bucket starts where the previous ended.
    for (let i = 1; i < labels.length; i++) {
      const prevEnd = labels[i - 1]!.split('–')[1];
      const thisStart = labels[i]!.split('–')[0];
      expect(thisStart).toBe(prevEnd);
    }
  });

  it('⚠️ no bucket label reads as a percentage of correctness', () => {
    for (let i = 0; i < CONFIDENCE_BUCKET_COUNT; i++) {
      expect(confidenceBucketLabel(i)).not.toContain('%');
      expect(assertsProhibitedClaim(confidenceBucketLabel(i))).toBe(false);
    }
  });
});

describe('⚠️ the vocabulary policy, and the contradiction it replaced', () => {
  /**
   * The first version of this rule was "these strings must not appear on the
   * page". It contradicted itself on the first line of copy: the required
   * disclaimer contains the word "correct", and the sentence denying an accuracy
   * metric contains the word "accuracy". A blanket scan fails on exactly the
   * sentences that make the page honest, and the natural way to make such a test
   * pass is to delete them.
   *
   * The rule now targets USE. These tests are what stop it sliding back.
   */

  it('flags a term used as a metric name or label', () => {
    expect(assertsProhibitedClaim('Accuracy')).toBe(true);
    expect(assertsProhibitedClaim('Model quality score')).toBe(true);
    expect(assertsProhibitedClaim('calibrated_confidence')).toBe(true);
    expect(assertsProhibitedClaim('reliability')).toBe(true);
    expect(assertsProhibitedClaim('confidence_pct')).toBe(true);
  });

  it('⚠️ the REQUIRED disclaimers would fail a blanket scan — proving why it was wrong', () => {
    // Each of these is mandatory copy, and each contains a term from the list.
    // If the policy were "the term must not appear", the page could not be
    // honest and pass at the same time.
    expect(CONFIDENCE_DISCLAIMER).toContain('correct');
    expect(NO_ACCURACY_DISCLAIMER).toContain('accuracy');
    expect(assertsProhibitedClaim(NO_ACCURACY_DISCLAIMER)).toBe(true);

    // ...and the policy resolves it structurally rather than by wording tricks.
    expect(DISCLAIMER_ATTRIBUTE).toBe('data-governance-disclaimer');
  });

  it('leaves ordinary operational labels alone', () => {
    for (const label of [
      'Executions',
      'Succeeded',
      'Failed',
      'Provider execution latency',
      'Queue delay',
      'Attempts per execution',
      'Routing decisions',
      'Replays',
      'Fallback',
    ]) {
      expect(assertsProhibitedClaim(label), label).toBe(false);
    }
  });

  it('⚠️ "Completed without error" is the honest phrasing, and passes', () => {
    // The label the page uses instead of "success rate" as a quality claim.
    expect(assertsProhibitedClaim('Completed without error')).toBe(false);
  });

  it('is case-insensitive, so a heading cannot slip through capitalised', () => {
    expect(assertsProhibitedClaim('ACCURACY')).toBe(true);
    expect(assertsProhibitedClaim('Precision')).toBe(true);
  });

  it('⚠️ a negating prefix makes a different word, and the opposite meaning', () => {
    /**
     * The token-level version of the same mistake. `uncalibrated` is the honest
     * label the confidence signal carries, and `inaccurate` denies exactly what
     * `accurate` would claim. A substring match flags both and would force the
     * page to describe the signal as something other than uncalibrated — which
     * is the one thing it certainly is.
     */
    expect(assertsProhibitedClaim('uncalibrated')).toBe(false);
    expect(assertsProhibitedClaim('Uncalibrated model signal')).toBe(false);
    expect(assertsProhibitedClaim('inaccurate')).toBe(false);

    // And the claims themselves still do not get through.
    expect(assertsProhibitedClaim('calibrated')).toBe(true);
    expect(assertsProhibitedClaim('calibrated_confidence')).toBe(true);
    expect(assertsProhibitedClaim('accurate')).toBe(true);
    expect(assertsProhibitedClaim('quality_score_v2')).toBe(true);
    // A separator is not a letter, so an underscore cannot be used to hide one.
    expect(assertsProhibitedClaim('un_calibrated')).toBe(true);
  });

  it('names the terms that matter for an AI governance surface', () => {
    for (const term of ['accuracy', 'precision', 'recall', 'calibrated', 'correctness']) {
      expect(PROHIBITED_CLAIM_TERMS as readonly string[]).toContain(term);
    }
  });
});

describe('population layers and thresholds', () => {
  it('names exactly the four layers the design defines', () => {
    expect([...POPULATION_LAYERS]).toEqual(['scoped', 'corpus', 'headline', 'replay']);
  });

  it('⚠️ suppresses a rate below 30 observations', () => {
    // Not a power calculation — a presentation convention. Under 30, one event
    // moves a percentage by more than three points and the count says more.
    expect(MIN_SAMPLE_FOR_RATE).toBe(30);
  });

  it('caps the window at a leap year plus a day', () => {
    expect(MAX_GOVERNANCE_WINDOW_DAYS).toBe(366);
  });

  it('⚠️ the version identifies the MEANING of the numbers', () => {
    expect(AI_GOVERNANCE_VERSION).toBe('ai-governance-v1');
  });

  it('the disclaimers say what is absent, not what is good', () => {
    expect(OPERATIONAL_COUNTS_DISCLAIMER).toContain('do not measure');
    expect(COPILOT_DISCLAIMER).toContain('not recorded');
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Phase 21 — sample states and correction vocabulary
// ═════════════════════════════════════════════════════════════════════════

describe('⚠️ the three sample states, and why a boolean was not enough', () => {
  it('names exactly the three states', () => {
    expect([...SAMPLE_STATES]).toEqual(['none', 'insufficient', 'sufficient']);
  });

  /**
   * ⚠️ THE DISTINCTION THE OLD BOOLEAN COULD NOT MAKE. "Nothing happened" and
   * "too little happened to divide" are different facts, and a single
   * `rate_suppressed` flag collapses them — leaving the reader to guess, and
   * usually to guess zero.
   */
  it('separates no observations from too few observations', () => {
    expect(sampleStateOf(0)).toBe('none');
    expect(sampleStateOf(1)).toBe('insufficient');
  });

  it('turns sufficient exactly at the shared threshold, not near it', () => {
    expect(sampleStateOf(MIN_SAMPLE_FOR_RATE - 1)).toBe('insufficient');
    expect(sampleStateOf(MIN_SAMPLE_FOR_RATE)).toBe('sufficient');
    expect(sampleStateOf(MIN_SAMPLE_FOR_RATE + 1)).toBe('sufficient');
  });

  /** A negative denominator is nonsense, but it must not read as sufficient. */
  it('treats a nonsensical denominator as no observations', () => {
    expect(sampleStateOf(-1)).toBe('none');
  });

  it('every state is one of the declared three', () => {
    for (const d of [0, 1, 29, 30, 31, 1000]) {
      expect(SAMPLE_STATES as readonly string[]).toContain(sampleStateOf(d));
    }
  });
});

describe('⚠️ corrections are counted, and a correction rate still is not', () => {
  /**
   * Phase 20 made corrections possible and Phase 21 counts them. The
   * DENOMINATOR is what is still missing: a correction and the classification
   * it replaced fall in different windows, and a corrected ticket's source
   * becomes 'human', so it leaves any ticket-table denominator as the numerator
   * grows. Dropping this entry would be the moment the page starts lying.
   */
  it('keeps human_correction_rate on the unmeasurable list', () => {
    expect(GOVERNANCE_UNMEASURABLE).toContain('human_correction_rate');
  });

  it('keeps accuracy and cost unmeasurable too', () => {
    expect(GOVERNANCE_UNMEASURABLE).toContain('accuracy');
    expect(GOVERNANCE_UNMEASURABLE).toContain('cost');
    expect(GOVERNANCE_UNMEASURABLE).toContain('token_usage');
  });

  it('the correction disclaimer denies the causal claim rather than making it', () => {
    expect(CORRECTION_DISCLAIMER).toContain('does not establish');
    expect(CORRECTION_DISCLAIMER).toContain('authorized human');
  });

  /**
   * ⚠️ The disclaimer contains the word "wrong", which is exactly the kind of
   * copy a blanket string scan would have deleted. It is a denial, so it is
   * allowed — the same exemption the confidence disclaimer relies on.
   */
  it('the disclaimer is prose, and prose is exempt via the attribute', () => {
    expect(DISCLAIMER_ATTRIBUTE).toBe('data-governance-disclaimer');
  });

  /**
   * ⚠️ THE NAMES THAT WOULD HAVE BEEN EASY AND WRONG. Every key the correction
   * panel publishes is checked against the vocabulary rule here, because the
   * obvious labels for this feature are the forbidden ones.
   */
  it('no correction response key asserts a prohibited claim', () => {
    const keys = [
      'corrections',
      'applies_to_filter',
      'events',
      'tickets',
      'tickets_corrected_more_than_once',
      'events_without_ticket',
      'category_changes',
      'severity_changes',
      'severity_overrides',
      'override_eligible',
      'severity_override_rate',
      'sample',
      'prior_source',
    ];
    for (const k of keys) expect(assertsProhibitedClaim(k)).toBe(false);
  });

  it('the names that were rejected WOULD be caught, proving the rule bites', () => {
    for (const k of ['ai_accuracy', 'classification_correctness', 'model_reliability']) {
      expect(assertsProhibitedClaim(k)).toBe(true);
    }
  });

  it('neutral correction vocabulary passes the rule', () => {
    for (const label of [
      'Human classification corrections',
      'Correction events',
      'Tickets corrected',
      'Category changes',
      'Severity changes',
      'Severity overrides',
      'Prior classification source',
    ]) {
      expect(assertsProhibitedClaim(label)).toBe(false);
    }
  });
});
