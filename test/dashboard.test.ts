import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { fromDayNumber, resortToday, toDayNumber } from '../src/bookings/dates.js';
import { CLOSE_FORBIDDEN, CLOSE_UNAUTHORIZED } from '../src/dashboard/routes.js';
import { buildTestApp } from './helpers.js';

const WS_PATH = '/admin/dashboard/ws';
const today = toDayNumber(resortToday()) as number;
const day = (offset: number) => fromDayNumber(today + offset);
const MORNING = new Date(today * 86_400_000 + 3 * 3_600_000);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Message = any;

/** Records everything a test client receives, from the moment the socket is created. */
class Inbox {
  private readonly messages: Message[] = [];
  private readonly listeners = new Set<() => void>();
  readonly closed: Promise<{ code: number; reason: string }>;

  constructor(ws: WebSocket) {
    ws.on('message', (data) => {
      this.messages.push(JSON.parse(data.toString()));
      for (const listener of this.listeners) listener();
    });
    this.closed = new Promise((resolve) => {
      ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });
  }

  /** Removes and returns the first message matching `predicate`, waiting for it if needed. */
  take(predicate: (message: Message) => boolean = () => true, timeoutMs = 2_000): Promise<Message> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const index = this.messages.findIndex(predicate);
        if (index === -1) return;
        const [message] = this.messages.splice(index, 1);
        cleanup();
        resolve(message);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('timed out waiting for a dashboard message'));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.listeners.delete(check);
      };
      this.listeners.add(check);
      check();
    });
  }

  /** Messages received so far that match `predicate`, without removing them. */
  peek(predicate: (message: Message) => boolean): Message[] {
    return this.messages.filter(predicate);
  }
}

describe('booking dashboard', () => {
  const EMAIL_DOMAIN = `dashboard-${randomUUID()}.test`;
  let app: FastifyInstance;
  let roomTypeId: string;
  let roomIds: string[];
  let guest: { id: string; headers: { authorization: string }; token: string };
  let adminToken: string;
  const sockets: WebSocket[] = [];

  const ours = (message: Message) => roomIds.includes(message.booking?.roomId);
  const eventFor = (type: string, bookingId: string) => (message: Message) =>
    message.type === type && message.booking?.id === bookingId;

  const connect = async (headers: Record<string, string> = {}, target = app) => {
    let inbox: Inbox | undefined;
    const ws = await target.injectWS(WS_PATH, { headers }, {
      onInit: (socket) => {
        inbox = new Inbox(socket);
      },
    });
    sockets.push(ws);
    return { ws, inbox: inbox as Inbox };
  };

  /** Connects as admin with the Authorization header and consumes the initial snapshot. */
  const connectAdmin = async () => {
    const client = await connect({ authorization: `Bearer ${adminToken}` });
    await client.inbox.take((m) => m.type === 'snapshot');
    return client;
  };

  const book = (checkIn: string, checkOut: string, roomId = roomIds[0], target = app) =>
    target.inject({
      method: 'POST',
      url: '/bookings',
      headers: guest.headers,
      payload: { roomId, checkIn, checkOut },
    });

  const cancel = (bookingId: string) =>
    app.inject({ method: 'POST', url: `/bookings/${bookingId}/cancel`, headers: guest.headers });

  beforeAll(async () => {
    app = await buildTestApp({ now: () => MORNING, dashboard: { authTimeoutMs: 300 } });
    const type = await app.db.query(
      `INSERT INTO room_types (name, base_price_satang) VALUES ($1, 2000000) RETURNING id`,
      [`Dashboard Type ${randomUUID()}`],
    );
    roomTypeId = type.rows[0].id;
    const rooms = await app.db.query(
      `INSERT INTO rooms (room_type_id, name) VALUES ($1, $2), ($1, $3) RETURNING id`,
      [roomTypeId, `Dashboard Villa ${randomUUID()}`, `Dashboard Villa ${randomUUID()}`],
    );
    roomIds = rooms.rows.map((row) => row.id as string);

    const registered = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: `${randomUUID()}@${EMAIL_DOMAIN}`, password: 'correct horse battery' },
    });
    const body = registered.json();
    guest = {
      id: body.user.id,
      token: body.accessToken,
      headers: { authorization: `Bearer ${body.accessToken}` },
    };
    adminToken = app.jwt.sign({ sub: guest.id, role: 'admin' });
  });

  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.terminate();
    await app.db.query(
      'DELETE FROM bookings WHERE room_id IN (SELECT id FROM rooms WHERE room_type_id = $1)',
      [roomTypeId],
    );
  });

  afterAll(async () => {
    await app.db.query('DELETE FROM rooms WHERE room_type_id = $1', [roomTypeId]);
    await app.db.query('DELETE FROM room_types WHERE id = $1', [roomTypeId]);
    await app.db.query('DELETE FROM users WHERE email LIKE $1', [`%@${EMAIL_DOMAIN}`]);
    await app.close();
  });

  describe('GET /admin/dashboard', () => {
    it('is for admins only', async () => {
      const call = (headers: Record<string, string>) =>
        app.inject({ method: 'GET', url: '/admin/dashboard', headers });

      expect((await call({})).statusCode).toBe(401);
      expect((await call(guest.headers)).statusCode).toBe(403);
      expect((await call({ authorization: `Bearer ${adminToken}` })).statusCode).toBe(200);
    });

    it('returns a summary and the most recent bookings', async () => {
      await book(day(0), day(2));

      const response = await app.inject({
        method: 'GET',
        url: '/admin/dashboard',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      const snapshot = response.json();

      expect(snapshot).toEqual({
        date: day(0),
        summary: {
          totalRooms: expect.any(Number),
          roomsOccupiedTonight: expect.any(Number),
          checkInsToday: expect.any(Number),
          checkOutsToday: expect.any(Number),
          activeBookings: expect.any(Number),
          cancelledBookings: expect.any(Number),
          confirmedRevenueSatang: expect.any(Number),
        },
        recentBookings: expect.any(Array),
        generatedAt: MORNING.toISOString(),
      });
      // Other test files write bookings at the same time, so only lower bounds are exact.
      expect(snapshot.summary.totalRooms).toBeGreaterThanOrEqual(2);
      expect(snapshot.summary.roomsOccupiedTonight).toBeGreaterThanOrEqual(1);
      expect(snapshot.summary.roomsOccupiedTonight).toBeLessThanOrEqual(snapshot.summary.totalRooms);
      expect(snapshot.summary.checkInsToday).toBeGreaterThanOrEqual(1);
      expect(snapshot.recentBookings.length).toBeLessThanOrEqual(20);
    });
  });

  describe('WebSocket authentication', () => {
    it('rejects the upgrade with HTTP 401 or 403 when the header token is not an admin', async () => {
      await expect(connect({ authorization: 'Bearer nonsense' })).rejects.toThrow('401');
      await expect(connect(guest.headers)).rejects.toThrow('403');
    });

    it('sends a snapshot right after header authentication', async () => {
      const { inbox } = await connect({ authorization: `Bearer ${adminToken}` });

      const message = await inbox.take();

      expect(message.type).toBe('snapshot');
      expect(message.data.summary).toBeDefined();
    });

    it('accepts an admin token in the first message', async () => {
      const { ws, inbox } = await connect();
      ws.send(JSON.stringify({ type: 'auth', token: adminToken }));

      expect((await inbox.take()).type).toBe('snapshot');
    });

    it.each([
      ['a non-admin token', () => ({ type: 'auth', token: guest.token }), CLOSE_FORBIDDEN],
      ['an invalid token', () => ({ type: 'auth', token: 'nonsense' }), CLOSE_UNAUTHORIZED],
      ['an unsigned token', () => ({ type: 'auth', token: unsignedAdminToken() }), CLOSE_UNAUTHORIZED],
      ['a message other than auth', () => ({ type: 'snapshot' }), CLOSE_UNAUTHORIZED],
      ['malformed JSON', () => '{"type":', CLOSE_UNAUTHORIZED],
    ])('closes the socket when the first message has %s', async (_name, message, code) => {
      const { ws, inbox } = await connect();
      const payload = message();
      ws.send(typeof payload === 'string' ? payload : JSON.stringify(payload));

      expect((await inbox.closed).code).toBe(code);
      expect(inbox.peek(() => true)).toEqual([]);
    });

    it('closes a socket that never authenticates', async () => {
      const { inbox } = await connect();

      expect(await inbox.closed).toEqual({ code: CLOSE_UNAUTHORIZED, reason: 'Authentication timeout' });
    });

    it('closes the socket when the token expires', async () => {
      const shortLived = app.jwt.sign({ sub: guest.id, role: 'admin' }, { expiresIn: 1 });
      const { inbox } = await connect({ authorization: `Bearer ${shortLived}` });

      expect(await inbox.closed).toEqual({ code: CLOSE_UNAUTHORIZED, reason: 'Token expired' });
    });
  });

  describe('live events', () => {
    it('pushes booking.created and booking.cancelled to admins', async () => {
      const { inbox } = await connectAdmin();

      const booking = (await book(day(10), day(12))).json().booking;
      const created = await inbox.take(eventFor('booking.created', booking.id));
      await cancel(booking.id);
      const cancelled = await inbox.take(eventFor('booking.cancelled', booking.id));

      expect(created).toEqual({
        type: 'booking.created',
        booking,
        occurredAt: MORNING.toISOString(),
      });
      expect(cancelled.booking).toEqual({ ...booking, status: 'cancelled' });
    });

    it('sends no event for a rejected booking or a repeated cancellation', async () => {
      const { inbox } = await connectAdmin();
      const booking = (await book(day(10), day(12))).json().booking;
      await inbox.take(eventFor('booking.created', booking.id));

      expect((await book(day(11), day(13))).statusCode).toBe(409);
      await cancel(booking.id);
      await cancel(booking.id);
      await inbox.take(eventFor('booking.cancelled', booking.id));
      // A later event marks the point by which any stray event would have arrived.
      const marker = (await book(day(20), day(21))).json().booking;
      await inbox.take(eventFor('booking.created', marker.id));

      expect(inbox.peek(ours)).toEqual([]);
    });

    it('sends exactly one event when many requests race for the same dates', async () => {
      const { inbox } = await connectAdmin();

      const responses = await Promise.all(Array.from({ length: 50 }, () => book(day(30), day(32))));
      const winner = responses.find((r) => r.statusCode === 201)?.json().booking;
      await inbox.take(eventFor('booking.created', winner.id));
      await pause(200);

      expect(responses.filter((r) => r.statusCode === 201)).toHaveLength(1);
      expect(inbox.peek(ours)).toEqual([]);
    });

    it('delivers events from another API instance through Redis Pub/Sub', async () => {
      const other = await buildTestApp({ now: () => MORNING });
      try {
        const { inbox } = await connectAdmin();

        const booking = (await book(day(40), day(41), roomIds[1], other)).json().booking;

        expect((await inbox.take(eventFor('booking.created', booking.id))).booking).toEqual(booking);
      } finally {
        await other.close();
      }
    });

    it('broadcasts to every connected admin and none of the guests', async () => {
      const first = await connectAdmin();
      const second = await connectAdmin();
      await expect(connect(guest.headers)).rejects.toThrow('403');

      const booking = (await book(day(50), day(51))).json().booking;

      await first.inbox.take(eventFor('booking.created', booking.id));
      await second.inbox.take(eventFor('booking.created', booking.id));
    });

    it('stops sending to a client after it disconnects', async () => {
      const { ws, inbox } = await connectAdmin();
      ws.close();
      await inbox.closed;

      const booking = (await book(day(60), day(61))).json().booking;
      await pause(200);

      expect(inbox.peek(eventFor('booking.created', booking.id))).toEqual([]);
    });
  });

  describe('client messages', () => {
    it('answers a snapshot request and reports invalid messages', async () => {
      const { ws, inbox } = await connectAdmin();

      ws.send(JSON.stringify({ type: 'snapshot' }));
      expect((await inbox.take((m) => m.type === 'snapshot')).data.summary).toBeDefined();

      ws.send('not json');
      expect((await inbox.take((m) => m.type === 'error')).error.code).toBe('INVALID_MESSAGE');

      ws.send(JSON.stringify({ type: 'auth', token: adminToken }));
      expect((await inbox.take((m) => m.type === 'error')).error.code).toBe('ALREADY_AUTHENTICATED');
    });
  });
});

function unsignedAdminToken(): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: '1', role: 'admin' })}.`;
}
