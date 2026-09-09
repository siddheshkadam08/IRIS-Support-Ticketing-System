import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DISCLAIMER_ATTRIBUTE, assertsProhibitedClaim } from '@iris/shared/types';

/**
 * The governance vocabulary rule, enforced on the page source.
 *
 * ⚠️ WHY THIS IS NOT A PAGE-WIDE STRING SCAN.
 *
 * The first version of the rule said "these words must not appear". It failed
 * on its own required copy: the confidence disclaimer contains "correct", and
 * the sentence denying an accuracy metric contains "accuracy". The only way to
 * make that test pass is to delete the disclaimers — so the test would have
 * enforced the opposite of governance, and it would have looked green doing it.
 *
 * The rule this file enforces instead:
 *
 *   PROHIBITED   a term that ASSERTS a property, used as a heading, label,
 *                column header, chart title or KPI.
 *   REQUIRED     the same term inside an element marked
 *                `data-governance-disclaimer`, where it DENIES that property.
 *
 * The page marks disclaimers with that attribute; this test exempts exactly
 * those regions and holds everything else to the rule. The exemption is proved
 * load-bearing below rather than assumed.
 */

const SOURCE = readFileSync(fileURLToPath(new URL('./AIGovernance.tsx', import.meta.url)), 'utf8');

/** Comments are not rendered, so they are not claims. Removed before checking. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
}

/**
 * Split the source into the text a viewer could read as a claim, and the text
 * that is explicitly a disclaimer.
 */
function partition(src: string): { claims: string; disclaimers: string } {
  const code = stripComments(src);
  const disclaimerBlocks: string[] = [];

  // <Disclaimer> … </Disclaimer> and any element carrying the attribute.
  const patterns = [
    /<Disclaimer>[\s\S]*?<\/Disclaimer>/g,
    new RegExp(`<(\\w+)[^>]*${DISCLAIMER_ATTRIBUTE}[^>]*>[\\s\\S]*?<\\/\\1>`, 'g'),
  ];

  let claims = code;
  for (const p of patterns) {
    claims = claims.replace(p, (match) => {
      disclaimerBlocks.push(match);
      return ' ';
    });
  }
  return { claims, disclaimers: disclaimerBlocks.join('\n') };
}

const { claims, disclaimers } = partition(SOURCE);

describe('⚠️ the page asserts nothing the data cannot support', () => {
  it('no heading, label, column header or chart title makes a prohibited claim', () => {
    expect(assertsProhibitedClaim(claims), 'a prohibited claim appears outside a disclaimer').toBe(
      false,
    );
  });

  it('⚠️ POSITIVE CONTROL: the checker really does reject a claim in that position', () => {
    /**
     * Without this, the assertion above would pass just as happily against an
     * empty string, a file that failed to load, or a partition function that
     * accidentally exempted everything.
     */
    const withViolation = `${claims}\n<Card title="Model accuracy" />`;
    expect(assertsProhibitedClaim(withViolation)).toBe(true);

    const kpi = `${claims}\n<Figure label="Calibrated confidence" />`;
    expect(assertsProhibitedClaim(kpi)).toBe(true);
  });

  it('⚠️ POSITIVE CONTROL: the exemption is load-bearing, not decorative', () => {
    /**
     * The disclaimer text must actually contain terms the rule prohibits
     * elsewhere. If it did not, the split would be doing nothing and the whole
     * policy would collapse back into the string scan it replaced.
     */
    expect(disclaimers.length, 'disclaimer regions must have been found').toBeGreaterThan(500);
    expect(assertsProhibitedClaim(disclaimers), 'disclaimers deny what labels may not claim').toBe(
      true,
    );
  });

  it('every column header and card title is checked individually, not only in bulk', () => {
    const headers = [...claims.matchAll(/<th>([^<]+)<\/th>/g)].map((m) => m[1]!.trim());
    const titles = [...claims.matchAll(/title="([^"]+)"/g)].map((m) => m[1]!);
    const labels = [...claims.matchAll(/label=\{?"([^"]+)"/g)].map((m) => m[1]!);

    // Positive control: the page really does have headers, titles and labels.
    expect(headers.length, 'the page must have table headers to check').toBeGreaterThan(10);
    expect(titles.length, 'the page must have card titles to check').toBeGreaterThan(5);
    expect(labels.length, 'the page must have KPI labels to check').toBeGreaterThan(4);

    for (const text of [...headers, ...titles, ...labels]) {
      expect(assertsProhibitedClaim(text), `"${text}"`).toBe(false);
    }
  });
});

describe('⚠️ the required denials are present', () => {
  it('states that these counts do not measure whether the AI was right', () => {
    expect(disclaimers).toMatch(/do not measure whether the AI was right/i);
    expect(disclaimers).toMatch(/no ground truth/i);
  });

  it('labels confidence as an uncalibrated signal, not a probability of correctness', () => {
    expect(disclaimers).toMatch(/uncalibrated model signal/i);
    expect(disclaimers).toMatch(/not a probability that the output is correct/i);
  });

  it('says no accuracy metric exists', () => {
    expect(disclaimers).toMatch(/no accuracy metric exists/i);
  });

  it('says Copilot drafts are ephemeral and their fate unrecorded', () => {
    expect(disclaimers).toMatch(/ephemeral by design/i);
    expect(disclaimers).toMatch(/not recorded/i);
  });

  it('says routing is decided by IRIS rather than by the model', () => {
    expect(SOURCE).toMatch(/made by IRIS, not by the model/i);
    expect(disclaimers).toMatch(/The\s+model does not choose/i);
  });

  it('marks disclaimers with the attribute the policy names', () => {
    expect(SOURCE).toContain(DISCLAIMER_ATTRIBUTE);
  });
});

describe('⚠️ presentation rules that keep a number honest', () => {
  it('shows the population arithmetic before any figure', () => {
    const panel = SOURCE.indexOf('What is being measured');
    const firstFigure = SOURCE.indexOf('<Figure');
    expect(panel).toBeGreaterThan(-1);
    expect(panel, 'the population panel must come before the first KPI').toBeLessThan(firstFigure);
  });

  it('never renders a suppressed rate as a percentage', () => {
    // The suppressed branch renders an em dash and says why; it must not fall
    // through to `(0).toFixed(1)%`, which reads as "nothing succeeded".
    expect(SOURCE).toMatch(/rate_suppressed[\s\S]{0,40}\?\s*'—'/);
  });

  it('reports fallback as occurrences and never as a rate', () => {
    expect(SOURCE).toMatch(/occurrence/);
    expect(SOURCE).not.toMatch(/fallback[_ ]?rate/i);
  });

  it('renders a missing provenance value as "not recorded" rather than blank or invented', () => {
    expect(SOURCE).toMatch(/not recorded/);
  });

  it('names the three latency measurements separately', () => {
    expect(SOURCE).toMatch(/Provider execution/);
    expect(SOURCE).toMatch(/Wall clock/);
    expect(SOURCE).toMatch(/Queue delay/);
    expect(SOURCE).toMatch(/must not be compared or combined/i);
  });

  it('⚠️ shows the denominator next to every percentile block', () => {
    // A percentile without its n is the shape of an accuracy claim.
    const denominators = [...SOURCE.matchAll(/<Denominator/g)].length;
    expect(denominators).toBeGreaterThanOrEqual(8);
  });
});
