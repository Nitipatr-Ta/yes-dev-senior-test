import type pg from 'pg';
import type { Config } from '../config.js';
import { hashPassword } from './password.js';

/**
 * Creates the first admin from ADMIN_EMAIL / ADMIN_PASSWORD when both are set.
 * An existing account with that email is left untouched, so restarting never resets a password.
 */
export async function ensureAdmin(pool: pg.Pool, config: Config): Promise<boolean> {
  if (!config.ADMIN_EMAIL || !config.ADMIN_PASSWORD) return false;

  const existing = await pool.query('SELECT 1 FROM users WHERE email = $1', [config.ADMIN_EMAIL]);
  if (existing.rowCount) return false;

  const passwordHash = await hashPassword(config.ADMIN_PASSWORD);
  const inserted = await pool.query(
    `INSERT INTO users (email, password_hash, role) VALUES ($1, $2, 'admin')
     ON CONFLICT (email) DO NOTHING`,
    [config.ADMIN_EMAIL, passwordHash],
  );
  return inserted.rowCount === 1;
}
