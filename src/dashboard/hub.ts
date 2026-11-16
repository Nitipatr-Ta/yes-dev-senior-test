import type { FastifyBaseLogger } from 'fastify';
import type { WebSocket } from 'ws';

/** A client that cannot keep up is dropped instead of growing server memory without bound. */
const MAX_BUFFERED_BYTES = 1_000_000;
const MAX_QUEUED_MESSAGES = 1_000;

interface Client {
  /** False until the snapshot is sent; events that arrive earlier are queued behind it. */
  ready: boolean;
  queue: string[];
  alive: boolean;
}

/** The authenticated dashboard sockets connected to this API instance. */
export class DashboardHub {
  private readonly clients = new Map<WebSocket, Client>();
  private heartbeat: NodeJS.Timeout | undefined;

  constructor(private readonly log: FastifyBaseLogger) {}

  get size(): number {
    return this.clients.size;
  }

  /**
   * Starts delivering events to the socket. Events are queued until markReady(), so a client
   * added before its snapshot is loaded misses nothing and still sees the snapshot first.
   */
  add(socket: WebSocket): void {
    const client: Client = { ready: false, queue: [], alive: true };
    this.clients.set(socket, client);
    socket.on('pong', () => {
      client.alive = true;
    });
  }

  markReady(socket: WebSocket): void {
    const client = this.clients.get(socket);
    if (!client) return;
    client.ready = true;
    const queued = client.queue;
    client.queue = [];
    for (const message of queued) this.sendTo(socket, message);
  }

  remove(socket: WebSocket): void {
    this.clients.delete(socket);
  }

  broadcast(message: string): void {
    for (const [socket, client] of this.clients) {
      if (client.ready) {
        this.sendTo(socket, message);
      } else if (client.queue.length < MAX_QUEUED_MESSAGES) {
        client.queue.push(message);
      } else {
        this.drop(socket, 'too many events queued before snapshot');
      }
    }
  }

  /** Pings every client; one that has not answered the previous ping is disconnected. */
  startHeartbeat(intervalMs: number): void {
    this.heartbeat = setInterval(() => {
      for (const [socket, client] of this.clients) {
        if (!client.alive) {
          this.drop(socket, 'no pong');
          continue;
        }
        client.alive = false;
        if (socket.readyState === socket.OPEN) socket.ping();
      }
    }, intervalMs);
    this.heartbeat.unref();
  }

  close(): void {
    clearInterval(this.heartbeat);
    for (const socket of this.clients.keys()) socket.close(1001, 'Server shutting down');
    this.clients.clear();
  }

  private sendTo(socket: WebSocket, message: string): void {
    if (socket.readyState !== socket.OPEN) return;
    if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.drop(socket, 'send buffer full');
      return;
    }
    socket.send(message);
  }

  private drop(socket: WebSocket, reason: string): void {
    this.log.warn({ reason }, 'dropping dashboard client');
    this.clients.delete(socket);
    socket.terminate();
  }
}
