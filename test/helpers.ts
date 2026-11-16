import type { FastifyInstance } from 'fastify';
import { buildApp, type AppOptions } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { runMigrations } from '../src/db/migrate.js';

export const TEST_JWT_SECRET = 'test_only_jwt_secret_0123456789_abcdefghij';

/**
 * Builds the app against the real PostgreSQL and Redis, with the schema migrated.
 * Rate limiting is off unless a test asks for it: every test request comes from the same
 * address, and several tests fire hundreds of requests on purpose.
 */
export async function buildTestApp(
  options: AppOptions = {},
  env: NodeJS.ProcessEnv = {},
): Promise<FastifyInstance> {
  const app = await buildApp(
    loadConfig({
      JWT_SECRET: TEST_JWT_SECRET,
      ...process.env,
      LOG_LEVEL: 'silent',
      ...env,
    }),
    { rateLimit: { enabled: false }, ...options },
  );
  await runMigrations(app.db);
  return app;
}
