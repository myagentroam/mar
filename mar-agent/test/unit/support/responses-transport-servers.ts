import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createSecureServer as createHttp2SecureServer } from 'node:http2';
import { createServer as createHttpsServer } from 'node:https';
import { join } from 'node:path';
import { connect as connectTcp, createServer as createTcpServer, type Socket } from 'node:net';
import { createServer as createHttpServer } from 'node:http';

export interface CloseableServer {
  close(callback: (error?: Error) => void): void;
}

async function tlsFixture() {
  const fixtures = join(process.cwd(), 'test', 'fixtures');
  const [key, cert] = await Promise.all([
    readFile(join(fixtures, 'localhost-test-key.pem')),
    readFile(join(fixtures, 'localhost-test-cert.pem'))
  ]);
  return { key, cert };
}

export async function startHttp2ResponsesServer(events: readonly unknown[]) {
  const protocols: string[] = [];
  const requests: unknown[] = [];
  const server = createHttp2SecureServer(await tlsFixture());
  server.on('session', (session) => {
    protocols.push(session.socket.alpnProtocol ?? '');
  });
  server.on('stream', (stream) => {
    let body = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => (body += chunk));
    stream.on('end', () => {
      requests.push(JSON.parse(body));
      stream.respond({ ':status': 200, 'content-type': 'text/event-stream' });
      stream.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
    });
  });
  await listen(server);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server unavailable');
  return {
    server,
    baseUrl: `https://127.0.0.1:${address.port}`,
    protocols,
    requests
  };
}

export async function startHttps1ResponsesServer(events: readonly unknown[]) {
  let requests = 0;
  const server = createHttpsServer(await tlsFixture(), (request, response) => {
    requests++;
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
    });
  });
  await listen(server);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server unavailable');
  return {
    server,
    baseUrl: `https://127.0.0.1:${address.port}`,
    requests: () => requests
  };
}

export async function startResponsesWebSocketServer(
  events: readonly unknown[] | readonly (readonly unknown[])[],
  options: {
    readonly closeAfterRequestIndexes?: readonly number[];
    readonly closeWhenEmpty?: boolean;
    readonly handshakeStatuses?: readonly number[];
    readonly rawResponseFrames?: readonly Buffer[];
    readonly responsesByConnection?: readonly (readonly (readonly unknown[])[])[];
    readonly responsesByRequest?: readonly (readonly unknown[])[];
    readonly responseFrameDelaysByRequest?: readonly (readonly number[])[];
    readonly maxClientFrameBytes?: number;
  } = {}
) {
  const requests: unknown[] = [];
  const clientFrames: Array<{ bytes: number; opcode: number; fin: boolean; connection: number }> =
    [];
  const handshakes: Array<Record<string, string | string[] | undefined>> = [];
  let connections = 0;
  let closedConnections = 0;
  const server = createHttpServer((_request, response) => {
    response.writeHead(426, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({ error: { code: 'upgrade_required', message: 'Use WebSocket.' } })
    );
  });
  server.on('upgrade', (request, socket) => {
    const handshakeIndex = handshakes.length;
    handshakes.push(request.headers);
    const handshakeStatus = options.handshakeStatuses?.[handshakeIndex];
    if (handshakeStatus !== undefined && handshakeStatus !== 101) {
      const body = JSON.stringify({ error: { code: 'unauthorized', message: 'expired' } });
      socket.end(
        [
          `HTTP/1.1 ${handshakeStatus} Unauthorized`,
          'Content-Type: application/json',
          `Content-Length: ${Buffer.byteLength(body)}`,
          'Connection: close',
          '',
          body
        ].join('\r\n')
      );
      return;
    }
    const key = request.headers['sec-websocket-key'];
    if (typeof key !== 'string') {
      socket.destroy();
      return;
    }
    connections++;
    const connectionIndex = connections - 1;
    let requestIndex = 0;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    socket.on('error', () => undefined);
    socket.once('close', () => {
      closedConnections++;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    });
    socket.once('end', () => {
      if (!socket.writableEnded) socket.end();
    });
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${createHash('sha1')
          .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
          .digest('base64')}`,
        '',
        ''
      ].join('\r\n')
    );
    readClientTextFrames(
      socket,
      (text) => {
        const globalRequestIndex = requests.length;
        requests.push(JSON.parse(text));
        if (options.rawResponseFrames !== undefined) {
          for (const frame of options.rawResponseFrames) socket.write(frame);
          return;
        }
        const responseEvents =
          options.responsesByRequest?.[globalRequestIndex] ??
          options.responsesByConnection?.[connectionIndex]?.[requestIndex++] ??
          (Array.isArray(events[0])
            ? ((events as readonly (readonly unknown[])[])[connectionIndex] ?? [])
            : (events as readonly unknown[]));
        const delays = options.responseFrameDelaysByRequest?.[globalRequestIndex];
        for (const [index, event] of responseEvents.entries()) {
          const send = () => socket.write(serverTextFrame(JSON.stringify(event)));
          const delay = delays?.[index] ?? 0;
          if (delay > 0) {
            const timer = setTimeout(() => {
              timers.delete(timer);
              if (!socket.destroyed) send();
            }, delay);
            timers.add(timer);
          } else send();
        }
        if (options.closeAfterRequestIndexes?.includes(globalRequestIndex))
          socket.end(serverCloseFrame());
        else if (responseEvents.length === 0 && options.closeWhenEmpty !== false)
          socket.end(serverCloseFrame());
      },
      (frame) => {
        clientFrames.push({ ...frame, connection: connectionIndex });
        if (
          options.maxClientFrameBytes !== undefined &&
          frame.bytes > options.maxClientFrameBytes
        ) {
          socket.end(serverFrame(0x8, Buffer.from([0x03, 0xf1])));
          return false;
        }
        return true;
      }
    );
  });
  await listen(server);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server unavailable');
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    clientFrames,
    handshakes,
    connections: () => connections,
    closedConnections: () => closedConnections
  };
}

export async function startSocks5Proxy(input: {
  readonly targetHost?: string;
  readonly targetPort: number;
  readonly username?: string;
  readonly password?: string;
}) {
  const destinations: Array<{ host: string; port: number }> = [];
  const authentications: Array<{ username: string; password: string }> = [];
  const server = createTcpServer((client) => {
    client.on('error', () => undefined);
    let buffer = Buffer.alloc(0);
    let state: 'GREETING' | 'AUTH' | 'CONNECT' | 'TUNNEL' = 'GREETING';
    const consume = () => {
      while (state !== 'TUNNEL') {
        if (state === 'GREETING') {
          if (buffer.length < 2) return;
          const methodCount = buffer[1]!;
          if (buffer.length < 2 + methodCount) return;
          const methods = buffer.subarray(2, 2 + methodCount);
          buffer = buffer.subarray(2 + methodCount);
          const requiresAuth = input.username !== undefined;
          const method = requiresAuth ? 0x02 : 0x00;
          if (!methods.includes(method)) {
            client.end(Buffer.from([0x05, 0xff]));
            return;
          }
          client.write(Buffer.from([0x05, method]));
          state = requiresAuth ? 'AUTH' : 'CONNECT';
          continue;
        }
        if (state === 'AUTH') {
          if (buffer.length < 2) return;
          const usernameLength = buffer[1]!;
          if (buffer.length < 2 + usernameLength + 1) return;
          const passwordLength = buffer[2 + usernameLength]!;
          if (buffer.length < 3 + usernameLength + passwordLength) return;
          const username = buffer.subarray(2, 2 + usernameLength).toString('utf8');
          const password = buffer
            .subarray(3 + usernameLength, 3 + usernameLength + passwordLength)
            .toString('utf8');
          buffer = buffer.subarray(3 + usernameLength + passwordLength);
          authentications.push({ username, password });
          if (username !== input.username || password !== input.password) {
            client.end(Buffer.from([0x01, 0x01]));
            return;
          }
          client.write(Buffer.from([0x01, 0x00]));
          state = 'CONNECT';
          continue;
        }
        if (buffer.length < 5) return;
        const addressType = buffer[3]!;
        let host: string;
        let offset: number;
        if (addressType === 0x03) {
          const hostLength = buffer[4]!;
          if (buffer.length < 7 + hostLength) return;
          host = buffer.subarray(5, 5 + hostLength).toString('utf8');
          offset = 5 + hostLength;
        } else if (addressType === 0x01) {
          if (buffer.length < 10) return;
          host = [...buffer.subarray(4, 8)].join('.');
          offset = 8;
        } else {
          client.end(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          return;
        }
        const port = buffer.readUInt16BE(offset);
        buffer = buffer.subarray(offset + 2);
        destinations.push({ host, port });
        const upstream = connectTcp(input.targetPort, input.targetHost ?? '127.0.0.1');
        upstream.once('connect', () => {
          client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
          state = 'TUNNEL';
          if (buffer.length > 0) upstream.write(buffer);
          client.pipe(upstream);
          upstream.pipe(client);
        });
        upstream.once('error', () => {
          if (!client.destroyed && !client.writableEnded)
            client.end(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        });
        return;
      }
    };
    client.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      consume();
    });
  });
  await listen(server);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server unavailable');
  return {
    server,
    url: `socks5://${input.username === undefined ? '' : `${encodeURIComponent(input.username)}:${encodeURIComponent(input.password ?? '')}@`}127.0.0.1:${address.port}`,
    destinations,
    authentications
  };
}

function readClientTextFrames(
  socket: Socket,
  onText: (text: string) => void,
  onFrame: (frame: { bytes: number; opcode: number; fin: boolean }) => boolean
): void {
  let buffer = Buffer.alloc(0);
  let fragments: Buffer[] = [];
  let stopped = false;
  socket.on('data', (chunk: Buffer) => {
    if (stopped) return;
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const opcode = buffer[0]! & 0x0f;
      const fin = (buffer[0]! & 0x80) !== 0;
      const masked = (buffer[1]! & 0x80) !== 0;
      let length = buffer[1]! & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        const largeLength = buffer.readBigUInt64BE(2);
        if (largeLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('frame too large');
        length = Number(largeLength);
        offset = 10;
      }
      const maskBytes = masked ? 4 : 0;
      if (buffer.length < offset + maskBytes + length) return;
      if (!onFrame({ bytes: length, opcode, fin })) {
        stopped = true;
        buffer = Buffer.alloc(0);
        fragments = [];
        return;
      }
      const mask = masked ? buffer.subarray(offset, offset + 4) : undefined;
      offset += maskBytes;
      const payload = Buffer.from(buffer.subarray(offset, offset + length));
      buffer = buffer.subarray(offset + length);
      if (mask)
        for (let index = 0; index < payload.length; index++)
          payload[index] = payload[index]! ^ mask[index % 4]!;
      if (opcode === 0x1 || opcode === 0x0) {
        fragments.push(payload);
        if (fin) {
          onText(Buffer.concat(fragments).toString('utf8'));
          fragments = [];
        }
      } else if (opcode === 0x8 && !socket.destroyed && !socket.writableEnded)
        socket.end(serverCloseFrame());
    }
  });
}

function serverTextFrame(text: string): Buffer {
  return serverFrame(0x1, Buffer.from(text));
}

function serverCloseFrame(): Buffer {
  return serverFrame(0x8, Buffer.alloc(0));
}

function serverFrame(opcode: number, payload: Buffer): Buffer {
  if (payload.length < 126)
    return Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]);
  if (payload.length <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(payload.length), 2);
  return Buffer.concat([header, payload]);
}

async function listen(server: { listen(...args: unknown[]): unknown }): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const value = server as {
      listen(port: number, host: string, callback: () => void): void;
      once(event: 'error', listener: (error: Error) => void): void;
      off(event: 'error', listener: (error: Error) => void): void;
    };
    const onError = (error: Error) => reject(error);
    value.once('error', onError);
    value.listen(0, '127.0.0.1', () => {
      value.off('error', onError);
      resolve();
    });
  });
}
