import type { NodeConnectionPath } from './node-connection.js';
import type { NodeStream } from './node-stream.js';
import { NodeStreamMux, type NodeStreamHandler, type NodeStreamOpen } from './node-stream-mux.js';

export const NODE_STREAM_CHANNEL_LABEL = 'mar-node-stream';

export type NodeStreamCarrier = {
  send(bytes: Uint8Array<ArrayBuffer>): Promise<void>;
  close(): void;
  onMessage(receive: (bytes: unknown) => void): void;
  onClose(disconnect: () => void): void;
};

/** WebRTC adapter shared by the browser and the Node's RTC implementation. */
export function rtcNodeStreamCarrier(channel: RTCDataChannel): NodeStreamCarrier {
  channel.binaryType = 'arraybuffer';
  channel.addEventListener('error', () => channel.close(), { once: true });
  return {
    async send(bytes) {
      channel.send(bytes);
    },
    close: () => channel.close(),
    onMessage: (receive) => channel.addEventListener('message', (event) => receive(event.data)),
    onClose: (disconnect) => channel.addEventListener('close', disconnect, { once: true })
  };
}

/** Bind one carrier to the common byte-stream protocol. Handshake and authorization stay outside. */
export function bindNodeStreamPath(input: {
  carrier: Pick<NodeStreamCarrier, 'send' | 'close'>;
  maxStreams: number;
  accept?(request: NodeStreamOpen, signal: AbortSignal): Promise<NodeStreamHandler | undefined>;
}) {
  const { carrier, accept } = input;
  const mux = new NodeStreamMux({
    maxStreams: input.maxStreams,
    send: async (bytes) => {
      try {
        await carrier.send(bytes);
      } catch (error) {
        close();
        throw error;
      }
    },
    ...(accept === undefined ? {} : { accept })
  });
  const close = () => {
    if (mux.closed) return;
    mux.disconnect();
    carrier.close();
  };
  const path: NodeConnectionPath<NodeStreamOpen, NodeStream> = {
    get closed() {
      return mux.closed;
    },
    close,
    openStream: (request, signal) => mux.openStream(request, signal)
  };
  return {
    path,
    receive(bytes: unknown): void {
      try {
        mux.receive(bytes);
      } catch {
        close();
      }
    },
    disconnect: () => mux.disconnect()
  };
}

/** ICE is already admitted by its authenticated Peer; its ordered channel has no Relay handshake. */
export function bindNodeDirectPath(input: {
  carrier: NodeStreamCarrier;
  maxStreams: number;
  accept?(request: NodeStreamOpen, signal: AbortSignal): Promise<NodeStreamHandler | undefined>;
}): NodeConnectionPath<NodeStreamOpen, NodeStream> {
  const endpoint = bindNodeStreamPath(input);
  input.carrier.onClose(endpoint.disconnect);
  input.carrier.onMessage(endpoint.receive);
  return endpoint.path;
}
