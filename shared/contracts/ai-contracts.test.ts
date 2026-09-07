import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {
  AI_FEATURES,
  AI_EVENT_FEATURES,
  AI_QUEUE_NAME,
  SUPPORTED_AI_FEATURES,
  isSupportedFeature,
  DEFAULT_AI_THRESHOLDS,
} from '@iris/shared/types';

/**
 * The AI contract is only worth having if it cannot drift.
 *
 * Three things are checked here, deliberately mirroring what contracts.test.ts
 * already does for the ticket API:
 *
 *   1. The schema itself is coherent and every $ref resolves internally.
 *   2. The schema's feature enum equals the TypeScript AI_FEATURES constant.
 *      A capability added in one place and forgotten in the other fails HERE,
 *      not in production at 2am.
 *   3. The shared fixtures validate (or fail to validate) exactly as declared.
 *
 * ai-service/tests/test_contracts.py runs check 3 against the SAME schema file
 * and the SAME fixtures, which is what makes "one contract, two languages"
 * true rather than aspirational.
 */

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');

const schema = JSON.parse(read('./ai/ai-contracts.schema.json'));
const fixtures = JSON.parse(read('./ai/fixtures/cases.json')) as {
  cases: Array<{ name: string; def: string; valid: boolean; payload: unknown }>;
};

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(schema);

/** Compiles a validator for one $def by pointer into the single schema file. */
const validatorFor = (def: string) => ajv.compile({ $ref: `${schema.$id}#/$defs/${def}` });

function collectRefs(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, out);
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') out.push(value);
      else collectRefs(value, out);
    }
  }
  return out;
}

describe('AI contract schema', () => {
  it('is a single self-contained 2020-12 document', () => {
    expect(schema.$schema).toContain('2020-12');
    expect(schema.$id).toBeTruthy();
    expect(Object.keys(schema.$defs).length).toBeGreaterThan(8);
  });

  it('uses only internal $refs, so both AJV and Python load it with no resolver', () => {
    const refs = [...new Set(collectRefs(schema))];
    expect(refs.length).toBeGreaterThan(5);
    for (const ref of refs) {
      expect(ref.startsWith('#/$defs/'), `external $ref not allowed: ${ref}`).toBe(true);
      const def = ref.replace('#/$defs/', '');
      expect(schema.$defs[def], `unresolved $ref: ${ref}`).toBeDefined();
    }
  });

  it('every $def compiles', () => {
    for (const def of Object.keys(schema.$defs)) {
      expect(() => validatorFor(def), def).not.toThrow();
    }
  });
});

describe('schema and TypeScript cannot drift', () => {
  it('the ai_feature enum equals the AI_FEATURES constant', () => {
    expect(schema.$defs.ai_feature.enum).toEqual([...AI_FEATURES]);
  });

  it('Phase 1 supports only the noop stub', () => {
    expect(SUPPORTED_AI_FEATURES).toEqual(['noop']);
    expect(isSupportedFeature('noop')).toBe(true);
    // Declared for later phases, but Core must reject it today.
    expect(isSupportedFeature('classification')).toBe(false);
    expect(isSupportedFeature('telepathy')).toBe(false);
  });

  it('every feature the dispatcher can emit is a declared feature', () => {
    for (const [eventType, features] of Object.entries(AI_EVENT_FEATURES)) {
      expect(eventType).toMatch(/^[a-z_]+\.[a-z_]+$/);
      for (const f of features) expect(AI_FEATURES).toContain(f);
    }
  });

  it('there is exactly one AI queue', () => {
    expect(AI_QUEUE_NAME).toBe('ai.jobs');
  });

  it('the ADR-005 default thresholds are the documented ones', () => {
    expect(DEFAULT_AI_THRESHOLDS).toEqual({
      auto_route_p1: 0.8,
      auto_route_margin: 0.25,
      triage_floor: 0.5,
    });
  });
});

describe('shared fixtures', () => {
  it('covers both the valid and the invalid direction', () => {
    expect(fixtures.cases.some((c) => c.valid)).toBe(true);
    expect(fixtures.cases.some((c) => !c.valid)).toBe(true);
  });

  for (const c of fixtures.cases) {
    it(`${c.valid ? 'accepts' : 'rejects'}: ${c.name}`, () => {
      const validate = validatorFor(c.def);
      const ok = validate(c.payload);
      if (ok !== c.valid) {
        throw new Error(
          `${c.name}: expected valid=${c.valid}, got ${ok}. ` +
            `${JSON.stringify(validate.errors ?? [])}`,
        );
      }
      expect(ok).toBe(c.valid);
    });
  }
});

describe('the data boundary is enforced by the schema, not by review', () => {
  const validate = validatorFor('ai_execute_request');

  /**
   * Every field here is something a well-meaning refactor could plausibly add
   * to the Python payload. additionalProperties:false is what turns each one
   * into a failing test instead of a silent data leak into the AI service.
   */
  const forbidden = [
    'product_id',
    'product_tenant_id',
    'raised_by_ref',
    'raiser_identity',
    'raiser_email',
    'identity_assurance',
    'reference',
    'assignee_id',
    'metadata',
    'internal_key',
    'client_secret',
  ];

  for (const field of forbidden) {
    it(`refuses ${field} at the top level`, () => {
      const payload = {
        feature: 'noop',
        request_id: 'req_1',
        input: { subject: null, description: 'x' },
        [field]: 'should-never-cross',
      };
      expect(validate(payload)).toBe(false);
    });

    it(`refuses ${field} inside input`, () => {
      const payload = {
        feature: 'noop',
        request_id: 'req_1',
        input: { subject: null, description: 'x', [field]: 'should-never-cross' },
      };
      expect(validate(payload)).toBe(false);
    });
  }
});
