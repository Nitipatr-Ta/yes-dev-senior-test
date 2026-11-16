import type pg from 'pg';
import { resortToday, toDayNumber } from '../bookings/dates.js';
import { HttpError } from '../errors.js';
import { calculateNightlyPrice, type AppliedPriceRule } from './engine.js';

export interface QuoteRequest {
  roomId: string;
  userId: string;
  checkIn: string;
  checkOut: string;
  now: Date;
  /**
   * Locks the room type row until the surrounding transaction ends, so bookings of the same
   * type are priced one at a time and the available-room count cannot go stale before the
   * insert. Use inside a transaction.
   */
  lockRoomType?: boolean;
}

export interface Quote {
  nights: number;
  basePriceSatang: number;
  nightlyPriceSatang: number;
  totalPriceSatang: number;
  rules: AppliedPriceRule[];
}

type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

/** Loads what the pricing engine needs and prices the stay. Throws 404 / 409 HttpError. */
export async function quoteStay(db: Queryable, request: QuoteRequest): Promise<Quote> {
  const room = await db.query<{ room_type_id: string; base_price_satang: string }>(
    `SELECT r.room_type_id, t.base_price_satang
     FROM rooms r JOIN room_types t ON t.id = r.room_type_id
     WHERE r.id = $1
     ${request.lockRoomType ? 'FOR NO KEY UPDATE OF t' : ''}`,
    [request.roomId],
  );
  const roomRow = room.rows[0];
  if (!roomRow) throw new HttpError(404, 'ROOM_NOT_FOUND', 'Room not found');

  const facts = await db.query<{
    room_available: boolean;
    available_rooms: number;
    completed_stays: number;
  }>(
    `WITH taken AS (
       SELECT DISTINCT b.room_id
       FROM bookings b JOIN rooms r ON r.id = b.room_id
       WHERE r.room_type_id = $1
         AND b.status = 'confirmed'
         AND daterange(b.check_in, b.check_out, '[)') && daterange($3::date, $4::date, '[)')
     )
     SELECT
       NOT EXISTS (SELECT 1 FROM taken WHERE room_id = $2) AS room_available,
       (SELECT count(*) FROM rooms WHERE room_type_id = $1)::int
         - (SELECT count(*) FROM taken)::int AS available_rooms,
       (SELECT count(*) FROM bookings
         WHERE user_id = $5 AND status = 'confirmed' AND check_out <= $6::date)::int AS completed_stays`,
    [
      roomRow.room_type_id,
      request.roomId,
      request.checkIn,
      request.checkOut,
      request.userId,
      resortToday(request.now),
    ],
  );
  const factsRow = facts.rows[0];
  if (!factsRow) throw new Error('pricing facts query returned no row');
  if (!factsRow.room_available) {
    throw new HttpError(
      409,
      'ROOM_UNAVAILABLE',
      'The room is already booked for some of the requested dates',
    );
  }

  const basePriceSatang = Number(roomRow.base_price_satang);
  const { nightlyPriceSatang, rules } = calculateNightlyPrice({
    basePriceSatang,
    bookedAt: request.now,
    availableRooms: factsRow.available_rooms,
    completedStays: factsRow.completed_stays,
  });

  const nights = (toDayNumber(request.checkOut) ?? 0) - (toDayNumber(request.checkIn) ?? 0);
  const totalPriceSatang = nightlyPriceSatang * nights;
  if (nights < 1 || !Number.isSafeInteger(totalPriceSatang)) {
    throw new Error('invalid stay length or total price');
  }
  return { nights, basePriceSatang, nightlyPriceSatang, totalPriceSatang, rules };
}
