import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { fromDayNumber, resortToday, toDayNumber } from '../src/bookings/dates.js';
import { roomLockKey } from '../src/bookings/routes.js';
import { MAX_ADVANCE_DAYS, MAX_NIGHTS } from '../src/bookings/schemas.js';
import { acquireLock, releaseLock } from '../src/redis/lock.js';
import { buildTestApp } from './helpers.js';

const EMAIL_DOMAIN = `bookings-${randomUUID()}.test`;
const BASE_PRICE_SATANG = 2_000_000;
const today = toDayNumber(resortToday()) as number;
/** Calendar date `offset` days from today at the resort. */
const day = (offset: number) => fromDayNumber(today + offset);
// 10:00 at the resort (03:00 UTC): outside peak hour, so prices here stay at the base price.
const MORNING = new Date(today * 86_400_000 + 3 * 3_600_000);

describe('calendar dates', () => {
  it('accepts real dates and rejects impossible ones', () => {
    expect(toDayNumber('2028-02-29')).not.toBeNull();
    expect(toDayNumber('2027-02-29')).toBeNull();
    expect(toDayNumber('2027-13-01')).toBeNull();
    expect(toDayNumber('2027-1-1')).toBeNull();
    expect(toDayNumber('2027-01-01T00:00:00Z')).toBeNull();
  });

  it('uses the Asia/Bangkok calendar day', () => {
    expect(resortToday(new Date('2027-01-01T16:59:59Z'))).toBe('2027-01-01');
    expect(resortToday(new Date('2027-01-01T17:00:00Z'))).toBe('2027-01-02');
  });
});

describe('booking API', () => {
  let app: FastifyInstance;
  let roomTypeId: string;
  let roomTypeName: string;
  let roomId: string;
  let alice: { id: string; headers: { authorization: string } };
  let bob: { id: string; headers: { authorization: string } };

  const createUser = async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: `${randomUUID()}@${EMAIL_DOMAIN}`, password: 'correct horse battery' },
    });
    const body = response.json();
    return { id: body.user.id as string, headers: { authorization: `Bearer ${body.accessToken}` } };
  };

  const book = (user: typeof alice, checkIn: string, checkOut: string, room = roomId) =>
    app.inject({
      method: 'POST',
      url: '/bookings',
      headers: user.headers,
      payload: { roomId: room, checkIn, checkOut },
    });

  const confirmedCount = async () => {
    const result = await app.db.query(
      `SELECT count(*)::int AS count FROM bookings WHERE room_id = $1 AND status = 'confirmed'`,
      [roomId],
    );
    return result.rows[0].count as number;
  };

  beforeAll(async () => {
    app = await buildTestApp({ now: () => MORNING });
    // A room type of its own keeps this file independent of the seeded villa and other test
    // files. It has two rooms and only the first is booked, so the last-room rule never applies.
    roomTypeName = `Test Type ${randomUUID()}`;
    const type = await app.db.query(
      `INSERT INTO room_types (name, base_price_satang) VALUES ($1, $2) RETURNING id`,
      [roomTypeName, BASE_PRICE_SATANG],
    );
    roomTypeId = type.rows[0].id;
    const rooms = await app.db.query(
      `INSERT INTO rooms (room_type_id, name) VALUES ($1, $2), ($1, $3) RETURNING id`,
      [roomTypeId, `Test Villa ${randomUUID()}`, `Test Villa ${randomUUID()}`],
    );
    roomId = rooms.rows[0].id;
    [alice, bob] = await Promise.all([createUser(), createUser()]);
  });

  beforeEach(async () => {
    await app.db.query('DELETE FROM bookings WHERE room_id = $1', [roomId]);
    await app.redis.del(roomLockKey(roomId));
  });

  afterAll(async () => {
    await app.db.query('DELETE FROM bookings WHERE room_id = $1', [roomId]);
    await app.db.query('DELETE FROM rooms WHERE room_type_id = $1', [roomTypeId]);
    await app.db.query('DELETE FROM room_types WHERE id = $1', [roomTypeId]);
    await app.db.query('DELETE FROM users WHERE email LIKE $1', [`%@${EMAIL_DOMAIN}`]);
    await app.close();
  });

  it('requires authentication', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/bookings',
      payload: { roomId, checkIn: day(10), checkOut: day(12) },
    });

    expect(response.statusCode).toBe(401);
  });

  it('creates a confirmed booking priced per night', async () => {
    const response = await book(alice, day(10), day(13));

    expect(response.statusCode).toBe(201);
    expect(response.json().booking).toEqual({
      id: expect.any(String),
      roomId,
      userId: alice.id,
      checkIn: day(10),
      checkOut: day(13),
      status: 'confirmed',
      nightlyPriceSatang: BASE_PRICE_SATANG,
      totalPriceSatang: BASE_PRICE_SATANG * 3,
      priceRules: [],
      createdAt: expect.any(String),
    });
  });

  it('accepts a numeric roomId', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/bookings',
      headers: alice.headers,
      payload: { roomId: Number(roomId), checkIn: day(10), checkOut: day(11) },
    });

    expect(response.statusCode).toBe(201);
  });

  it.each([
    ['missing body', undefined],
    ['wrong date format', { checkIn: '10/01/2027', checkOut: day(12) }],
    ['impossible date', { checkIn: '2027-02-30', checkOut: '2027-03-02' }],
    ['checkOut equal to checkIn', { checkIn: day(10), checkOut: day(10) }],
    ['checkOut before checkIn', { checkIn: day(12), checkOut: day(10) }],
    ['checkIn in the past', { checkIn: day(-1), checkOut: day(2) }],
    ['stay longer than the limit', { checkIn: day(10), checkOut: day(10 + MAX_NIGHTS + 1) }],
    ['checkIn too far ahead', { checkIn: day(MAX_ADVANCE_DAYS + 1), checkOut: day(MAX_ADVANCE_DAYS + 2) }],
    ['invalid roomId', { roomId: '1; DROP TABLE bookings', checkIn: day(10), checkOut: day(12) }],
    ['unknown field', { checkIn: day(10), checkOut: day(12), totalPriceSatang: 1 }],
  ])('rejects %s with 400', async (_name, payload) => {
    const response = await app.inject({
      method: 'POST',
      url: '/bookings',
      headers: alice.headers,
      payload: payload && { roomId, ...payload },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
    expect(await confirmedCount()).toBe(0);
  });

  it('accepts a stay starting today and one of exactly the maximum length', async () => {
    expect((await book(alice, day(0), day(1))).statusCode).toBe(201);
    expect((await book(alice, day(40), day(40 + MAX_NIGHTS))).statusCode).toBe(201);
  });

  it('returns 404 for an unknown room', async () => {
    const response = await book(alice, day(10), day(12), '999999999999');

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('ROOM_NOT_FOUND');
  });

  it.each([
    ['identical range', 10, 13],
    ['overlap at the start', 8, 11],
    ['overlap at the end', 12, 15],
    ['range inside', 11, 12],
    ['range around', 9, 14],
  ])('rejects an overlapping booking: %s', async (_name, from, to) => {
    expect((await book(alice, day(10), day(13))).statusCode).toBe(201);

    const response = await book(bob, day(from), day(to));

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('ROOM_UNAVAILABLE');
    expect(await confirmedCount()).toBe(1);
  });

  it('allows back-to-back stays: check-out day equals the next check-in day', async () => {
    expect((await book(alice, day(10), day(13))).statusCode).toBe(201);
    expect((await book(bob, day(13), day(15))).statusCode).toBe(201);
    expect((await book(bob, day(8), day(10))).statusCode).toBe(201);
  });

  it('lets exactly one of many simultaneous requests for the same dates succeed', async () => {
    const users = [alice, bob];
    const responses = await Promise.all(
      Array.from({ length: 100 }, (_unused, index) =>
        book(users[index % 2] as typeof alice, day(20), day(23)),
      ),
    );

    const statuses = responses.map((response) => response.statusCode);
    expect(statuses.filter((status) => status === 201)).toHaveLength(1);
    expect(statuses.filter((status) => status === 409)).toHaveLength(99);
    for (const response of responses.filter((r) => r.statusCode === 409)) {
      expect(['ROOM_BUSY', 'ROOM_UNAVAILABLE']).toContain(response.json().error.code);
    }
    expect(await confirmedCount()).toBe(1);
    expect(await app.redis.exists(roomLockKey(roomId))).toBe(0);
  });

  it('never double-books when simultaneous requests overlap only partly', async () => {
    const responses = await Promise.all(
      Array.from({ length: 60 }, (_unused, index) =>
        book(alice, day(30 + (index % 6)), day(33 + (index % 6))),
      ),
    );
    expect(responses.every((r) => r.statusCode === 201 || r.statusCode === 409)).toBe(true);

    const overlaps = await app.db.query(
      `SELECT count(*)::int AS count
       FROM bookings a JOIN bookings b ON a.id < b.id AND a.room_id = b.room_id
       WHERE a.room_id = $1 AND a.status = 'confirmed' AND b.status = 'confirmed'
         AND daterange(a.check_in, a.check_out, '[)') && daterange(b.check_in, b.check_out, '[)')`,
      [roomId],
    );
    expect(overlaps.rows[0].count).toBe(0);
    expect(await confirmedCount()).toBeGreaterThanOrEqual(1);
  });

  it('is protected by the database constraint alone, without the Redis lock', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 30 }, () =>
        app.db.query(
          `INSERT INTO bookings
             (room_id, user_id, check_in, check_out, nightly_price_satang, total_price_satang)
           VALUES ($1, $2, $3::date, $4::date, 1, 1)`,
          [roomId, alice.id, day(50), day(52)],
        ),
      ),
    );

    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(rejected).toHaveLength(29);
    expect(rejected.every((r) => r.reason.code === '23P01')).toBe(true);
  });

  it('turns a request away with ROOM_BUSY while the room lock is held', async () => {
    const lock = await acquireLock(app.redis, roomLockKey(roomId), 10_000);
    expect(lock).not.toBeNull();

    const busy = await book(alice, day(10), day(12));
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error.code).toBe('ROOM_BUSY');
    expect(busy.headers['retry-after']).toBe('1');
    expect(await confirmedCount()).toBe(0);

    await releaseLock(app.redis, lock!);
    expect((await book(alice, day(10), day(12))).statusCode).toBe(201);
  });

  it('releases the room lock after a rejected booking too', async () => {
    await book(alice, day(10), day(12));
    await book(bob, day(10), day(12));

    expect(await app.redis.exists(roomLockKey(roomId))).toBe(0);
  });

  it('does not release a lock that belongs to another holder', async () => {
    const key = `lock:test:${randomUUID()}`;
    const first = await acquireLock(app.redis, key, 10_000);
    expect(await acquireLock(app.redis, key, 10_000)).toBeNull();

    expect(await releaseLock(app.redis, { key, token: 'someone-else' })).toBe(false);
    expect(await app.redis.exists(key)).toBe(1);
    expect(await releaseLock(app.redis, first!)).toBe(true);
    expect(await releaseLock(app.redis, first!)).toBe(false);
  });

  it('frees the dates when a booking is cancelled, and cancelling twice is harmless', async () => {
    const bookingId = (await book(alice, day(10), day(13))).json().booking.id;
    const cancel = () =>
      app.inject({ method: 'POST', url: `/bookings/${bookingId}/cancel`, headers: alice.headers });

    const first = await cancel();
    expect(first.statusCode).toBe(200);
    expect(first.json().booking.status).toBe('cancelled');
    expect((await cancel()).statusCode).toBe(200);

    expect((await book(bob, day(10), day(13))).statusCode).toBe(201);
    expect(await confirmedCount()).toBe(1);
  });

  it('hides other users bookings', async () => {
    const bookingId = (await book(alice, day(10), day(13))).json().booking.id;

    const read = await app.inject({ method: 'GET', url: `/bookings/${bookingId}`, headers: bob.headers });
    const cancel = await app.inject({
      method: 'POST',
      url: `/bookings/${bookingId}/cancel`,
      headers: bob.headers,
    });
    const list = await app.inject({ method: 'GET', url: '/bookings', headers: bob.headers });

    expect(read.statusCode).toBe(404);
    expect(cancel.statusCode).toBe(404);
    expect(list.json().bookings).toEqual([]);
    expect(await confirmedCount()).toBe(1);
  });

  it('lets an admin read and cancel any booking', async () => {
    const bookingId = (await book(alice, day(10), day(13))).json().booking.id;
    const admin = { authorization: `Bearer ${app.jwt.sign({ sub: bob.id, role: 'admin' })}` };

    const read = await app.inject({ method: 'GET', url: `/bookings/${bookingId}`, headers: admin });
    const cancel = await app.inject({
      method: 'POST',
      url: `/bookings/${bookingId}/cancel`,
      headers: admin,
    });

    expect(read.statusCode).toBe(200);
    expect(cancel.json().booking.status).toBe('cancelled');
  });

  it('lists and reads the caller own bookings', async () => {
    const created = (await book(alice, day(10), day(13))).json().booking;

    const list = await app.inject({ method: 'GET', url: '/bookings', headers: alice.headers });
    const read = await app.inject({ method: 'GET', url: `/bookings/${created.id}`, headers: alice.headers });
    const invalid = await app.inject({ method: 'GET', url: '/bookings/abc', headers: alice.headers });

    expect(list.json().bookings).toEqual([created]);
    expect(read.json().booking).toEqual(created);
    expect(invalid.statusCode).toBe(400);
  });

  it('reports room availability for a date range', async () => {
    await book(alice, day(10), day(13));
    const rooms = async (query: string) => {
      const response = await app.inject({ method: 'GET', url: `/rooms${query}` });
      return { status: response.statusCode, room: response.json().rooms?.find((r: { id: string }) => r.id === roomId) };
    };

    expect((await rooms('')).room).toEqual({
      id: roomId,
      name: expect.any(String),
      roomType: roomTypeName,
      basePriceSatang: BASE_PRICE_SATANG,
    });
    expect((await rooms(`?checkIn=${day(12)}&checkOut=${day(14)}`)).room.available).toBe(false);
    expect((await rooms(`?checkIn=${day(13)}&checkOut=${day(14)}`)).room.available).toBe(true);
    expect((await rooms(`?checkIn=${day(13)}`)).status).toBe(400);
  });
});
