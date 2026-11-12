import { once } from 'node:events';
import net from 'node:net';
import Fastify from 'fastify';
import WebSocket from 'ws';
import { describe, expect, it, vi } from 'vitest';
import { registerRealtimeRoutes } from '../../src/route/realtime-routes.js';

describe('desktop relay WebSocket routes', () => {
  it('closes its own live sockets when the Server closes', async () => {
    const app = Fastify();
    registerRealtimeRoutes({
      app,
      database: {} as never,
      publicOrigin: undefined,
      nodeControl: { attachNodeDesktopRelay: () => {} } as never
    });
    const url = (await app.listen({ host: '127.0.0.1', port: 0 })).replace('http:', 'ws:');
    const client = new WebSocket(`${url}/api/node/desktop-relay`);
    try {
      await once(client, 'open');
      const closed = once(client, 'close');
      await app.close();
      await closed;
    } finally {
      client.terminate();
      await app.close();
    }
  });

  it('keeps legacy limits, bounds desktop frames before delivery, and checks browser Origin and session', async () => {
    const app = Fastify();
    const received = vi.fn();
    const browserAttached = vi.fn((socket: WebSocket) => socket.on('message', received));
    registerRealtimeRoutes({
      app,
      publicOrigin: 'http://trusted.test',
      database: {
        findCurrentUserSession: (value: string) =>
          value === 'valid-session'
            ? {
                userId: 1,
                username: 'user',
                isAdmin: true,
                sessionHash: 'session-hash',
                mustChangePassword: false,
                csrfTokenHash: 'csrf'
              }
            : undefined
      },
      nodeControl: {
        attach: (socket: WebSocket) =>
          socket.on('message', (message) => socket.send(String(message.length))),
        attachNodeDesktopRelay: (socket: WebSocket) =>
          socket.on('message', (message) => {
            received(message);
            socket.send(String(message.length));
          }),
        attachBrowserDesktopRelay: browserAttached
      } as never
    });
    const sockets: WebSocket[] = [];
    try {
      const url = (await app.listen({ host: '127.0.0.1', port: 0 })).replace('http:', 'ws:');
      const connect = async (path: string, headers?: Record<string, string>) => {
        const socket = new WebSocket(`${url}${path}`, { headers, perMessageDeflate: true });
        sockets.push(socket);
        await once(socket, 'open');
        return socket;
      };
      expect(app.server.listenerCount('upgrade')).toBe(1);
      const legacy = await connect('/api/node/connect');
      const legacyReply = once(legacy, 'message');
      legacy.send(Buffer.alloc(5 * 1024 * 1024));
      expect((await legacyReply)[0].toString()).toBe(String(5 * 1024 * 1024));
      const desktop = await connect('/api/node/desktop-relay');
      expect(desktop.extensions).toBe('');
      const validReply = once(desktop, 'message');
      desktop.send(Buffer.alloc(16384));
      expect((await validReply)[0].toString()).toBe('16384');
      expect(received).toHaveBeenCalledTimes(1);
      for (const fragmented of [false, true]) {
        const oversized = await connect('/api/node/desktop-relay');
        const closed = once(oversized, 'close');
        if (fragmented) {
          oversized.send(Buffer.alloc(10000), { fin: false });
          oversized.send(Buffer.alloc(10000), { fin: true });
        } else oversized.send(Buffer.alloc(16385));
        expect((await closed)[0]).toBe(1009);
      }
      expect(received).toHaveBeenCalledTimes(1);
      const deniedOrigin = await connect('/api/desktop/relay', {
        origin: 'http://evil.test',
        cookie: 'mar_user_session=valid-session'
      });
      expect((await once(deniedOrigin, 'close'))[0]).toBe(4003);
      const deniedSession = await connect('/api/desktop/relay', { origin: 'http://trusted.test' });
      expect((await once(deniedSession, 'close'))[0]).toBe(4001);
      const browser = await connect('/api/desktop/relay', {
        origin: 'http://trusted.test',
        cookie: 'mar_user_session=valid-session'
      });
      expect(browserAttached).toHaveBeenCalledWith(expect.anything(), {
        userId: 1,
        sessionHash: 'session-hash'
      });
      browser.terminate();
      const address = app.server.address();
      if (!address || typeof address === 'string') throw new Error('No test listener');
      const raw = net.connect(address.port, '127.0.0.1');
      await once(raw, 'connect');
      const prefix = Buffer.alloc(14);
      prefix[0] = 0x82;
      prefix[1] = 0xff;
      prefix.writeBigUInt64BE(8n * 1024n * 1024n, 2);
      const earlyClose = new Promise<void>((resolve, reject) => {
        let bytes = Buffer.alloc(0);
        const timer = setTimeout(
          () => reject(new Error('Oversized frame was not rejected early')),
          3000
        );
        raw.on('error', reject);
        raw.on('data', (chunk) => {
          bytes = Buffer.concat([bytes, chunk]);
          if (!bytes.includes(Buffer.from([0x88, 2, 3, 0xf1]))) return;
          clearTimeout(timer);
          raw.destroy();
          resolve();
        });
      });
      raw.write(
        Buffer.concat([
          Buffer.from(
            'GET /api/node/desktop-relay HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: MDEyMzQ1Njc4OWFiY2RlZg==\r\n\r\n'
          ),
          prefix
        ])
      );
      await earlyClose;
      expect(received).toHaveBeenCalledTimes(1);
    } finally {
      sockets.forEach((socket) => socket.terminate());
      await app.close();
    }
  }, 15000);
});
