/**
 * Dynamic Pricing Engine. A pure function: no clock, database or network access.
 * Money is in integer satang and multipliers are in basis points (10000 = 1.0),
 * so no floating-point arithmetic touches a price.
 */

const BPS = 10_000n;
const RESORT_UTC_OFFSET_HOURS = 7; // Asia/Bangkok has no daylight saving time.

export const PEAK_HOUR_START = 20;
export const PEAK_HOUR_END = 22; // exclusive
export const LOYAL_GUEST_MIN_STAYS = 4; // "more than 3 stays"

export const PRICE_RULES = {
  LAST_ROOM: { multiplierBps: 12_000, description: 'Last available room: +20%' },
  PEAK_HOUR: { multiplierBps: 11_500, description: 'Booked between 20:00 and 22:00: +15%' },
  LOYAL_GUEST: { multiplierBps: 9_000, description: 'More than 3 completed stays: -10%' },
} as const;

export type PriceRuleCode = keyof typeof PRICE_RULES;

export interface AppliedPriceRule {
  code: PriceRuleCode;
  multiplierBps: number;
  description: string;
}

export interface PricingInput {
  /** Base price per night, in satang. */
  basePriceSatang: number;
  /** The moment the booking is made. */
  bookedAt: Date;
  /** Rooms of this type free for the whole requested stay, counting the one being booked. */
  availableRooms: number;
  /** The guest's confirmed bookings whose check-out date has passed. */
  completedStays: number;
}

export interface PricingResult {
  nightlyPriceSatang: number;
  rules: AppliedPriceRule[];
}

export function resortHour(instant: Date): number {
  return (instant.getUTCHours() + RESORT_UTC_OFFSET_HOURS) % 24;
}

export function calculateNightlyPrice(input: PricingInput): PricingResult {
  const { basePriceSatang, bookedAt, availableRooms, completedStays } = input;
  if (!Number.isSafeInteger(basePriceSatang) || basePriceSatang <= 0) {
    throw new RangeError('basePriceSatang must be a positive integer');
  }
  if (!Number.isInteger(availableRooms) || availableRooms < 1) {
    throw new RangeError('availableRooms must be an integer of at least 1');
  }
  if (!Number.isInteger(completedStays) || completedStays < 0) {
    throw new RangeError('completedStays must be a non-negative integer');
  }
  if (Number.isNaN(bookedAt.getTime())) throw new RangeError('bookedAt must be a valid date');

  const hour = resortHour(bookedAt);
  const codes: PriceRuleCode[] = [];
  if (availableRooms === 1) codes.push('LAST_ROOM');
  if (hour >= PEAK_HOUR_START && hour < PEAK_HOUR_END) codes.push('PEAK_HOUR');
  if (completedStays >= LOYAL_GUEST_MIN_STAYS) codes.push('LOYAL_GUEST');

  // Rules compound. Everything is multiplied first and divided once, so the result
  // does not depend on rule order and is rounded (half up) a single time.
  let numerator = BigInt(basePriceSatang);
  let denominator = 1n;
  for (const code of codes) {
    numerator *= BigInt(PRICE_RULES[code].multiplierBps);
    denominator *= BPS;
  }
  const nightlyPriceSatang = Number((numerator + denominator / 2n) / denominator);
  if (!Number.isSafeInteger(nightlyPriceSatang)) throw new RangeError('price exceeds safe integer');

  return { nightlyPriceSatang, rules: codes.map((code) => ({ code, ...PRICE_RULES[code] })) };
}
