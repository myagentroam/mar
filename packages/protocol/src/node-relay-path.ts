import type { NodeConnectionPath } from './node-connection.js';
import type { NodeStream } from './node-stream.js';
import type { NodeStreamHandler, NodeStreamOpen } from './node-stream-mux.js';
import { decodeNodeRelayHandshake } from './node-stream-wire.js';
import { bindNodeStreamPath, type NodeStreamCarrier } from './node-stream-path.js';

/** Waits for relay admission, then hands its carrier to the binary stream multiplexer. */
export async function openNodeRelayPath(input: {
  carrier: NodeStreamCarrier;
  maxStreams: number;
  signal: AbortSignal;
  accept?(request: NodeStreamOpen, signal: AbortSignal): Promise<NodeStreamHandler | undefined>;
}): Promise<NodeConnectionPath<NodeStreamOpen, NodeStream>> {
  const { carrier, signal } = input;
  const admitted = Promise.withResolvers<void>();
  const endpoint = bindNodeStreamPath(input);
  let ready = false;
  const disconnect = () => {
    endpoint.disconnect();
    admitted.reject(new Error('NODE_RELAY_UNAVAILABLE'));
  };
  const close = () => {
    endpoint.path.close();
    admitted.reject(new Error('NODE_RELAY_UNAVAILABLE'));
  };
  const abort = () => {
    admitted.reject(signal.reason);
    close();
  };
  carrier.onClose(disconnect);
  carrier.onMessage((bytes) => {
    try {
      if (ready) endpoint.receive(bytes);
      else {
        if (decodeNodeRelayHandshake(bytes).type !== 'RELAY_READY')
          throw new Error('NODE_RELAY_FRAME_INVALID');
        ready = true;
        admitted.resolve();
      }
    } catch {
      close();
    }
  });
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  try {
    await admitted.promise;
    signal.throwIfAborted();
    return endpoint.path;
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
