import { existsSync, readFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import { AppError, resolveFromRoot, toEnvelope } from '@iris/shared/types';
import { verifyRequest } from '@iris/shared/hmac';
import { config, devIdentityEnabled, isDev } from './config.js';
import { logger } from './logger.js';
import {
  closeCredentialPool,
  startCredentialInvalidation,
  findByClientId,
  findByPublishableKey,
  originAllowed,
  signingSecretFor,
  type ProductCredential,
} from './auth/credentials.js';
import { DEV_ISSUER, initDevIdentity, mintDevIdentityToken, verifyIdentity } from './auth/identity.js';
import { assertPublishableKeyScope, bucketFor } from './auth/scope.js';
import {
  clearedSessionCookie,
  readSessionCookie,
  sessionCookie,
  verifySession,
} from './auth/session.js';
import { closeRateLimiter, consume, initRateLimiter } from './rate-limit/limiter.js';

const b64 = (v: string | null) => (v ? Buffer.from(v, 'utf8').toString('base64url') : '');

/** Bodies arrive as raw Buffers (see removeAllContentTypeParsers below). */
function parseJsonBody(body: unknown): unknown {
  if (!body) return {};
  if (Buffer.isBuffer(body)) {
    const text = body.toString('utf8').trim();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new AppError('invalid_request', 'Body is not valid JSON.');
    }
  }
  return body;
}

/** Replay cache for HMAC nonces (Redis-backed limiter aside, this is local). */
const seenNonces = new Map<string, number>();
function rememberNonce(nonce: string): boolean {
  const now = Date.now();
  for (const [k, exp] of seenNonces) if (exp < now) seenNonces.delete(k);
  if (seenNonces.has(nonce)) return false;
  seenNonces.set(nonce, now + 600_000);
  return true;
}

interface Caller {
  product: ProductCredential;
  role: 'product' | 'raiser';
  raiserRef: string | null;
  raiserName: string | null;
  raiserEmail: string | null;
  tenantId: string | null;
  rateKey: string;
}

export async function buildGateway() {
  const app = Fastify({
    loggerInstance: logger,
    genReqId: (req) => (req.headers['x-request-id'] as string) ?? `req_${randomUUID()}`,
    trustProxy: true,
    bodyLimit: config.MAX_ATTACHMENT_BYTES + 1_048_576,

    // Must exceed the BROWSER's idle-socket timeout, not merely be "generous".
    //
    // Node's default is 72s; Chrome holds an idle keep-alive socket for ~300s.
    // That leaves a ~4-minute window where the browser reuses a socket the
    // server has already closed. The browser transparently retries a GET on a
    // dead socket, but it must NOT retry a POST — so the failure surfaces as
    // an unexplained "Failed to fetch" on exactly the requests that matter,
    // and only after the user has been idle. Filling in a form is idle.
    //
    // Symptom seen: "Could not reach the server" when submitting the new-tenant
    // form, with nothing at all in the server log — because the request was
    // never sent. Raising this above the browser's timeout removes the race.
    keepAliveTimeout: 620_000,
    // Node requires headersTimeout > keepAliveTimeout, else it reaps the socket
    // it was just told to keep.
    connectionTimeout: 0,
  });
  app.server.headersTimeout = 625_000;

  // ── raw body capture ─────────────────────────────────────────────────
  // The signature is computed over the RAW bytes. If Fastify parses JSON
  // first, re-serialising changes whitespace and key order and EVERY
  // signature fails, with no obvious cause. This is the single most common
  // integration bug on both sides.
  //
  // removeAllContentTypeParsers() is load-bearing: registering a '*' parser
  // alone does NOT displace Fastify's built-in application/json parser, so
  // JSON bodies would still arrive pre-parsed and the raw bytes would be gone.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });

  app.setErrorHandler((err, req, reply) => {
    const requestId = req.id as string;
    if (err instanceof AppError) {
      if (err.status >= 500) logger.error({ err, requestId }, err.message);
      return reply.status(err.status).send(toEnvelope(err, requestId));
    }
    logger.error({ err, requestId, url: req.url }, 'unhandled gateway error');
    return reply
      .status(500)
      .send(toEnvelope(new AppError('internal_error', 'An unexpected error occurred.'), requestId));
  });

  // A default 404 handler; replaced below with an SPA-aware one when the
  // admin bundle is present.

  await app.register(cors, {
    origin: true, // per-product allowlist is enforced in authenticate(), not here
    credentials: false,
    exposedHeaders: [
      'X-Request-Id',
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
      'X-RateLimit-Reset',
      'Retry-After',
    ],
    allowedHeaders: [
      'Content-Type',
      'X-IRIS-Key',
      'X-IRIS-Timestamp',
      'X-IRIS-Nonce',
      'X-IRIS-Signature',
      'X-IRIS-Identity',
      'X-IRIS-Publishable-Key',
      'Idempotency-Key',
      'X-Request-Id',
    ],
  });

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Request-Id', req.id as string);
    return payload;
  });

  // ── health ───────────────────────────────────────────────────────────
  app.get('/health', async () => ({
    status: 'ok',
    service: 'gateway',
    version: '1.0.0',
    uptime_s: Math.round(process.uptime()),
  }));

  // ── the widget bundle ────────────────────────────────────────────────
  // Served here rather than by nginx locally, which also makes integration a
  // single origin: one script tag pointing at the gateway.
  // Anchored to the repo root, not cwd: `npm run dev --workspace=gateway`
  // runs with cwd=gateway/, which would resolve to gateway/widget/dist and
  // leave the bundle unserved with only a warning.
  await app.register(fastifyStatic, {
    root: resolveFromRoot(config.WIDGET_DIST_PATH),
    prefix: '/',
    decorateReply: false,
    cacheControl: true,
    maxAge: isDev ? 0 : '1h',
    setHeaders: (res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('X-Content-Type-Options', 'nosniff');
    },
  });

  // ── the admin panel (SPA) ────────────────────────────────────────────
  // Served here so it is same-origin with the API, which is what allows the
  // session to live in an httpOnly cookie rather than in localStorage.
  const adminRoot = resolveFromRoot(config.ADMIN_DIST_PATH);
  if (existsSync(adminRoot)) {
    await app.register(fastifyStatic, {
      root: adminRoot,
      prefix: '/admin/',
      decorateReply: false,
      cacheControl: true,
      maxAge: isDev ? 0 : '1h',
    });

    // Client-side routes (/admin/tickets/abc) are not files — hand them the
    // shell and let the router resolve them. Never applies to /admin/api/*,
    // which is registered above and matches first.
    app.setNotFoundHandler((req, reply) => {
      const path = req.url.split('?')[0]!;
      if (req.method === 'GET' && path.startsWith('/admin') && !path.startsWith('/admin/api')) {
        return reply.type('text/html').send(readFileSync(pathJoin(adminRoot, 'index.html')));
      }
      return reply
        .status(404)
        .send(toEnvelope(new AppError('not_found', 'No such endpoint.'), req.id as string));
    });
  } else {
    logger.warn(
      { adminRoot },
      'admin panel bundle not found — run `npm run build --workspace=admin-panel`',
    );
  }

  // ── dev-only identity minting ────────────────────────────────────────
  // In production the INTEGRATING PRODUCT mints these — see widget/INTEGRATION.md.
  if (devIdentityEnabled) {
    app.post('/dev/identity-token', async (req) => {
      const body = z
        .object({
          publishable_key: z.string(),
          sub: z.string().default('usr_demo_1'),
          product_tenant_id: z.string().default('acme-corp'),
          name: z.string().default('Siddhesh'),
          email: z.string().default('siddhesh@acme.example'),
        })
        .parse(parseJsonBody(req.body));

      const product = await findByPublishableKey(body.publishable_key);
      if (!product) throw new AppError('unauthenticated', 'Unknown publishable key.');

      const token = await mintDevIdentityToken({
        sub: body.sub,
        product_tenant_id: body.product_tenant_id,
        name: body.name,
        email: body.email,
      });
      return { identity_token: token, issuer: DEV_ISSUER, expires_in: 300 };
    });
  }

  // ── authentication ───────────────────────────────────────────────────
  async function authenticate(req: FastifyRequest): Promise<Caller> {
    const h = req.headers;
    const origin = (h.origin as string | undefined) ?? undefined;
    const pubKey =
      (h['x-iris-publishable-key'] as string | undefined) ??
      (typeof req.query === 'object' && req.query
        ? (req.query as Record<string, string>).key
        : undefined);
    const clientId = h['x-iris-key'] as string | undefined;

    // ── Path A: publishable key (the widget) ──────────────────────────
    if (pubKey) {
      const product = await findByPublishableKey(pubKey);
      if (!product) throw new AppError('unauthenticated', 'Unknown publishable key.');
      if (!originAllowed(product, origin)) {
        throw new AppError('origin_not_allowed', 'This origin is not registered for the product.');
      }
      assertPublishableKeyScope(req.method, req.url);

      const identityToken = h['x-iris-identity'] as string | undefined;
      if (identityToken) {
        const id = await verifyIdentity(product, identityToken);
        return {
          product,
          role: 'raiser',
          raiserRef: id.sub,
          raiserName: id.name,
          raiserEmail: id.email,
          tenantId: id.productTenantId,
          rateKey: `${product.id}:${id.sub}`,
        };
      }

      // Anonymous raise is a per-product choice and off by default; the widget
      // config surfaces it, and core-service enforces it.
      return {
        product,
        role: 'product',
        raiserRef: null,
        raiserName: null,
        raiserEmail: null,
        tenantId: null,
        rateKey: `${product.id}:${req.ip}`,
      };
    }

    // ── Path B: server credential (HMAC) ──────────────────────────────
    if (clientId) {
      const product = await findByClientId(clientId);
      if (!product) throw new AppError('unauthenticated', 'Unknown client id.');

      const timestamp = h['x-iris-timestamp'] as string | undefined;
      const nonce = h['x-iris-nonce'] as string | undefined;
      const signature = h['x-iris-signature'] as string | undefined;
      if (!timestamp || !nonce || !signature) {
        throw new AppError('signature_invalid', 'Missing signature headers.');
      }
      if (!rememberNonce(nonce)) {
        throw new AppError('nonce_replayed', 'This nonce has already been used.');
      }

      // The secret is stored encrypted, not hashed — HMAC verification is a
      // symmetric operation and a hash cannot be reversed.
      let secret: string;
      try {
        secret = signingSecretFor(product);
      } catch (err) {
        logger.error({ err, productId: product.id }, 'cannot recover signing secret');
        throw new AppError('signature_invalid', 'No verifiable secret for this client.');
      }
      const result = verifyRequest(
        secret,
        {
          method: req.method,
          path: req.url,
          timestamp,
          nonce,
          body: (req.body as Buffer | undefined) ?? '',
        },
        signature,
      );
      if (!result.ok) {
        const code =
          result.reason === 'timestamp_out_of_window' ? 'timestamp_out_of_window' : 'signature_invalid';
        throw new AppError(code, 'Request signature verification failed.');
      }

      const identityToken = h['x-iris-identity'] as string | undefined;
      if (identityToken) {
        const id = await verifyIdentity(product, identityToken);
        return {
          product,
          role: 'raiser',
          raiserRef: id.sub,
          raiserName: id.name,
          raiserEmail: id.email,
          tenantId: id.productTenantId,
          rateKey: `${product.id}:${id.sub}`,
        };
      }
      return {
        product,
        role: 'product',
        raiserRef: null,
        raiserName: null,
        raiserEmail: null,
        tenantId: null,
        rateKey: product.id,
      };
    }

    throw new AppError('unauthenticated', 'No credential supplied.');
  }

  // ── proxy /admin/api/* to core-service ───────────────────────────────
  //
  // The API is namespaced under /admin/api so it cannot collide with the SPA's
  // client-side routes — /admin/tickets is a page, /admin/api/tickets is the
  // endpoint behind it.
  //
  // Session lives in an httpOnly cookie. That is only possible because the
  // gateway also serves the admin panel, making it same-origin — a token in
  // localStorage would be readable by any XSS on the page.
  app.all('/admin/api/*', async (req: FastifyRequest, reply: FastifyReply) => {
    const path = req.url.split('?')[0]!;
    const isLogin = path === '/admin/api/auth/login';

    const headers: Record<string, string> = {
      'x-internal-key': config.INTERNAL_API_KEY,
      'x-request-id': req.id as string,
    };
    if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'] as string;

    // Login is the one unauthenticated admin endpoint.
    if (!isLogin) {
      const claims = verifySession(readSessionCookie(req));
      headers['x-iris-support-user-id'] = claims.sub;
      headers['x-iris-role'] = claims.role;
      headers['x-iris-scope'] = claims.scopes.join(',');

      const rate = await consume(`admin:${claims.sub}`, 'write');
      if (!rate.allowed) {
        reply.header('Retry-After', rate.resetSeconds);
        throw new AppError('rate_limited', 'Too many requests.');
      }
    } else {
      // Blunts blind flooding. The per-account lockout in core-service is the
      // actual credential-stuffing defence — see LIMITS.login.
      const rate = await consume(`login:${req.ip}`, 'login');
      if (!rate.allowed) {
        reply.header('Retry-After', rate.resetSeconds);
        throw new AppError('rate_limited', 'Too many sign-in attempts. Try again shortly.');
      }
    }

    const target = new URL(req.url, config.CORE_SERVICE_URL);
    const raw = req.body as Buffer | undefined;
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body: !['GET', 'HEAD'].includes(req.method) && raw ? new Uint8Array(raw) : undefined,
      signal: AbortSignal.timeout(30_000),
    });

    const payload = Buffer.from(await upstream.arrayBuffer());

    // Turn the login response into a cookie; the token never reaches JS.
    if (isLogin && upstream.ok) {
      try {
        const parsed = JSON.parse(payload.toString('utf8')) as { token?: string };
        if (parsed.token) {
          reply.header('Set-Cookie', sessionCookie(parsed.token));
          delete parsed.token;
          return reply.status(upstream.status).type('application/json').send(parsed);
        }
      } catch {
        /* fall through and relay as-is */
      }
    }
    if (path === '/admin/api/auth/logout') {
      reply.header('Set-Cookie', clearedSessionCookie());
    }

    return reply
      .status(upstream.status)
      .type(upstream.headers.get('content-type') ?? 'application/json')
      .send(payload);
  });

  // ── proxy /v1/* to core-service ──────────────────────────────────────
  app.all('/v1/*', async (req: FastifyRequest, reply: FastifyReply) => {
    const caller = await authenticate(req);

    const bucket = bucketFor(req.method, req.url);
    const rate = await consume(caller.rateKey, bucket);
    reply
      .header('X-RateLimit-Limit', rate.limit)
      .header('X-RateLimit-Remaining', rate.remaining)
      .header('X-RateLimit-Reset', rate.resetSeconds);
    if (!rate.allowed) {
      reply.header('Retry-After', rate.resetSeconds);
      throw new AppError('rate_limited', 'Too many requests.');
    }

    const target = new URL(req.url, config.CORE_SERVICE_URL);
    const headers: Record<string, string> = {
      'x-internal-key': config.INTERNAL_API_KEY,
      'x-request-id': req.id as string,
      // Resolved context. core-service trusts these because it is never
      // publicly bound and the internal key gates direct access.
      'x-iris-product-id': caller.product.id,
      'x-iris-role': caller.role,
    };
    if (caller.raiserRef) headers['x-iris-raiser-ref'] = caller.raiserRef;
    if (caller.raiserName) headers['x-iris-raiser-name'] = b64(caller.raiserName);
    if (caller.raiserEmail) headers['x-iris-raiser-email'] = b64(caller.raiserEmail);
    if (caller.tenantId) headers['x-iris-tenant-id'] = caller.tenantId;
    if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'] as string;
    if (req.headers['idempotency-key']) {
      headers['idempotency-key'] = req.headers['idempotency-key'] as string;
    }

    const hasBody = !['GET', 'HEAD'].includes(req.method);
    const raw = req.body as Buffer | undefined;
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      // Uint8Array rather than Buffer: Buffer is not a valid BodyInit under
      // DOM types, even though undici accepts it at runtime.
      body: hasBody && raw ? new Uint8Array(raw) : undefined,
      signal: AbortSignal.timeout(30_000),
    });

    const payload = Buffer.from(await upstream.arrayBuffer());
    const contentType = upstream.headers.get('content-type') ?? 'application/json';
    const disposition = upstream.headers.get('content-disposition');
    if (disposition) reply.header('Content-Disposition', disposition);
    return reply.status(upstream.status).type(contentType).send(payload);
  });

  return app;
}

async function main(): Promise<void> {
  initRateLimiter();
  await initDevIdentity();
  // Tenant edits in the admin portal must reach us immediately, not when a
  // 60-second cache happens to expire.
  await startCredentialInvalidation();

  const app = await buildGateway();
  await app.listen({ port: config.GATEWAY_PORT, host: '0.0.0.0' });
  logger.info({ port: config.GATEWAY_PORT, env: config.NODE_ENV }, 'gateway listening (public)');

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    await app.close();
    await closeRateLimiter();
    await closeCredentialPool();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

if (process.argv[1]?.includes('server')) {
  main().catch((err) => {
    logger.error({ err }, 'failed to start gateway');
    process.exit(1);
  });
}
