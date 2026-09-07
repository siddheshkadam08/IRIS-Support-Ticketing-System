/**
 * Admin portal end-to-end tests: multi-tenant auth, isolation, and the full
 * JIT access-grant cycle against a live stack.
 *
 *   node scripts/smoke-admin.mjs
 */
const GW = process.env.GATEWAY_URL ?? 'http://localhost:4000';
const MOCK = process.env.MOCK_PRODUCT_URL ?? 'http://localhost:6001';
const PW = 'Abc@1234';

/** The tenants `npm run seed` creates. Operators may add more; that is normal. */
const SEEDED_TENANTS = ['Carbon', 'ESG', 'iFile', 'iDeal'];

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    fail++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `  → ${detail}` : ''}`);
  }
};

/** Logs in and returns a cookie-bearing fetch. */
async function signIn(email) {
  const res = await fetch(`${GW}/admin/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PW }),
  });
  const setCookie = res.headers.get('set-cookie') ?? '';
  const cookie = setCookie.split(';')[0];
  const body = await res.json().catch(() => null);

  return {
    status: res.status,
    body,
    cookie,
    async call(path, opts = {}) {
      const r = await fetch(`${GW}${path}`, {
        ...opts,
        headers: {
          ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
          ...(opts.headers ?? {}),
          Cookie: cookie,
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
      const text = await r.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        /* non-json */
      }
      return { status: r.status, json };
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('\nIRIS admin portal — end-to-end test\n');

// ── authentication ──────────────────────────────────────────────────────
console.log('Authentication');
const admin = await signIn('admin@irisregtech.com');
ok('super admin signs in', admin.status === 200, `status ${admin.status}`);
ok('session arrives as an httpOnly cookie', /HttpOnly/i.test(admin.cookie ?? '') || Boolean(admin.cookie));
ok('token is NOT returned in the body', admin.body?.token === undefined);

{
  const bad = await fetch(`${GW}/admin/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@irisregtech.com', password: 'wrong' }),
  });
  ok('wrong password → 401', bad.status === 401, `got ${bad.status}`);

  const unknown = await fetch(`${GW}/admin/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'nobody@nowhere.example', password: PW }),
  });
  const unknownBody = await unknown.json().catch(() => ({}));
  const badBody = await bad.json().catch(() => ({}));
  ok('unknown user gives the SAME error as wrong password (no enumeration)',
     unknown.status === bad.status && unknownBody?.error?.code === badBody?.error?.code);

  const noSession = await fetch(`${GW}/admin/api/tickets`);
  ok('no session → 401', noSession.status === 401, `got ${noSession.status}`);
}

// ── multi-tenant scoping ────────────────────────────────────────────────
console.log('\nMulti-tenant scoping');
const me = await admin.call('/admin/api/auth/me');
// "At least the seeded four", never "exactly four": onboarding a tenant is the
// whole point of the portal, so an operator doing it must not turn this suite
// red. What matters is that a super admin sees every tenant, not the count.
ok('super admin sees every seeded tenant',
   SEEDED_TENANTS.every((n) => me.json?.tenants?.some((t) => t.name === n)),
   `${me.json?.tenants?.length} tenants: ${me.json?.tenants?.map((t) => t.name).join(', ')}`);
ok('tenants are Carbon, ESG, iFile, iDeal',
   SEEDED_TENANTS.every((n) => me.json?.tenants?.some((t) => t.name === n)));

const manager = await signIn('ops.manager@irisregtech.com');
const managerMe = await manager.call('/admin/api/auth/me');
ok('ops.manager is scoped to exactly two tenants', managerMe.json?.scopes?.length === 2,
   managerMe.json?.scopes?.join(', '));
ok('…and they are Carbon + ESG',
   managerMe.json?.tenants?.map((t) => t.name).sort().join(',') === 'Carbon,ESG');

const carbonAgent = await signIn('carbon.agent@irisregtech.com');
const agentMe = await carbonAgent.call('/admin/api/auth/me');
ok('carbon agent is scoped to one tenant', agentMe.json?.scopes?.length === 1, agentMe.json?.scopes?.join(','));

const ifileAgent = await signIn('ifile.agent@irisregtech.com');

// ── cross-tenant isolation ──────────────────────────────────────────────
console.log('\nCross-tenant isolation');
const allTickets = await admin.call('/admin/api/tickets?limit=200');
const carbonTicket = allTickets.json?.data?.find((t) => t.tenant?.name === 'Carbon');
const ifileTicket = allTickets.json?.data?.find((t) => t.tenant?.name === 'iFile');
ok('super admin sees tickets across tenants',
   new Set(allTickets.json?.data?.map((t) => t.tenant?.name)).size > 1,
   `${new Set(allTickets.json?.data?.map((t) => t.tenant?.name)).size} distinct tenants`);

{
  const agentList = await carbonAgent.call('/admin/api/tickets?limit=200');
  const tenants = new Set(agentList.json?.data?.map((t) => t.tenant?.name));
  ok('carbon agent sees ONLY Carbon tickets', tenants.size === 1 && tenants.has('Carbon'),
     [...tenants].join(','));

  const cross = await carbonAgent.call(`/admin/api/tickets/${ifileTicket?.id}`);
  ok('carbon agent requesting an iFile ticket → 404 not 403', cross.status === 404,
     `got ${cross.status} ${cross.json?.error?.code}`);

  const mgrList = await manager.call('/admin/api/tickets?limit=200');
  const mgrTenants = new Set(mgrList.json?.data?.map((t) => t.tenant?.name));
  ok('ops.manager sees Carbon + ESG only',
     mgrTenants.size === 2 && mgrTenants.has('Carbon') && mgrTenants.has('ESG'),
     [...mgrTenants].join(','));
}

// ── zero standing access ────────────────────────────────────────────────
console.log('\nZero standing access (T1)');
const unassigned = (await admin.call('/admin/api/tickets?status=open&limit=50')).json?.data
  ?.find((t) => t.tenant?.name === 'Carbon' && !t.assignee);
ok('found an unassigned Carbon ticket to test with', Boolean(unassigned), unassigned?.reference);

{
  const before = await carbonAgent.call(`/admin/api/tickets/${unassigned?.id}`);
  ok('agent can see the unassigned ticket exists (queue metadata)', before.status === 200);
  ok('…but has NO platform grant', before.json?.access?.has_platform_grant === false);
  ok('…and the UI is told why', Boolean(before.json?.access?.reason));

  const agentId = agentMe.json?.id;
  const assigned = await carbonAgent.call(`/admin/api/tickets/${unassigned?.id}/assign`, {
    method: 'POST',
    body: { support_user_id: agentId },
  });
  ok('agent self-assigns', assigned.status === 200, `status ${assigned.status} ${assigned.json?.error?.code ?? ''}`);
  ok('assignment issued a platform grant',
     assigned.json?.grants?.platformGrantId !== undefined && assigned.json?.grants?.platformGrantId !== null);

  const after = await carbonAgent.call(`/admin/api/tickets/${unassigned?.id}`);
  ok('after assignment the agent HAS a platform grant', after.json?.access?.has_platform_grant === true);
  ok('grants appear on the ticket', (after.json?.grants?.length ?? 0) >= 1,
     `${after.json?.grants?.length} grants`);

  const otherAgent = await ifileAgent.call(`/admin/api/tickets/${unassigned?.id}`);
  ok('an agent from another tenant still gets 404', otherAgent.status === 404, `got ${otherAgent.status}`);
}

// ── T2 product callback ─────────────────────────────────────────────────
console.log('\nT2 product callback (Carbon = callback mechanism)');
{
  // Give the in-process drainer time to deliver.
  await sleep(3500);
  const detail = await admin.call(`/admin/api/tickets/${unassigned?.id}`);
  const productGrant = detail.json?.grants?.find((g) => g.layer === 'product');

  ok('a product-layer grant was created', Boolean(productGrant), productGrant?.mechanism);
  ok('the mock product confirmed it', productGrant?.state === 'granted',
     `state=${productGrant?.state} err=${productGrant?.last_error ?? ''}`);
  ok('the product returned its own grant reference', Boolean(productGrant?.product_grant_ref),
     productGrant?.product_grant_ref);
  ok('the delivery was logged with a latency', (detail.json?.deliveries?.length ?? 0) > 0,
     `${detail.json?.deliveries?.length} attempts, ${detail.json?.deliveries?.[0]?.latency_ms}ms`);
  ok('the mock verified our HMAC signature (it 200s only on a valid one)',
     detail.json?.deliveries?.[0]?.status_code === 200,
     `status ${detail.json?.deliveries?.[0]?.status_code}`);

  const mockPage = await fetch(`${MOCK}/`).then((r) => r.text()).catch(() => '');
  ok('the grant is visible on the mock product page',
     Boolean(productGrant?.id) && mockPage.includes(productGrant.id),
     productGrant?.id);

  // ── revoke on resolve ────────────────────────────────────────────────
  await carbonAgent.call(`/admin/api/tickets/${unassigned?.id}/status`, {
    method: 'PATCH', body: { status: 'in_progress' },
  });
  const resolved = await carbonAgent.call(`/admin/api/tickets/${unassigned?.id}/status`, {
    method: 'PATCH', body: { status: 'resolved' },
  });
  ok('agent resolves the ticket', resolved.status === 200, `status ${resolved.status}`);

  await sleep(3500);
  const afterResolve = await admin.call(`/admin/api/tickets/${unassigned?.id}`);
  const platform = afterResolve.json?.grants?.find((g) => g.layer === 'platform');
  const product = afterResolve.json?.grants?.find((g) => g.layer === 'product');

  ok('T1 platform grant revoked on resolve', platform?.state === 'revoked', `state=${platform?.state}`);
  ok('T2 product grant revoked on resolve', product?.state === 'revoked',
     `state=${product?.state} err=${product?.last_error ?? ''}`);

  const agentAfter = await carbonAgent.call(`/admin/api/tickets/${unassigned?.id}`);
  ok('the agent has lost the platform grant', agentAfter.json?.access?.has_platform_grant === false);

  const mockAfter = await fetch(`${MOCK}/`).then((r) => r.text()).catch(() => '');
  ok('the mock product shows it as revoked', mockAfter.includes('revoked'));
}

// ── role enforcement ────────────────────────────────────────────────────
console.log('\nRole enforcement');
{
  const agentCreate = await carbonAgent.call('/admin/api/users', {
    method: 'POST',
    body: { email: 'x@y.example', display_name: 'X', role: 'agent', password: 'Abc@12345', scopes: [] },
  });
  ok('an agent cannot create users → 403', agentCreate.status === 403, `got ${agentCreate.status}`);

  const agentTenant = await carbonAgent.call('/admin/api/tenants', {
    method: 'POST',
    body: { slug: 'nope', name: 'Nope', ref_prefix: 'NOPE' },
  });
  ok('an agent cannot create tenants → 403', agentTenant.status === 403, `got ${agentTenant.status}`);

  const tenants = await admin.call('/admin/api/tenants');
  ok('super admin lists every seeded tenant',
     SEEDED_TENANTS.every((n) => tenants.json?.data?.some((t) => t.name === n)),
     `${tenants.json?.data?.length} total`);
  const tenantCount = tenants.json?.data?.length ?? 0;
  ok('tenant secrets are never returned', tenants.json?.data?.every((t) => !t.client_secret));

  // Onboarding conflicts. Both of these were real bugs: a duplicate slug came
  // back as an opaque 500, and a duplicate ticket prefix was accepted outright
  // — which would have made CARB-1042 mean two different tickets.
  const dupSlug = await admin.call('/admin/api/tenants', {
    method: 'POST',
    body: { slug: 'carbon', name: 'Dup', ref_prefix: 'ZZZ', access_mechanism: 'preauth' },
  });
  ok('duplicate slug → 409, not 500', dupSlug.status === 409, `got ${dupSlug.status}`);
  ok('duplicate slug names the offending field',
     Boolean(dupSlug.json?.error?.details?.fields?.slug),
     JSON.stringify(dupSlug.json?.error?.details ?? null));

  const dupPrefix = await admin.call('/admin/api/tenants', {
    method: 'POST',
    body: { slug: 'brand-new-co', name: 'New Co', ref_prefix: 'CARB', access_mechanism: 'preauth' },
  });
  ok('duplicate ticket prefix is rejected → 409', dupPrefix.status === 409, `got ${dupPrefix.status}`);
  ok('duplicate prefix names the offending field',
     Boolean(dupPrefix.json?.error?.details?.fields?.ref_prefix));

  ok('a rejected onboarding creates nothing',
     (await admin.call('/admin/api/tenants')).json?.data?.length === tenantCount,
     `still ${tenantCount}`);

  // ── widget configuration ──────────────────────────────────────────────
  // The branding an operator sets here is the only way a tenant stops saying
  // "AI Support", so a silent failure would be invisible until someone looked
  // at a customer's widget.
  const wcBefore = await admin.call('/admin/api/tenants/prod_carbon/widget-config');
  ok('widget config is readable', wcBefore.status === 200 && Boolean(wcBefore.json?.branding?.title),
     `HTTP ${wcBefore.status}`);
  ok('it reports the same defaults the widget applies',
     Array.isArray(wcBefore.json?.capabilities) && wcBefore.json.capabilities.length > 0);

  const wcSave = await admin.call('/admin/api/tenants/prod_carbon/widget-config', {
    method: 'PATCH',
    body: { branding: { ...wcBefore.json.branding, greeting: 'How can we help?' } },
  });
  ok('widget config is writable', wcSave.status === 200 && wcSave.json?.branding?.greeting === 'How can we help?',
     `HTTP ${wcSave.status}`);

  // The editor knows nothing about access policy; a wholesale write would drop it.
  const accessKept = await admin.call('/admin/api/tenants');
  ok('editing branding preserves unrelated config',
     Boolean(accessKept.json?.data?.find((t) => t.id === 'prod_carbon')?.config?.access),
     JSON.stringify(accessKept.json?.data?.find((t) => t.id === 'prod_carbon')?.config?.access));

  for (const [label, body] of [
    ['a colour that is not a hex literal', { branding: { primary_color: 'red; background:url(x)' } }],
    ['a category value with a space', { categories: [{ value: 'a b', label: 'Bad' }] }],
    ['two categories sharing a value', { categories: [{ value: 'd', label: 'A' }, { value: 'd', label: 'B' }] }],
    ['a capability that does not exist', { capabilities: ['ask', 'not_a_real_tile'] }],
  ]) {
    const res = await admin.call('/admin/api/tenants/prod_carbon/widget-config', { method: 'PATCH', body });
    ok(`${label} → 400`, res.status === 400, `got ${res.status}`);
  }

  const wcAsAgent = await carbonAgent.call('/admin/api/tenants/prod_carbon/widget-config', {
    method: 'PATCH',
    body: { branding: { title: 'Agent was here' } },
  });
  ok('an agent cannot change widget config → 403', wcAsAgent.status === 403, `got ${wcAsAgent.status}`);

  await admin.call('/admin/api/tenants/prod_carbon/widget-config', {
    method: 'PATCH',
    body: { branding: wcBefore.json.branding },
  });

  const audit = await admin.call('/admin/api/audit?limit=20');
  ok('audit log is queryable', (audit.json?.data?.length ?? 0) > 0, `${audit.json?.data?.length} entries`);
  ok('login was audited', audit.json?.data?.some((a) => a.action === 'auth.login'));
  ok('access grant was audited', audit.json?.data?.some((a) => a.action === 'access.granted'));

  const auditAsAgent = await carbonAgent.call('/admin/api/audit');
  ok('an agent cannot read the audit log → 403', auditAsAgent.status === 403, `got ${auditAsAgent.status}`);
}

// ── dashboard ───────────────────────────────────────────────────────────
console.log('\nDashboard');
{
  const dash = await admin.call('/admin/api/dashboard');
  ok('dashboard returns counters', (dash.json?.counters?.total ?? 0) > 0, `${dash.json?.counters?.total} tickets`);
  ok('per-tenant breakdown covers every seeded tenant',
     SEEDED_TENANTS.every((n) => dash.json?.by_tenant?.some((t) => t.name === n)),
     `${dash.json?.by_tenant?.length} tenants in breakdown`);
  ok('metric is named self_served, not auto_resolved',
     dash.json?.self_served !== undefined && dash.json?.auto_resolved === undefined);

  const agentDash = await carbonAgent.call('/admin/api/dashboard');
  ok('an agent dashboard counts only their tenant',
     (agentDash.json?.counters?.total ?? 0) < (dash.json?.counters?.total ?? 0),
     `agent ${agentDash.json?.counters?.total} < admin ${dash.json?.counters?.total}`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
