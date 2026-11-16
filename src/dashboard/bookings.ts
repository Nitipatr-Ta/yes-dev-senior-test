import type pg from 'pg';
import { z } from 'zod';
import { toBooking, type Booking, type BookingRow } from '../bookings/model.js';
import { idSchema } from '../bookings/schemas.js';

export const adminBookingsQuery = z.strictObject({
  status: z.enum(['confirmed', 'cancelled']).optional(),
  roomId: idSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

export type AdminBookingsQuery = z.infer<typeof adminBookingsQuery>;

/** A booking with the names an admin needs to read the list without further lookups. */
export type AdminBooking = Booking & { userEmail: string; roomName: string };

export interface AdminBookingsPage {
  bookings: AdminBooking[];
  /** Bookings matching the filters, across all pages. */
  total: number;
  limit: number;
  offset: number;
}

const FILTER = `($1::text IS NULL OR b.status = $1) AND ($2::bigint IS NULL OR b.room_id = $2)`;

/** Every booking in the system, newest first, one page at a time. */
export async function listAllBookings(
  db: pg.Pool,
  query: AdminBookingsQuery,
): Promise<AdminBookingsPage> {
  const filters = [query.status ?? null, query.roomId ?? null];

  const [page, count] = await Promise.all([
    db.query<BookingRow & { user_email: string; room_name: string }>(
      `SELECT b.id, b.room_id, b.user_id, b.check_in::text, b.check_out::text, b.status,
              b.nightly_price_satang, b.total_price_satang, b.price_rules, b.created_at,
              u.email AS user_email, r.name AS room_name
       FROM bookings b
       JOIN users u ON u.id = b.user_id
       JOIN rooms r ON r.id = b.room_id
       WHERE ${FILTER}
       ORDER BY b.created_at DESC, b.id DESC
       LIMIT $3 OFFSET $4`,
      [...filters, query.limit, query.offset],
    ),
    db.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM bookings b WHERE ${FILTER}`,
      filters,
    ),
  ]);

  return {
    bookings: page.rows.map((row) => ({
      ...toBooking(row),
      userEmail: row.user_email,
      roomName: row.room_name,
    })),
    total: count.rows[0]?.total ?? 0,
    limit: query.limit,
    offset: query.offset,
  };
}
