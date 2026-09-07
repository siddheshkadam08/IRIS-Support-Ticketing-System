import { randomBytes } from 'node:crypto';

/**
 * Prefixed ULIDs. ULIDs rather than UUIDs because they sort chronologically,
 * which makes cursor pagination and log reading dramatically easier.
 * Mirrors docs/api-contract.md §2.2.
 */
export const ID_PREFIX = {
  ticket: 'tkt',
  comment: 'cmt',
  attachment: 'att',
  grant: 'grt',
  product: 'prod',
  supportUser: 'su',
  event: 'evt',
  request: 'req',
  kbArticle: 'kb',
  conversation: 'cnv',
  automation: 'aut',
  aiExecution: 'aix',
  aiJob: 'aij',
} as const;

export type IdPrefix = (typeof ID_PREFIX)[keyof typeof ID_PREFIX];

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Crockford base32, 10 chars of time + 16 chars of randomness. */
function ulid(now = Date.now()): string {
  let time = '';
  let t = now;
  for (let i = 9; i >= 0; i--) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(16);
  let rand = '';
  for (let i = 0; i < 16; i++) rand += CROCKFORD[bytes[i]! % 32];
  return time + rand;
}

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${ulid()}`;
}

export function hasPrefix(id: string, prefix: IdPrefix): boolean {
  return typeof id === 'string' && id.startsWith(`${prefix}_`);
}

/**
 * Human-readable ticket reference, e.g. CARB-1042.
 * Per-product, never a global sequence — a global counter leaks cross-product
 * volume to any customer who can see two references.
 */
export function ticketReference(productRefPrefix: string, seq: number): string {
  return `${productRefPrefix.toUpperCase()}-${seq}`;
}
