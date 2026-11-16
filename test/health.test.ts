import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from './helpers.js';

describe('GET /health', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('reports database and redis as up', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'ok',
      checks: { database: 'up', redis: 'up' },
    });
  });

  it('reports redis as down at once when it is unreachable, without hanging', async () => {
    const noRedis = await buildTestApp({}, { REDIS_URL: 'redis://127.0.0.1:6399' });
    try {
      const started = Date.now();
      const response = await noRedis.inject({ method: 'GET', url: '/health' });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        status: 'degraded',
        checks: { database: 'up', redis: 'down' },
      });
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      await noRedis.close();
    }
  });
});
