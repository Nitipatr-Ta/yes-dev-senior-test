import Fastify, { type FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import pg from 'pg';
import { registerAuth } from './auth/plugin.js';
import { authRoutes } from './auth/routes.js';
import { bookingRoutes } from './bookings/routes.js';
import type { Config } from './config.js';
import { registerErrorHandler } from './errors.js';
import { pricingRoutes } from './pricing/routes.js';

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
}

export async function buildApp(
  config: Config,
  options: AppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
  });

  const db = new pg.Pool({ connectionString: config.DATABASE_URL, max: 20 });
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 3 });

  app.decorate('config', config);
  app.decorate('db', db);
  app.decorate('redis', redis);
  app.decorate('now', options.now ?? (() => new Date()));

  app.addHook('onClose', async () => {
    await Promise.allSettled([db.end(), redis.quit()]);
  });

  registerErrorHandler(app);
  await registerAuth(app);
  await app.register(authRoutes);
  await app.register(bookingRoutes);
  await app.register(pricingRoutes);

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
