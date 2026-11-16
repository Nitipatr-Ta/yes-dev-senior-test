import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import pg from 'pg';
import { registerAuth } from './auth/plugin.js';
import { authRoutes } from './auth/routes.js';
import { bookingRoutes } from './bookings/routes.js';
import type { Config } from './config.js';
import { dashboardRoutes, type DashboardOptions } from './dashboard/routes.js';
import { registerErrorHandler } from './errors.js';
import { pricingRoutes } from './pricing/routes.js';
import { registerRateLimit, type RateLimitOptions } from './rate-limit/plugin.js';

declare module 'fastify' {
  interface FastifyInstance {
    config: Config;
    db: pg.Pool;
    redis: Redis;
    /** The current time. Replaceable in tests; pricing and date checks depend on it. */
    now: () => Date;
  }
}

export interface AppOptions {
  now?: () => Date;
  dashboard?: DashboardOptions;
  rateLimit?: RateLimitOptions;
}

export async function buildApp(
  config: Config,
  options: AppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    trustProxy: config.TRUST_PROXY,
  });

  const db = new pg.Pool({ connectionString: config.DATABASE_URL, max: 20 });
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 3 });
  // Without a listener ioredis prints every reconnect failure to stderr.
  redis.on('error', (error) => app.log.warn({ err: error }, 'redis connection error'));

  app.decorate('config', config);
  app.decorate('db', db);
  app.decorate('redis', redis);
  app.decorate('now', options.now ?? (() => new Date()));

  app.addHook('onClose', async () => {
    await Promise.allSettled([db.end(), redis.quit()]);
  });

  registerErrorHandler(app);
  // Registered before any route: it wraps routes as they are added.
  // Dashboard clients only send small control messages.
  await app.register(fastifyWebsocket, { options: { maxPayload: 8 * 1024 } });
  // Before the routes, so the per-IP limit runs first and routes can add their own limits.
  registerRateLimit(app, options.rateLimit);
  await registerAuth(app);
  await app.register(authRoutes);
  await app.register(bookingRoutes);
  await app.register(pricingRoutes);
  await app.register(dashboardRoutes, options.dashboard ?? {});

  app.get('/health', async (_request, reply) => {
    const [database, cache] = await Promise.allSettled([db.query('SELECT 1'), redis.ping()]);
    const checks = {
      database: database.status === 'fulfilled' ? 'up' : 'down',
      redis: cache.status === 'fulfilled' ? 'up' : 'down',
    };
    const healthy = checks.database === 'up' && checks.redis === 'up';
    return reply.code(healthy ? 200 : 503).send({ status: healthy ? 'ok' : 'degraded', checks });
  });

  return app;
}
