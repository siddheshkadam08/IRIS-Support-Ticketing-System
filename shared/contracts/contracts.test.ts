import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { TICKET_STATUSES, SEVERITIES, ERROR_CODES } from '@iris/shared/types';

/**
 * The contract is only worth having if it cannot drift.
 *
 * These tests keep it honest in three ways:
 *   1. The OpenAPI document is structurally valid and every $ref resolves.
 *   2. Its enums match the TypeScript constants — which in turn mirror the
 *      database CHECK constraints. A value added in one place and forgotten in
 *      another fails here.
 *   3. Response schemas actually validate representative payloads.
 *
 * Live responses are validated against these same schemas by scripts/smoke.mjs.
 */

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');

const spec = parseYaml(read('./openapi/iris-v1.yaml')) as Record<string, any>;
const webhookSchema = JSON.parse(read('./webhooks/webhook-event.schema.json'));
const outboxSchema = JSON.parse(read('./events/outbox-event.schema.json'));

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);

/** Resolves a local `#/a/b/c` pointer, or throws with the pointer that broke. */
function resolvePointer(root: unknown, ref: string): unknown {
  const parts = ref.replace(/^#\//, '').split('/');
  let node: any = root;
  for (const part of parts) {
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
    if (node == null || !(key in node)) throw new Error(`unresolved $ref: ${ref} (at "${key}")`);
    node = node[key];
  }
  return node;
}

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

describe('OpenAPI document', () => {
  it('declares OpenAPI 3.1 with the required top-level fields', () => {
    expect(spec.openapi).toMatch(/^3\.1\./);
    expect(spec.info?.title).toBeTruthy();
    expect(spec.info?.version).toBe('1.0.0');
    expect(Object.keys(spec.paths ?? {}).length).toBeGreaterThan(0);
  });

  it('every $ref resolves', () => {
    const refs = [...new Set(collectRefs(spec))];
    expect(refs.length).toBeGreaterThan(20);
    for (const ref of refs) {
      expect(ref.startsWith('#/'), `external $ref not allowed: ${ref}`).toBe(true);
      expect(() => resolvePointer(spec, ref), ref).not.toThrow();
    }
  });

  it('every operation has an operationId, and they are unique', () => {
    const ids: string[] = [];
    for (const [path, item] of Object.entries<any>(spec.paths)) {
      for (const [method, op] of Object.entries<any>(item)) {
        expect(op.operationId, `${method.toUpperCase()} ${path} has no operationId`).toBeTruthy();
        ids.push(op.operationId);
      }
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every operation documents at least one 2xx and one error response', () => {
    for (const [path, item] of Object.entries<any>(spec.paths)) {
      for (const [method, op] of Object.entries<any>(item)) {
        const codes = Object.keys(op.responses ?? {});
        const where = `${method.toUpperCase()} ${path}`;
        expect(codes.some((c) => c.startsWith('2')), `${where} has no 2xx`).toBe(true);
        expect(codes.some((c) => /^[45]/.test(c)), `${where} documents no failure`).toBe(true);
      }
    }
  });

  it('documents every endpoint the widget and products actually call', () => {
    // If an endpoint ships without a spec entry, this is where it is caught.
    for (const path of [
      '/v1/tickets',
      '/v1/tickets/{id}',
      '/v1/tickets/{id}/comments',
      '/v1/tickets/{id}/status',
      '/v1/tickets/{id}/rating',
      '/v1/tickets/{id}/history',
      '/v1/tickets/{id}/attachments',
      '/v1/widget/config',
      '/v1/widget/ask',
      '/v1/kb/articles',
      '/v1/kb/articles/{id}',
      '/v1/kb/articles/{id}/helpful',
      '/v1/announcements',
      '/v1/attachments',
      '/v1/attachments/{id}/content',
    ]) {
      expect(spec.paths[path], `${path} is not in the spec`).toBeDefined();
    }
  });
});

describe('spec enums match the code', () => {
  // These constants mirror the database CHECK constraints. Keeping the spec
  // pinned to them means the published contract cannot quietly disagree with
  // what the database will actually accept.
  it('TicketStatus', () => {
    expect(spec.components.schemas.TicketStatus.enum).toEqual([...TICKET_STATUSES]);
  });

  it('Severity', () => {
    expect(spec.components.schemas.Severity.enum).toEqual([...SEVERITIES]);
  });

  it('every error code is documented, and none is invented', () => {
    const documented: string[] = spec.components.schemas.ErrorEnvelope.properties.error.properties.code.enum;
    const actual = Object.keys(ERROR_CODES);
    expect([...documented].sort()).toEqual([...actual].sort());
  });
});

describe('response schemas validate real payloads', () => {
  /** Compiles a component schema with its siblings available for $ref. */
  const compile = (name: string) => {
    const schemas = spec.components.schemas as Record<string, unknown>;
    return ajv.compile({
      ...(schemas[name] as object),
      $defs: schemas,
      // Rewrite OpenAPI-style pointers to the $defs we just inlined.
      ...{},
    });
  };

  const ticket = {
    id: 'tkt_01JQZ7YB3KX8M2N4P6R8T0V2W4',
    reference: 'CARB-1042',
    status: 'open',
    product_tenant_id: 'acme-corp',
    subject: 'Q3 export fails',
    description: 'The download button returns a 500.',
    category: 'reports',
    severity: 'high',
    classification_source: 'product',
    summary: null,
    raised_by: { ref: 'usr_9f21', name: 'Priya Nair', email: 'priya@acme.example' },
    identity_assurance: 'sso',
    rating: null,
    rating_comment: null,
    raised_at: '2026-03-26T08:14:22Z',
    first_response_at: null,
    resolved_at: null,
    closed_at: null,
    assignee: null,
  };

  it('accepts a well-formed ticket', () => {
    const validate = compileStandalone('Ticket');
    expect(validate(ticket), JSON.stringify(validate.errors)).toBe(true);
  });

  it('rejects a ticket with an unknown status', () => {
    const validate = compileStandalone('Ticket');
    expect(validate({ ...ticket, status: 'escalated' })).toBe(false);
  });

  it('rejects a ticket missing its reference', () => {
    const validate = compileStandalone('Ticket');
    const { reference, ...without } = ticket;
    expect(validate(without)).toBe(false);
  });

  it('accepts the error envelope and rejects an undocumented code', () => {
    const validate = compileStandalone('ErrorEnvelope');
    expect(
      validate({ error: { code: 'ticket_not_found', message: 'nope', request_id: 'req_1' } }),
    ).toBe(true);
    expect(validate({ error: { code: 'teapot', message: 'nope', request_id: 'req_1' } })).toBe(false);
  });

  it('accepts an ask response and rejects an invalid suggested_action', () => {
    const validate = compileStandalone('AskResponse');
    const payload = {
      conversation_id: 'cnv_01JQZ9A8S6',
      suggested_action: 'answer',
      answers: [
        { type: 'kb_article', id: 'kb_1', title: 'Reset', excerpt: '…', score: 0.9 },
      ],
      prefill: { description: 'help', category: null, severity: 'medium' },
    };
    expect(validate(payload), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...payload, suggested_action: 'auto_resolve' })).toBe(false);
  });

  void compile;
});

describe('webhook event schema', () => {
  const validate = ajv.compile(webhookSchema);

  const base = {
    event_id: 'evt_01JQZ8X4M2',
    api_version: 'v1',
    occurred_at: '2026-03-26T09:00:00Z',
  };

  it('accepts a ticket event', () => {
    const ok = validate({ ...base, event: 'ticket.assigned', data: { ticket_id: 'tkt_1' } });
    expect(ok, JSON.stringify(validate.errors)).toBe(true);
  });

  it('requires ticket_id on ticket events', () => {
    expect(validate({ ...base, event: 'ticket.assigned', data: {} })).toBe(false);
  });

  it('accepts an access grant request', () => {
    const ok = validate({
      ...base,
      event: 'access.grant_requested',
      grant_id: 'grt_1',
      data: { ticket_id: 'tkt_1', support_user_id: 'su_1' },
    });
    expect(ok, JSON.stringify(validate.errors)).toBe(true);
  });

  it('requires grant_id on access events', () => {
    expect(
      validate({ ...base, event: 'access.revoke_requested', data: { ticket_id: 'tkt_1' } }),
    ).toBe(false);
  });

  it('rejects an unknown event type', () => {
    expect(validate({ ...base, event: 'ticket.exploded', data: { ticket_id: 't' } })).toBe(false);
  });

  it('rejects a wrong api_version', () => {
    expect(
      validate({ ...base, api_version: 'v2', event: 'ticket.closed', data: { ticket_id: 't' } }),
    ).toBe(false);
  });

  it('documents the product-side grant and revoke responses', () => {
    const grant = ajv.compile(webhookSchema.$defs.grantResponse);
    expect(grant({ status: 'granted', product_grant_ref: 'carbon-grant-1' })).toBe(true);
    expect(grant({ status: 'maybe' })).toBe(false);

    const revoke = ajv.compile(webhookSchema.$defs.revokeResponse);
    expect(revoke({ status: 'revoked' })).toBe(true);
    expect(revoke({ status: 'granted' })).toBe(false);
  });
});

describe('outbox event schema', () => {
  const validate = ajv.compile(outboxSchema);

  it('accepts an access grant outbox row', () => {
    const ok = validate({
      event_id: 'evt_1',
      product_id: 'prod_carbon',
      aggregate: 'access_grant',
      aggregate_id: 'grt_1',
      event_type: 'access.grant_requested',
      payload: { ticket_id: 'tkt_1' },
      request_id: 'req_1',
      published_at: null,
      attempt_count: 0,
    });
    expect(ok, JSON.stringify(validate.errors)).toBe(true);
  });

  it('rejects an unknown aggregate', () => {
    expect(
      validate({ event_id: 'e', aggregate: 'invoice', event_type: 'x', payload: {} }),
    ).toBe(false);
  });

  it('rejects unexpected properties — the internal shape is closed', () => {
    expect(
      validate({ event_id: 'e', aggregate: 'ticket', event_type: 'x', payload: {}, surprise: 1 }),
    ).toBe(false);
  });
});

/**
 * Compiles a component schema standalone by inlining the whole component map
 * and rewriting OpenAPI's `#/components/schemas/X` pointers to `#/$defs/X`,
 * which is what plain JSON Schema understands.
 */
function compileStandalone(name: string) {
  const schemas = spec.components.schemas as Record<string, unknown>;
  const rewrite = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(rewrite);
    if (node && typeof node === 'object') {
      return Object.fromEntries(
        Object.entries(node).map(([k, v]) =>
          k === '$ref' && typeof v === 'string'
            ? [k, v.replace('#/components/schemas/', '#/$defs/')]
            : [k, rewrite(v)],
        ),
      );
    }
    return node;
  };
  const root = rewrite(schemas[name]) as Record<string, unknown>;
  return ajv.compile({ ...root, $defs: rewrite(schemas) as Record<string, unknown> });
}
