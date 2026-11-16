import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { runMigrations } from '../src/db/migrate.js';
import { withTransaction } from '../src/db/transaction.js';
import { buildTestApp } from './helpers.js';

describe('database helpers', () => {
  const EMAIL_DOMAIN = `db-${randomUUID()}.test`;
  let app: FastifyInstance;
  const email = () => `${randomUUID()}@${EMAIL_DOMAIN}`;
  const userExists = async (address: string) =>
    (await app.db.query('SELECT 1 FROM users WHERE email = $1', [address])).rowCount === 1;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.db.query('DELETE FROM users WHERE email LIKE $1', [`%@${EMAIL_DOMAIN}`]);
    await app.close();
  });

  describe('runMigrations', () => {
    it('has recorded every migration file exactly once', async () => {
      const files = (await readdir(new URL('../migrations', import.meta.url)))
        .filter((file) => file.endsWith('.sql'))
        .sort();

      const recorded = await app.db.query<{ name: string }>(
        'SELECT name FROM schema_migrations ORDER BY name',
      );

      expect(recorded.rows.map((row) => row.name)).toEqual(files);
    });

    it('applies nothing when run again', async () => {
      expect(await runMigrations(app.db)).toEqual([]);
    });

    it('is safe to run from several API instances at once', async () => {
      const results = await Promise.all(Array.from({ length: 5 }, () => runMigrations(app.db)));

      expect(results).toEqual([[], [], [], [], []]);
    });

    it('seeded the room type and its room', async () => {
      const result = await app.db.query(
        `SELECT t.base_price_satang, r.name
         FROM room_types t JOIN rooms r ON r.room_type_id = t.id
         WHERE t.name = 'The Royal Hideaway' AND r.name = 'Royal Hideaway Villa 1'`,
      );

      expect(result.rows).toEqual([{ base_price_satang: '2000000', name: 'Royal Hideaway Villa 1' }]);
    });
  });

  describe('schema constraints', () => {
    it('rejects a booking whose check-out is not after its check-in', async () => {
      const address = email();
      await app.db.query(`INSERT INTO users (email, password_hash) VALUES ($1, 'x')`, [address]);
      const insert = (checkIn: string, checkOut: string) =>
        app.db.query(
          `INSERT INTO bookings (room_id, user_id, check_in, check_out, nightly_price_satang, total_price_satang)
           SELECT (SELECT id FROM rooms LIMIT 1), id, $2::date, $3::date, 1, 1
           FROM users WHERE email = $1`,
          [address, checkIn, checkOut],
        );

      await expect(insert('2099-01-02', '2099-01-02')).rejects.toMatchObject({
        constraint: 'bookings_valid_range',
      });
      await expect(insert('2099-01-03', '2099-01-02')).rejects.toMatchObject({
        constraint: 'bookings_valid_range',
      });
    });

    it('rejects a duplicate email, an unknown role and a non-positive price', async () => {
      const address = email();
      await app.db.query(`INSERT INTO users (email, password_hash) VALUES ($1, 'x')`, [address]);

      await expect(
        app.db.query(`INSERT INTO users (email, password_hash) VALUES ($1, 'x')`, [address]),
      ).rejects.toMatchObject({ code: '23505' });
      await expect(
        app.db.query(`INSERT INTO users (email, password_hash, role) VALUES ($1, 'x', 'root')`, [
          email(),
        ]),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        app.db.query(`INSERT INTO room_types (name, base_price_satang) VALUES ($1, 0)`, [
          `Free Type ${randomUUID()}`,
        ]),
      ).rejects.toMatchObject({ code: '23514' });
    });
  });

  describe('withTransaction', () => {
    it('commits when the work resolves and returns its result', async () => {
      const address = email();

      const result = await withTransaction(app.db, async (client) => {
        await client.query(`INSERT INTO users (email, password_hash) VALUES ($1, 'x')`, [address]);
        return 'done';
      });

      expect(result).toBe('done');
      expect(await userExists(address)).toBe(true);
    });

    it('rolls everything back when the work throws, and rethrows the error', async () => {
      const first = email();
      const second = email();
      const failure = new Error('stop');

      await expect(
        withTransaction(app.db, async (client) => {
          await client.query(`INSERT INTO users (email, password_hash) VALUES ($1, 'x')`, [first]);
          await client.query(`INSERT INTO users (email, password_hash) VALUES ($1, 'x')`, [second]);
          throw failure;
        }),
      ).rejects.toBe(failure);

      expect(await userExists(first)).toBe(false);
      expect(await userExists(second)).toBe(false);
    });

    it('rolls back when a statement fails, and leaves the connection usable', async () => {
      const address = email();

      await expect(
        withTransaction(app.db, async (client) => {
          await client.query(`INSERT INTO users (email, password_hash) VALUES ($1, 'x')`, [address]);
          await client.query('SELECT * FROM a_table_that_does_not_exist');
        }),
      ).rejects.toMatchObject({ code: '42P01' });

      expect(await userExists(address)).toBe(false);
    });

    it('returns its connection to the pool every time', async () => {
      // More transactions than the pool has connections: a leak would make this hang.
      for (let index = 0; index < 30; index += 1) {
        await withTransaction(app.db, (client) => client.query('SELECT 1')).catch(() => undefined);
        await withTransaction(app.db, async () => {
          throw new Error('fail');
        }).catch(() => undefined);
      }

      expect(app.db.waitingCount).toBe(0);
      expect(app.db.idleCount).toBe(app.db.totalCount);
    });
  });
});
