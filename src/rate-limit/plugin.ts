import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { HttpError } from '../errors.js';
import { consume } from './limiter.js';

export interface RateLimitRule {
  limit: number;
  windowMs: number;
}

const MINUTE = 60_000;

export const DEFAULT_RATE_LIMIT_RULES = {
  /** Every request except /health, per client IP. */
  global: { limit: 300, windowMs: MINUTE },
  /** POST /auth/register and POST /auth/login, per client IP. */
  auth: { limit: 20, windowMs: MINUTE },
  /** POST /auth/login, per email: slows password guessing spread over many IPs. */
  loginEmail: { limit: 10, windowMs: MINUTE },
  /** POST /bookings, per authenticated user. */
  booking: { limit: 30, windowMs: MINUTE },
  /** WebSocket upgrades of the dashboard, per client IP. */
  dashboardWs: { limit: 30, windowMs: MINUTE },
} satisfies Record<string, RateLimitRule>;

export type RateLimitRuleName = keyof typeof DEFAULT_RATE_LIMIT_RULES;

export interface RateLimitOptions {
  /** Overrides RATE_LIMIT_ENABLED. */
  enabled?: boolean;
  rules?: Partial<Record<RateLimitRuleName, RateLimitRule>>;
  /** Redis key prefix; tests use their own so runs do not share counters. */
  keyPrefix?: string;
}

type RateLimitHook = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * Builds a hook that counts the request against `rule`, keyed by what `key` returns
     * (an IP, a user id). Returning undefined skips the check for that request.
     */
    rateLimit: (
      rule: RateLimitRuleName,
      key: (request: FastifyRequest) => string | undefined,
    ) => RateLimitHook;
  }
}

/** Key by client IP. Behind a reverse proxy this is only correct with TRUST_PROXY=true. */
export const byIp = (request: FastifyRequest): string => request.ip;

/** Hashes a client-supplied value so it cannot bloat or inject into a Redis key. */
export const hashKey = (value: string): string =>
  createHash('sha256').update(value).digest('hex').slice(0, 32);

export function registerRateLimit(app: FastifyInstance, options: RateLimitOptions = {}): void {
  const enabled = options.enabled ?? app.config.RATE_LIMIT_ENABLED;
  const rules = { ...DEFAULT_RATE_LIMIT_RULES, ...options.rules };
  const keyPrefix = options.keyPrefix ?? 'rl';
  // When several rules apply to one request, the headers describe the tightest one.
  const tightest = new WeakMap<FastifyRequest, number>();

  const rateLimit: FastifyInstance['rateLimit'] = (ruleName, key) => async (request, reply) => {
    if (!enabled) return;
    const subject = key(request);
    if (subject === undefined) return;
    const rule = rules[ruleName];

    // Fail open: if Redis is unavailable, serving traffic matters more than limiting it.
    // Checking the status first avoids waiting for ioredis to give up on each request.
    if (app.redis.status !== 'ready') {
      request.log.warn({ rule: ruleName }, 'rate limit skipped: redis not ready');
      return;
    }
    let result;
    try {
      result = await consume(
        app.redis,
        `${keyPrefix}:${ruleName}:${subject}`,
        rule.limit,
        rule.windowMs,
      );
    } catch (error) {
      request.log.warn({ err: error, rule: ruleName }, 'rate limit skipped: redis error');
      return;
    }

    const resetSeconds = Math.max(Math.ceil(result.resetMs / 1000), 1);
    const previous = tightest.get(request);
    if (previous === undefined || result.remaining < previous) {
      tightest.set(request, result.remaining);
      reply.header('X-RateLimit-Limit', result.limit);
      reply.header('X-RateLimit-Remaining', result.remaining);
      reply.header('X-RateLimit-Reset', resetSeconds);
    }

    if (!result.allowed) {
      reply.header('Retry-After', resetSeconds);
      throw new HttpError(429, 'RATE_LIMITED', 'Too many requests. Please retry later.');
    }
  };

  app.decorate('rateLimit', rateLimit);

  // /health stays reachable for container health checks and monitoring.
  const globalLimit = rateLimit('global', byIp);
  app.addHook('onRequest', async (request, reply) => {
    if (request.url === '/health') return;
    await globalLimit(request, reply);
  });
}
