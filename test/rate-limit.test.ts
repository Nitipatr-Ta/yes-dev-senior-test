import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { consume } from '../src/rate-limit/limiter.js';
import { buildTestApp } from './helpers.js';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const HOUR = 3_600_000;

// Each test uses its own client address, so tests do not share per-IP counters.
let lastIp = 0;
const nextIp = () => {
  lastIp += 1;
  return `10.1.${Math.floor(lastIp / 250)}.${(lastIp % 250) + 1}`;
};

/** Removes the counters a test app created. */
const clearKeys = async (app: FastifyInstance, prefix: string) => {
  const keys = await app.redis.keys(`${prefix}:*`);
  if (keys.length > 0) await app.redis.del(...keys);
};

describe('rate limiter', () => {
  let app: FastifyInstance;
  const prefix = `rl-test-${randomUUID()}`;
  const key = () => `${prefix}:${randomUUID()}`;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await clearKeys(app, prefix);
    await app.close();
  });

  it('allows up to the limit, then blocks, and reports what is left', async () => {
    const k = key();
    const results = [];
    for (let index = 0; index < 5; index += 1) results.push(await consume(app.redis, k, 3, HOUR));

    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false, false]);
    expect(results.map((r) => r.remaining)).toEqual([2, 1, 0, 0, 0]);
    expect(results[0]?.limit).toBe(3);
    expect(results[4]?.resetMs).toBeGreaterThan(HOUR - 5_000);
    expect(results[4]?.resetMs).toBeLessThanOrEqual(HOUR);
  });

  it('counts each key separately', async () => {
    const first = key();
    await consume(app.redis, first, 1, HOUR);

    expect((await consume(app.redis, first, 1, HOUR)).allowed).toBe(false);
    expect((await consume(app.redis, key(), 1, HOUR)).allowed).toBe(true);
  });

  it('starts counting again when the window ends', async () => {
    const k = key();
    await consume(app.redis, k, 1, 150);
    expect((await consume(app.redis, k, 1, 150)).allowed).toBe(false);

    await pause(200);

    expect((await consume(app.redis, k, 1, 150)).allowed).toBe(true);
  });

  it('does not extend the window when blocked requests keep coming', async () => {
    const k = key();
    await consume(app.redis, k, 1, 300);
    await pause(150);
    const blocked = await consume(app.redis, k, 1, 300);

    expect(blocked.allowed).toBe(false);
    expect(blocked.resetMs).toBeLessThanOrEqual(150);
  });

  it('allows exactly the limit when requests arrive simultaneously', async () => {
    const k = key();
    const results = await Promise.all(
      Array.from({ length: 100 }, () => consume(app.redis, k, 10, HOUR)),
    );

    expect(results.filter((r) => r.allowed)).toHaveLength(10);
    expect(await app.redis.pttl(k)).toBeGreaterThan(0);
  });
});

describe('rate limiting on the API', () => {
  let app: FastifyInstance;
  const prefix = `rl-test-${randomUUID()}`;
  const password = 'correct horse battery';
  const email = () => `${randomUUID()}@rate-limit.test`;

  const login = (ip: string, body: object) =>
    app.inject({ method: 'POST', url: '/auth/login', remoteAddress: ip, payload: body });

  beforeAll(async () => {
    app = await buildTestApp({
      rateLimit: {
        enabled: true,
        keyPrefix: prefix,
        rules: {
          global: { limit: 1_000, windowMs: HOUR },
          auth: { limit: 5, windowMs: HOUR },
          loginEmail: { limit: 2, windowMs: HOUR },
          booking: { limit: 2, windowMs: HOUR },
          dashboardWs: { limit: 1, windowMs: HOUR },
        },
      },
    });
  });

  afterAll(async () => {
    await clearKeys(app, prefix);
    await app.close();
  });

  it('answers 429 with Retry-After once an IP exceeds the auth limit', async () => {
    const ip = nextIp();
    const statuses = [];
    for (let index = 0; index < 5; index += 1) {
      statuses.push((await login(ip, { email: email(), password })).statusCode);
    }
    const blocked = await login(ip, { email: email(), password });

    expect(statuses).toEqual([401, 401, 401, 401, 401]);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toEqual({
      error: { code: 'RATE_LIMITED', message: expect.any(String) },
    });
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(blocked.headers['retry-after'])).toBeLessThanOrEqual(3_600);
    expect(blocked.headers['x-ratelimit-limit']).toBe('5');
    expect(blocked.headers['x-ratelimit-remaining']).toBe('0');
  });

  it('reports the remaining allowance on requests that are let through', async () => {
    const ip = nextIp();
    // Register has only the per-IP auth rule. The body is invalid so no user is created.
    const register = () =>
      app.inject({ method: 'POST', url: '/auth/register', remoteAddress: ip, payload: {} });

    const first = await register();
    const second = await register();

    expect(first.statusCode).toBe(400);
    expect(first.headers['x-ratelimit-limit']).toBe('5');
    expect(first.headers['x-ratelimit-remaining']).toBe('4');
    expect(second.headers['x-ratelimit-remaining']).toBe('3');
    expect(first.headers['retry-after']).toBeUndefined();
  });

  it('reports the tightest rule when several apply to one request', async () => {
    // Login is under the per-IP rule (5) and the per-email rule (2).
    const response = await login(nextIp(), { email: email(), password });

    expect(response.headers['x-ratelimit-limit']).toBe('2');
    expect(response.headers['x-ratelimit-remaining']).toBe('1');
  });

  it('shares the auth limit between register and login, and keeps IPs apart', async () => {
    const ip = nextIp();
    for (let index = 0; index < 5; index += 1) await login(ip, { email: email(), password });

    const register = await app.inject({
      method: 'POST',
      url: '/auth/register',
      remoteAddress: ip,
      payload: { email: 'not-an-email', password },
    });
    const otherIp = await login(nextIp(), { email: email(), password });

    expect(register.statusCode).toBe(429);
    expect(otherIp.statusCode).toBe(401);
  });

  it('limits attempts on one email even when they come from different IPs', async () => {
    const target = email();

    const first = await login(nextIp(), { email: target, password });
    const second = await login(nextIp(), { email: target.toUpperCase(), password });
    const third = await login(nextIp(), { email: target, password });
    const otherEmail = await login(nextIp(), { email: email(), password });

    expect([first.statusCode, second.statusCode]).toEqual([401, 401]);
    expect(third.statusCode).toBe(429);
    expect(third.headers['x-ratelimit-limit']).toBe('2');
    expect(otherEmail.statusCode).toBe(401);
  });

  it('still validates a login body that has no usable email', async () => {
    const response = await login(nextIp(), { email: 'not-an-email', password });

    expect(response.statusCode).toBe(400);
  });

  it('limits bookings per user, not per IP', async () => {
    const ip = nextIp();
    const book = (userId: string) =>
      app.inject({
        method: 'POST',
        url: '/bookings',
        remoteAddress: ip,
        headers: { authorization: `Bearer ${app.jwt.sign({ sub: userId, role: 'user' })}` },
        // Invalid on purpose: the limit is checked before the body, so no room is needed.
        payload: {},
      });

    const statuses = [];
    for (let index = 0; index < 3; index += 1) statuses.push((await book('900001')).statusCode);
    const otherUser = await book('900002');

    expect(statuses).toEqual([400, 400, 429]);
    expect(otherUser.statusCode).toBe(400);
  });

  it('does not count unauthenticated booking requests against anyone', async () => {
    const ip = nextIp();
    const anonymous = () =>
      app.inject({ method: 'POST', url: '/bookings', remoteAddress: ip, payload: {} });

    const statuses = [];
    for (let index = 0; index < 4; index += 1) statuses.push((await anonymous()).statusCode);

    expect(statuses).toEqual([401, 401, 401, 401]);
  });

  it('limits dashboard WebSocket upgrades per IP', async () => {
    const ip = nextIp();
    const socket = { remoteAddress: ip };
    const admin = { authorization: `Bearer ${app.jwt.sign({ sub: '1', role: 'admin' })}` };
    // The upgrade request is routed like any other, so the limit answers before the handshake.
    const connect = () =>
      app.injectWS('/admin/dashboard/ws', { headers: admin, socket } as never);

    const first = await connect();
    await expect(connect()).rejects.toThrow('429');
    first.terminate();
  });
});

describe('global rate limit', () => {
  let app: FastifyInstance;
  const prefix = `rl-test-${randomUUID()}`;

  beforeAll(async () => {
    app = await buildTestApp({
      rateLimit: {
        enabled: true,
        keyPrefix: prefix,
        rules: { global: { limit: 3, windowMs: HOUR } },
      },
    });
  });

  afterAll(async () => {
    await clearKeys(app, prefix);
    await app.close();
  });

  it('applies to every route, including unknown ones, per IP', async () => {
    const ip = nextIp();
    const get = (url: string, remoteAddress = ip) => app.inject({ method: 'GET', url, remoteAddress });

    const statuses = [
      (await get('/rooms')).statusCode,
      (await get('/nope')).statusCode,
      (await get('/auth/me')).statusCode,
      (await get('/rooms')).statusCode,
    ];

    expect(statuses).toEqual([200, 404, 401, 429]);
    expect((await get('/rooms', nextIp())).statusCode).toBe(200);
  });

  it('never limits /health', async () => {
    const ip = nextIp();
    const statuses = [];
    for (let index = 0; index < 6; index += 1) {
      statuses.push((await app.inject({ method: 'GET', url: '/health', remoteAddress: ip })).statusCode);
    }

    expect(statuses).toEqual([200, 200, 200, 200, 200, 200]);
  });

  it('ignores X-Forwarded-For unless TRUST_PROXY is on', async () => {
    const ip = nextIp();
    const get = (forwardedFor: string) =>
      app.inject({
        method: 'GET',
        url: '/rooms',
        remoteAddress: ip,
        headers: { 'x-forwarded-for': forwardedFor },
      });

    const statuses = [];
    for (let index = 0; index < 4; index += 1) statuses.push((await get(`203.0.113.${index}`)).statusCode);

    // A forged header must not hand the client a fresh allowance.
    expect(statuses).toEqual([200, 200, 200, 429]);
  });
});

describe('rate limiting switches', () => {
  it('is off when disabled', async () => {
    const app = await buildTestApp({
      rateLimit: { enabled: false, rules: { global: { limit: 1, windowMs: HOUR } } },
    });
    try {
      const ip = nextIp();
      const first = await app.inject({ method: 'GET', url: '/rooms', remoteAddress: ip });
      const second = await app.inject({ method: 'GET', url: '/rooms', remoteAddress: ip });

      expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
      expect(first.headers['x-ratelimit-limit']).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('uses the client address from X-Forwarded-For when TRUST_PROXY is on', async () => {
    const prefix = `rl-test-${randomUUID()}`;
    const app = await buildTestApp(
      { rateLimit: { enabled: true, keyPrefix: prefix, rules: { global: { limit: 1, windowMs: HOUR } } } },
      { TRUST_PROXY: 'true' },
    );
    try {
      const proxy = nextIp();
      const get = (client: string) =>
        app.inject({
          method: 'GET',
          url: '/rooms',
          remoteAddress: proxy,
          headers: { 'x-forwarded-for': client },
        });

      expect((await get('198.51.100.1')).statusCode).toBe(200);
      expect((await get('198.51.100.1')).statusCode).toBe(429);
      expect((await get('198.51.100.2')).statusCode).toBe(200);
    } finally {
      await clearKeys(app, prefix);
      await app.close();
    }
  });

  it('lets requests through when Redis is unreachable', async () => {
    const app = await buildTestApp(
      { rateLimit: { enabled: true, rules: { global: { limit: 1, windowMs: HOUR } } } },
      { REDIS_URL: 'redis://127.0.0.1:6399' },
    );
    try {
      const ip = nextIp();
      const started = Date.now();
      const statuses = [];
      for (let index = 0; index < 3; index += 1) {
        statuses.push((await app.inject({ method: 'GET', url: '/rooms', remoteAddress: ip })).statusCode);
      }

      expect(statuses).toEqual([200, 200, 200]);
      // Failing open must not make each request wait for Redis retries.
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      await app.close();
    }
  });
});
