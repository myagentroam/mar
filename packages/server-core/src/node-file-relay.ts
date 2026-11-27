import type { WebSocket } from 'ws';
import {
  decodeFileRelayFrame,
  encodeFileRelayFrame,
  nodeEnvelopeSchema
} from '@myagentroam/protocol';
import type { NodeEnvelope } from '@myagentroam/protocol';
import type { NodeIdentityStore } from './node-identity.js';

interface FileConnection {
  readonly socket: WebSocket;
  readonly control: WebSocket;
  readonly binding: string;
}

/** Owns authenticated file sockets; the request broker owns admission and request correlation. */
export class NodeFileRelay {
  private readonly connections = new Map<string, FileConnection>();
  private readonly sockets = new Set<WebSocket>();
  private closed = false;

  constructor(
    private readonly options: {
      readonly database: Pick<NodeIdentityStore, 'authenticateNode'>;
      readonly recordIncoming?: (bytes: number) => void;
      readonly currentControl: (nodeId: string, binding: string) => WebSocket | undefined;
      readonly response: (
        nodeId: string,
        socket: WebSocket,
        envelope: NodeEnvelope,
        bytes: Uint8Array,
        declaredLength: unknown
      ) => void;
      readonly disconnected: (socket: WebSocket) => void;
    }
  ) {}

  socketFor(nodeId: string): WebSocket | undefined {
    const entry = this.connections.get(nodeId);
    if (
      entry &&
      entry.control === this.options.currentControl(nodeId, entry.binding) &&
      entry.socket.readyState === entry.socket.OPEN
    )
      return entry.socket;
    return undefined;
  }

  attach(socket: WebSocket): void {
    if (this.closed) {
      socket.terminate();
      return;
    }
    this.sockets.add(socket);
    let nodeId: string | undefined;
    let authenticating = false;
    let alive = true;
    const deadline = setTimeout(() => socket.terminate(), 10_000);
    deadline.unref();
    const heartbeat = setInterval(() => {
      if (!alive || socket.readyState !== socket.OPEN) {
        socket.terminate();
        return;
      }
      alive = false;
      socket.ping();
    }, 20_000);
    heartbeat.unref();
    socket.on('pong', () => {
      alive = true;
    });
    socket.once('error', () => socket.terminate());
    socket.once('close', () => {
      clearTimeout(deadline);
      clearInterval(heartbeat);
      this.sockets.delete(socket);
      if (nodeId && this.connections.get(nodeId)?.socket === socket)
        this.connections.delete(nodeId);
      this.options.disconnected(socket);
    });
    socket.on('message', (raw, binary) => {
      if (!binary || !Buffer.isBuffer(raw)) {
        socket.terminate();
        return;
      }
      try {
        const { metadata, payload } = decodeFileRelayFrame(raw);
        if (!nodeId) {
          const { type, nodeId: requested, credential, controlBinding } = metadata;
          if (
            authenticating ||
            type !== 'file.authenticate' ||
            payload.length !== 0 ||
            typeof requested !== 'string' ||
            requested.length === 0 ||
            requested.length > 128 ||
            typeof credential !== 'string' ||
            credential.length === 0 ||
            credential.length > 1024 ||
            typeof controlBinding !== 'string' ||
            controlBinding.length === 0 ||
            controlBinding.length > 128
          )
            throw new Error('MESSAGE_INVALID');
          const control = this.options.currentControl(requested, controlBinding);
          if (!control) throw new Error('NODE_OFFLINE');
          authenticating = true;
          void Promise.resolve(this.options.database.authenticateNode(requested, credential))
            .then((node) => {
              if (
                this.closed ||
                !node ||
                node.id !== requested ||
                node.disabled ||
                this.options.currentControl(requested, controlBinding) !== control ||
                socket.readyState !== socket.OPEN
              ) {
                socket.terminate();
                return;
              }
              this.disconnectNode(requested);
              nodeId = requested;
              this.connections.set(nodeId, { socket, control, binding: controlBinding });
              clearTimeout(deadline);
              socket.send(encodeFileRelayFrame({ type: 'file.authenticated' }), {
                compress: false
              });
            })
            .catch(() => socket.terminate());
          return;
        }
        if (this.socketFor(nodeId) !== socket || metadata.type !== 'file.response')
          throw new Error('MESSAGE_INVALID');
        const envelope = nodeEnvelopeSchema.parse(metadata.envelope);
        if (envelope.type !== 'node.response' || !envelope.replyTo)
          throw new Error('MESSAGE_INVALID');
        this.options.recordIncoming?.(raw.byteLength);
        this.options.response(nodeId, socket, envelope, payload, metadata.byteLength);
      } catch {
        socket.terminate();
      }
    });
  }

  disconnectNode(nodeId: string): void {
    const entry = this.connections.get(nodeId);
    if (!entry) return;
    this.connections.delete(nodeId);
    this.options.disconnected(entry.socket);
    entry.socket.terminate();
  }

  close(): void {
    this.closed = true;
    for (const nodeId of this.connections.keys()) this.disconnectNode(nodeId);
    for (const socket of this.sockets) socket.terminate();
  }
}
