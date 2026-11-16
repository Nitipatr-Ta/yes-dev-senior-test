import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTransaction } from '../db/transaction.js';
import { HttpError } from '../errors.js';
import { quoteStay } from '../pricing/quote.js';
import { acquireLock, releaseLock, type Lock } from '../redis/lock.js';
import { resortToday } from './dates.js';
import { calendarDate, idSchema, makeStayCheck, stayFields } from './schemas.js';

const PG_FOREIGN_KEY_VIOLATION = '23503';
const PG_EXCLUSION_VIOLATION = '23P01';
const ROOM_LOCK_TTL_MS = 5_000;

export const roomLockKey = (roomId: string) => `lock:room:${roomId}`;

const bookingParams = z.strictObject({ id: idSchema });

interface BookingRow {
  id: string;
  room_id: string;
  user_id: string;
  check_in: string;
  check_out: string;
  status: 'confirmed' | 'cancelled';
  nightly_price_satang: string;
  total_price_satang: string;
  price_rules: unknown;
  created_at: Date;
}

const BOOKING_COLUMNS = `id, room_id, user_id, check_in::text, check_out::text, status,
  nightly_price_satang, total_price_satang, price_rules, created_at`;

function toBooking(row: BookingRow) {
  return {
    id: row.id,
    roomId: row.room_id,
    userId: row.user_id,
    checkIn: row.check_in,
    checkOut: row.check_out,
    status: row.status,
    nightlyPriceSatang: Number(row.nightly_price_satang),
    totalPriceSatang: Number(row.total_price_satang),
    priceRules: row.price_rules,
    createdAt: row.created_at.toISOString(),
  };
}

function pgErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

export async function bookingRoutes(app: FastifyInstance): Promise<void> {
  // "Today" comes from app.now(), so tests can pin the clock.
  const checkStay = makeStayCheck(() => resortToday(app.now()));

  const createBookingBody = z
    .strictObject({
      roomId: z.union([idSchema, z.number().int().positive().transform(String)]),
      ...stayFields,
    })
    .superRefine(checkStay);

  const availabilityQuery = z
    .strictObject({ checkIn: calendarDate.optional(), checkOut: calendarDate.optional() })
    .superRefine((value, context) => {
      if (value.checkIn === undefined && value.checkOut === undefined) return;
      if (value.checkIn === undefined || value.checkOut === undefined) {
        context.addIssue({
          code: 'custom',
          path: [value.checkIn === undefined ? 'checkIn' : 'checkOut'],
          message: 'checkIn and checkOut must be given together',
        });
        return;
      }
      checkStay({ checkIn: value.checkIn, checkOut: value.checkOut }, context);
    });

  app.get('/rooms', async (request) => {
    const query = availabilityQuery.parse(request.query);
    const withAvailability = query.checkIn !== undefined && query.checkOut !== undefined;

    const result = await app.db.query<{
      id: string;
      name: string;
      room_type: string;
      base_price_satang: string;
      available: boolean | null;
    }>(
      `SELECT r.id, r.name, t.name AS room_type, t.base_price_satang,
              CASE WHEN $1::date IS NULL THEN NULL ELSE NOT EXISTS (
                SELECT 1 FROM bookings b
                WHERE b.room_id = r.id
                  AND b.status = 'confirmed'
                  AND daterange(b.check_in, b.check_out, '[)') && daterange($1::date, $2::date, '[)')
              ) END AS available
       FROM rooms r
       JOIN room_types t ON t.id = r.room_type_id
       ORDER BY r.id`,
      [query.checkIn ?? null, query.checkOut ?? null],
    );

    return {
      rooms: result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        roomType: row.room_type,
        basePriceSatang: Number(row.base_price_satang),
        ...(withAvailability ? { available: row.available } : {}),
      })),
    };
  });

  app.post('/bookings', { preHandler: app.authenticate }, async (request, reply) => {
    const body = createBookingBody.parse(request.body);

    // Layer 1: one request per room reaches the database at a time; the rest are turned away
    // here without opening a transaction. This sheds load. It does not guarantee correctness.
    let lock: Lock | null = null;
    let lockAvailable = true;
    try {
      lock = await acquireLock(app.redis, roomLockKey(body.roomId), ROOM_LOCK_TTL_MS);
    } catch (error) {
      // Redis is unreachable: keep taking bookings, relying on the exclusion constraint alone.
      lockAvailable = false;
      request.log.warn(error, 'room lock unavailable, relying on database constraint');
    }
    if (lockAvailable && lock === null) {
      reply.header('Retry-After', '1');
      throw new HttpError(
        409,
        'ROOM_BUSY',
        'Another booking for this room is being processed. Please retry.',
      );
    }

    try {
      const booking = await withTransaction(app.db, async (client) => {
        // The price is fixed at the moment of booking and stored with the booking.
        const quote = await quoteStay(client, {
          roomId: body.roomId,
          userId: request.user.sub,
          checkIn: body.checkIn,
          checkOut: body.checkOut,
          now: app.now(),
          lockRoomType: true,
        });

        // Layer 2: bookings_no_overlap rejects the insert if any confirmed booking for this
        // room overlaps, even when the Redis lock expired mid-request or was never taken.
        const inserted = await client.query<BookingRow>(
          `INSERT INTO bookings
             (room_id, user_id, check_in, check_out, nightly_price_satang, total_price_satang, price_rules)
           VALUES ($1, $2, $3::date, $4::date, $5, $6, $7::jsonb)
           RETURNING ${BOOKING_COLUMNS}`,
          [
            body.roomId,
            request.user.sub,
            body.checkIn,
            body.checkOut,
            quote.nightlyPriceSatang,
            quote.totalPriceSatang,
            JSON.stringify(quote.rules),
          ],
        );
        const row = inserted.rows[0];
        if (!row) throw new Error('INSERT INTO bookings returned no row');
        return row;
      });
      return await reply.code(201).send({ booking: toBooking(booking) });
    } catch (error) {
      const code = pgErrorCode(error);
      if (code === PG_EXCLUSION_VIOLATION) {
        throw new HttpError(
          409,
          'ROOM_UNAVAILABLE',
          'The room is already booked for some of the requested dates',
        );
      }
      if (code === PG_FOREIGN_KEY_VIOLATION) {
        // The room row was read in the same transaction, so the missing parent is the user.
        throw new HttpError(401, 'UNAUTHORIZED', 'User no longer exists');
      }
      throw error;
    } finally {
      if (lock) {
        await releaseLock(app.redis, lock).catch((error: unknown) => {
          request.log.warn(error, 'failed to release room lock; it will expire on its own');
        });
      }
    }
  });

  app.get('/bookings', { preHandler: app.authenticate }, async (request) => {
    const result = await app.db.query<BookingRow>(
      `SELECT ${BOOKING_COLUMNS} FROM bookings WHERE user_id = $1 ORDER BY check_in, id`,
      [request.user.sub],
    );
    return { bookings: result.rows.map(toBooking) };
  });

  // A booking that belongs to someone else is reported as missing, so ids cannot be probed.
  const visibleTo = (userId: string, role: string) =>
    role === 'admin' ? { clause: '', values: [] } : { clause: 'AND user_id = $2', values: [userId] };

  app.get('/bookings/:id', { preHandler: app.authenticate }, async (request) => {
    const params = bookingParams.parse(request.params);
    const scope = visibleTo(request.user.sub, request.user.role);
    const result = await app.db.query<BookingRow>(
      `SELECT ${BOOKING_COLUMNS} FROM bookings WHERE id = $1 ${scope.clause}`,
      [params.id, ...scope.values],
    );
    const booking = result.rows[0];
    if (!booking) throw new HttpError(404, 'BOOKING_NOT_FOUND', 'Booking not found');
    return { booking: toBooking(booking) };
  });

  app.post('/bookings/:id/cancel', { preHandler: app.authenticate }, async (request) => {
    const params = bookingParams.parse(request.params);
    const scope = visibleTo(request.user.sub, request.user.role);
    // Cancelling twice is harmless: the row is returned as cancelled either way.
    const result = await app.db.query<BookingRow>(
      `UPDATE bookings SET status = 'cancelled' WHERE id = $1 ${scope.clause}
       RETURNING ${BOOKING_COLUMNS}`,
      [params.id, ...scope.values],
    );
    const booking = result.rows[0];
    if (!booking) throw new HttpError(404, 'BOOKING_NOT_FOUND', 'Booking not found');
    return { booking: toBooking(booking) };
  });
}
