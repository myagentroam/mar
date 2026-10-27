import { connect as connectTcp, type Socket } from 'node:net';
import { connect as connectTls } from 'node:tls';
import {
  Client,
  Socks5ProxyAgent,
  buildConnector,
  fetch as undiciFetch,
  type Dispatcher
} from 'undici';
import { TransportFault } from './transport-error.js';

const SOCKS5_HANDSHAKE_TIMEOUT_MS = 10_000;

export interface HttpAttempt {
  readonly request: RequestInit;
  readonly httpVersion: '1.1' | '2';
  readonly socks5Url?: string;
}

export type HttpRequestInit =
  RequestInit | HttpAttempt | (() => Promise<RequestInit | HttpAttempt>);

export async function fetchWithConnectionTimeout(
  url: string,
  attempt: HttpAttempt,
  signal: AbortSignal,
  connectionTimeoutMs: number
): Promise<Response> {
  if (signal.aborted) throw signal.reason;
  const controller = new AbortController();
  const timeoutError = new TransportFault('connection-timeout', 'Connection timed out.');
  let rejectInterruption: (reason: unknown) => void = () => undefined;
  const interruption = new Promise<never>((_resolve, reject) => {
    rejectInterruption = reject;
  });
  const abortFromCaller = () => {
    const reason = signal.reason;
    controller.abort(reason);
    rejectInterruption(reason);
  };
  signal.addEventListener('abort', abortFromCaller, { once: true });
  const timeout = setTimeout(
    () => {
      controller.abort(timeoutError);
      rejectInterruption(timeoutError);
    },
    Math.max(1, connectionTimeoutMs)
  );
  try {
    return await Promise.race([fetchHttpAttempt(url, attempt, controller.signal), interruption]);
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abortFromCaller);
  }
}

async function fetchHttpAttempt(
  url: string,
  attempt: HttpAttempt,
  signal: AbortSignal
): Promise<Response> {
  if (attempt.httpVersion === '1.1' && attempt.socks5Url === undefined)
    return await fetch(url, { ...attempt.request, signal });

  const dispatcher =
    attempt.socks5Url === undefined
      ? http2Client(url)
      : attempt.httpVersion === '2'
        ? http2SocksClient(url, attempt.socks5Url)
        : new Socks5ProxyAgent(attempt.socks5Url);
  try {
    const response = await undiciFetch(url, {
      ...(attempt.request as Parameters<typeof undiciFetch>[1]),
      signal,
      dispatcher
    });
    return responseWithDispatcherLifecycle(response as unknown as Response, dispatcher);
  } catch (error) {
    await dispatcher.destroy(error instanceof Error ? error : null).catch(() => undefined);
    if (hasErrorCode(error, 'MAR_AGENT_HTTP2_NEGOTIATION_FAILED'))
      throw new TransportFault('http2-negotiation', 'HTTP/2 negotiation failed.', error);
    throw error;
  }
}

function http2Client(url: string): Client {
  return new Client(new URL(url).origin, {
    allowH2: true,
    connect: strictHttp2Connector()
  });
}

function http2SocksClient(url: string, socks5Url: string): Client {
  return new Client(new URL(url).origin, {
    allowH2: true,
    connect: async (options, callback) => {
      try {
        const tlsSocket = await connectSocks5Target({
          socks5Url,
          targetHost: options.hostname,
          targetPort: Number(options.port || 443),
          tls: true,
          servername: options.servername || options.hostname,
          alpnProtocols: ['h2'],
          requiredAlpnProtocol: 'h2'
        });
        callback(null, tlsSocket);
      } catch (error) {
        callback(asError(error), null);
      }
    }
  });
}

export async function connectSocks5Target(input: {
  readonly socks5Url: string;
  readonly targetHost: string;
  readonly targetPort: number;
  readonly tls: boolean;
  readonly servername?: string;
  readonly alpnProtocols?: readonly string[];
  readonly requiredAlpnProtocol?: string;
  readonly signal?: AbortSignal;
}): Promise<Socket> {
  if (input.signal?.aborted) throw input.signal.reason;
  const proxy = parseSocks5Proxy(input.socks5Url);
  const targetHost = Buffer.from(input.targetHost, 'utf8');
  if (
    targetHost.length === 0 ||
    targetHost.length > 255 ||
    !Number.isSafeInteger(input.targetPort) ||
    input.targetPort < 1 ||
    input.targetPort > 65_535
  )
    throw invalidSocks5Proxy();

  const socket = connectTcp({ host: proxy.hostname, port: proxy.port });
  const timeoutError = Object.assign(new Error('SOCKS5 connection timed out.'), {
    code: 'ETIMEDOUT'
  });
  const abort = () => socket.destroy(asError(input.signal?.reason));
  const timeout = () => socket.destroy(timeoutError);
  input.signal?.addEventListener('abort', abort, { once: true });
  socket.setTimeout(SOCKS5_HANDSHAKE_TIMEOUT_MS);
  socket.once('timeout', timeout);
  try {
    await waitForSocketConnect(socket);
    const methods = proxy.username === undefined ? [0x00] : [0x00, 0x02];
    await writeSocket(socket, Buffer.from([0x05, methods.length, ...methods]));
    const greeting = await readSocketExactly(socket, 2);
    if (greeting[0] !== 0x05 || greeting[1] === 0xff)
      throw socks5ProtocolError('EACCES', 'SOCKS5 proxy rejected authentication methods.');
    if (greeting[1] === 0x02) {
      if (proxy.username === undefined || proxy.password === undefined)
        throw socks5ProtocolError('EACCES', 'SOCKS5 proxy requires authentication.');
      const username = Buffer.from(proxy.username, 'utf8');
      const password = Buffer.from(proxy.password, 'utf8');
      await writeSocket(
        socket,
        Buffer.concat([
          Buffer.from([0x01, username.length]),
          username,
          Buffer.from([password.length]),
          password
        ])
      );
      const authentication = await readSocketExactly(socket, 2);
      if (authentication[0] !== 0x01 || authentication[1] !== 0x00)
        throw socks5ProtocolError('EACCES', 'SOCKS5 proxy authentication failed.');
    } else if (greeting[1] !== 0x00)
      throw socks5ProtocolError('EACCES', 'SOCKS5 proxy selected an unsupported method.');

    const port = Buffer.allocUnsafe(2);
    port.writeUInt16BE(input.targetPort);
    await writeSocket(
      socket,
      Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, targetHost.length]), targetHost, port])
    );
    const reply = await readSocketExactly(socket, 4);
    if (reply[0] !== 0x05 || reply[2] !== 0x00)
      throw socks5ProtocolError('EPROTO', 'SOCKS5 proxy returned an invalid response.');
    if (reply[1] !== 0x00) throw socks5ReplyError(reply[1]!);
    await consumeSocks5BoundAddress(socket, reply[3]!);
    socket.setTimeout(0);
    socket.off('timeout', timeout);
    input.signal?.removeEventListener('abort', abort);
    if (!input.tls) return socket;

    return await upgradeSocks5Tls(socket, input);
  } catch (error) {
    socket.destroy();
    throw error;
  } finally {
    socket.off('timeout', timeout);
    input.signal?.removeEventListener('abort', abort);
  }
}

function parseSocks5Proxy(value: string): {
  readonly hostname: string;
  readonly port: number;
  readonly username?: string;
  readonly password?: string;
} {
  try {
    const url = new URL(value);
    const port = url.port === '' ? 1080 : Number(url.port);
    if (
      url.protocol !== 'socks5:' ||
      url.hostname.length === 0 ||
      !Number.isSafeInteger(port) ||
      port < 1 ||
      port > 65_535 ||
      (url.pathname !== '' && url.pathname !== '/') ||
      url.search !== '' ||
      url.hash !== ''
    )
      throw invalidSocks5Proxy();
    const hasAuthentication = url.username !== '' || url.password !== '';
    const username = hasAuthentication ? decodeURIComponent(url.username) : undefined;
    const password = hasAuthentication ? decodeURIComponent(url.password) : undefined;
    if (
      (hasAuthentication && username?.length === 0) ||
      (username !== undefined && Buffer.byteLength(username) > 255) ||
      (password !== undefined && Buffer.byteLength(password) > 255)
    )
      throw invalidSocks5Proxy();
    return {
      hostname: url.hostname,
      port,
      ...(username === undefined ? {} : { username, password: password ?? '' })
    };
  } catch (cause) {
    if (cause instanceof TransportFault) throw cause;
    throw invalidSocks5Proxy(cause);
  }
}

async function waitForSocketConnect(socket: Socket): Promise<void> {
  if (socket.readyState === 'open') return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      socket.off('connect', connected);
      socket.off('error', failed);
      socket.off('close', closed);
    };
    const connected = () => {
      cleanup();
      resolve();
    };
    const failed = (error: Error) => {
      cleanup();
      reject(error);
    };
    const closed = () => {
      cleanup();
      reject(Object.assign(new Error('SOCKS5 proxy connection closed.'), { code: 'ECONNRESET' }));
    };
    socket.once('connect', connected);
    socket.once('error', failed);
    socket.once('close', closed);
  });
}

async function writeSocket(socket: Socket, value: Uint8Array): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.write(value, (error) => (error ? reject(error) : resolve()));
  });
}

async function readSocketExactly(socket: Socket, length: number): Promise<Buffer> {
  while (socket.readableLength < length) {
    if (socket.readableEnded || socket.destroyed)
      throw Object.assign(new Error('SOCKS5 proxy connection ended early.'), {
        code: 'ECONNRESET'
      });
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        socket.off('readable', readable);
        socket.off('error', failed);
        socket.off('end', ended);
        socket.off('close', ended);
      };
      const readable = () => {
        cleanup();
        resolve();
      };
      const failed = (error: Error) => {
        cleanup();
        reject(error);
      };
      const ended = () => {
        cleanup();
        reject(
          Object.assign(new Error('SOCKS5 proxy connection ended early.'), {
            code: 'ECONNRESET'
          })
        );
      };
      socket.once('readable', readable);
      socket.once('error', failed);
      socket.once('end', ended);
      socket.once('close', ended);
    });
  }
  const value = socket.read(length);
  if (!Buffer.isBuffer(value) || value.length !== length)
    throw socks5ProtocolError('EPROTO', 'SOCKS5 proxy returned an invalid response.');
  return value;
}

async function consumeSocks5BoundAddress(socket: Socket, addressType: number): Promise<void> {
  if (addressType === 0x01) {
    await readSocketExactly(socket, 6);
    return;
  }
  if (addressType === 0x04) {
    await readSocketExactly(socket, 18);
    return;
  }
  if (addressType === 0x03) {
    const length = (await readSocketExactly(socket, 1))[0]!;
    await readSocketExactly(socket, length + 2);
    return;
  }
  throw socks5ProtocolError('EPROTO', 'SOCKS5 proxy returned an invalid address.');
}

async function upgradeSocks5Tls(
  socket: Socket,
  input: {
    readonly servername?: string;
    readonly targetHost: string;
    readonly alpnProtocols?: readonly string[];
    readonly requiredAlpnProtocol?: string;
    readonly signal?: AbortSignal;
  }
): Promise<Socket> {
  const tlsSocket = connectTls({
    socket,
    servername: input.servername ?? input.targetHost,
    ...(input.alpnProtocols === undefined ? {} : { ALPNProtocols: [...input.alpnProtocols] })
  });
  const abort = () => tlsSocket.destroy(asError(input.signal?.reason));
  const timeoutError = Object.assign(new Error('TLS connection timed out.'), {
    code: 'ETIMEDOUT'
  });
  const timeout = () => tlsSocket.destroy(timeoutError);
  input.signal?.addEventListener('abort', abort, { once: true });
  tlsSocket.setTimeout(SOCKS5_HANDSHAKE_TIMEOUT_MS);
  tlsSocket.once('timeout', timeout);
  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        tlsSocket.off('secureConnect', connected);
        tlsSocket.off('error', failed);
        tlsSocket.off('close', closed);
      };
      const connected = () => {
        cleanup();
        resolve();
      };
      const failed = (error: Error) => {
        cleanup();
        reject(error);
      };
      const closed = () => {
        cleanup();
        reject(Object.assign(new Error('TLS connection closed early.'), { code: 'ECONNRESET' }));
      };
      tlsSocket.once('secureConnect', connected);
      tlsSocket.once('error', failed);
      tlsSocket.once('close', closed);
    });
    tlsSocket.setTimeout(0);
    tlsSocket.off('timeout', timeout);
    if (
      input.requiredAlpnProtocol !== undefined &&
      tlsSocket.alpnProtocol !== input.requiredAlpnProtocol
    )
      throw http2NegotiationError();
    return tlsSocket;
  } catch (error) {
    tlsSocket.destroy();
    throw error;
  } finally {
    tlsSocket.off('timeout', timeout);
    input.signal?.removeEventListener('abort', abort);
  }
}

function socks5ReplyError(reply: number): Error & { code: string } {
  const code =
    reply === 0x03
      ? 'ENETUNREACH'
      : reply === 0x04
        ? 'EHOSTUNREACH'
        : reply === 0x05
          ? 'ECONNREFUSED'
          : reply === 0x06
            ? 'ETIMEDOUT'
            : reply === 0x07
              ? 'EPROTONOSUPPORT'
              : reply === 0x08
                ? 'EAFNOSUPPORT'
                : 'EIO';
  return socks5ProtocolError(code, 'SOCKS5 proxy could not connect to the endpoint.');
}

function socks5ProtocolError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function invalidSocks5Proxy(cause?: unknown): TransportFault {
  return new TransportFault('invalid-proxy', 'SOCKS5 proxy URL is invalid.', cause);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Transport failed.', { cause: error });
}

function strictHttp2Connector(): ReturnType<typeof buildConnector> {
  const connector = buildConnector({ allowH2: true });
  return (options, callback) =>
    connector(options, (error, socket) => {
      if (error || socket === null) {
        callback(error, socket);
        return;
      }
      if (!('alpnProtocol' in socket) || socket.alpnProtocol !== 'h2') {
        const negotiationError = http2NegotiationError();
        socket.destroy(negotiationError);
        callback(negotiationError, null);
        return;
      }
      callback(null, socket);
    });
}

function http2NegotiationError(): Error & { code: string } {
  return Object.assign(new Error('HTTP/2 ALPN negotiation failed.'), {
    code: 'MAR_AGENT_HTTP2_NEGOTIATION_FAILED'
  });
}

function responseWithDispatcherLifecycle(response: Response, dispatcher: Dispatcher): Response {
  if (response.body === null) {
    void dispatcher.close();
    return response;
  }
  const reader = response.body.getReader();
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await dispatcher.close().catch(() => undefined);
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          controller.close();
          await close();
        } else controller.enqueue(result.value);
      } catch (error) {
        controller.error(error);
        await close();
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
      await close();
    }
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}

export function isModelHttpAttempt(value: RequestInit | HttpAttempt): value is HttpAttempt {
  return 'request' in value && (value.httpVersion === '1.1' || value.httpVersion === '2');
}

export function hasErrorCode(error: unknown, code: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current !== null && typeof current === 'object'; depth++) {
    const value = current as { code?: unknown; cause?: unknown };
    if (value.code === code) return true;
    current = value.cause;
  }
  return false;
}
