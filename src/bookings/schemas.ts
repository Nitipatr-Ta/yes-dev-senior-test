import { z } from 'zod';
import { toDayNumber } from './dates.js';

export const MAX_NIGHTS = 30;
export const MAX_ADVANCE_DAYS = 365;

// BIGINT ids travel as decimal strings; 18 digits always fits in a PostgreSQL BIGINT.
export const idSchema = z.string().regex(/^[1-9]\d{0,17}$/, 'must be a positive integer id');

export const calendarDate = z
  .string()
  .refine((value) => toDayNumber(value) !== null, 'must be a valid date in YYYY-MM-DD format');

export const stayFields = { checkIn: calendarDate, checkOut: calendarDate };

/** Builds the cross-field check for a stay. `getToday` returns today's date at the resort. */
export function makeStayCheck(getToday: () => string) {
  return (value: { checkIn: string; checkOut: string }, context: z.RefinementCtx): void => {
    const checkIn = toDayNumber(value.checkIn);
    const checkOut = toDayNumber(value.checkOut);
    const today = toDayNumber(getToday());
    if (checkIn === null || checkOut === null || today === null) return;

    const issue = (path: string, message: string) =>
      context.addIssue({ code: 'custom', path: [path], message });

    if (checkOut <= checkIn) issue('checkOut', 'must be after checkIn');
    else if (checkOut - checkIn > MAX_NIGHTS) {
      issue('checkOut', `stay is limited to ${MAX_NIGHTS} nights`);
    }
    if (checkIn < today) issue('checkIn', 'must not be in the past');
    if (checkIn > today + MAX_ADVANCE_DAYS) {
      issue('checkIn', `must be within ${MAX_ADVANCE_DAYS} days from today`);
    }
  };
}
