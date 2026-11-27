import { EventEmitter } from 'node:events';
import type { RawData, WebSocket } from 'ws';
import {
  decodeByteFrame,
  decodeTerminalMux,
  encodeTerminalMux,
  TERMINAL_MUX
} from '@myagentroam/protocol';
import type { UserNodeAuthorization } from './node-access-contracts.js';

const MAX_STREAMS = 10;
const MAX_BUFFERED = 1024 * 1024;
export interface TerminalRelaySocket extends Pick<
  WebSocket,
  'OPEN' | 'CLOSING' | 'readyState' | 'bufferedAmount' | 'ping' | 'terminate' | 'close'
> {
  send(data: Uint8Array, callback?: (error?: Error) => void): void;
  on(event: 'message', listener: (raw: RawData, isBinary: boolean) => void): unknown;
  on(event: 'pong', listener: () => void): unknown;
  once(event: 'close', listener: () => void): unknown;
  removeListener(event: 'message', listener: (raw: RawData, isBinary: boolean) => void): unknown;
  removeListener(event: 'close', listener: () => void): unknown;
}

/** Virtual browser endpoint. The physical socket owns heartbeat and authentication. */
export class TerminalMuxStream extends EventEmitter implements TerminalRelaySocket {
  readonly OPEN = 1 as const;
  readonly CLOSING = 2 as const;
  readyState: WebSocket['readyState'] = 1;

  constructor(
    private readonly socket: WebSocket,
    private readonly stream: number,
    private readonly remove: () => void
  ) {
    super();
  }

  get bufferedAmount() {
    return this.socket.bufferedAmount;
  }

  send(data: Uint8Array, done?: (error?: Error) => void) {
    if (this.readyState !== this.OPEN || this.socket.readyState !== this.socket.OPEN) {
      done?.(new Error('TERMINAL_CONNECTION_LOST'));
      return;
    }
    this.socket.send(encodeTerminalMux(TERMINAL_MUX.data, this.stream, data), done);
  }

  ping() {
    this.emit('pong');
  }
  terminate() {
    this.close();
  }

  close(_code?: number, _reason?: string | Buffer, notify = true) {
    if (this.readyState !== this.OPEN) return;
    this.readyState = 3;
    this.remove();
    if (notify && this.socket.readyState === this.socket.OPEN)
      this.socket.send(encodeTerminalMux(TERMINAL_MUX.close, this.stream));
    this.emit('close');
  }
}

/** Demultiplexes a credential-bound socket; existing relay owns each authorized stream. */
export function attachTerminalMux(input: {
  socket: WebSocket;
  authorize: () => Promise<UserNodeAuthorization | undefined>;
  attach: (
    stream: TerminalMuxStream,
    ticket: string,
    deferred: boolean,
    user: UserNodeAuthorization
  ) => void;
}): (code: number, reason: string) => void {
  const { socket } = input;
  const streams = new Map<number, TerminalMuxStream>();
  let lastStream = 0;
  const closeStreams = () => {
    for (const stream of streams.values()) stream.close(undefined, undefined, false);
  };
  const close = (code: number, reason: string) => {
    socket.close(code, reason);
    // Release attachments now, even if the peer has not acknowledged the WebSocket close.
    closeStreams();
  };
  socket.once('close', closeStreams);
  socket.on('message', (raw, binary) => {
    if (socket.readyState !== socket.OPEN) return;
    try {
      if (!binary || !Buffer.isBuffer(raw)) throw new Error('TERMINAL_MUX_INVALID');
      const { type, stream, payload } = decodeTerminalMux(raw);
      if (type === TERMINAL_MUX.ready) throw new Error('TERMINAL_MUX_INVALID');
      if (type === TERMINAL_MUX.open) {
        if (stream <= lastStream) throw new Error('TERMINAL_MUX_INVALID');
        lastStream = stream;
        const { metadata, payload: extra } = decodeByteFrame(payload);
        const { ticket, deferred } = metadata;
        if (
          extra.length ||
          typeof ticket !== 'string' ||
          !ticket ||
          ticket.length > 128 ||
          typeof deferred !== 'boolean' ||
          Object.keys(metadata).length !== 2
        )
          throw new Error('TERMINAL_MUX_INVALID');
        const endpoint = new TerminalMuxStream(socket, stream, () => streams.delete(stream));
        if (streams.size >= MAX_STREAMS || socket.bufferedAmount > MAX_BUFFERED) {
          endpoint.close();
          return;
        }
        streams.set(stream, endpoint);
        void input
          .authorize()
          .then((user) => {
            if (socket.readyState !== socket.OPEN || endpoint.readyState !== endpoint.OPEN) return;
            if (user === undefined) close(1008, 'UNAUTHENTICATED');
            else input.attach(endpoint, ticket, deferred, user);
          })
          .catch(() => {
            // A cancelled OPEN no longer owns a stream and cannot close its siblings.
            if (socket.readyState === socket.OPEN && endpoint.readyState === endpoint.OPEN)
              close(1011, 'USER_AUTHORIZATION_UNAVAILABLE');
          });
        return;
      }
      if (stream > lastStream) throw new Error('TERMINAL_MUX_INVALID');
      const endpoint = streams.get(stream);
      if (type === TERMINAL_MUX.close) endpoint?.close(undefined, undefined, false);
      else if (endpoint && !endpoint.emit('message', payload, true)) endpoint.close();
    } catch {
      close(4002, 'TERMINAL_MUX_INVALID');
    }
  });
  // Upgrading is not admission; do not let the broker dispatch a ticket before these handlers exist.
  socket.send(encodeTerminalMux(TERMINAL_MUX.ready, 0));
  return close;
}
