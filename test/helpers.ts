import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { buildApp, type AppOptions } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { runMigrations } from '../src/db/migrate.js';

export const TEST_JWT_SECRET = 'test_only_jwt_secret_0123456789_abcdefghij';

/**
 * Where the tests find PostgreSQL and Redis, so that a plain `npm test` works.
 *
 * DATABASE_URL / REDIS_URL set for the run win. Otherwise the URLs are built from the same
 * variables docker-compose.yml reads (from .env when there is one, else its defaults), so
 * they always match the containers `docker-compose up` started. The DATABASE_URL line in
 * .env is deliberately not used: it is a second copy of the password and can go stale.
 */
function connectionEnv(): { DATABASE_URL: string; REDIS_URL: string } {
  let file: NodeJS.Dict<string> = {};
  try {
    file = parseEnv(readFileSync(new URL('../.env', import.meta.url), 'utf8'));
  } catch {
    // No .env file: docker-compose used its defaults, and so do we.
  }
  // Same defaults as docker-compose.yml.
  const user = file.POSTGRES_USER ?? 'booking';
  const password = file.POSTGRES_PASSWORD ?? 'booking_local_dev';
  const database = file.POSTGRES_DB ?? 'booking';
  const postgresPort = file.POSTGRES_PORT ?? '5432';
  const redisPort = file.REDIS_PORT ?? '6379';

  return {
    DATABASE_URL:
      process.env.DATABASE_URL ??
      `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@localhost:${postgresPort}/${database}`,
    REDIS_URL: process.env.REDIS_URL ?? `redis://localhost:${redisPort}`,
  };
}

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
      ...connectionEnv(),
      LOG_LEVEL: 'silent',
      ...env,
    }),
    { rateLimit: { enabled: false }, ...options },
  );
  await runMigrations(app.db);
  return app;
}
