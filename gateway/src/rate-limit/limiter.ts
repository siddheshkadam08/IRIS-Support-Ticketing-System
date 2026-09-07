import Redis from 'ioredis';
import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Token bucket, per product, per bucket class — api-contract §2.7.
 *
 * Redis-backed when reachable so limits hold across processes; in-memory
 * otherwise. Rate limiting must never be the reason the platform is down, so
 * a Redis outage degrades rather than fails.
 */
export interface BucketLimit {
  limit: number;
  windowSeconds: number;
}

export const LIMITS: Record<string, BucketLimit> = {
  // /v1/widget/ask triggers model inference, so it is materially more
  // expensive than a ticket write — and reachable with a scrapeable key.
  ask: { limit: 10, windowSeconds: 60 },
  create_ticket: { limit: 20, windowSeconds: 600 },
  read: { limit: 300, windowSeconds: 60 },
  write: { limit: 60, windowSeconds: 60 },
  /**
   * Admin sign-in, per source IP.
   *
   * Deliberately not as tight as it could be: a whole office behind one NAT
   * shares this IP, so an aggressive per-IP limit locks out innocent people
   * while barely inconveniencing an attacker who has a botnet. The real
   * defence against credential stuffing is the PER-ACCOUNT lockout — 10
   * consecutive failures freezes that account for 15 minutes regardless of
   * where the attempts come from. This bucket only blunts blind flooding.
   */
  login: { limit: 30, windowSeconds: 60 },
};

export interface RateResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetSeconds: number;
}

let redis: Redis | null = null;
let redisHealthy = false;

export function initRateLimiter(): void {
  if (!config.REDIS_URL) {
    logger.info('no REDIS_URL — using in-memory rate limiting');
    return;
  }
  redis = new Redis(config.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
    enableOfflineQueue: false,
  });
  redis.on('error', (err) => {
    if (redisHealthy) logger.warn({ err: err.message }, 'redis unavailable — falling back to memory');
    redisHealthy = false;
  });
  redis.on('ready', () => {
    redisHealthy = true;
    logger.info('redis connected — distributed rate limiting active');
  });
  redis.connect().catch((err) => {
    logger.warn({ err: err.message }, 'redis connect failed — using in-memory rate limiting');
  });
}

const memory = new Map<string, { count: number; resetAt: number }>();

function memoryConsume(key: string, l: BucketLimit): RateResult {
  const now = Date.now();
  const entry = memory.get(key);
  if (!entry || entry.resetAt <= now) {
    const resetAt = now + l.windowSeconds * 1000;
    memory.set(key, { count: 1, resetAt });
    // Opportunistic sweep so the map cannot grow without bound.
    if (memory.size > 10_000) {
      for (const [k, v] of memory) if (v.resetAt <= now) memory.delete(k);
    }
    return { allowed: true, limit: l.limit, remaining: l.limit - 1, resetSeconds: l.windowSeconds };
  }
  entry.count += 1;
  const resetSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
  return {
    allowed: entry.count <= l.limit,
    limit: l.limit,
    remaining: Math.max(0, l.limit - entry.count),
    resetSeconds,
  };
}

export async function consume(bucketKey: string, bucket: string): Promise<RateResult> {
  const l = LIMITS[bucket] ?? LIMITS.write!;
  const key = `iris:rl:${bucket}:${bucketKey}`;

  if (redis && redisHealthy) {
    try {
      const count = await redis.incr(key);
      if (count === 1) await redis.expire(key, l.windowSeconds);
      const ttl = await redis.ttl(key);
      return {
        allowed: count <= l.limit,
        limit: l.limit,
        remaining: Math.max(0, l.limit - count),
        resetSeconds: ttl > 0 ? ttl : l.windowSeconds,
      };
    } catch {
      redisHealthy = false;
    }
  }
  return memoryConsume(key, l);
}

export async function closeRateLimiter(): Promise<void> {
  if (redis) await redis.quit().catch(() => {});
}
