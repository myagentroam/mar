import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_TERMINAL_MUX_BYTES } from '@myagentroam/protocol/byte-frame';

export const IPC_BUFFER_LIMIT = 1024 * 1024;
export const IPC_HANDSHAKE_MS = 5_000;

export function terminalBrokerAddress({ serverUrl, key, nodeId }, platform = process.platform) {
  const scope = createHash('sha256')
    .update(JSON.stringify(['marctl-terminal-v2', serverUrl, nodeId, key]))
    .digest('hex')
    .slice(0, 32);
  if (platform === 'linux') return `\0marctl-terminal-${scope}`;
  if (platform === 'win32') return `\\\\.\\pipe\\marctl-terminal-${scope}`;
  return join(tmpdir(), `marctl-${scope}.sock`);
}

export function ipcProof(key, role, clientNonce, serverNonce) {
  return createHmac('sha256', key).update(`${role}:${clientNonce}:${serverNonce}`).digest('hex');
}

export function validNonce(value) {
  return typeof value === 'string' && /^[0-9a-f]{32}$/u.test(value);
}

export function matchesIpcProof(value, expected) {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{64}$/u.test(value) &&
    timingSafeEqual(Buffer.from(value, 'hex'), Buffer.from(expected, 'hex'))
  );
}

/** Length-delimits binary messages on a local byte socket, without owning the relay. */
export class TerminalIpc extends EventEmitter {
  #pending = Buffer.alloc(0);
  constructor(socket) {
    super();
    this.socket = socket;
    socket.on('data', (data) => {
      this.#pending = this.#pending.length ? Buffer.concat([this.#pending, data]) : data;
      while (this.#pending.length >= 4) {
        const size = this.#pending.readUInt32BE(0);
        if (size === 0 || size > MAX_TERMINAL_MUX_BYTES) return this.close();
        if (this.#pending.length < 4 + size) return;
        const body = this.#pending.subarray(4, 4 + size);
        this.#pending = this.#pending.subarray(4 + size);
        this.emit('frame', body);
        if (socket.destroyed) return;
      }
    });
    socket.on('error', () => this.close());
    socket.once('close', () => this.emit('close'));
  }

  get bufferedAmount() {
    return this.socket.writableLength;
  }

  send(bytes, done) {
    if (
      this.socket.destroyed ||
      this.socket.writableEnded ||
      bytes.byteLength > MAX_TERMINAL_MUX_BYTES ||
      this.bufferedAmount + bytes.byteLength + 4 > IPC_BUFFER_LIMIT
    ) {
      done?.(new Error('TERMINAL_IPC_UNAVAILABLE'));
      this.close();
      return;
    }
    const frame = Buffer.allocUnsafe(4 + bytes.byteLength);
    frame.writeUInt32BE(bytes.byteLength);
    frame.set(bytes, 4);
    this.socket.write(frame, done);
  }

  end() {
    this.socket.end();
  }
  close() {
    this.socket.destroy();
  }
}
