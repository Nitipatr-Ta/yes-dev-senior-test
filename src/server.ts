import { buildApp } from './app.js';
import { ensureAdmin } from './auth/bootstrap.js';
import { loadConfig } from './config.js';
import { runMigrations } from './db/migrate.js';

const config = loadConfig();
const app = await buildApp(config);

const applied = await runMigrations(app.db);
app.log.info({ applied }, 'migration completed');

if (await ensureAdmin(app.db, config)) {
  app.log.info({ email: config.ADMIN_EMAIL }, 'admin user created');
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'shutting down');
    app.close().then(
      () => process.exit(0),
      (error: unknown) => {
        app.log.error(error, 'error during shutdown');
        process.exit(1);
      },
    );
  });
}

try {
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (error) {
  app.log.error(error, 'failed to start server');
  process.exit(1);
}
