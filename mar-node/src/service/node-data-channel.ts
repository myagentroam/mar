import WebSocket from 'ws';
import { openNodeRelayPath } from '@myagentroam/protocol/node-relay-path';
import type { NodeStreamHandler, NodeStreamOpen } from '@myagentroam/protocol/node-stream-mux';
import {
  encodeNodeRelayHandshake,
  MAX_NODE_STREAM_FRAME_BYTES
} from '@myagentroam/protocol/node-stream-wire';
import type { NodeConfig } from '../config.js';
import { nodeConnectEndpoint } from '../connection/endpoints.js';

/** Owns the Node-side WS for the current control connection. Domain code only accepts streams. */
export class NodeDataChannel {
  private socket: WebSocket | undefined;
  private retry: NodeJS.Timeout | undefined;
  private binding: string | undefined;
  private attempts = 0;

  constructor(
    private readonly options: {
      config(): NodeConfig | undefined;
      controlConnected(): boolean;
      reconnect: boolean;
      reconnectDelay(attempt: number): number;
      accept(request: NodeStreamOpen, signal: AbortSignal): Promise<NodeStreamHandler | undefined>;
    }
  ) {}

  connect(controlBinding: string): void {
    if (this.binding !== controlBinding) {
      this.disconnect();
      this.binding = controlBinding;
    }
    const config = this.options.config();
    if (
      this.socket ||
      this.retry ||
      !config?.nodeId ||
      !config.credential ||
      !this.options.controlConnected()
    )
      return;

    const url = new URL(nodeConnectEndpoint(config.serverUrl));
    url.pathname = url.pathname.replace(/\/connect$/u, '/relay');
    const socket = new WebSocket(url, { maxPayload: MAX_NODE_STREAM_FRAME_BYTES });
    this.socket = socket;
    let deadline: NodeJS.Timeout;
    const renew = (delay: number) => {
      clearTimeout(deadline);
      deadline = setTimeout(() => socket.terminate(), delay);
      deadline.unref();
    };
    renew(15_000);
    socket.on('ping', () => renew(45_000));
    socket.once('error', () => socket.terminate());
    socket.once('close', () => {
      clearTimeout(deadline);
      if (this.socket !== socket) return;
      this.socket = undefined;
      if (!this.options.reconnect || !this.options.controlConnected()) return;
      this.retry = setTimeout(() => {
        this.retry = undefined;
        this.connect(controlBinding);
      }, this.options.reconnectDelay(this.attempts++));
      this.retry.unref();
    });

    const auth = encodeNodeRelayHandshake({
      type: 'RELAY_AUTH',
      nodeId: config.nodeId,
      credential: config.credential,
      controlBinding
    });
    const carrier = {
      send: (bytes: Uint8Array): Promise<void> =>
        new Promise((resolve, reject) => {
          socket.send(bytes, (error) => (error ? reject(error) : resolve()));
        }),
      close: () => socket.terminate(),
      onMessage: (receive: (bytes: unknown) => void) => {
        socket.on('message', (raw, binary) => {
          if (binary && Buffer.isBuffer(raw)) receive(raw);
          else socket.terminate();
        });
      },
      onClose: (disconnect: () => void) => {
        socket.once('close', disconnect);
      }
    };
    void openNodeRelayPath({
      carrier,
      maxStreams: 256,
      signal: AbortSignal.timeout(15_000),
      accept: (request, signal) => this.options.accept(request, signal)
    }).then(
      () => {
        if (socket === this.socket) {
          this.attempts = 0;
          renew(45_000);
        }
      },
      () => socket.terminate()
    );
    socket.once('open', () => {
      if (socket === this.socket) socket.send(auth, { compress: false });
    });
  }

  disconnect(): void {
    clearTimeout(this.retry);
    this.retry = undefined;
    this.binding = undefined;
    this.attempts = 0;
    const socket = this.socket;
    this.socket = undefined;
    socket?.terminate();
  }
}
