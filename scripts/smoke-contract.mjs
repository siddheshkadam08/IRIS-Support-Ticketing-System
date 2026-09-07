/**
 * Validates LIVE gateway responses against the published OpenAPI schemas.
 *
 *   node scripts/smoke-contract.mjs
 *
 * The contract tests in shared/contracts/contracts.test.ts prove the spec is
 * internally coherent. This proves the RUNNING SERVICE actually matches it —
 * which is the only thing an integrator cares about. If someone adds a field,
 * renames one, or changes a status code without touching the spec, this fails.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GW = process.env.GATEWAY_URL ?? 'http://localhost:4000';
const CARBON = 'pub_live_carbon_8f2a';

const spec = parseYaml(
  readFileSync(path.join(ROOT, 'shared/contracts/openapi/iris-v1.yaml'), 'utf8'),
);
const schemas = spec.components.schemas;

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);

/** OpenAPI uses `#/components/schemas/X`; plain JSON Schema wants `#/$defs/X`. */
const rewrite = (node) => {
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
const defs = rewrite(schemas);
const validatorFor = (name) => ajv.compile({ ...rewrite(schemas[name]), $defs: defs });

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    fail++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `\n      ${detail}` : ''}`);
  }
};

/** Fetch, then assert the body conforms to the named schema. */
async function conforms(label, schemaName, url, opts = {}) {
  const res = await fetch(`${GW}${url}`, {
    method: opts.method ?? 'GET',
    headers: {
      'X-IRIS-Publishable-Key': opts.key ?? CARBON,
      ...(opts.token ? { 'X-IRIS-Identity': opts.token } : {}),
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => null);

  if (opts.expectStatus && res.status !== opts.expectStatus) {
    ok(label, false, `expected HTTP ${opts.expectStatus}, got ${res.status}`);
    return null;
  }
  const validate = validatorFor(schemaName);
  const valid = validate(json);
  ok(
    label,
    valid,
    valid
      ? ''
      : (validate.errors ?? [])
          .slice(0, 4)
          .map((e) => `${e.instancePath || '/'} ${e.message}`)
          .join('\n      '),
  );
  return json;
}

console.log('\nLive responses vs the published OpenAPI contract\n');

// A real identity, so raiser-scoped endpoints behave as documented.
const token = await fetch(`${GW}/dev/identity-token`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    publishable_key: CARBON,
    sub: `usr_contract_${Date.now().toString(36)}`,
    product_tenant_id: 'acme-corp',
    name: 'Contract Check',
    email: 'contract@acme.example',
  }),
})
  .then((r) => r.json())
  .then((d) => d.identity_token)
  .catch(() => null);

console.log('Widget');
await conforms('GET /v1/widget/config → WidgetConfig', 'WidgetConfig', '/v1/widget/config', { token });
await conforms('POST /v1/widget/ask → AskResponse', 'AskResponse', '/v1/widget/ask', {
  method: 'POST',
  token,
  body: { question: 'How do I reset my password?' },
});

console.log('\nKnowledge base');
await conforms('GET /v1/kb/articles → KbArticlePage', 'KbArticlePage', '/v1/kb/articles?limit=5', { token });
const articles = await fetch(`${GW}/v1/kb/articles?limit=1`, {
  headers: { 'X-IRIS-Publishable-Key': CARBON },
}).then((r) => r.json());
const articleId = articles?.data?.[0]?.id;
if (articleId) {
  await conforms('GET /v1/kb/articles/{id} → KbArticle', 'KbArticle', `/v1/kb/articles/${articleId}`, { token });
}

console.log('\nTickets');
const created = await conforms('POST /v1/tickets → Ticket', 'Ticket', '/v1/tickets', {
  method: 'POST',
  token,
  expectStatus: 201,
  body: {
    product_tenant_id: 'acme-corp',
    subject: 'Contract conformance check',
    description: 'Raised by scripts/smoke-contract.mjs to validate the live response shape.',
    category: 'reports',
    severity: 'low',
  },
});
await conforms('GET /v1/tickets → TicketPage', 'TicketPage', '/v1/tickets?limit=5', { token });
if (created?.id) {
  await conforms('GET /v1/tickets/{id} → TicketDetail', 'TicketDetail', `/v1/tickets/${created.id}`, { token });
}

console.log('\nErrors');
await conforms(
  'unknown ticket → ErrorEnvelope',
  'ErrorEnvelope',
  '/v1/tickets/tkt_does_not_exist',
  { token, expectStatus: 404 },
);
await conforms(
  'no credential → ErrorEnvelope',
  'ErrorEnvelope',
  '/v1/tickets',
  { key: '', expectStatus: 401 },
);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
