import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { runMigrations } from '../src/db/migrate.js';

export const TEST_JWT_SECRET = 'test_only_jwt_secret_0123456789_abcdefghij';

/** Builds the app against the real PostgreSQL and Redis, with the schema migrated. */
export async function buildTestApp(env: NodeJS.ProcessEnv = {}): Promise<FastifyInstance> {
  const app = await buildApp(
    loadConfig({
      JWT_SECRET: TEST_JWT_SECRET,
      ...process.env,
      LOG_LEVEL: 'silent',
      ...env,
    }),
  );
  await runMigrations(app.db);
  return app;
}
