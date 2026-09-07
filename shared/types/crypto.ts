import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Symmetric secret storage and password hashing.
 *
 * Both use only node:crypto — no native module to fail building on Windows,
 * and nothing to keep patched.
 */

// ─────────────────────────────────────────────────────────────────────────
// Secrets at rest — AES-256-GCM
//
// HMAC is a SYMMETRIC operation: to verify an inbound signature or sign an
// outbound callback we need the secret itself. A hash cannot be reversed, so
// hashing was the wrong primitive for these. Secrets are encrypted; the
// separate hash column stays for cheap equality checks.
// ─────────────────────────────────────────────────────────────────────────

const ENC_PREFIX = 'v1';

function encryptionKey(): Buffer {
  const raw = process.env.SECRET_ENCRYPTION_KEY;
  if (!raw || raw.length < 16) {
    throw new Error(
      'SECRET_ENCRYPTION_KEY is missing or too short. Set it in .env — see .env.example.',
    );
  }
  // Derive a fixed 32 bytes so the env var can be any reasonable passphrase.
  return createHash('sha256').update(raw, 'utf8').digest();
}

/** Returns `v1.<iv>.<authTag>.<ciphertext>`, all base64url. */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [ENC_PREFIX, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join(
    '.',
  );
}

export function decryptSecret(encoded: string): string {
  const [version, ivB64, tagB64, ctB64] = encoded.split('.');
  if (version !== ENC_PREFIX || !ivB64 || !tagB64 || !ctB64) {
    throw new Error('Malformed encrypted secret.');
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    encryptionKey(),
    Buffer.from(ivB64, 'base64url'),
  );
  // GCM authenticates as well as encrypts — a tampered ciphertext throws here
  // rather than silently decrypting to garbage.
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * Digest for equality checks on credentials.
 * Named distinctly from hmac-utils' sha256Hex so the shared barrel has no
 * duplicate export.
 */
export const hashSecret = (v: string): string => createHash('sha256').update(v).digest('hex');

/** Constant-time compare of a presented secret against its stored digest. */
export function secretMatches(presented: string, storedHash: string | null): boolean {
  if (!storedHash) return false;
  const a = Buffer.from(hashSecret(presented), 'utf8');
  const b = Buffer.from(storedHash, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

// ─────────────────────────────────────────────────────────────────────────
// Passwords — scrypt
//
// Memory-hard, in the standard library, and recommended by OWASP. Format:
//   scrypt$N$r$p$<salt base64url>$<hash base64url>
// The parameters travel with the hash, so they can be raised later without
// invalidating existing passwords.
// ─────────────────────────────────────────────────────────────────────────

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 } as const;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: 256 * 1024 * 1024,
  });
  return [
    'scrypt',
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString('base64url'),
    hash.toString('base64url'),
  ].join('$');
}

export function verifyPassword(password: string, stored: string | null): boolean {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64!, 'base64url');
  const expected = Buffer.from(hashB64!, 'base64url');

  let actual: Buffer;
  try {
    actual = scryptSync(password, salt, expected.length, {
      N: Number(nStr),
      r: Number(rStr),
      p: Number(pStr),
      maxmem: 256 * 1024 * 1024,
    });
  } catch {
    return false;
  }
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/** Opaque session/API tokens. */
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');
