export interface BookingRow {
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

/** Columns to select for a BookingRow. Dates are cast to text so they stay calendar dates. */
export const BOOKING_COLUMNS = `id, room_id, user_id, check_in::text, check_out::text, status,
  nightly_price_satang, total_price_satang, price_rules, created_at`;

export function toBooking(row: BookingRow) {
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

/** A booking as the API returns it. */
export type Booking = ReturnType<typeof toBooking>;
