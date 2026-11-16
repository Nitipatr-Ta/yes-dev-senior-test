import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';

// Deletes the key only if it still holds our token, so a holder whose lock already
// expired cannot release a lock that now belongs to another request.
const RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`;

export interface Lock {
  key: string;
  token: string;
}

/** Tries once to take the lock. Returns null when another holder has it. */
export async function acquireLock(redis: Redis, key: string, ttlMs: number): Promise<Lock | null> {
  const token = randomUUID();
  const result = await redis.set(key, token, 'PX', ttlMs, 'NX');
  return result === 'OK' ? { key, token } : null;
}

/** Returns false when the lock had already expired or was taken over. */
export async function releaseLock(redis: Redis, lock: Lock): Promise<boolean> {
  const released = await redis.eval(RELEASE_SCRIPT, 1, lock.key, lock.token);
  return released === 1;
}
