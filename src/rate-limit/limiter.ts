import type { Redis } from 'ioredis';

// Fixed window. INCR and PEXPIRE run in one script so two concurrent first requests cannot
// both skip setting the expiry, and no key is ever left without a TTL.
const CONSUME_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { count, ttl }
`;

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Milliseconds until the window ends and the count starts again. */
  resetMs: number;
}

/**
 * Counts one request against `key`. The window starts at the first request and lasts
 * `windowMs`; up to `limit` requests are allowed in it.
 */
export async function consume(
  redis: Redis,
  key: string,
  limit: number,
  windowMs: number,
): Promise<RateLimitResult> {
  const [count, ttl] = (await redis.eval(CONSUME_SCRIPT, 1, key, windowMs)) as [number, number];
  return {
    allowed: count <= limit,
    limit,
    remaining: Math.max(limit - count, 0),
    resetMs: ttl,
  };
}
