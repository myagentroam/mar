import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { createConnection } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createWorkbenchNotificationProxy } from '../e2e/support/workbench-notification-proxy.js';

function createCounterServer() {
  let httpRequests = 0;
  let upgradeRequests = 0;
  const server = createServer((_request, response) => {
    httpRequests += 1;
    response.end('local sentinel');
  });
  server.on('upgrade', (_request, socket) => {
    upgradeRequests += 1;
    socket.end(
      'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'
    );
  });
  return {
    server,
    counts: () => ({ httpRequests, upgradeRequests })
  };
}

async function listen(server: Server): Promise<URL> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('LOCAL_SERVER_ADDRESS_MISSING');
  return new URL(`http://127.0.0.1:${address.port}`);
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

function readStatusLine(origin: URL, path: string, upgrade: boolean): Promise<string> {
  const socket = createConnection({ host: origin.hostname, port: Number(origin.port) });
  return new Promise((resolve, reject) => {
    let response = '';
    socket.setEncoding('latin1');
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.write(
        [
          `GET ${path} HTTP/1.1`,
          `Host: ${origin.host}`,
          upgrade ? 'Connection: Upgrade' : 'Connection: close',
          ...(upgrade ? ['Upgrade: websocket', 'Sec-WebSocket-Version: 13'] : []),
          '',
          ''
        ].join('\r\n')
      );
    });
    socket.on('data', (chunk) => {
      response += chunk;
      const lineEnd = response.indexOf('\r\n');
      if (lineEnd < 0) return;
      const statusLine = response.slice(0, lineEnd);
      socket.destroy();
      resolve(statusLine);
    });
  });
}

describe('workbench notification proxy', () => {
  it('rejects backslash origin escapes on HTTP and Upgrade without forwarding off-origin', async () => {
    const upstream = createCounterServer();
    const sentinel = createCounterServer();
    let upstreamListening = false;
    let sentinelListening = false;
    let proxy: Awaited<ReturnType<typeof createWorkbenchNotificationProxy>> | undefined;
    try {
      const upstreamOrigin = await listen(upstream.server);
      upstreamListening = true;
      const sentinelOrigin = await listen(sentinel.server);
      sentinelListening = true;
      proxy = await createWorkbenchNotificationProxy(upstreamOrigin.origin);

      const escapedPath = `/${String.fromCharCode(92)}127.0.0.1:${sentinelOrigin.port}/escape`;
      expect(new URL(escapedPath, upstreamOrigin).origin).toBe(sentinelOrigin.origin);
      expect(await readStatusLine(new URL(proxy.origin), escapedPath, false)).toBe(
        'HTTP/1.1 400 Bad Request'
      );
      expect(await readStatusLine(new URL(proxy.origin), escapedPath, true)).toBe(
        'HTTP/1.1 400 Bad Request'
      );
      expect(upstream.counts()).toEqual({ httpRequests: 0, upgradeRequests: 0 });
      expect(sentinel.counts()).toEqual({ httpRequests: 0, upgradeRequests: 0 });
    } finally {
      await proxy?.close();
      if (sentinelListening) await closeServer(sentinel.server);
      if (upstreamListening) await closeServer(upstream.server);
    }
  });
});
