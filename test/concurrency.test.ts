/**
 * Concurrency tests for the booking API.
 *
 * Unlike the other test files, requests here go over real TCP connections to a listening
 * server, from many users at once, so the HTTP layer, the connection pool, the Redis lock and
 * the database constraint are all exercised together. Every test checks the same invariant in
 * the database afterwards: no two confirmed bookings of a room overlap.
 */
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { fromDayNumber, resortToday, toDayNumber } from '../src/bookings/dates.js';
import { buildTestApp } from './helpers.js';

const USERS = 25;
const ROOMS = 3;
const TEST_TIMEOUT_MS = 60_000;
/**
 * Requests in flight at once. Opening several hundred TCP connections in the same instant
 * overflows the listen backlog of a developer machine (ECONNRESET on connect), which would
 * test the operating system instead of the API. Requests beyond this number queue in the agent.
 */
const CONNECTIONS = 100;
const agent = new http.Agent({ keepAlive: true, maxSockets: CONNECTIONS });

const today = toDayNumber(resortToday()) as number;
const day = (offset: number) => fromDayNumber(today + offset);
const MORNING = new Date(today * 86_400_000 + 3 * 3_600_000);

interface Outcome {
  status: number;
  code?: string;
  bookingId?: string;
}

describe('booking under concurrent load', () => {
  const EMAIL_DOMAIN = `concurrency-${randomUUID()}.test`;
  let app: FastifyInstance;
  let baseUrl: string;
  let roomTypeId: string;
  let roomIds: string[];
  let tokens: string[];

  const listen = async (instance: FastifyInstance) => {
    await instance.listen({ host: '127.0.0.1', port: 0 });
    return `http://127.0.0.1:${(instance.server.address() as AddressInfo).port}`;
  };

  /** One HTTP request over the shared keep-alive pool. */
  const send = (
    method: string,
    url: string,
    token?: string,
    payload?: object,
  ): Promise<{ status: number; body: { booking?: { id: string }; error?: { code: string } } }> =>
    new Promise((resolve, reject) => {
      const data = payload === undefined ? undefined : JSON.stringify(payload);
      const request = http.request(
        url,
        {
          method,
          agent,
          headers: {
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => {
            try {
              resolve({
                status: response.statusCode ?? 0,
                body: JSON.parse(Buffer.concat(chunks).toString()),
              });
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      request.on('error', reject);
      request.end(data);
    });

  const book = async (
    token: string,
    roomId: string,
    checkIn: string,
    checkOut: string,
    url = baseUrl,
  ): Promise<Outcome> => {
    const { status, body } = await send('POST', `${url}/bookings`, token, {
      roomId,
      checkIn,
      checkOut,
    });
    return { status, code: body.error?.code, bookingId: body.booking?.id };
  };

  const cancel = async (token: string, bookingId: string) =>
    (await send('POST', `${baseUrl}/bookings/${bookingId}/cancel`, token)).status;

  const userToken = (index: number) => tokens[index % tokens.length] as string;
  const room = (index: number) => roomIds[index % roomIds.length] as string;

  const tally = (outcomes: Outcome[]) => {
    const counts: Record<string, number> = {};
    for (const outcome of outcomes) {
      const label = outcome.code ? `${outcome.status} ${outcome.code}` : String(outcome.status);
      counts[label] = (counts[label] ?? 0) + 1;
    }
    return counts;
  };

  /** Pairs of confirmed bookings of the same room whose date ranges overlap. Must be 0. */
  const overlappingPairs = async () => {
    const result = await app.db.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM bookings a JOIN bookings b ON a.id < b.id AND a.room_id = b.room_id
       WHERE a.room_id = ANY($1::bigint[]) AND a.status = 'confirmed' AND b.status = 'confirmed'
         AND daterange(a.check_in, a.check_out, '[)') && daterange(b.check_in, b.check_out, '[)')`,
      [roomIds],
    );
    return result.rows[0]?.count;
  };

  const confirmedIds = async () => {
    const result = await app.db.query<{ id: string }>(
      `SELECT id FROM bookings WHERE room_id = ANY($1::bigint[]) AND status = 'confirmed'`,
      [roomIds],
    );
    return result.rows.map((row) => row.id).sort();
  };

  const clearBookings = () =>
    app.db.query('DELETE FROM bookings WHERE room_id = ANY($1::bigint[])', [roomIds]);

  beforeAll(async () => {
    app = await buildTestApp({ now: () => MORNING });
    baseUrl = await listen(app);

    const type = await app.db.query(
      `INSERT INTO room_types (name, base_price_satang) VALUES ($1, 2000000) RETURNING id`,
      [`Concurrency Type ${randomUUID()}`],
    );
    roomTypeId = type.rows[0].id;
    const rooms = await app.db.query(
      `INSERT INTO rooms (room_type_id, name)
       SELECT $1::bigint, 'Concurrency Villa ' || gen_random_uuid()::text
       FROM generate_series(1, $2::int)
       RETURNING id`,
      [roomTypeId, ROOMS],
    );
    roomIds = rooms.rows.map((row) => row.id as string);

    // Inserted directly: registering through the API would hash 25 passwords for no benefit.
    const users = await app.db.query(
      `INSERT INTO users (email, password_hash)
       SELECT gen_random_uuid()::text || $1::text, 'not-a-real-hash'
       FROM generate_series(1, $2::int)
       RETURNING id`,
      [`@${EMAIL_DOMAIN}`, USERS],
    );
    tokens = users.rows.map((row) => app.jwt.sign({ sub: row.id as string, role: 'user' }));
  });

  beforeEach(async () => {
    await clearBookings();
  });

  afterAll(async () => {
    await clearBookings();
    await app.db.query('DELETE FROM rooms WHERE room_type_id = $1', [roomTypeId]);
    await app.db.query('DELETE FROM room_types WHERE id = $1', [roomTypeId]);
    await app.db.query('DELETE FROM users WHERE email LIKE $1', [`%@${EMAIL_DOMAIN}`]);
    agent.destroy();
    await app.close();
  });

  it(
    'accepts exactly one of 500 concurrent requests for the same room and dates',
    async () => {
      const outcomes = await Promise.all(
        Array.from({ length: 500 }, (_unused, index) =>
          book(userToken(index), room(0), day(10), day(13)),
        ),
      );

      const counts = tally(outcomes);
      expect(counts['201']).toBe(1);
      expect((counts['409 ROOM_BUSY'] ?? 0) + (counts['409 ROOM_UNAVAILABLE'] ?? 0)).toBe(499);
      expect(await confirmedIds()).toEqual([outcomes.find((o) => o.status === 201)?.bookingId]);
      expect(await overlappingPairs()).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'never double-books when 600 requests ask for random overlapping stays on 3 rooms',
    async () => {
      // Stays of 1-4 nights starting within a 12-day span: almost every request collides
      // with several others, on the same room and at the same moment.
      const requests = Array.from({ length: 600 }, (_unused, index) => {
        const start = 20 + Math.floor(Math.random() * 12);
        const nights = 1 + Math.floor(Math.random() * 4);
        return { token: userToken(index), roomId: room(index), start, nights };
      });

      const outcomes = await Promise.all(
        requests.map((r) => book(r.token, r.roomId, day(r.start), day(r.start + r.nights))),
      );

      const accepted = outcomes.filter((o) => o.status === 201).map((o) => o.bookingId).sort();
      // Nothing but "booked" and "conflict": no 5xx, no timeouts.
      expect(outcomes.filter((o) => o.status !== 201 && o.status !== 409)).toEqual([]);
      expect(accepted.length).toBeGreaterThanOrEqual(ROOMS);
      // What clients were told matches what is stored: no lost and no phantom bookings.
      expect(await confirmedIds()).toEqual(accepted);
      expect(await overlappingPairs()).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'books every night exactly once when clients retry after ROOM_BUSY',
    async () => {
      // 10 single nights, each wanted by 20 clients. ROOM_BUSY only means "someone else is
      // booking this room right now", so a client that retries must end with a final answer.
      const nights = Array.from({ length: 10 }, (_unused, index) => 40 + index);
      const attempt = async (token: string, night: number): Promise<Outcome> => {
        for (let tries = 0; tries < 200; tries += 1) {
          const outcome = await book(token, room(0), day(night), day(night + 1));
          if (outcome.code !== 'ROOM_BUSY') return outcome;
          await new Promise((resolve) => setTimeout(resolve, 5 + Math.random() * 20));
        }
        return { status: 0, code: 'GAVE_UP' };
      };

      const outcomes = await Promise.all(
        nights.flatMap((night) =>
          Array.from({ length: 20 }, (_unused, index) => attempt(userToken(index + night), night)),
        ),
      );

      expect(tally(outcomes)).toEqual({ '201': 10, '409 ROOM_UNAVAILABLE': 190 });
      const stored = await app.db.query<{ check_in: string; count: number }>(
        `SELECT check_in::text, count(*)::int AS count FROM bookings
         WHERE room_id = $1 AND status = 'confirmed' GROUP BY check_in ORDER BY check_in`,
        [room(0)],
      );
      expect(stored.rows).toEqual(nights.map((night) => ({ check_in: day(night), count: 1 })));
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'stays consistent while bookings and cancellations of the same dates interleave',
    async () => {
      // 30 clients each try 10 times to book the same stay and cancel it straight away, so the
      // dates are freed and taken again while other requests are in flight.
      let bookedCount = 0;
      const worker = async (index: number) => {
        for (let round = 0; round < 10; round += 1) {
          const outcome = await book(userToken(index), room(1), day(60), day(62));
          expect([201, 409]).toContain(outcome.status);
          if (outcome.bookingId) {
            bookedCount += 1;
            expect(await cancel(userToken(index), outcome.bookingId)).toBe(200);
          }
        }
      };

      await Promise.all(Array.from({ length: 30 }, (_unused, index) => worker(index)));

      const rows = await app.db.query<{ status: string; count: number }>(
        `SELECT status, count(*)::int AS count FROM bookings WHERE room_id = $1 GROUP BY status`,
        [room(1)],
      );
      // The dates were reused many times, and every booking that was made was also cancelled.
      expect(bookedCount).toBeGreaterThan(1);
      expect(rows.rows).toEqual([{ status: 'cancelled', count: bookedCount }]);
      expect(await overlappingPairs()).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'still accepts exactly one booking when Redis is unreachable',
    async () => {
      // No lock, no rate limit, no events: only the database constraint is left.
      const noRedis = await buildTestApp(
        { now: () => MORNING },
        { REDIS_URL: 'redis://127.0.0.1:6399' },
      );
      try {
        const url = await listen(noRedis);

        const started = Date.now();
        const outcomes = await Promise.all(
          Array.from({ length: 100 }, (_unused, index) =>
            book(userToken(index), room(2), day(70), day(72), url),
          ),
        );
        const elapsedMs = Date.now() - started;

        expect(tally(outcomes)).toEqual({ '201': 1, '409 ROOM_UNAVAILABLE': 99 });
        // Falling back must be immediate, not after waiting for Redis reconnect attempts.
        expect(elapsedMs).toBeLessThan(3_000);
        expect(await confirmedIds()).toHaveLength(1);
        expect(await overlappingPairs()).toBe(0);
      } finally {
        await noRedis.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'keeps serving other requests while a room is under heavy contention',
    async () => {
      const contention = Promise.all(
        Array.from({ length: 300 }, (_unused, index) =>
          book(userToken(index), room(0), day(80), day(81)),
        ),
      );
      // A separate connection, so these two do not wait behind the 300 in the agent's queue.
      const health = await fetch(`${baseUrl}/health`);
      const otherRoom = await fetch(`${baseUrl}/bookings`, {
        method: 'POST',
        headers: { authorization: `Bearer ${userToken(0)}`, 'content-type': 'application/json' },
        body: JSON.stringify({ roomId: room(1), checkIn: day(80), checkOut: day(81) }),
      });

      expect(health.status).toBe(200);
      expect(otherRoom.status).toBe(201);
      expect(tally(await contention)['201']).toBe(1);
      expect(await overlappingPairs()).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );
});
