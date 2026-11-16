import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { fromDayNumber, resortToday, toDayNumber } from '../src/bookings/dates.js';
import { calculateNightlyPrice, resortHour, type PricingInput } from '../src/pricing/engine.js';
import { buildTestApp } from './helpers.js';

const BASE = 2_000_000; // 20,000 THB
const today = toDayNumber(resortToday()) as number;
const day = (offset: number) => fromDayNumber(today + offset);
/** Today at the given resort (UTC+7) wall-clock time. */
const resortTime = (hour: number, minute = 0, second = 0) =>
  new Date(today * 86_400_000 + ((hour - 7) * 3600 + minute * 60 + second) * 1000);

describe('pricing engine', () => {
  const price = (overrides: Partial<PricingInput> = {}) =>
    calculateNightlyPrice({
      basePriceSatang: BASE,
      bookedAt: resortTime(10),
      availableRooms: 5,
      completedStays: 0,
      ...overrides,
    });
  const codes = (overrides: Partial<PricingInput>) => price(overrides).rules.map((r) => r.code);

  it('returns the base price when no rule applies', () => {
    expect(price()).toEqual({ nightlyPriceSatang: BASE, rules: [] });
  });

  it('adds 20% for the last available room', () => {
    expect(price({ availableRooms: 1 }).nightlyPriceSatang).toBe(2_400_000);
    expect(codes({ availableRooms: 1 })).toEqual(['LAST_ROOM']);
    expect(codes({ availableRooms: 2 })).toEqual([]);
  });

  it.each([
    ['19:59:59', resortTime(19, 59, 59), false],
    ['20:00:00', resortTime(20), true],
    ['21:59:59', resortTime(21, 59, 59), true],
    ['22:00:00', resortTime(22), false],
  ])('applies the peak-hour rule correctly at %s resort time', (_label, bookedAt, applies) => {
    expect(codes({ bookedAt })).toEqual(applies ? ['PEAK_HOUR'] : []);
    expect(price({ bookedAt }).nightlyPriceSatang).toBe(applies ? 2_300_000 : BASE);
  });

  it('measures peak hour in Asia/Bangkok, not UTC', () => {
    expect(resortHour(new Date('2027-01-01T13:30:00Z'))).toBe(20);
    expect(codes({ bookedAt: new Date('2027-01-01T13:30:00Z') })).toEqual(['PEAK_HOUR']);
    expect(codes({ bookedAt: new Date('2027-01-01T20:30:00Z') })).toEqual([]);
    expect(resortHour(new Date('2027-01-01T18:00:00Z'))).toBe(1);
  });

  it('gives 10% off only after more than 3 completed stays', () => {
    expect(codes({ completedStays: 3 })).toEqual([]);
    expect(codes({ completedStays: 4 })).toEqual(['LOYAL_GUEST']);
    expect(price({ completedStays: 4 }).nightlyPriceSatang).toBe(1_800_000);
  });

  it('compounds all rules: 20,000 x 1.2 x 1.15 x 0.9 = 24,840 THB', () => {
    const result = price({ availableRooms: 1, bookedAt: resortTime(20, 30), completedStays: 10 });

    expect(result.nightlyPriceSatang).toBe(2_484_000);
    expect(result.rules).toEqual([
      { code: 'LAST_ROOM', multiplierBps: 12_000, description: expect.any(String) },
      { code: 'PEAK_HOUR', multiplierBps: 11_500, description: expect.any(String) },
      { code: 'LOYAL_GUEST', multiplierBps: 9_000, description: expect.any(String) },
    ]);
  });

  it('compounds each pair of rules', () => {
    expect(price({ availableRooms: 1, bookedAt: resortTime(21) }).nightlyPriceSatang).toBe(
      2_760_000,
    );
    expect(price({ availableRooms: 1, completedStays: 4 }).nightlyPriceSatang).toBe(2_160_000);
    expect(price({ bookedAt: resortTime(21), completedStays: 4 }).nightlyPriceSatang).toBe(
      2_070_000,
    );
  });

  it('always returns whole satang, rounding half up once at the end', () => {
    // 1 x 1.15 = 1.15 -> 1; 3 x 1.15 = 3.45 -> 3
    expect(price({ basePriceSatang: 1, bookedAt: resortTime(20) }).nightlyPriceSatang).toBe(1);
    expect(price({ basePriceSatang: 3, bookedAt: resortTime(20) }).nightlyPriceSatang).toBe(3);
    // 50 x 1.15 x 0.9 = 51.75 -> 52; 5 x 0.9 = 4.5 -> 5
    expect(
      price({ basePriceSatang: 50, bookedAt: resortTime(20), completedStays: 4 })
        .nightlyPriceSatang,
    ).toBe(52);
    expect(price({ basePriceSatang: 5, completedStays: 4 }).nightlyPriceSatang).toBe(5);
    // 3,333,333 x 1.2 x 1.15 x 0.9 = 4,139,999.586 -> 4,140,000 (floats would drift here).
    expect(
      price({
        basePriceSatang: 3_333_333,
        availableRooms: 1,
        bookedAt: resortTime(20),
        completedStays: 4,
      }).nightlyPriceSatang,
    ).toBe(4_140_000);
  });

  it('is deterministic and does not mutate its input', () => {
    const input = Object.freeze({
      basePriceSatang: BASE,
      bookedAt: resortTime(20),
      availableRooms: 1,
      completedStays: 4,
    });
    expect(calculateNightlyPrice(input)).toEqual(calculateNightlyPrice(input));
  });

  it.each([
    ['zero base price', { basePriceSatang: 0 }],
    ['fractional base price', { basePriceSatang: 100.5 }],
    ['no available room', { availableRooms: 0 }],
    ['negative stays', { completedStays: -1 }],
    ['invalid date', { bookedAt: new Date('nope') }],
  ])('rejects %s', (_name, overrides) => {
    expect(() => price(overrides)).toThrow(RangeError);
  });
});

describe('pricing in the booking flow', () => {
  const EMAIL_DOMAIN = `pricing-${randomUUID()}.test`;
  let app: FastifyInstance;
  let now = resortTime(10);
  let roomTypeId: string;
  let roomA: string;
  let roomB: string;
  let guest: { id: string; headers: { authorization: string } };
  let other: { id: string; headers: { authorization: string } };

  const createUser = async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: `${randomUUID()}@${EMAIL_DOMAIN}`, password: 'correct horse battery' },
    });
    const body = response.json();
    return { id: body.user.id as string, headers: { authorization: `Bearer ${body.accessToken}` } };
  };

  const book = (user: typeof guest, room: string, checkIn: string, checkOut: string) =>
    app.inject({
      method: 'POST',
      url: '/bookings',
      headers: user.headers,
      payload: { roomId: room, checkIn, checkOut },
    });

  const quote = (user: typeof guest, room: string, checkIn: string, checkOut: string) =>
    app.inject({
      method: 'GET',
      url: `/pricing/quote?roomId=${room}&checkIn=${checkIn}&checkOut=${checkOut}`,
      headers: user.headers,
    });

  const ruleCodes = (rules: { code: string }[]) => rules.map((rule) => rule.code);

  /** Inserts a confirmed one-night stay directly, bypassing the API's date checks. */
  const insertStay = (userId: string, checkIn: string, checkOut: string, status = 'confirmed') =>
    app.db.query(
      `INSERT INTO bookings
         (room_id, user_id, check_in, check_out, status, nightly_price_satang, total_price_satang)
       VALUES ($1, $2, $3::date, $4::date, $5, $6, $6)`,
      [roomB, userId, checkIn, checkOut, status, BASE],
    );

  /**
   * Gives the user `count` confirmed stays that ended in the past, starting `startOffset` days
   * from today. Callers adding stays for two users must use ranges that do not overlap.
   */
  const addPastStays = async (userId: string, count: number, startOffset = -100) => {
    for (let index = 0; index < count; index += 1) {
      await insertStay(userId, day(startOffset + index * 2), day(startOffset + 1 + index * 2));
    }
  };

  const clearBookings = () =>
    app.db.query(
      'DELETE FROM bookings WHERE room_id IN (SELECT id FROM rooms WHERE room_type_id = $1)',
      [roomTypeId],
    );

  beforeAll(async () => {
    app = await buildTestApp({ now: () => now });
    const type = await app.db.query(
      `INSERT INTO room_types (name, base_price_satang) VALUES ($1, $2) RETURNING id`,
      [`Pricing Type ${randomUUID()}`, BASE],
    );
    roomTypeId = type.rows[0].id;
    const rooms = await app.db.query(
      `INSERT INTO rooms (room_type_id, name) VALUES ($1, $2), ($1, $3) RETURNING id`,
      [roomTypeId, `Pricing Villa ${randomUUID()}`, `Pricing Villa ${randomUUID()}`],
    );
    [roomA, roomB] = rooms.rows.map((row) => row.id as string) as [string, string];
    [guest, other] = await Promise.all([createUser(), createUser()]);
  });

  beforeEach(async () => {
    now = resortTime(10);
    await clearBookings();
  });

  afterAll(async () => {
    await clearBookings();
    await app.db.query('DELETE FROM rooms WHERE room_type_id = $1', [roomTypeId]);
    await app.db.query('DELETE FROM room_types WHERE id = $1', [roomTypeId]);
    await app.db.query('DELETE FROM users WHERE email LIKE $1', [`%@${EMAIL_DOMAIN}`]);
    await app.close();
  });

  it('requires authentication and valid input for a quote', async () => {
    const anonymous = await app.inject({
      method: 'GET',
      url: `/pricing/quote?roomId=${roomA}&checkIn=${day(10)}&checkOut=${day(12)}`,
    });
    expect(anonymous.statusCode).toBe(401);
    expect((await quote(guest, roomA, day(12), day(10))).statusCode).toBe(400);
    expect((await quote(guest, '999999999999', day(10), day(12))).statusCode).toBe(404);
  });

  it('quotes the base price when no rule applies', async () => {
    const response = await quote(guest, roomA, day(10), day(13));

    expect(response.statusCode).toBe(200);
    expect(response.json().quote).toEqual({
      roomId: roomA,
      checkIn: day(10),
      checkOut: day(13),
      nights: 3,
      basePriceSatang: BASE,
      nightlyPriceSatang: BASE,
      totalPriceSatang: BASE * 3,
      priceRules: [],
      quotedAt: now.toISOString(),
    });
  });

  it('applies the last-room rule only for dates where one room is left', async () => {
    expect((await book(other, roomB, day(10), day(13))).statusCode).toBe(201);

    const overlapping = (await quote(guest, roomA, day(12), day(14))).json().quote;
    const clear = (await quote(guest, roomA, day(13), day(15))).json().quote;

    expect(ruleCodes(overlapping.priceRules)).toEqual(['LAST_ROOM']);
    expect(overlapping.nightlyPriceSatang).toBe(2_400_000);
    expect(clear.priceRules).toEqual([]);
  });

  it('stops applying the last-room rule once the other booking is cancelled', async () => {
    const blocking = (await book(other, roomB, day(10), day(13))).json().booking;
    await app.inject({
      method: 'POST',
      url: `/bookings/${blocking.id}/cancel`,
      headers: other.headers,
    });

    expect((await quote(guest, roomA, day(10), day(13))).json().quote.priceRules).toEqual([]);
  });

  it('applies the peak-hour rule from the booking time', async () => {
    now = resortTime(20, 15);

    const booking = (await book(guest, roomA, day(10), day(12))).json().booking;

    expect(booking.nightlyPriceSatang).toBe(2_300_000);
    expect(booking.totalPriceSatang).toBe(4_600_000);
    expect(ruleCodes(booking.priceRules)).toEqual(['PEAK_HOUR']);
  });

  it('counts only completed, confirmed stays towards the loyalty discount', async () => {
    await addPastStays(guest.id, 3);
    // Not counted: a future stay, a cancelled past stay, and another guest's past stays.
    await insertStay(guest.id, day(40), day(41));
    await insertStay(guest.id, day(-50), day(-49), 'cancelled');
    await addPastStays(other.id, 5, -200);
    expect((await quote(guest, roomA, day(10), day(12))).json().quote.priceRules).toEqual([]);

    // A stay that checked out today counts as completed.
    await insertStay(guest.id, day(-1), day(0));
    const loyal = (await quote(guest, roomA, day(10), day(12))).json().quote;

    expect(ruleCodes(loyal.priceRules)).toEqual(['LOYAL_GUEST']);
    expect(loyal.nightlyPriceSatang).toBe(1_800_000);
  });

  it('stores the compounded price and rules with the booking: 24,840 THB per night', async () => {
    await addPastStays(guest.id, 4);
    await book(other, roomB, day(10), day(13));
    now = resortTime(21, 59, 59);

    const quoted = (await quote(guest, roomA, day(10), day(13))).json().quote;
    const response = await book(guest, roomA, day(10), day(13));
    const booking = response.json().booking;

    expect(response.statusCode).toBe(201);
    expect(booking.nightlyPriceSatang).toBe(2_484_000);
    expect(booking.totalPriceSatang).toBe(7_452_000);
    expect(ruleCodes(booking.priceRules)).toEqual(['LAST_ROOM', 'PEAK_HOUR', 'LOYAL_GUEST']);
    expect(quoted.nightlyPriceSatang).toBe(booking.nightlyPriceSatang);
    expect(quoted.priceRules).toEqual(booking.priceRules);

    const stored = await app.db.query(
      'SELECT nightly_price_satang, total_price_satang, price_rules FROM bookings WHERE id = $1',
      [booking.id],
    );
    expect(stored.rows[0]).toEqual({
      nightly_price_satang: '2484000',
      total_price_satang: '7452000',
      price_rules: booking.priceRules,
    });
  });

  it('refuses to quote or book a room that is already booked for the dates', async () => {
    await book(other, roomA, day(10), day(13));

    const quoted = await quote(guest, roomA, day(11), day(12));
    const booked = await book(guest, roomA, day(11), day(12));

    expect(quoted.statusCode).toBe(409);
    expect(quoted.json().error.code).toBe('ROOM_UNAVAILABLE');
    expect(booked.statusCode).toBe(409);
    expect(booked.json().error.code).toBe('ROOM_UNAVAILABLE');
  });

  it('prices simultaneous bookings of the last two rooms consistently', async () => {
    // Both rooms are free, so the two requests race for "second to last" and "last".
    for (let round = 0; round < 10; round += 1) {
      await clearBookings();
      const [first, second] = await Promise.all([
        book(guest, roomA, day(20), day(22)),
        book(other, roomB, day(20), day(22)),
      ]);

      expect([first.statusCode, second.statusCode]).toEqual([201, 201]);
      const prices = [first, second].map((r) => r.json().booking.nightlyPriceSatang).sort();
      expect(prices).toEqual([BASE, 2_400_000]);
    }
  });
});
