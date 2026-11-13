import { once } from 'node:events';
import {
  Agent,
  createServer,
  request as createRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from 'node:http';
import { isIP, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';

const notificationWorkerShim = [
  'self.registration.showNotification = async (title, options = {}) => {',
  '  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });',
  '  for (const client of windows) {',
  '    client.postMessage({ type: "test.system-notification.shown", record: { title, options } });',
  '  }',
  '};',
  'self.registration.getNotifications = async () => [];',
  ''
].join('\n');

export interface WorkbenchNotificationProxy {
  readonly origin: string;
  close(): Promise<void>;
}

function loopbackUpstream(baseURL: string): URL {
  const upstream = new URL(baseURL);
  const hostname = upstream.hostname.replace(/^\[|\]$/gu, '');
  const family = isIP(hostname);
  const isLoopback =
    (family === 4 && hostname.startsWith('127.')) || (family === 6 && hostname === '::1');
  if (upstream.protocol !== 'http:' || !isLoopback || upstream.username || upstream.password)
    throw new Error('WORKBENCH_NOTIFICATION_PROXY_REQUIRES_LOOPBACK_HTTP');
  return upstream;
}

function targetURL(request: IncomingMessage, upstream: URL): URL | undefined {
  const path = request.url;
  if (path === undefined || !path.startsWith('/') || path.startsWith('//')) return undefined;
  try {
    const destination = new URL(path, upstream);
    return destination.origin === upstream.origin ? destination : undefined;
  } catch {
    return undefined;
  }
}

function forwardedHeaders(request: IncomingMessage, upstream: URL): IncomingMessage['headers'] {
  return { ...request.headers, host: upstream.host };
}

function writeBadGateway(response: ServerResponse): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
  response.end('Upstream unavailable');
}

function forwardHTTP(
  request: IncomingMessage,
  response: ServerResponse,
  upstream: URL,
  agent: Agent
): void {
  const destination = targetURL(request, upstream);
  if (destination === undefined) {
    response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Invalid request target');
    return;
  }

  const isNotificationWorker =
    request.method === 'GET' && destination.pathname === '/service-worker.js';
  const headers = forwardedHeaders(request, upstream);
  if (isNotificationWorker) headers['accept-encoding'] = 'identity';

  const upstreamRequest = createRequest(
    destination,
    { method: request.method, headers, agent },
    (upstreamResponse) => {
      const statusCode = upstreamResponse.statusCode ?? 502;
      const injectWorkerShim = isNotificationWorker && statusCode === 200;
      const responseHeaders = { ...upstreamResponse.headers };
      if (injectWorkerShim) {
        delete responseHeaders['content-length'];
        delete responseHeaders['content-encoding'];
        delete responseHeaders.etag;
        delete responseHeaders['last-modified'];
        responseHeaders['cache-control'] = 'no-store';
      }
      response.writeHead(statusCode, upstreamResponse.statusMessage, responseHeaders);

      if (!injectWorkerShim) {
        upstreamResponse.pipe(response);
        return;
      }

      const chunks: Buffer[] = [];
      upstreamResponse.on('data', (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      upstreamResponse.on('end', () => {
        response.end(Buffer.concat([Buffer.from(notificationWorkerShim), ...chunks]));
      });
      upstreamResponse.on('error', () => response.destroy());
    }
  );

  upstreamRequest.on('error', () => writeBadGateway(response));
  request.on('aborted', () => upstreamRequest.destroy());
  response.on('close', () => {
    if (!response.writableFinished) upstreamRequest.destroy();
  });
  request.pipe(upstreamRequest);
}

function writeUpgradeResponse(socket: Duplex, response: IncomingMessage): void {
  const statusCode = response.statusCode ?? 502;
  const statusMessage = response.statusMessage ?? '';
  const headers = Object.entries(response.headers).flatMap(([name, value]) =>
    value === undefined
      ? []
      : (Array.isArray(value) ? value : [value]).map((entry) => `${name}: ${entry}`)
  );
  socket.write(
    `HTTP/${response.httpVersion} ${statusCode} ${statusMessage}\r\n${headers.join('\r\n')}\r\n\r\n`
  );
}

function forwardUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  upstream: URL,
  agent: Agent
): void {
  const destination = targetURL(request, upstream);
  if (destination === undefined) {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return;
  }

  const upstreamRequest = createRequest(destination, {
    method: request.method,
    headers: forwardedHeaders(request, upstream),
    agent
  });
  upstreamRequest.on('upgrade', (response, upstreamSocket, upstreamHead) => {
    writeUpgradeResponse(socket, response);
    if (upstreamHead.length > 0) socket.write(upstreamHead);
    if (head.length > 0) upstreamSocket.write(head);
    upstreamSocket.pipe(socket);
    socket.pipe(upstreamSocket);
    socket.on('close', () => upstreamSocket.destroy());
    upstreamSocket.on('close', () => socket.destroy());
  });
  upstreamRequest.on('response', (response) => {
    writeUpgradeResponse(socket, response);
    response.pipe(socket);
  });
  upstreamRequest.on('error', () => {
    if (!socket.destroyed) socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
  });
  socket.on('close', () => upstreamRequest.destroy());
  upstreamRequest.end();
}

export async function createWorkbenchNotificationProxy(
  baseURL: string
): Promise<WorkbenchNotificationProxy> {
  const upstream = loopbackUpstream(baseURL);
  const agent = new Agent({ keepAlive: false });
  const sockets = new Set<Socket>();
  const server: Server = createServer((request, response) =>
    forwardHTTP(request, response, upstream, agent)
  );
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (request, socket, head) =>
    forwardUpgrade(request, socket, head, upstream, agent)
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address();
  if (address === null || typeof address === 'string') {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error)))
    );
    agent.destroy();
    throw new Error('WORKBENCH_NOTIFICATION_PROXY_ADDRESS_UNAVAILABLE');
  }

  let closePromise: Promise<void> | undefined;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close() {
      closePromise ??= new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
        for (const socket of sockets) socket.destroy();
        agent.destroy();
      });
      return closePromise;
    }
  };
}
