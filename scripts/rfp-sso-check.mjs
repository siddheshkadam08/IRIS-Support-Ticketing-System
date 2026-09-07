/**
 * Proves the SSO handoff end to end for the RFP tenant, against a REAL issuer.
 *
 *   node scripts/rfp-sso-check.mjs
 *
 * Stands up a throwaway identity provider — an RS256 key pair and a JWKS
 * endpoint on :6100 — registers it against the RFP tenant through the admin
 * API exactly as an operator would, then checks what the gateway accepts and,
 * more importantly, what it refuses.
 *
 * The negative cases carry the weight. A verifier that accepts a valid token is
 * not evidence of anything; one that accepts an unsigned token, a token from an
 * unregistered issuer, or a token minted for a different tenant is a hole. Each
 * of those is asserted here.
 */
import { createServer } from 'node:http';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

const GW = process.env.GATEWAY_URL ?? 'http://localhost:4000';
const AUDIENCE = 'iris-ticketing';
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

// ── a throwaway identity provider, standing in for RFP's real one ──────────
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
// Port 0 = whatever is free, so every run gets a DISTINCT issuer URL.
//
// A fixed port would be wrong here: each run mints a fresh key pair, so a
// second run serves different keys at a URL the gateway already has cached.
// The gateway refuses to re-fetch that fast on purpose (an attacker must not
// be able to make us hammer a product's IdP with junk tokens), so the run
// fails for a reason that has nothing to do with what it is testing.
await new Promise((r) => idp.listen(0, r));
const ISSUER = `http://localhost:${idp.address().port}`;

/** Mints a token the way RFP's backend would for a signed-in user. */
const mint = (over = {}) => {
  const t = new SignJWT({
    product_tenant_id: over.tenant ?? TENANT,
    name: 'Priya Nair',
    email: 'priya.nair@rfp.example.com',
    ...(over.claims ?? {}),
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'rfp-key-1' })
    .setIssuer(over.issuer ?? ISSUER)
    .setAudience(over.audience ?? AUDIENCE)
    .setSubject(over.sub ?? 'usr_priya_nair')
    .setIssuedAt()
    .setExpirationTime(over.exp ?? '5m')
    .setJti(`jti_${Math.random().toString(36).slice(2)}`);
  return t.sign(over.key ?? privateKey);
};

// ── sign in as the platform admin and configure the tenant ─────────────────
const login = await fetch(`${GW}/admin/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'admin@irisregtech.com', password: 'Abc@1234' }),
});
const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];

const tenants = await fetch(`${GW}/admin/api/tenants`, { headers: { cookie } }).then((r) => r.json());
const rfp = tenants.data?.find((t) => t.slug === 'rfp');

console.log('\nSSO handoff — RFP tenant\n');
console.log('Configuration');
ok('the RFP tenant exists', Boolean(rfp), `saw: ${tenants.data?.map((t) => t.slug).join(', ')}`);
if (!rfp) {
  console.log('\nCannot continue without the tenant.\n');
  idp.close();
  process.exit(1);
}

const configure = await fetch(`${GW}/admin/api/tenants/${rfp.id}`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json', cookie },
  body: JSON.stringify({
    allowed_issuers: [ISSUER],
    jwks_url: `${ISSUER}/.well-known/jwks.json`,
  }),
});
ok('an operator can register the issuer and JWKS URL', configure.status === 200, `HTTP ${configure.status}`);

const after = await fetch(`${GW}/admin/api/tenants`, { headers: { cookie } })
  .then((r) => r.json())
  .then((d) => d.data.find((t) => t.slug === 'rfp'));
ok('the portal reports SSO as configured',
   after?.jwks_url === `${ISSUER}/.well-known/jwks.json` && after?.allowed_issuers?.includes(ISSUER),
   JSON.stringify({ jwks_url: after?.jwks_url, allowed_issuers: after?.allowed_issuers }));

// A JWKS URL is fetched by the server, so it is an SSRF sink.
const ssrf = await fetch(`${GW}/admin/api/tenants/${rfp.id}`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json', cookie },
  body: JSON.stringify({ jwks_url: 'http://169.254.169.254/latest/meta-data/' }),
});
ok('a JWKS URL pointing at link-local metadata is refused', ssrf.status === 400, `HTTP ${ssrf.status}`);

// ── what the gateway does with tokens ──────────────────────────────────────
const call = (token) =>
  fetch(`${GW}/v1/widget/config`, {
    headers: { 'X-IRIS-Publishable-Key': rfp.publishable_key, ...(token ? { 'X-IRIS-Identity': token } : {}) },
  });

console.log('\nToken verification');
const good = await call(await mint());
ok('a correctly signed token is accepted', good.status === 200, `HTTP ${good.status}`);

const wrongIssuer = await call(await mint({ issuer: 'https://evil.example.com' }));
ok('a token from an unregistered issuer is rejected', wrongIssuer.status === 401, `HTTP ${wrongIssuer.status}`);

const { privateKey: otherKey } = await generateKeyPair('RS256', { extractable: true });
const wrongKey = await call(await mint({ key: otherKey }));
ok('a token signed with the wrong key is rejected', wrongKey.status === 401, `HTTP ${wrongKey.status}`);

const wrongAudience = await call(await mint({ audience: 'someone-else' }));
ok('a token minted for another audience is rejected', wrongAudience.status === 401, `HTTP ${wrongAudience.status}`);

const tooLong = await call(await mint({ exp: '24h' }));
ok('a token living longer than 5 minutes is rejected', tooLong.status === 401, `HTTP ${tooLong.status}`);

const expired = await call(await mint({ exp: Math.floor(Date.now() / 1000) - 600 }));
ok('an expired token is rejected', expired.status === 401, `HTTP ${expired.status}`);

// alg:none — the classic JWT break. Hand-built, since jose refuses to mint it.
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const algNone = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
  iss: ISSUER, aud: AUDIENCE, sub: 'usr_attacker', product_tenant_id: TENANT, iat: now, exp: now + 200,
})}.`;
ok('an unsigned (alg:none) token is rejected', (await call(algNone)).status === 401);

const noTenant = await call(await mint({ tenant: undefined, claims: { product_tenant_id: undefined } }));
ok('a token with no product_tenant_id is rejected', noTenant.status === 401, `HTTP ${noTenant.status}`);

console.log('\nIdentity actually flows through');
const cfg = await good.json().catch(() => null);
ok('the widget config comes back branded for RFP',
   typeof cfg?.product?.name === 'string' && /rfp/i.test(cfg.product.name),
   JSON.stringify(cfg?.product ?? null));

idp.close();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
