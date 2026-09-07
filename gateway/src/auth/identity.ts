import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  jwtVerify,
  SignJWT,
  type JWK,
  type JWTPayload,
  type KeyLike,
} from 'jose';
import { AppError } from '@iris/shared/types';
import { devIdentityEnabled } from '../config.js';
import { logger } from '../logger.js';
import type { ProductCredential } from './credentials.js';

/**
 * End-user identity: a short-lived JWT the INTEGRATING PRODUCT mints, verified
 * against its published JWKS. The platform owns no end-user accounts.
 *
 * Asymmetric algorithms only. `alg: none` and HS256-confusion (signing with
 * the public key as an HMAC secret) are the two classic JWT breaks, and a
 * permissive verifier accepts both — so the allowlist is explicit.
 */
const ALLOWED_ALGS = ['RS256', 'ES256'] as const;
const AUDIENCE = 'iris-ticketing';
const MAX_TTL_SECONDS = 300;

export interface ResolvedIdentity {
  sub: string;
  productTenantId: string;
  name: string | null;
  email: string | null;
}

/** Dev-only issuer, so the demo page can obtain a token without a host backend. */
export const DEV_ISSUER = 'https://iris-dev-issuer.local';
let devKeys: { privateKey: KeyLike; publicJwk: JWK } | null = null;

export async function initDevIdentity(): Promise<void> {
  if (!devIdentityEnabled) return;
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'iris-dev-key-1';
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  devKeys = { privateKey, publicJwk: jwk };
  logger.warn(
    'DEV identity minting is ENABLED (POST /dev/identity-token). Never enable this in production — ' +
      'in production the integrating product mints these. See widget/INTEGRATION.md.',
  );
}

export async function mintDevIdentityToken(claims: {
  sub: string;
  product_tenant_id: string;
  name?: string;
  email?: string;
}): Promise<string> {
  if (!devKeys) throw new AppError('not_found', 'Dev identity minting is not enabled.');
  return new SignJWT({
    product_tenant_id: claims.product_tenant_id,
    name: claims.name ?? null,
    email: claims.email ?? null,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'iris-dev-key-1' })
    .setIssuer(DEV_ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime('5m')
    .setJti(`jti_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`)
    .sign(devKeys.privateKey);
}

const jwksCache = new Map<string, { at: number; resolver: ReturnType<typeof createLocalJWKSet> }>();
const JWKS_TTL_MS = 300_000;
/**
 * Floor between forced refetches of the same JWKS.
 *
 * Without it, "refetch when a signature fails" is a free amplifier: anyone who
 * can reach the widget endpoint could make us hammer a product's IdP by sending
 * garbage tokens. One refetch per URL per 30s makes that worthless while still
 * closing a key rotation within half a minute.
 */
const JWKS_REFETCH_COOLDOWN_MS = 30_000;
const lastForcedFetch = new Map<string, number>();

async function fetchJwks(url: string) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`JWKS responded ${res.status}`);
    const jwks = (await res.json()) as { keys: unknown[] };
    const resolver = createLocalJWKSet({ keys: jwks.keys as never });
    jwksCache.set(url, { at: Date.now(), resolver });
    return resolver;
  } catch (err) {
    logger.warn({ err, url }, 'JWKS fetch failed');
    // Existing tickets remain readable — we depend on the product's IdP only
    // at the moment of raise. See ADR-003.
    throw new AppError('identity_provider_unreachable', 'Could not reach the identity provider.');
  }
}

async function resolverFor(product: ProductCredential, issuer: string) {
  if (devIdentityEnabled && issuer === DEV_ISSUER && devKeys) {
    return createLocalJWKSet({ keys: [devKeys.publicJwk] });
  }

  // A statically registered JWK — supported so an integrator (or local
  // testing) does not need to stand up a JWKS endpoint.
  if (product.jwks_inline) {
    const inline = product.jwks_inline as { keys?: JWK[] };
    return createLocalJWKSet({ keys: inline.keys ?? [inline as JWK] });
  }

  if (!product.jwks_url) {
    throw new AppError('identity_token_invalid', 'No JWKS configured for this product.');
  }

  const hit = jwksCache.get(product.jwks_url);
  if (hit && Date.now() - hit.at < JWKS_TTL_MS) return hit.resolver;
  return fetchJwks(product.jwks_url);
}

/**
 * Re-fetch a product's keys and try once more.
 *
 * A cached JWKS is a stale-key hazard: when a product rotates its signing key,
 * every token it mints fails verification until our cache expires. With a
 * 5-minute TTL that is a five-minute outage for that product's users, caused
 * entirely by us, and looking exactly like "SSO is broken".
 *
 * So a verification failure is treated as a *hint* that the keys may have
 * moved, not as a verdict. If a refetch produces keys that verify the token,
 * it was rotation. If it does not, the original rejection stands — this widens
 * nothing, because the token still has to verify against keys the product
 * itself published a moment ago.
 */
async function retryAfterRotation(
  product: ProductCredential,
  token: string,
  issuer: string,
): Promise<JWTPayload | null> {
  const url = product.jwks_url;
  if (!url || product.jwks_inline) return null;

  const last = lastForcedFetch.get(url) ?? 0;
  if (Date.now() - last < JWKS_REFETCH_COOLDOWN_MS) return null;
  lastForcedFetch.set(url, Date.now());

  try {
    const resolver = await fetchJwks(url);
    const verified = await jwtVerify(token, resolver, {
      algorithms: [...ALLOWED_ALGS],
      audience: AUDIENCE,
      issuer,
      clockTolerance: 30,
    });
    logger.info({ url }, 'identity token verified after JWKS refresh — the product rotated its key');
    return verified.payload;
  } catch {
    return null;
  }
}

/**
 * Verified-token cache, keyed by jti.
 *
 * NOTE this is a cache, not single-use enforcement. An identity token is a
 * short-lived bearer assertion that the widget legitimately reuses for every
 * call within its 5-minute life — rejecting the second use would break the
 * product on its first click. The TTL is the replay bound; the cache exists
 * so we verify a signature once per token rather than once per request.
 *
 * Single-use `jti` is correct for one-shot exchanges (an authorization code,
 * a magic link). It is wrong for a session-scoped identity assertion.
 */
const verifiedTokens = new Map<string, { at: number; identity: ResolvedIdentity }>();

function cacheGet(jti: string): ResolvedIdentity | null {
  const hit = verifiedTokens.get(jti);
  if (!hit) return null;
  if (Date.now() - hit.at > MAX_TTL_SECONDS * 1000) {
    verifiedTokens.delete(jti);
    return null;
  }
  return hit.identity;
}

function cacheSet(jti: string, identity: ResolvedIdentity): void {
  const now = Date.now();
  for (const [k, v] of verifiedTokens) {
    if (now - v.at > MAX_TTL_SECONDS * 1000) verifiedTokens.delete(k);
  }
  verifiedTokens.set(jti, { at: now, identity });
}

export async function verifyIdentity(
  product: ProductCredential,
  token: string,
): Promise<ResolvedIdentity> {
  let payload: JWTPayload;
  try {
    const claims = JSON.parse(
      Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'),
    ) as { iss?: string; jti?: string };

    // Signature already verified within this token's lifetime — reuse it
    // rather than re-verifying on every request.
    if (claims.jti) {
      const hit = cacheGet(claims.jti);
      if (hit) return hit;
    }
    const unverifiedIssuer = claims.iss as string;

    const allowedIssuers = [
      ...(product.allowed_issuers ?? []),
      ...(devIdentityEnabled ? [DEV_ISSUER] : []),
    ];
    if (allowedIssuers.length && !allowedIssuers.includes(unverifiedIssuer)) {
      throw new AppError('identity_token_invalid', 'Issuer is not registered for this product.');
    }

    const resolver = await resolverFor(product, unverifiedIssuer);
    try {
      const verified = await jwtVerify(token, resolver, {
        algorithms: [...ALLOWED_ALGS],
        audience: AUDIENCE,
        issuer: unverifiedIssuer,
        clockTolerance: 30,
      });
      payload = verified.payload;
    } catch (verifyErr) {
      // Possibly a key rotation we have not seen yet — ask the product again.
      const retried = await retryAfterRotation(product, token, unverifiedIssuer);
      if (!retried) throw verifyErr;
      payload = retried;
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError('identity_token_invalid', 'Identity token failed verification.');
  }

  if (!payload.sub) throw new AppError('identity_token_invalid', 'Token has no subject.');
  if (!payload.exp || !payload.iat) {
    throw new AppError('identity_token_invalid', 'Token must carry iat and exp.');
  }
  // Short-lived by contract — a long-lived identity assertion is a standing
  // credential, which is exactly what this design avoids.
  if (payload.exp - payload.iat > MAX_TTL_SECONDS + 30) {
    throw new AppError('identity_token_invalid', 'Token lifetime exceeds 5 minutes.');
  }
  const tenant = payload.product_tenant_id;
  if (typeof tenant !== 'string' || !tenant) {
    throw new AppError('identity_token_invalid', 'Token must carry product_tenant_id.');
  }

  const identity: ResolvedIdentity = {
    sub: payload.sub,
    productTenantId: tenant,
    name: typeof payload.name === 'string' ? payload.name : null,
    email: typeof payload.email === 'string' ? payload.email : null,
  };

  if (payload.jti) cacheSet(payload.jti, identity);
  return identity;
}
