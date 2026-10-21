import { fork } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { DirectFallbackError, DirectUnsafeError } from './direct.mjs';

const CLEANUP_TIMEOUT_MS = 1000;
const MAX_BUFFER_BYTES = 2 * 1024 * 1024;
const ipcBytes = new WeakMap();

function sendIpc(target, message, onError = () => {}, onSent = () => {}) {
  const bytes = Buffer.byteLength(JSON.stringify(message));
  const pending = ipcBytes.get(target) ?? 0;
  if (!target.connected || pending + bytes > MAX_BUFFER_BYTES) {
    onError(new Error('TERMINAL_CONNECTION_LOST'));
    return false;
  }
  ipcBytes.set(target, pending + bytes);
  try {
    target.send(message, (error) => {
      ipcBytes.set(target, (ipcBytes.get(target) ?? 0) - bytes);
      if (error) onError(error);
      else onSent();
    });
    return true;
  } catch (error) {
    ipcBytes.set(target, (ipcBytes.get(target) ?? 0) - bytes);
    onError(error);
    return false;
  }
}

export function openDirectTerminalProcess({
  connection,
  nodeId,
  terminalId,
  manifest,
  afterSequence = 0,
  timeoutMs = 15000,
  heartbeatMs = 10000,
  onPrepared,
  onIceConnected,
  onTransportReady,
  signal,
  forkImpl = fork
}) {
  if (signal?.aborted) return Promise.reject(new DirectFallbackError('DIRECT_RACE_CANCELLED'));
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = forkImpl(new URL('./direct-process.mjs', import.meta.url), [], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        execArgv: []
      });
    } catch {
      reject(new DirectFallbackError('DIRECT_UNAVAILABLE'));
      return;
    }
    let settled = false;
    let opening = false;
    let stopping = false;
    let exited = false;
    let cleanupTimer;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      clearTimeout(setupTimer);
      signal?.removeEventListener('abort', onAbort);
      if (exited) return;
      sendIpc(child, { type: 'abort' });
      // Native cleanup may block. Only this connection's process is terminated.
      cleanupTimer = setTimeout(() => child.kill('SIGKILL'), CLEANUP_TIMEOUT_MS);
    };
    const transport = new IsolatedDirectTransport(child, stop);
    const fail = (error) => {
      if (settled) {
        transport.fail(error);
      } else {
        settled = true;
        reject(error);
        stop();
      }
    };
    const setupError = () =>
      opening
        ? new DirectUnsafeError('DIRECT_OPEN_CANCEL_UNCONFIRMED')
        : new DirectFallbackError('DIRECT_UNAVAILABLE');
    const setupTimer = setTimeout(() => fail(setupError()), timeoutMs);
    const onAbort = () =>
      fail(
        opening
          ? new DirectUnsafeError('DIRECT_OPEN_CANCEL_UNCONFIRMED')
          : new DirectFallbackError('DIRECT_RACE_CANCELLED')
      );
    child.on('message', (message) => {
      if (message.type === 'callback') {
        const callback = { prepared: onPrepared, ice: onIceConnected, transport: onTransportReady }[
          message.event
        ];
        if (message.event === 'opening') opening = true;
        Promise.resolve()
          .then(() => {
            if (stopping) throw new DirectFallbackError('DIRECT_RACE_CANCELLED');
            return callback?.();
          })
          .then(
            () =>
              sendIpc(child, { type: 'callback.result', id: message.id }, () => fail(setupError())),
            () => sendIpc(child, { type: 'callback.result', id: message.id, failed: true })
          );
      } else if (message.type === 'attached' && !settled) {
        settled = true;
        clearTimeout(setupTimer);
        resolve(transport);
      } else if (message.type === 'failure') {
        const error = settled
          ? new Error(message.code ?? 'TERMINAL_CONNECTION_LOST')
          : message.name === 'DirectUnsafeError' ||
              (opening && message.name !== 'DirectFallbackError')
            ? new DirectUnsafeError(message.code)
            : new DirectFallbackError(message.code);
        fail(error);
      } else if (message.type === 'frame') {
        transport.frame(message.frame, message.isBinary);
      } else if (message.type === 'send.result') {
        transport.written(message.id, message.code);
      } else if (message.type === 'finished') {
        clearTimeout(cleanupTimer);
      }
    });
    child.on('error', () => fail(setupError()));
    child.on('disconnect', () => {
      if (!stopping) fail(setupError());
    });
    child.on('exit', () => {
      exited = true;
      clearTimeout(cleanupTimer);
      clearTimeout(setupTimer);
      signal?.removeEventListener('abort', onAbort);
      if (!stopping) fail(setupError());
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    sendIpc(
      child,
      {
        type: 'start',
        options: { connection, nodeId, terminalId, manifest, afterSequence, timeoutMs, heartbeatMs }
      },
      () => fail(setupError())
    );
    if (signal?.aborted) onAbort();
  });
}

class IsolatedDirectTransport extends EventEmitter {
  #child;
  #stop;
  #active = false;
  #closed = false;
  #events = [];
  #bytes = 0;
  #writes = new Map();
  #writeBytes = 0;
  #nextId = 0;

  constructor(child, stop) {
    super();
    this.#child = child;
    this.#stop = stop;
  }

  activate() {
    if (this.#active) return;
    this.#active = true;
    const events = this.#events;
    this.#events = [];
    this.#bytes = 0;
    for (const [type, value, isBinary] of events) this.#emit(type, value, isBinary);
  }

  frame(frame, isBinary = false) {
    if (this.#closed) return;
    if (!this.#active) {
      this.#bytes += Buffer.byteLength(frame);
      if (this.#bytes > MAX_BUFFER_BYTES)
        return this.fail(new Error('TERMINAL_DIRECT_BUFFER_EXCEEDED'));
    }
    this.#emit('message', frame, isBinary);
  }

  send(frame) {
    if (this.#closed) return Promise.reject(new Error('TERMINAL_CONNECTION_LOST'));
    const value = typeof frame === 'string' ? frame : JSON.stringify(frame);
    const bytes = Buffer.byteLength(value);
    if (this.#writeBytes + bytes > MAX_BUFFER_BYTES)
      return Promise.reject(new Error('TERMINAL_DIRECT_BUFFER_EXCEEDED'));
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      this.#writeBytes += bytes;
      this.#writes.set(id, { resolve, reject, bytes });
      sendIpc(this.#child, { type: 'send', id, frame: value }, () =>
        this.fail(new Error('TERMINAL_CONNECTION_LOST'))
      );
    });
  }

  written(id, code) {
    const write = this.#writes.get(id);
    if (!write) return;
    this.#writes.delete(id);
    this.#writeBytes -= write.bytes;
    if (code) write.reject(new Error(code));
    else write.resolve();
  }

  fail(error) {
    if (this.#closed) return;
    this.#emit(
      'error',
      new Error(
        error instanceof DirectFallbackError || error instanceof DirectUnsafeError
          ? 'TERMINAL_CONNECTION_LOST'
          : error.message
      )
    );
    this.close();
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const { reject } of this.#writes.values()) reject(new Error('TERMINAL_CONNECTION_LOST'));
    this.#writes.clear();
    this.#writeBytes = 0;
    this.#stop();
    this.#emit('close');
  }

  #emit(type, value, isBinary = false) {
    if (!this.#active) this.#events.push([type, value, isBinary]);
    else if (type !== 'error' || this.listenerCount('error') > 0) this.emit(type, value, isBinary);
  }
}

function runChild() {
  const controller = new AbortController();
  const callbacks = new Map();
  let nextId = 0;
  let transport;
  let native;
  let cleaning = false;
  const cleanup = () => {
    if (cleaning) return;
    cleaning = true;
    setImmediate(() => {
      try {
        native?.cleanup();
      } catch {
        /* Process exit also releases native resources. */
      }
      sendIpc(
        process,
        { type: 'finished' },
        () => process.exit(0),
        () => process.exit(0)
      );
    });
  };
  const callback = (event) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      callbacks.set(id, { resolve, reject });
      sendIpc(process, { type: 'callback', id, event }, reject);
    });
  const abort = () => {
    controller.abort();
    for (const { reject } of callbacks.values())
      reject(new DirectFallbackError('DIRECT_RACE_CANCELLED'));
    callbacks.clear();
    if (transport) transport.close();
  };
  process.on('disconnect', () => {
    abort();
    cleanup();
  });
  process.on('message', async (message) => {
    if (message.type === 'callback.result') {
      const pending = callbacks.get(message.id);
      callbacks.delete(message.id);
      if (message.failed) pending?.reject(new DirectFallbackError('DIRECT_RACE_CANCELLED'));
      else pending?.resolve();
    } else if (message.type === 'abort') {
      abort();
    } else if (message.type === 'send') {
      try {
        await transport.send(message.frame);
        sendIpc(process, { type: 'send.result', id: message.id });
      } catch {
        sendIpc(process, { type: 'send.result', id: message.id, code: 'TERMINAL_INPUT_FAILED' });
      }
    } else if (message.type === 'start') {
      try {
        const { MarctlClient } = await import('./client.mjs');
        const { openDirectTerminal } = await import('./direct.mjs');
        const { default: WebSocketClass } = await import('ws');
        native = await import('node-datachannel');
        const { connection, ...options } = message.options;
        let iceSelection;
        transport = await openDirectTerminal({
          ...options,
          client: new MarctlClient(connection),
          WebSocketClass,
          peerConnectionFactory: (name, config) => new native.PeerConnection(name, config),
          cleanupNative: cleanup,
          signal: controller.signal,
          onPrepared: () => callback('prepared'),
          onIceConnected: () => {
            iceSelection = callback('ice');
            iceSelection.catch(() => controller.abort());
          },
          onTransportReady: async () => {
            await iceSelection;
            await callback('transport');
          },
          beforeOpen: () => callback('opening')
        });
        sendIpc(process, { type: 'attached' });
        transport.on('message', (frame, isBinary) =>
          sendIpc(process, { type: 'frame', frame: String(frame), isBinary }, abort)
        );
        transport.on('error', (error) => {
          sendIpc(process, { type: 'failure', code: error.message });
          abort();
        });
        transport.on('close', () => {
          sendIpc(process, { type: 'failure', code: 'TERMINAL_DIRECT_CLOSED' });
          cleanup();
        });
        transport.activate();
      } catch (error) {
        sendIpc(process, {
          type: 'failure',
          name: error instanceof DirectUnsafeError ? 'DirectUnsafeError' : 'DirectFallbackError',
          code: error.code ?? 'DIRECT_UNAVAILABLE'
        });
        cleanup();
      }
    }
  });
}

if (process.send && process.argv[1] === fileURLToPath(import.meta.url)) runChild();
