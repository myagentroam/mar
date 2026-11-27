import WebSocket from 'ws';
import {
  createEnvelope,
  decodeFileRelayFrame,
  encodeFileRelayEnvelope,
  encodeFileRelayFrame,
  FILE_RELAY_MAX_FRAME_BYTES,
  FILE_RELAY_MAX_PENDING,
  isFileRelayOperation,
  nodeEnvelopeSchema,
  publicErrorMessage,
  restoreFileRelayBody,
  type NodeEnvelope
} from '@myagentroam/protocol';
import { nodeConnectEndpoint } from '../connection/endpoints.js';
import type { NodeConfig } from '../config.js';

type Reply = (type: string, payload: unknown, replyTo?: string) => void;

/** Owns only the file-data connection. Existing Node request services own business execution. */
export class NodeFileChannel {
  private socket: WebSocket | undefined;
  private retry: NodeJS.Timeout | undefined;
  private controlBinding: string | undefined;
  private attempts = 0;
  // Admitted file work can outlive its socket; a replacement must share the budget.
  private inflight = 0;

  constructor(
    private readonly options: {
      readonly config: () => NodeConfig | undefined;
      readonly controlConnected: () => boolean;
      readonly reconnect: boolean;
      readonly reconnectDelay: (attempt: number) => number;
      readonly request: (envelope: NodeEnvelope, reply: Reply) => Promise<void>;
    }
  ) {}

  connect(controlBinding: string): void {
    if (this.controlBinding !== controlBinding) {
      this.disconnect();
      this.controlBinding = controlBinding;
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
    url.pathname = url.pathname.replace(/\/connect$/u, '/file-connect');
    const socket = new WebSocket(url, { maxPayload: FILE_RELAY_MAX_FRAME_BYTES });
    this.socket = socket;
    let authenticated = false;
    let deadline: NodeJS.Timeout | undefined;
    const renew = (delay: number) => {
      clearTimeout(deadline);
      deadline = setTimeout(() => socket.terminate(), delay);
      deadline.unref();
    };
    renew(15_000);
    socket.on('ping', () => {
      if (authenticated) renew(45_000);
    });
    socket.once('open', () => {
      if (this.socket === socket)
        socket.send(
          encodeFileRelayFrame({
            type: 'file.authenticate',
            nodeId: config.nodeId,
            credential: config.credential,
            controlBinding
          }),
          { compress: false }
        );
    });
    socket.once('error', () => socket.terminate());
    socket.once('close', () => {
      clearTimeout(deadline);
      if (this.socket !== socket) return;
      this.socket = undefined;
      if (!this.options.controlConnected() || !this.options.reconnect) return;
      this.retry = setTimeout(() => {
        this.retry = undefined;
        this.connect(controlBinding);
      }, this.options.reconnectDelay(this.attempts++));
      this.retry.unref();
    });
    socket.on('message', (raw, binary) => {
      if (
        !binary ||
        !Buffer.isBuffer(raw) ||
        this.socket !== socket ||
        !this.options.controlConnected()
      ) {
        socket.terminate();
        return;
      }
      try {
        const { metadata, payload } = decodeFileRelayFrame(raw);
        if (!authenticated) {
          if (metadata.type !== 'file.authenticated' || payload.length !== 0)
            throw new Error('MESSAGE_INVALID');
          authenticated = true;
          this.attempts = 0;
          renew(45_000);
          return;
        }
        if (metadata.type !== 'file.request') throw new Error('MESSAGE_INVALID');
        const envelope = nodeEnvelopeSchema.parse(metadata.envelope);
        const body = envelope.payload as { operation?: unknown; data?: unknown } | null;
        if (envelope.type !== 'node.request' || !isFileRelayOperation(body?.operation, body?.data))
          throw new Error('MESSAGE_INVALID');
        const operation = body!.operation;
        restoreFileRelayBody(envelope, operation, payload, metadata.byteLength);
        const reply: Reply = (type, response, replyTo) => {
          if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) return;
          if (socket.bufferedAmount >= FILE_RELAY_MAX_PENDING * FILE_RELAY_MAX_FRAME_BYTES) {
            socket.terminate();
            return;
          }
          socket.send(
            encodeFileRelayEnvelope(
              createEnvelope(type, response, { replyTo: replyTo ?? envelope.id }),
              operation
            ),
            (error) => {
              if (error) socket.terminate();
            }
          );
        };
        // A Server deadline can expire before the Node finishes a chunk. This
        // is per-request backpressure, not a fault on the authenticated socket.
        if (this.inflight >= FILE_RELAY_MAX_PENDING) {
          reply('node.response', {
            error: 'FILE_RELAY_BUSY',
            message: publicErrorMessage('FILE_RELAY_BUSY')
          });
          return;
        }
        this.inflight++;
        void this.options
          .request(envelope, reply)
          .catch(() => socket.terminate())
          .finally(() => {
            this.inflight--;
          });
      } catch {
        socket.terminate();
      }
    });
  }

  disconnect(): void {
    clearTimeout(this.retry);
    this.retry = undefined;
    const socket = this.socket;
    this.socket = undefined;
    this.controlBinding = undefined;
    this.attempts = 0;
    socket?.terminate();
  }
}
