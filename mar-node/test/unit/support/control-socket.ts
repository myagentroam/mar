import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import type { NodeCapabilities } from '@myagentroam/protocol';
import type { NodeConnector } from '../../../src/connector.js';

type CaptureSocket = {
  readonly readyState: number;
  readonly OPEN?: number;
  send(raw: string): void;
  close?(...args: unknown[]): void;
};

let nextSocket: CaptureSocket | undefined;

/** Supply a test socket to the real control-channel connection path. */
export function mockedWebSocket(original: typeof WebSocket): typeof WebSocket {
  const constructor = function (...args: unknown[]) {
    if (nextSocket === undefined) return Reflect.construct(original, args);
    const target = nextSocket;
    nextSocket = undefined;
    const socket = new EventEmitter();
    return Object.assign(socket, target, {
      close: (...closeArgs: unknown[]) => {
        target.close?.(...closeArgs);
        queueMicrotask(() => socket.emit('close', 1000, Buffer.alloc(0)));
      }
    });
  };
  Object.setPrototypeOf(constructor, original);
  return constructor as unknown as typeof WebSocket;
}

export function connectTestSocket(connector: NodeConnector, socket: CaptureSocket): void {
  const internals = connector as unknown as {
    config: { serverUrl: string } | undefined;
    capabilities: NodeCapabilities;
    controlChannel: { connect(): void; ready(capabilities: NodeCapabilities): void };
  };
  const config = internals.config;
  if (config === undefined) internals.config = { serverUrl: 'http://127.0.0.1' };
  nextSocket = socket;
  try {
    internals.controlChannel.connect();
    if (nextSocket !== undefined) throw new Error('Test control socket was not connected');
    internals.controlChannel.ready(internals.capabilities);
  } finally {
    nextSocket = undefined;
    internals.config = config;
  }
}

export function disconnectTestSocket(connector: NodeConnector): void {
  (connector as unknown as { controlChannel: { stop(): void } }).controlChannel.stop();
}
