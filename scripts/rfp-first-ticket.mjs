/**
 * Raises ONE controlled ticket for the RFP tenant and follows it all the way
 * through, using a real SSO token from a real issuer.
 *
 *   node scripts/rfp-first-ticket.mjs
 *
 * Deliberately one ticket, not a load test: the point is to watch a single
 * request cross every boundary in the system and check that each one behaved.
 *
 *   product mints a token  →  gateway verifies it against the product's JWKS
 *   →  core-service allocates RFP-1000 under RLS  →  the ticket is visible to
 *   its raiser and to a platform admin  →  and to nobody else.
 *
 * The isolation checks at the end are the ones worth reading. A ticketing
 * system that stores a ticket is unremarkable; one that can prove another
 * tenant's agent cannot see it is the actual product.
 */
import { createServer } from 'node:http';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

const GW = process.env.GATEWAY_URL ?? 'http://localhost:4000';
const TENANT = 'rfp-internal';

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

// ── RFP's identity provider ────────────────────────────────────────────────
const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
const jwk = await exportJWK(publicKey);
Object.assign(jwk, { kid: 'rfp-key-1', alg: 'RS256', use: 'sig' });

const idp = createServer((req, res) => {
  if (req.url?.startsWith('/.well-known/jwks.json')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ keys: [jwk] }));
    return;
  }
  res.writeHead(404).end();
});
// Port 0: a distinct issuer URL per run. A fixed one would serve a fresh key
// pair at a URL the gateway still has cached, and the deliberate cooldown on
// forced JWKS re-fetches would then fail the run for the wrong reason.
await new Promise((r) => idp.listen(0, r));
const ISSUER = `http://localhost:${idp.address().port}`;

const mintFor = (sub, name, email) =>
  new SignJWT({ product_tenant_id: TENANT, name, email })
    .setProtectedHeader({ alg: 'RS256', kid: 'rfp-key-1' })
    .setIssuer(ISSUER)
    .setAudience('iris-ticketing')
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime('5m')
    .setJti(`jti_${Math.random().toString(36).slice(2)}`)
    .sign(privateKey);

const signIn = async (email) => {
  const res = await fetch(`${GW}/admin/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Abc@1234' }),
  });
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
  return (path, init = {}) =>
    fetch(`${GW}${path}`, { ...init, headers: { ...(init.headers ?? {}), cookie } })
      .then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
};

console.log('\nRFP — one controlled ticket, end to end\n');

// ── setup ──────────────────────────────────────────────────────────────────
const admin = await signIn('admin@irisregtech.com');
const tenants = await admin('/admin/api/tenants');
const rfp = tenants.json?.data?.find((t) => t.slug === 'rfp');
if (!rfp) {
  console.log('  \x1b[31m✗\x1b[0m the RFP tenant does not exist\n');
  idp.close();
  process.exit(1);
}

await admin(`/admin/api/tenants/${rfp.id}`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ allowed_issuers: [ISSUER], jwks_url: `${ISSUER}/.well-known/jwks.json` }),
});

const token = await mintFor('usr_priya_nair', 'Priya Nair', 'priya.nair@rfp.example.com');
const widget = (path, init = {}) =>
  fetch(`${GW}${path}`, {
    ...init,
    headers: {
      'X-IRIS-Publishable-Key': rfp.publishable_key,
      'X-IRIS-Identity': token,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

// ── the handoff ────────────────────────────────────────────────────────────
console.log('1 · SSO handoff');
const cfg = await widget('/v1/widget/config');
ok('the product\'s token is accepted by the gateway', cfg.status === 200, `HTTP ${cfg.status}`);
ok('the widget is branded for RFP', /rfp/i.test(cfg.json?.product?.name ?? ''), cfg.json?.product?.name);

// ── raise ──────────────────────────────────────────────────────────────────
console.log('\n2 · Raising the ticket');

// Exactly one ticket, even across re-runs. A "controlled" check that quietly
// accumulates a ticket every time it runs is not controlled.
const existing = (await admin('/admin/api/tickets?limit=200')).json?.data
  ?.find((t) => t.reference === 'RFP-1000');

// The spoofed raiser fields ride along on the SAME request as the real one.
// The product supplies them; the token contradicts them; the token must win.
// Folding it into this one call proves it without leaving a second ticket.
const created = existing
  ? { status: 201, json: (await admin(`/admin/api/tickets/${existing.id}`)).json, reused: true }
  : await widget('/v1/tickets', {
      method: 'POST',
      body: JSON.stringify({
        product_tenant_id: TENANT,
        subject: 'Cannot export the Q3 response pack',
        description:
          'Exporting the Q3 RFP response pack returns an empty file. Reproduced on Chrome and Edge, '
          + 'signed in as a proposal manager. The preview renders correctly before export.',
        category: 'reports',
        severity: 'high',
        raised_by_ref: 'usr_someone_else',
        raiser_identity: { name: 'Someone Else', email: 'someone.else@rfp.example.com' },
      }),
    });

if (created.reused) console.log('    (RFP-1000 already exists — validating it rather than raising another)');
ok('the ticket is created', created.status === 201, `HTTP ${created.status} ${JSON.stringify(created.json)}`);

const ticket = created.json;
ok('its reference is RFP-1000', ticket?.reference === 'RFP-1000', `got ${ticket?.reference}`);
ok('it opens in the `open` state', ticket?.status === 'open', ticket?.status);
ok('the raiser came from the token, not the request body',
   ticket?.raised_by?.name === 'Priya Nair' && ticket?.raised_by?.email === 'priya.nair@rfp.example.com',
   JSON.stringify(ticket?.raised_by));
ok('the spoofed raiser in the body was ignored',
   ticket?.raised_by?.email !== 'someone.else@rfp.example.com',
   JSON.stringify(ticket?.raised_by));

// ── the raiser's own view ──────────────────────────────────────────────────
console.log('\n3 · What the raiser can see');
const mine = await widget('/v1/tickets?limit=20');
ok('the raiser sees their own ticket', mine.json?.data?.some((t) => t.reference === 'RFP-1000'));

const other = await mintFor('usr_someone_else', 'Someone Else', 'someone.else@rfp.example.com');
const theirs = await fetch(`${GW}/v1/tickets?limit=20`, {
  headers: { 'X-IRIS-Publishable-Key': rfp.publishable_key, 'X-IRIS-Identity': other },
}).then((r) => r.json());
ok('a different user in the same tenant does NOT see it',
   !theirs?.data?.some((t) => t.reference === 'RFP-1000'),
   `${theirs?.data?.length ?? 0} tickets visible to them`);

// ── the support side ───────────────────────────────────────────────────────
console.log('\n4 · What the support team can see');
const adminList = await admin('/admin/api/tickets?limit=200');
const seen = adminList.json?.data?.find((t) => t.reference === 'RFP-1000');
ok('a platform admin sees the ticket', Boolean(seen));
ok('it is attributed to the RFP tenant', seen?.tenant?.name === 'RFP', seen?.tenant?.name);

const carbonAgent = await signIn('carbon.agent@irisregtech.com');
const carbonView = await carbonAgent('/admin/api/tickets?limit=200');
ok('a Carbon agent cannot see an RFP ticket in any list',
   !carbonView.json?.data?.some((t) => t.reference === 'RFP-1000'));

const direct = await carbonAgent(`/admin/api/tickets/${ticket?.id}`);
ok('…and fetching it by id returns 404, not 403',
   direct.status === 404,
   `HTTP ${direct.status} — a 403 would confirm the ticket exists`);

// ── the audit trail ────────────────────────────────────────────────────────
console.log('\n5 · The audit trail');
// Filtered by entity, not "somewhere in the last 50 rows" — every tenant edit
// writes an audit row too, so a recency window quietly stops proving anything.
const audit = await admin(`/admin/api/audit?entity_id=${ticket?.id}`);
ok('raising the ticket was audited',
   audit.json?.data?.some((a) => a.entity_id === ticket?.id),
   `${audit.json?.data?.length ?? 0} audit rows for this ticket`);

idp.close();
console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail === 0 && ticket?.reference) {
  console.log(`  ${ticket.reference}  ·  ${ticket.id}\n`);
}
process.exit(fail === 0 ? 0 : 1);
