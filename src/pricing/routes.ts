import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resortToday } from '../bookings/dates.js';
import { idSchema, makeStayCheck, stayFields } from '../bookings/schemas.js';
import { quoteStay } from './quote.js';

export async function pricingRoutes(app: FastifyInstance): Promise<void> {
  const quoteQuery = z
    .strictObject({ roomId: idSchema, ...stayFields })
    .superRefine(makeStayCheck(() => resortToday(app.now())));

  // The price a booking made right now would get. It is not held: the price is
  // recalculated when the booking is created and can differ (peak hour, last room).
  app.get('/pricing/quote', { preHandler: app.authenticate }, async (request) => {
    const query = quoteQuery.parse(request.query);
    const now = app.now();
    const quote = await quoteStay(app.db, { ...query, userId: request.user.sub, now });

    return {
      quote: {
        roomId: query.roomId,
        checkIn: query.checkIn,
        checkOut: query.checkOut,
        nights: quote.nights,
        basePriceSatang: quote.basePriceSatang,
        nightlyPriceSatang: quote.nightlyPriceSatang,
        totalPriceSatang: quote.totalPriceSatang,
        priceRules: quote.rules,
        quotedAt: now.toISOString(),
      },
    };
  });
}
