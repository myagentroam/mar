import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { lstatSync, unlinkSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { MAX_TERMINAL_FRAME_BYTES } from '@myagentroam/protocol/byte-frame';

export const IPC_BUFFER_LIMIT = 1024 * 1024;
export const IPC_HANDSHAKE_MS = 5_000;

export function terminalBrokerAddress(
  { serverUrl, key, nodeId, privateId },
  platform = process.platform
) {
  const scope = createHash('sha256')
    .update(
      JSON.stringify([
        'marctl-terminal-v4',
        serverUrl,
        nodeId,
        key,
        ...(privateId ? [privateId] : [])
      ])
    )
    .digest('hex')
    .slice(0, 32);
  if (platform === 'linux') return `\0marctl-terminal-${scope}`;
  if (platform === 'win32') return `\\\\.\\pipe\\marctl-terminal-${scope}`;
  return join(tmpdir(), `marctl-${scope}.sock`);
}

/** A killed broker can leave a filesystem socket; a live listener or non-socket is never reclaimed. */
export async function listenTerminalBroker(server, address) {
  const listen = () =>
    new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(address, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  try {
    await listen();
  } catch (error) {
    if (error.code !== 'EADDRINUSE' || !isAbsolute(address) || !address.endsWith('.sock'))
      throw error;
    const candidate = socketFile(address);
    if (!candidate?.isSocket() || candidate.uid !== process.getuid()) throw error;
    const refused = await new Promise((resolve) => {
      const probe = createConnection(address);
      const finish = (stale) => {
        probe.destroy();
        resolve(stale);
      };
      probe.once('connect', () => finish(false));
      probe.once('error', (failure) => finish(failure.code === 'ECONNREFUSED'));
      probe.setTimeout(500, () => finish(false));
    });
    if (!refused) throw error;
    const current = socketFile(address);
    if (current?.isSocket() && current.dev === candidate.dev && current.ino === candidate.ino)
      unlinkSync(address);
    await listen();
  }
}

function socketFile(address) {
  return lstatSync(address, { throwIfNoEntry: false });
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
  #paused = false;
  constructor(socket) {
    super();
    this.socket = socket;
    socket.on('data', (data) => {
      this.#pending = this.#pending.length ? Buffer.concat([this.#pending, data]) : data;
      this.#drain();
    });
    socket.on('error', () => this.close());
    socket.once('close', () => this.emit('close'));
  }

  get bufferedAmount() {
    return this.socket.writableLength;
  }

  pause() {
    this.#paused = true;
    this.socket.pause();
  }

  resume() {
    this.#paused = false;
    this.#drain();
    if (!this.#paused && !this.socket.destroyed) this.socket.resume();
  }

  #drain() {
    while (!this.#paused && !this.socket.destroyed && this.#pending.length >= 4) {
      const size = this.#pending.readUInt32BE(0);
      if (size === 0 || size > MAX_TERMINAL_FRAME_BYTES) return this.close();
      if (this.#pending.length < 4 + size) return;
      const body = this.#pending.subarray(4, 4 + size);
      this.#pending = this.#pending.subarray(4 + size);
      this.emit('frame', body);
    }
  }

  send(bytes, done) {
    if (
      this.socket.destroyed ||
      this.socket.writableEnded ||
      bytes.byteLength > MAX_TERMINAL_FRAME_BYTES ||
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
