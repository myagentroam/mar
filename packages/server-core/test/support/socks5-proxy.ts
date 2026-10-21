import { connect as connectTcp, createServer as createTcpServer, type Socket } from 'node:net';

export async function startSocks5Proxy(input: {
  readonly targetHost?: string;
  readonly targetPort: number;
  readonly username?: string;
  readonly password?: string;
}) {
  const destinations: Array<{ host: string; port: number }> = [];
  const authentications: Array<{ username: string; password: string }> = [];
  const clients = new Set<Socket>();
  const server = createTcpServer((client) => {
    clients.add(client);
    client.once('close', () => clients.delete(client));
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
    authentications,
    activeConnections: () => clients.size,
    async close() {
      for (const client of clients) client.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error)))
      );
    }
  };
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
