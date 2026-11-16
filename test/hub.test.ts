import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { WebSocket } from 'ws';
import { DashboardHub } from '../src/dashboard/hub.js';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The parts of a ws WebSocket that the hub uses, recording what the hub does to it. */
class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  sent: string[] = [];
  pings = 0;
  terminated = false;
  closedWith: { code: number; reason: string } | undefined;

  send(message: string): void {
    this.sent.push(message);
  }
  ping(): void {
    this.pings += 1;
  }
  terminate(): void {
    this.terminated = true;
    this.readyState = 3;
  }
  close(code: number, reason: string): void {
    this.closedWith = { code, reason };
    this.readyState = 3;
  }
}

describe('DashboardHub', () => {
  const warnings: unknown[] = [];
  const log = { warn: (details: unknown) => warnings.push(details) } as unknown as FastifyBaseLogger;
  let hub: DashboardHub;

  const newHub = () => {
    hub = new DashboardHub(log);
    return hub;
  };
  /** Adds a fake socket; `ready` says whether its snapshot has been sent. */
  const join = (ready = true) => {
    const socket = new FakeSocket();
    hub.add(socket as unknown as WebSocket);
    if (ready) hub.markReady(socket as unknown as WebSocket);
    return socket;
  };
  const asWs = (socket: FakeSocket) => socket as unknown as WebSocket;

  afterEach(() => {
    hub.close();
    warnings.length = 0;
  });

  it('broadcasts to every ready client', () => {
    newHub();
    const first = join();
    const second = join();

    hub.broadcast('a');
    hub.broadcast('b');

    expect(first.sent).toEqual(['a', 'b']);
    expect(second.sent).toEqual(['a', 'b']);
    expect(hub.size).toBe(2);
  });

  it('holds events for a client until its snapshot is sent, then delivers them in order', () => {
    newHub();
    const socket = join(false);

    hub.broadcast('event-1');
    hub.broadcast('event-2');
    expect(socket.sent).toEqual([]);

    socket.send('snapshot');
    hub.markReady(asWs(socket));
    hub.broadcast('event-3');

    expect(socket.sent).toEqual(['snapshot', 'event-1', 'event-2', 'event-3']);
  });

  it('stops sending to a removed client', () => {
    newHub();
    const socket = join();

    hub.remove(asWs(socket));
    hub.broadcast('a');

    expect(socket.sent).toEqual([]);
    expect(hub.size).toBe(0);
  });

  it('skips a socket that is no longer open', () => {
    newHub();
    const socket = join();
    socket.readyState = 2; // CLOSING

    hub.broadcast('a');

    expect(socket.sent).toEqual([]);
    expect(socket.terminated).toBe(false);
  });

  it('drops a client whose send buffer is full, and keeps serving the others', () => {
    newHub();
    const slow = join();
    const healthy = join();
    slow.bufferedAmount = 1_000_001;

    hub.broadcast('a');

    expect(slow.terminated).toBe(true);
    expect(slow.sent).toEqual([]);
    expect(healthy.sent).toEqual(['a']);
    expect(hub.size).toBe(1);
    expect(warnings).toEqual([{ reason: 'send buffer full' }]);
  });

  it('drops a client that queues too many events before its snapshot', () => {
    newHub();
    const stuck = join(false);

    for (let index = 0; index < 1_000; index += 1) hub.broadcast(`event-${index}`);
    expect(stuck.terminated).toBe(false);
    hub.broadcast('one-too-many');

    expect(stuck.terminated).toBe(true);
    expect(hub.size).toBe(0);
  });

  it('pings clients and drops the ones that do not answer', async () => {
    newHub();
    const responsive = join();
    const silent = join();
    // A healthy client answers each ping with a pong.
    const originalPing = responsive.ping.bind(responsive);
    responsive.ping = () => {
      originalPing();
      responsive.emit('pong');
    };

    hub.startHeartbeat(20);
    await pause(90);

    expect(responsive.pings).toBeGreaterThanOrEqual(2);
    expect(responsive.terminated).toBe(false);
    // One ping, no pong, dropped on the next beat.
    expect(silent.pings).toBe(1);
    expect(silent.terminated).toBe(true);
    expect(hub.size).toBe(1);
  });

  it('closes every client with 1001 on shutdown and stops the heartbeat', async () => {
    newHub();
    const socket = join();
    hub.startHeartbeat(10);

    hub.close();
    await pause(40);

    expect(socket.closedWith).toEqual({ code: 1001, reason: 'Server shutting down' });
    expect(socket.pings).toBe(0);
    expect(hub.size).toBe(0);
  });

  it('ignores markReady for a socket it does not know', () => {
    newHub();
    const stranger = new FakeSocket();

    expect(() => hub.markReady(asWs(stranger))).not.toThrow();
    expect(hub.size).toBe(0);
  });
});
