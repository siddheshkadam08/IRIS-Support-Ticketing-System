/**
 * Mock integrating product — access-callback receiver.
 *
 *   npm run mock-product
 *
 * Stands in for a real integrating product until sample-integrations exist,
 * and doubles as the REFERENCE IMPLEMENTATION for integrators.
 *
 * It verifies our signature with `verifyWebhook` from @iris/shared/hmac — the
 * very same module core-service signs with. A divergence between the two sides
 * is therefore impossible by construction rather than by convention.
 *
 * A real Python product would use the mirrored `iris_hmac` package in
 * shared/hmac-utils/py, which is asserted against the same vectors.
 *
 *   GET  /                        live grants page
 *   POST /iris/access-callback    grant + revoke
 *   POST /fail-mode?on=true       make callbacks fail, to exercise retry → DLQ
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { verifyWebhook, type VerifyResult } from '@iris/shared/hmac';
import { BRAND_FOOTER, loadRootEnv } from '@iris/shared/types';

loadRootEnv();

const PORT = Number(process.env.MOCK_PRODUCT_PORT ?? 6001);

/**
 * The webhook secret for each tenant that points here. In a real product this
 * comes from your own configuration — it is the value the platform showed you
 * once, when the tenant was created.
 */
const SECRETS: Record<string, string> = {
  carbon: 'whsec_carbon_7Kp2mXqR8vNtJdLwEaZb',
  ifile: 'whsec_ifile_7Kp2mXqR8vNtJdLwEaZb',
};

interface GrantRecord {
  grant_id: string;
  ticket: string | null;
  actor: string | null;
  resource: string | null;
  state: 'granted' | 'revoked';
  at: string;
}

const grants = new Map<string, GrantRecord>();
let failMode = false;
let counter = 0;

/**
 * Try each configured tenant secret until one verifies.
 *
 * A real product knows which tenant it is and would hold exactly one secret;
 * this mock stands in for two, so it tries both. `verifyWebhook` does the
 * work — timestamp window, Stripe-style header parsing, and a constant-time
 * comparison — and we never reimplement any of it here.
 */
function verifySignature(
  rawBody: string,
  header: string | undefined,
): { ok: true; tenant: string } | { ok: false; reason: string } {
  let lastReason = 'no configured secret produced a matching signature';

  for (const [tenant, secret] of Object.entries(SECRETS)) {
    const result: VerifyResult = verifyWebhook(secret, rawBody, header);
    if (result.ok) return { ok: true, tenant };
    // A malformed header or stale timestamp is the same verdict for every
    // secret, so report it rather than the generic mismatch.
    if (result.reason !== 'signature_invalid') lastReason = result.reason;
  }
  return { ok: false, reason: lastReason };
}

const page = (): string => {
  const rows = [...grants.values()]
    .sort((a, b) => b.at.localeCompare(a.at))
    .map(
      (g) => `<tr>
        <td><code>${g.grant_id}</code></td>
        <td>${g.ticket ?? '—'}</td>
        <td>${g.actor ?? '—'}</td>
        <td>${g.resource ?? '—'}</td>
        <td><span class="pill ${g.state}">${g.state}</span></td>
        <td>${g.at.replace('T', ' ').slice(0, 19)}</td></tr>`,
    )
    .join('');

  return `<!doctype html><html><head><meta charset="utf-8"><title>Mock product — access grants</title>
<meta http-equiv="refresh" content="3">
<style>
 body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#f8fafc;color:#0f172a}
 main{max-width:980px;margin:0 auto;padding:40px 24px}
 h1{font-size:22px;margin:0 0 4px} .lede{color:#64748b;font-size:14px;margin:0 0 24px;line-height:1.6}
 table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden}
 th{background:#f1f5f9;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#64748b;padding:10px 12px}
 td{padding:10px 12px;border-top:1px solid #f1f5f9;font-size:13px}
 code{font-size:11.5px;background:#f1f5f9;padding:1px 5px;border-radius:4px}
 .pill{font-size:10px;font-weight:700;padding:3px 9px;border-radius:999px;text-transform:uppercase}
 .pill.granted{background:#d1fae5;color:#065f46}.pill.revoked{background:#e2e8f0;color:#475569}
 .empty{padding:36px;text-align:center;color:#94a3b8;font-size:14px}
 .banner{padding:11px 14px;border-radius:9px;margin-bottom:18px;font-size:13px}
 .fail{background:#fef2f2;color:#991b1b;border:1px solid #fecaca}
 .ok{background:#f0fdf4;color:#166534;border:1px solid #bbf7d0}
 footer{text-align:center;color:#94a3b8;font-size:12px;padding:20px}
</style></head><body><main>
<h1>Mock integrating product</h1>
<p class="lede">Receives scoped access grants from the ticketing platform and verifies every request's
HMAC signature using <code>@iris/shared/hmac</code> — the same module the platform signs with.
Auto-refreshes every 3 seconds.</p>
<div class="banner ${failMode ? 'fail' : 'ok'}">
  ${
    failMode
      ? `<b>Fail mode ON</b> — callbacks return 500, so the platform retries with backoff and eventually dead-letters. Turn off: <code>curl -X POST "http://localhost:${PORT}/fail-mode?on=false"</code>`
      : `<b>Healthy</b> — callbacks are accepted. Simulate an outage: <code>curl -X POST "http://localhost:${PORT}/fail-mode?on=true"</code>`
  }
</div>
${
  grants.size === 0
    ? '<div class="empty">No grants yet. Assign a ticket in the admin portal for a tenant whose access mechanism is <b>callback</b> (Carbon or iFile).</div>'
    : `<table><thead><tr><th>Grant</th><th>Ticket</th><th>Support user</th><th>Resource</th><th>State</th><th>When</th></tr></thead><tbody>${rows}</tbody></table>`
}
<footer>${BRAND_FOOTER}</footer>
</main></body></html>`;
};

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const send = (code: number, body: unknown, type = 'application/json') => {
    res.writeHead(code, { 'Content-Type': type });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };

  if (req.method === 'GET' && url.pathname === '/') {
    return send(200, page(), 'text/html; charset=utf-8');
  }

  if (req.method === 'POST' && url.pathname === '/fail-mode') {
    failMode = url.searchParams.get('on') === 'true';
    console.log(`  fail mode -> ${failMode ? 'ON' : 'OFF'}`);
    return send(200, { fail_mode: failMode });
  }

  if (req.method === 'POST' && url.pathname === '/iris/access-callback') {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      // The RAW body, before any JSON parsing. Re-serialising would change
      // whitespace and key order and every signature would fail.
      const rawBody = Buffer.concat(chunks).toString('utf8');
      const verdict = verifySignature(rawBody, req.headers['x-iris-signature'] as string | undefined);

      if (!verdict.ok) {
        console.log(`  ✗ REJECTED — ${verdict.reason}`);
        return send(401, { error: 'signature verification failed', reason: verdict.reason });
      }

      if (failMode) {
        console.log('  ✗ fail mode — returning 500');
        return send(500, { error: 'simulated outage' });
      }

      let event: {
        event?: string;
        grant_id?: string;
        data?: { ticket_id?: string; support_user_id?: string; resource_ref?: string };
      };
      try {
        event = JSON.parse(rawBody);
      } catch {
        return send(400, { error: 'invalid JSON' });
      }

      const grantId = event.grant_id ?? 'unknown';
      const data = event.data ?? {};

      if (event.event === 'access.grant_requested') {
        const ref = `${verdict.tenant}-grant-${++counter}`;
        grants.set(grantId, {
          grant_id: grantId,
          ticket: data.ticket_id ?? null,
          actor: data.support_user_id ?? null,
          resource: data.resource_ref ?? data.ticket_id ?? null,
          state: 'granted',
          at: new Date().toISOString(),
        });
        console.log(`  ✓ GRANT   ${grantId} → ${ref}  (signature verified, tenant=${verdict.tenant})`);
        // The product chooses its own handle for the grant and returns it;
        // the platform stores it and quotes it back on revoke.
        return send(200, { status: 'granted', product_grant_ref: ref });
      }

      if (event.event === 'access.revoke_requested') {
        const existing = grants.get(grantId);
        if (existing) {
          existing.state = 'revoked';
          existing.at = new Date().toISOString();
        }
        console.log(`  ✓ REVOKE  ${grantId}  (signature verified)`);
        return send(200, { status: 'revoked' });
      }

      return send(202, { status: 'ignored', event: event.event });
    });
    return;
  }

  send(404, { error: 'not found' });
});

server.listen(PORT, () => {
  console.log(`\nMock integrating product listening on http://localhost:${PORT}`);
  console.log('  callback endpoint : POST /iris/access-callback');
  console.log(`  grants page       : http://localhost:${PORT}`);
  console.log(`  tenants configured: ${Object.keys(SECRETS).join(', ')}`);
  console.log('  signature check   : verifyWebhook() from @iris/shared/hmac\n');
});
