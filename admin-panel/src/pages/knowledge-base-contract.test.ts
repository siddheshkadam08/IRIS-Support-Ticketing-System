import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  KB_STATUSES,
  allowedKbTransitions,
  canEditKbArticle,
  canPublishKb,
} from '@iris/shared/kb';

/**
 * The KB page must not hold a second copy of the lifecycle — Phase 18.
 *
 * ⚠️ WHAT THIS FILE IS ACTUALLY GUARDING.
 *
 * The transition matrix and the role rules are shared data precisely so the
 * server and the panel cannot disagree. That guarantee survives exactly as long
 * as nobody writes `if (role === 'manager')` or `['draft','published']` into the
 * page — both of which are the obvious local thing to do, both of which work on
 * the day they are written, and both of which then drift silently. The drift
 * shows up as a button that 403s, or as a control withheld from someone who is
 * allowed, and neither breaks a test that only checks rendering.
 *
 * So this scans the page source for the shapes of a local restatement, and
 * separately asserts the shared rules are actually imported and called.
 *
 * Comments are stripped first: this file's own subject matter means the page's
 * comments legitimately discuss roles and states in prose.
 */

const SOURCE = readFileSync(fileURLToPath(new URL('./KnowledgeBase.tsx', import.meta.url)), 'utf8');

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
}

const CODE = stripComments(SOURCE);

describe('the page derives its rules from @iris/shared/kb', () => {
  it('imports the matrix and the role predicates from the shared subpath', () => {
    expect(CODE).toMatch(/from '@iris\/shared\/kb'/);
    for (const symbol of ['allowedKbTransitions', 'canPublishKb', 'canEditKbArticle', 'KB_STATUSES']) {
      expect(CODE, `${symbol} should be imported`).toContain(symbol);
    }
  });

  /**
   * ⚠️ IMPORTING IS NOT USING. A page can import the matrix and still hard-code
   * its buttons, which is exactly the failure this pair of assertions separates.
   */
  it('renders its transition controls from allowedKbTransitions, not a literal list', () => {
    expect(CODE).toMatch(/allowedKbTransitions\([^)]*\)\s*\.map/);
  });

  it('gates the publish controls on canPublishKb rather than on a role comparison', () => {
    expect(CODE).toMatch(/canPublishKb\(/);
    // No local role equality checks anywhere in the rendered code.
    expect(CODE).not.toMatch(/role\s*===\s*['"](manager|product_admin|super_admin|agent)['"]/);
    expect(CODE).not.toMatch(/\brole\s*!==\s*['"]agent['"]/);
  });

  it('gates the editor on canEditKbArticle rather than on the status directly', () => {
    expect(CODE).toMatch(/canEditKbArticle\(/);
  });

  /**
   * A local `['draft','published','archived']` would keep working while the
   * shared list grew a fourth state, and the new state would simply never
   * appear in the filter.
   */
  it('does not restate the status list as an array literal', () => {
    expect(CODE).not.toMatch(/\[\s*['"]draft['"]\s*,\s*['"]published['"]/);
    expect(CODE).toMatch(/KB_STATUSES\.map/);
  });

  /**
   * The page maps each status to a display label, which is presentation and
   * belongs here. The guard is that the map is COMPLETE — a missing key renders
   * `undefined` in a filter dropdown.
   */
  it('labels every status the shared contract defines', () => {
    for (const s of KB_STATUSES) {
      expect(CODE, `no label for ${s}`).toMatch(new RegExp(`${s}:\\s*['"]`));
    }
  });
});

describe('the page offers no control the server would refuse', () => {
  /**
   * `status` and `is_public` are both rejected by PATCH /admin/api/kb/articles/:id
   * — the first because the lifecycle has its own endpoint and its own role
   * check, the second because migration 018 leaves the column unwritable by the
   * application. A form field for either would look like it saved.
   */
  it('the article form does not send status or is_public', () => {
    const update = CODE.match(/api\.kbUpdate\([\s\S]{0,200}?\)/)?.[0] ?? '';
    const create = CODE.match(/api\.kbCreate\([\s\S]{0,200}?\)/)?.[0] ?? '';
    expect(update).not.toContain('status');
    expect(update).not.toContain('is_public');
    expect(create).not.toContain('status');
    expect(create).not.toContain('is_public');
  });

  it('has no publish, unpublish or archive client call of its own', () => {
    // One transition endpoint, one client method. Four would mean four call
    // sites each deciding for themselves what is allowed.
    expect(CODE).not.toMatch(/api\.kb(Publish|Unpublish|Archive)/);
    expect(CODE).toMatch(/api\.kbSetStatus\(/);
  });

  it('never offers a delete', () => {
    expect(CODE).not.toMatch(/api\.kbDelete/);
    expect(CODE).not.toMatch(/method:\s*'DELETE'/);
  });
});

/**
 * The rules the page consumes, asserted here too.
 *
 * Not redundant with shared/types/kb.test.ts: these are the exact questions the
 * page asks, so if a future change to the shared module altered one of them the
 * page's behaviour would change silently and this file names which behaviour.
 */
describe('the rules the page renders', () => {
  it('an agent is shown no transition controls', () => {
    expect(canPublishKb('agent')).toBe(false);
  });

  it('an archived article offers exactly one control, back to draft', () => {
    expect(allowedKbTransitions('archived')).toEqual(['draft']);
  });

  it('a published article offers unpublish and archive, never publish again', () => {
    expect([...allowedKbTransitions('published')].sort()).toEqual(['archived', 'draft']);
  });

  it('the editor is read-only for an archived article whatever the role', () => {
    for (const role of ['agent', 'manager', 'product_admin', 'super_admin']) {
      expect(canEditKbArticle(role, 'archived')).toBe(false);
    }
  });
});
