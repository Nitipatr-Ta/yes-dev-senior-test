import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { RawData, WebSocket } from 'ws';
import { z } from 'zod';
import type { AuthUser } from '../auth/plugin.js';
import { BOOKING_EVENTS_CHANNEL } from './events.js';
import { DashboardHub } from './hub.js';
import { loadDashboardSnapshot } from './snapshot.js';

/** WebSocket close codes. 4000-4999 are reserved for applications; these mirror HTTP 401/403. */
export const CLOSE_UNAUTHORIZED = 4401;
export const CLOSE_FORBIDDEN = 4403;
const CLOSE_INTERNAL_ERROR = 1011;

const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

const clientMessage = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('auth'), token: z.string().min(1).max(4096) }),
  z.strictObject({ type: z.literal('snapshot') }),
]);
type ClientMessage = z.infer<typeof clientMessage>;

export interface DashboardOptions {
  /** How long a connection may stay open without authenticating. */
  authTimeoutMs?: number;
}

function parseMessage(data: RawData, isBinary: boolean): ClientMessage | null {
  if (isBinary) return null;
  try {
    const result = clientMessage.safeParse(JSON.parse(data.toString()));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export async function dashboardRoutes(
  app: FastifyInstance,
  options: DashboardOptions,
): Promise<void> {
  const authTimeoutMs = options.authTimeoutMs ?? 5_000;
  const hub = new DashboardHub(app.log);

  // A connection in subscriber mode cannot run other commands, so it gets its own.
  const subscriber = app.redis.duplicate();
  subscriber.on('error', (error) => app.log.warn({ err: error }, 'dashboard subscriber error'));
  subscriber.on('message', (_channel, message) => hub.broadcast(message));
  await subscriber.subscribe(BOOKING_EVENTS_CHANNEL);
  hub.startHeartbeat(HEARTBEAT_INTERVAL_MS);

  app.addHook('onClose', async () => {
    hub.close();
    await subscriber.quit().catch(() => undefined);
  });

  app.get('/admin/dashboard', { preHandler: app.requireAdmin }, async () =>
    loadDashboardSnapshot(app.db, app.now()),
  );

  // Clients that can set headers (servers, Postman) authenticate before the upgrade and get a
  // plain HTTP 401/403. Browsers cannot set headers on a WebSocket, so without the header the
  // upgrade is allowed and the first message must be {"type":"auth","token":"..."}.
  // The token is never accepted in the URL, where it would end up in access logs.
  const authenticateIfHeader = async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.headers.authorization !== undefined) await app.requireAdmin(request, reply);
  };

  app.get(
    '/admin/dashboard/ws',
    { websocket: true, preHandler: authenticateIfHeader },
    (socket: WebSocket, request) => {
      let user: AuthUser | null = null;
      let expiryTimer: NodeJS.Timeout | undefined;
      const authTimer =
        request.headers.authorization === undefined
          ? setTimeout(() => socket.close(CLOSE_UNAUTHORIZED, 'Authentication timeout'), authTimeoutMs)
          : undefined;

      const send = (message: object) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
      };
      const sendError = (code: string, message: string) =>
        send({ type: 'error', error: { code, message } });

      const sendSnapshot = async () => {
        try {
          send({ type: 'snapshot', data: await loadDashboardSnapshot(app.db, app.now()) });
          return true;
        } catch (error) {
          request.log.error(error, 'failed to load dashboard snapshot');
          socket.close(CLOSE_INTERNAL_ERROR, 'Snapshot unavailable');
          return false;
        }
      };

      const start = async (authUser: AuthUser & { exp?: number }) => {
        user = authUser;
        clearTimeout(authTimer);
        // The token stops being valid at exp, so the connection it opened must not outlive it.
        if (authUser.exp !== undefined) {
          const remainingMs = authUser.exp * 1000 - Date.now();
          expiryTimer = setTimeout(
            () => socket.close(CLOSE_UNAUTHORIZED, 'Token expired'),
            Math.min(Math.max(remainingMs, 0), MAX_TIMEOUT_MS),
          );
        }
        hub.add(socket);
        if (await sendSnapshot()) hub.markReady(socket);
      };

      socket.on('message', (data, isBinary) => {
        const message = parseMessage(data, isBinary);

        if (user === null) {
          if (message?.type !== 'auth') {
            socket.close(CLOSE_UNAUTHORIZED, 'Authentication required');
            return;
          }
          let payload: AuthUser & { exp?: number };
          try {
            payload = app.jwt.verify<AuthUser & { exp?: number }>(message.token);
          } catch {
            socket.close(CLOSE_UNAUTHORIZED, 'Invalid or expired token');
            return;
          }
          if (payload.role !== 'admin') {
            socket.close(CLOSE_FORBIDDEN, 'Admin role required');
            return;
          }
          void start(payload);
          return;
        }

        if (message === null) sendError('INVALID_MESSAGE', 'Expected {"type":"snapshot"}');
        else if (message.type === 'auth') sendError('ALREADY_AUTHENTICATED', 'Already authenticated');
        else void sendSnapshot();
      });

      socket.on('close', () => {
        clearTimeout(authTimer);
        clearTimeout(expiryTimer);
        hub.remove(socket);
      });

      if (request.headers.authorization !== undefined) void start(request.user);
    },
  );
}
