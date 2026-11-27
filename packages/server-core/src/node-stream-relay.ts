import type { NodeStreamOpen } from '@myagentroam/protocol/node-stream-mux';
import {
  decodeNodeStreamFrame,
  NODE_STREAM_WINDOW_BYTES,
  nodeStreamCreditCost,
  type NodeStreamFrame
} from '@myagentroam/protocol/node-stream-wire';

type Send = (frame: NodeStreamFrame) => void;
export type NodeStreamAuthorizer = (
  request: NodeStreamOpen,
  signal: AbortSignal
) => Promise<NodeStreamAdmission | { code: string } | undefined>;
export interface NodeStreamAdmission {
  readonly grant: string;
  readonly revoked?: AbortSignal;
  /** Reports a clean duplex FIN or a reset/disconnect code; never carries business data. */
  readonly onEnd?: (code?: string) => void;
}
type Direction = { credit: number; fin: boolean };
type Client = {
  send: Send;
  authorize: NodeStreamAuthorizer;
  streams: Map<number, Route>;
  lastId: number;
};
type Route = {
  client: Client;
  clientId: number;
  nodeId?: number;
  scope: AbortController;
  removeRevocationListener?: () => void;
  onEnd?: NodeStreamAdmission['onEnd'];
  opened: boolean;
  upload: Direction;
  download: Direction;
};

/** Bridges authenticated client carriers onto one Node carrier. It owns only stream routing. */
export class NodeStreamRelay {
  readonly #clients = new Set<Client>();
  readonly #nodeStreams = new Map<number, Route>();
  #lastNodeId = 0;
  #streamCount = 0;
  #closed = false;

  constructor(
    private readonly sendToNode: Send,
    private readonly limits: { perClient: number; perNode: number }
  ) {}

  attachClient(send: Send, authorize: NodeStreamAuthorizer) {
    if (this.#closed) throw new Error('NODE_OFFLINE');
    const client: Client = { send, authorize, streams: new Map(), lastId: 0 };
    this.#clients.add(client);
    return {
      receive: (wire: unknown) => {
        if (this.#clients.has(client)) this.#receiveClient(client, decodeNodeStreamFrame(wire));
      },
      close: () => {
        if (!this.#clients.delete(client)) return;
        for (const route of client.streams.values()) {
          this.#release(route, 'NODE_STREAM_DISCONNECTED');
          if (route.nodeId !== undefined)
            this.sendToNode({
              type: 'RESET',
              streamId: route.nodeId,
              code: 'NODE_STREAM_DISCONNECTED'
            });
        }
      }
    };
  }

  receiveNode(wire: unknown): void {
    if (this.#closed) return;
    const frame = decodeNodeStreamFrame(wire);
    if (frame.type === 'OPEN' || frame.streamId > this.#lastNodeId)
      throw new Error('NODE_STREAM_FRAME_INVALID');
    const route = this.#nodeStreams.get(frame.streamId);
    if (route !== undefined) this.#forward(route, frame, false);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const client of this.#clients) {
      for (const route of client.streams.values()) {
        this.#release(route, 'NODE_STREAM_DISCONNECTED');
        client.send({ type: 'RESET', streamId: route.clientId, code: 'NODE_STREAM_DISCONNECTED' });
      }
    }
    this.#clients.clear();
  }

  #receiveClient(client: Client, frame: NodeStreamFrame): void {
    if (frame.type === 'OPEN') {
      if (frame.streamId <= client.lastId) throw new Error('NODE_STREAM_OPEN_INVALID');
      client.lastId = frame.streamId;
      if (
        client.streams.size >= this.limits.perClient ||
        this.#streamCount >= this.limits.perNode
      ) {
        client.send({ type: 'RESET', streamId: frame.streamId, code: 'NODE_STREAM_LIMIT' });
        return;
      }
      const route: Route = {
        client,
        clientId: frame.streamId,
        scope: new AbortController(),
        opened: false,
        upload: { credit: NODE_STREAM_WINDOW_BYTES, fin: false },
        download: { credit: NODE_STREAM_WINDOW_BYTES, fin: false }
      };
      client.streams.set(frame.streamId, route);
      this.#streamCount++;
      void this.#open(route, frame);
      return;
    }
    if (frame.streamId > client.lastId) throw new Error('NODE_STREAM_FRAME_INVALID');
    const route = client.streams.get(frame.streamId);
    if (route !== undefined) this.#forward(route, frame, true);
  }

  async #open(route: Route, request: Extract<NodeStreamFrame, { type: 'OPEN' }>): Promise<void> {
    let admission: Awaited<ReturnType<NodeStreamAuthorizer>>;
    try {
      admission = await route.client.authorize(
        { kind: request.kind, grant: request.grant },
        route.scope.signal
      );
    } catch {
      // The client never receives authorizer internals.
      admission = { code: 'NODE_STREAM_UNAVAILABLE' };
    }
    if (route.scope.signal.aborted) return;
    if (admission !== undefined && 'code' in admission) return this.#reset(route, admission.code);
    if (admission === undefined || admission.revoked?.aborted)
      return this.#reset(route, 'RESOURCE_DENIED');
    if (this.#lastNodeId === 0xffffffff) return this.#reset(route, 'NODE_STREAM_LIMIT');
    route.nodeId = ++this.#lastNodeId;
    if (admission.onEnd !== undefined) route.onEnd = admission.onEnd;
    this.#nodeStreams.set(route.nodeId, route);
    const revoked = admission.revoked;
    if (revoked !== undefined) {
      const reset = () => this.#reset(route, 'RESOURCE_DENIED');
      revoked.addEventListener('abort', reset, { once: true });
      route.removeRevocationListener = () => revoked.removeEventListener('abort', reset);
    }
    this.sendToNode({ ...request, streamId: route.nodeId, grant: admission.grant });
  }

  #forward(route: Route, frame: Exclude<NodeStreamFrame, { type: 'OPEN' }>, fromClient: boolean) {
    if (!recordFlow(route, frame, fromClient)) {
      this.#reset(route, 'NODE_STREAM_STATE_INVALID');
      return;
    }
    if (frame.type === 'RESET')
      this.#release(route, fromClient ? 'NODE_STREAM_CANCELLED' : frame.code);
    else if (route.upload.fin && route.download.fin) this.#release(route);
    if (fromClient) {
      if (route.nodeId !== undefined) this.sendToNode({ ...frame, streamId: route.nodeId });
    } else {
      route.client.send({ ...frame, streamId: route.clientId });
    }
  }

  #reset(route: Route, code: string): void {
    this.#release(route, code);
    route.client.send({ type: 'RESET', streamId: route.clientId, code });
    if (route.nodeId !== undefined)
      this.sendToNode({ type: 'RESET', streamId: route.nodeId, code });
  }

  #release(route: Route, code?: string): void {
    route.client.streams.delete(route.clientId);
    if (route.nodeId !== undefined) this.#nodeStreams.delete(route.nodeId);
    this.#streamCount--;
    // Authorization owners can abort their own signal synchronously during stream cleanup.
    route.removeRevocationListener?.();
    route.scope.abort();
    route.onEnd?.(code);
  }
}

function recordFlow(
  route: Route,
  frame: Exclude<NodeStreamFrame, { type: 'OPEN' }>,
  fromClient: boolean
): boolean {
  if (frame.type === 'RESET') return true;
  if (frame.type === 'OPENED') {
    if (fromClient || route.opened) return false;
    route.opened = true;
    return true;
  }
  if (!route.opened) return false;
  const direction = fromClient ? route.upload : route.download;
  if (frame.type === 'WINDOW') {
    const opposite = fromClient ? route.download : route.upload;
    opposite.credit += frame.bytes;
    return opposite.credit <= NODE_STREAM_WINDOW_BYTES;
  }
  if (direction.fin) return false;
  if (frame.type === 'FIN') {
    direction.fin = true;
    return true;
  }
  direction.credit -= nodeStreamCreditCost(frame.bytes.length);
  return direction.credit >= 0;
}
