import type { FastifyInstance } from 'fastify';
import type { Booking } from '../bookings/model.js';

/** Redis Pub/Sub channel. Every API instance subscribes, so all dashboards get every event. */
export const BOOKING_EVENTS_CHANNEL = 'dashboard:booking-events';

export type BookingEventType = 'booking.created' | 'booking.cancelled';

export interface BookingEvent {
  type: BookingEventType;
  booking: Booking;
  occurredAt: string;
}

/**
 * Fire and forget. The booking is already committed, so a Redis failure must not fail or
 * slow down the request; the dashboard misses this one event and the next snapshot has it.
 */
export function publishBookingEvent(
  app: FastifyInstance,
  type: BookingEventType,
  booking: Booking,
): void {
  const event: BookingEvent = { type, booking, occurredAt: app.now().toISOString() };
  app.redis.publish(BOOKING_EVENTS_CHANNEL, JSON.stringify(event)).catch((error: unknown) => {
    app.log.warn({ err: error, bookingId: booking.id, type }, 'failed to publish booking event');
  });
}
