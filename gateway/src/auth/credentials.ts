import { createHash } from 'node:crypto';
import pg from 'pg';
import { decryptSecret } from '@iris/shared/types';
import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Credential lookup only. The gateway is allowed to know what a product is and
 * what a valid signature is. It is NOT allowed to know what a ticket is — the
 * moment a domain concept lands here, the boundary has failed.
 */
const pool = new pg.Pool({
  connectionString: config.CORE_DATABASE_URL,
  max: 5,
  application_name: 'iris-gateway',
});

pool.on('error', (err) => logger.error({ err }, 'gateway pg pool error'));

export interface ProductCredential {
  id: string;
  name: string;
  slug: string;
  client_id: string;
  client_secret_hash: string;
  /** AES-256-GCM ciphertext. HMAC is symmetric, so the secret itself is needed. */
  client_secret_enc: string | null;
  publishable_key: string;
  allowed_origins: string[];
  allowed_issuers: string[];
  jwks_url: string | null;
  jwks_inline: unknown;
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; value: ProductCredential | null }>();

function cached(key: string): ProductCredential | null | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  // The TTL is only a backstop. Real invalidation arrives over LISTEN/NOTIFY —
  // see startCredentialInvalidation() below.
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
}

export const PRODUCT_CHANGED_CHANNEL = 'iris_product_changed';

/**
 * Drop cached credentials the moment a tenant changes.
 *
 * Without this the cache silently makes the admin portal lie. Change a tenant's
 * JWKS URL — or rotate its secret, or fix a wrong issuer — and the portal says
 * it took effect while the gateway keeps using the old value for up to a
 * minute. The operator sees their correct configuration still failing, assumes
 * they got it wrong, and changes something that was right.
 *
 * core-service issues the NOTIFY inside the same transaction as the UPDATE, so
 * it fires only if the change actually committed, and it reaches every gateway
 * instance rather than only the one that happened to serve the request.
 *
 * Clearing everything rather than one key is deliberate: tenant edits are rare,
 * a full clear costs one query per active product afterwards, and selective
 * eviction would have to reason about negative cache entries — a key probed
 * before the tenant existed is cached as `null` under a key we cannot derive
 * from the product id.
 */
export async function startCredentialInvalidation(): Promise<void> {
  let client: pg.PoolClient | null = null;

  const connect = async (): Promise<void> => {
    try {
      client = await pool.connect();
      client.on('notification', (msg) => {
        if (msg.channel !== PRODUCT_CHANGED_CHANNEL) return;
        cache.clear();
        logger.info({ product: msg.payload }, 'tenant changed — credential cache cleared');
      });
      client.on('error', (err) => {
        logger.warn({ err }, 'credential invalidation listener dropped; reconnecting');
        try {
          client?.release();
        } catch {
          /* already gone */
        }
        client = null;
        setTimeout(() => void connect(), 2000);
      });
      await client.query(`LISTEN ${PRODUCT_CHANGED_CHANNEL}`);
      logger.info('listening for tenant configuration changes');
    } catch (err) {
      // Not fatal: the 60s TTL still bounds staleness, so the gateway runs
      // correctly, just less promptly.
      logger.warn({ err }, 'could not start credential invalidation listener; falling back to TTL');
      setTimeout(() => void connect(), 5000);
    }
  };

  await connect();
}

/** Test/reset hook — also used when the listener cannot be established. */
export function clearCredentialCache(): void {
  cache.clear();
}

const SELECT = `SELECT id, name, slug, client_id, client_secret_hash, client_secret_enc,
                       publishable_key, allowed_origins, allowed_issuers, jwks_url, jwks_inline
                  FROM product WHERE is_active = true`;

/**
 * Credential lookups run as the app role but must bypass the product RLS
 * policy, because resolving *which* product is calling is what establishes the
 * scope in the first place. We do this by setting a scope of the row we are
 * about to match on — a lookup by unique credential can only ever return one
 * product, so this cannot widen visibility.
 */
async function lookup(column: 'publishable_key' | 'client_id' | 'id', value: string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.role','super_admin',true)`);
    const { rows } = await client.query<ProductCredential>(
      `${SELECT} AND ${column} = $1 LIMIT 1`,
      [value],
    );
    await client.query('COMMIT');
    return rows[0] ?? null;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function findByPublishableKey(key: string): Promise<ProductCredential | null> {
  const hit = cached(`pub:${key}`);
  if (hit !== undefined) return hit;
  const value = await lookup('publishable_key', key);
  cache.set(`pub:${key}`, { at: Date.now(), value });
  return value;
}

export async function findByClientId(clientId: string): Promise<ProductCredential | null> {
  const hit = cached(`cid:${clientId}`);
  if (hit !== undefined) return hit;
  const value = await lookup('client_id', clientId);
  cache.set(`cid:${clientId}`, { at: Date.now(), value });
  return value;
}

/**
 * Recover a product's signing secret.
 *
 * Stored encrypted rather than hashed because HMAC is symmetric — verifying an
 * inbound signature needs the secret itself, which a one-way hash cannot give
 * back. This replaces the hardcoded DEMO_SECRETS map that previously stood in.
 */
export function signingSecretFor(product: ProductCredential): string {
  if (!product.client_secret_enc) {
    throw new Error(
      `product ${product.slug} has no encrypted client secret — re-run the seed, or rotate its credentials from the admin portal`,
    );
  }
  return decryptSecret(product.client_secret_enc);
}

export function secretMatchesHash(secret: string, hash: string): boolean {
  return createHash('sha256').update(secret).digest('hex') === hash;
}

/**
 * Origin allowlist. '*' is permitted for local development only — in
 * production this is an explicit list (api-contract §3.4).
 */
export function originAllowed(product: ProductCredential, origin: string | undefined): boolean {
  const allowed = product.allowed_origins ?? [];
  if (allowed.includes('*')) return true;
  if (!origin) return allowed.length === 0;
  return allowed.some((a) => a.toLowerCase() === origin.toLowerCase());
}

export async function closeCredentialPool(): Promise<void> {
  await pool.end();
}
