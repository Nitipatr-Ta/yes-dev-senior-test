import type pg from 'pg';
import { resortToday } from '../bookings/dates.js';
import { BOOKING_COLUMNS, toBooking, type Booking, type BookingRow } from '../bookings/model.js';

export const RECENT_BOOKINGS_LIMIT = 20;

export interface DashboardSnapshot {
  /** Today's date at the resort; "today" and "tonight" in the summary refer to it. */
  date: string;
  summary: {
    totalRooms: number;
    roomsOccupiedTonight: number;
    checkInsToday: number;
    checkOutsToday: number;
    /** Confirmed bookings that have not checked out yet. */
    activeBookings: number;
    cancelledBookings: number;
    /** Sum of total prices of all confirmed bookings, past and future. */
    confirmedRevenueSatang: number;
  };
  /** Newest first. */
  recentBookings: Booking[];
  generatedAt: string;
}

export async function loadDashboardSnapshot(db: pg.Pool, now: Date): Promise<DashboardSnapshot> {
  const today = resortToday(now);

  const [summary, rooms, recent] = await Promise.all([
    db.query<{
      rooms_occupied_tonight: number;
      check_ins_today: number;
      check_outs_today: number;
      active_bookings: number;
      cancelled_bookings: number;
      confirmed_revenue_satang: string;
    }>(
      `SELECT
         count(DISTINCT room_id) FILTER (
           WHERE status = 'confirmed' AND check_in <= $1::date AND check_out > $1::date
         )::int AS rooms_occupied_tonight,
         count(*) FILTER (WHERE status = 'confirmed' AND check_in = $1::date)::int AS check_ins_today,
         count(*) FILTER (WHERE status = 'confirmed' AND check_out = $1::date)::int AS check_outs_today,
         count(*) FILTER (WHERE status = 'confirmed' AND check_out > $1::date)::int AS active_bookings,
         count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled_bookings,
         coalesce(sum(total_price_satang) FILTER (WHERE status = 'confirmed'), 0)::text
           AS confirmed_revenue_satang
       FROM bookings`,
      [today],
    ),
    db.query<{ total: number }>('SELECT count(*)::int AS total FROM rooms'),
    db.query<BookingRow>(
      `SELECT ${BOOKING_COLUMNS} FROM bookings ORDER BY created_at DESC, id DESC LIMIT $1`,
      [RECENT_BOOKINGS_LIMIT],
    ),
  ]);

  const counts = summary.rows[0];
  if (!counts) throw new Error('dashboard summary query returned no row');

  return {
    date: today,
    summary: {
      totalRooms: rooms.rows[0]?.total ?? 0,
      roomsOccupiedTonight: counts.rooms_occupied_tonight,
      checkInsToday: counts.check_ins_today,
      checkOutsToday: counts.check_outs_today,
      activeBookings: counts.active_bookings,
      cancelledBookings: counts.cancelled_bookings,
      confirmedRevenueSatang: Number(counts.confirmed_revenue_satang),
    },
    recentBookings: recent.rows.map(toBooking),
    generatedAt: now.toISOString(),
  };
}
