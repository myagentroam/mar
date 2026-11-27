import type { WebSocket } from 'ws';
export type { NodeStreamAdmission } from './node-stream-relay.js';
import {
  decodeNodeRelayHandshake,
  encodeNodeRelayHandshake,
  encodeNodeStreamFrame,
  type NodeRelayHandshake,
  type NodeStreamFrame
} from '@myagentroam/protocol/node-stream-wire';
import { NodeStreamRelay, type NodeStreamAuthorizer } from './node-stream-relay.js';

type NodeAuth = Extract<NodeRelayHandshake, { type: 'RELAY_AUTH' }>;
type NodeEntry = { socket: WebSocket; relay: NodeStreamRelay; clients: Set<WebSocket> };

type Options = {
  /** Authenticate, then return a synchronous check of the captured control connection. */
  admitNode(auth: NodeAuth): Promise<(() => boolean) | undefined>;
  maxStreams: { perClient: number; perNode: number };
  maxBufferedBytes: number;
  traffic?: {
    record(direction: 'in' | 'out', bytes: number): void;
    backpressure(bufferedBytes: number): void;
  };
};

/** Owns relay carrier admission and shutdown; NodeStreamRelay owns mappings, not sockets. */
export class NodeRelayChannel {
  readonly #nodes = new Map<string, NodeEntry>();
  readonly #sockets = new Set<WebSocket>();
  readonly #authentications = new Set<Promise<void>>();
  #closed = false;

  constructor(private readonly options: Options) {}

  attachNode(socket: WebSocket): void {
    if (!this.#track(socket)) return;
    let bound: { id: string; entry: NodeEntry } | undefined;
    let authenticating = false;
    const deadline = setTimeout(() => socket.terminate(), 10_000);
    deadline.unref();
    socket.once('close', () => {
      clearTimeout(deadline);
      if (bound && this.#nodes.get(bound.id) === bound.entry) this.disconnectNode(bound.id);
    });
    socket.on('message', (raw, binary) => {
      try {
        if (!binary || !Buffer.isBuffer(raw)) throw new Error('NODE_RELAY_FRAME_INVALID');
        this.options.traffic?.record('in', raw.length);
        if (bound !== undefined) {
          if (this.#nodes.get(bound.id) !== bound.entry) return;
          bound.entry.relay.receiveNode(raw);
          return;
        }
        const auth = decodeNodeRelayHandshake(raw);
        if (auth.type !== 'RELAY_AUTH' || authenticating)
          throw new Error('NODE_RELAY_AUTH_INVALID');
        authenticating = true;
        const pending = Promise.resolve()
          .then(() => this.options.admitNode(auth))
          .then((current) => {
            if (
              current === undefined ||
              !current() ||
              this.#closed ||
              socket.readyState !== socket.OPEN
            ) {
              socket.terminate();
              return;
            }
            this.disconnectNode(auth.nodeId);
            const entry = {
              socket,
              relay: new NodeStreamRelay(
                (frame) => this.#send(socket, frame),
                this.options.maxStreams
              ),
              clients: new Set<WebSocket>()
            };
            bound = { id: auth.nodeId, entry };
            this.#nodes.set(auth.nodeId, entry);
            clearTimeout(deadline);
            this.#ready(socket);
          })
          .catch(() => socket.terminate());
        this.#authentications.add(pending);
        void pending.then(() => this.#authentications.delete(pending));
      } catch {
        socket.close(4002, 'NODE_RELAY_FRAME_INVALID');
      }
    });
  }

  /** The route must bind this socket and authorizer to the authenticated user and target. */
  attachClient(socket: WebSocket, nodeId: string, authorize: NodeStreamAuthorizer): void {
    if (!this.#track(socket)) return;
    const node = this.#nodes.get(nodeId);
    if (node === undefined || node.socket.readyState !== node.socket.OPEN) {
      socket.close(4004, 'NODE_OFFLINE');
      return;
    }
    const port = node.relay.attachClient((frame) => this.#send(socket, frame), authorize);
    node.clients.add(socket);
    socket.on('message', (raw, binary) => {
      try {
        if (!binary || !Buffer.isBuffer(raw)) throw new Error('NODE_RELAY_FRAME_INVALID');
        this.options.traffic?.record('in', raw.length);
        port.receive(raw);
      } catch {
        socket.close(4002, 'NODE_RELAY_FRAME_INVALID');
      }
    });
    socket.once('close', () => {
      node.clients.delete(socket);
      port.close();
    });
    this.#ready(socket);
  }

  disconnectNode(nodeId: string): void {
    const entry = this.#nodes.get(nodeId);
    if (entry === undefined) return;
    this.#nodes.delete(nodeId);
    entry.relay.close();
    for (const client of entry.clients) client.close(4004, 'NODE_OFFLINE');
    entry.socket.terminate();
  }

  close(): void {
    this.#closed = true;
    for (const id of this.#nodes.keys()) this.disconnectNode(id);
    for (const socket of this.#sockets) socket.terminate();
  }

  async drainAuthentications(): Promise<void> {
    await Promise.all(this.#authentications);
  }

  #track(socket: WebSocket): boolean {
    if (this.#closed || socket.readyState !== socket.OPEN) {
      socket.terminate();
      return false;
    }
    this.#sockets.add(socket);
    let alive = true;
    const heartbeat = setInterval(() => {
      if (!alive || socket.readyState !== socket.OPEN) return socket.terminate();
      alive = false;
      socket.ping();
    }, 20_000);
    heartbeat.unref();
    socket.on('pong', () => {
      alive = true;
    });
    socket.on('error', () => socket.terminate());
    socket.once('close', () => {
      clearInterval(heartbeat);
      this.#sockets.delete(socket);
    });
    return true;
  }

  #ready(socket: WebSocket): void {
    this.#sendBytes(socket, encodeNodeRelayHandshake({ type: 'RELAY_READY' }), false);
  }

  #send(socket: WebSocket, frame: NodeStreamFrame): void {
    const bytes = encodeNodeStreamFrame(frame);
    this.#sendBytes(socket, bytes, frame.type === 'DATA' && bytes.length > 1024);
  }

  #sendBytes(socket: WebSocket, bytes: Uint8Array, compress: boolean): void {
    if (socket.readyState !== socket.OPEN) return;
    const buffered = socket.bufferedAmount + bytes.length;
    if (buffered > this.options.maxBufferedBytes) {
      this.options.traffic?.backpressure(buffered);
      socket.terminate();
      return;
    }
    socket.send(bytes, { compress });
    this.options.traffic?.record('out', bytes.length);
  }
}
