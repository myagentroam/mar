import type { WebSocket } from 'ws';
import {
  NODE_PROTOCOL_VERSION,
  createEnvelope,
  nodeCapabilitiesSchema,
  nodeEnvelopeSchema,
  type NodeCapabilities,
  type NodeEnvelope
} from '@myagentroam/protocol';
import type { NodeIdentityStore } from './node-identity.js';
import { safePublicError } from './http-errors.js';
const NODE_HEARTBEAT_TIMEOUT_MS = 45_000;
const NODE_HEARTBEAT_SWEEP_MS = 15_000;

export class NodeIdentityControl {
  protected readonly sockets = new Map<string, WebSocket>();
  protected readonly capabilities = new Map<string, NodeCapabilities>();
  private readonly lastHeartbeatAt = new Map<string, number>();
  private readonly attached = new Set<WebSocket>();
  private closed = false;
  private readonly authenticating = new Map<WebSocket, string>();
  private readonly handshakes = new WeakSet<WebSocket>();
  private readonly heartbeatSweep: NodeJS.Timeout;
  constructor(
    private readonly identityStore: NodeIdentityStore,
    private readonly recordTraffic?: (direction: 'in' | 'out', bytes: number) => void
  ) {
    this.heartbeatSweep = setInterval(() => this.terminateStaleNodes(), NODE_HEARTBEAT_SWEEP_MS);
    this.heartbeatSweep.unref();
  }
  protected connectionFeatures(): Record<string, unknown> {
    return {};
  }
  protected onNodeConnected(nodeId: string, replaced: boolean): void {
    void nodeId;
    void replaced;
  }
  protected onNodeDisconnected(nodeId: string): void {
    void nodeId;
  }
  protected sendStaleConnectionError(socket: WebSocket, envelope: NodeEnvelope): void {
    this.sendError(socket, 'NODE_UNAUTHENTICATED', envelope.id);
  }
  protected async handleAuthenticatedMessage(
    nodeId: string,
    socket: WebSocket,
    envelope: NodeEnvelope
  ): Promise<boolean> {
    void nodeId;
    void socket;
    void envelope;
    return false;
  }
  private disconnect(nodeId: string): void {
    const connected = this.sockets.delete(nodeId);
    this.capabilities.delete(nodeId);
    this.lastHeartbeatAt.delete(nodeId);
    if (connected) this.onNodeDisconnected(nodeId);
  }
  closeNode(nodeId: string, code: number, reason: string): void {
    const socket = this.sockets.get(nodeId);
    this.disconnect(nodeId);
    for (const [candidate, identity] of this.authenticating) {
      if (identity === nodeId) candidate.close(code, reason);
    }
    socket?.close(code, reason);
  }
  close(): void {
    this.closed = true;
    clearInterval(this.heartbeatSweep);
    const sockets = new Set([...this.attached, ...this.sockets.values()]);
    for (const nodeId of [...this.sockets.keys()]) this.disconnect(nodeId);
    this.attached.clear();
    for (const socket of sockets) socket.close(1001, 'SERVER_SHUTDOWN');
  }
  attach(socket: WebSocket): void {
    if (this.closed) {
      socket.close(1001, 'SERVER_SHUTDOWN');
      return;
    }
    let nodeId: string | undefined;
    this.attached.add(socket);
    socket.on('message', (raw) => {
      const serialized = raw.toString();
      this.recordTraffic?.('in', Buffer.byteLength(serialized));
      void this.handleMessage(
        socket,
        serialized,
        (value) => {
          nodeId = value;
        },
        () => nodeId
      ).catch((error: unknown) => {
        this.sendFailure(socket, error);
      });
    });
    socket.on('error', () => socket.terminate());
    socket.on('close', () => {
      this.attached.delete(socket);
      if (nodeId !== undefined && this.sockets.get(nodeId) === socket) this.disconnect(nodeId);
    });
  }

  isNodeConnected(nodeId: string): boolean {
    return this.sockets.has(nodeId);
  }

  nodeCapabilities(nodeId: string): NodeCapabilities | undefined {
    return this.capabilities.get(nodeId);
  }

  sendAuthenticatedNode(nodeId: string, type: string, payload: unknown): boolean {
    const socket = this.sockets.get(nodeId);
    if (socket === undefined || socket.readyState !== socket.OPEN) return false;
    this.send(socket, type, payload);
    return true;
  }

  private terminateStaleNodes(): void {
    const deadline = Date.now() - NODE_HEARTBEAT_TIMEOUT_MS;
    for (const [nodeId, socket] of this.sockets) {
      const lastSeen = this.lastHeartbeatAt.get(nodeId);
      if (lastSeen !== undefined && lastSeen < deadline) socket.terminate();
    }
  }

  private async handleMessage(
    socket: WebSocket,
    raw: string,
    setNodeId: (nodeId: string) => void,
    getNodeId: () => string | undefined
  ): Promise<void> {
    let envelope: NodeEnvelope;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        !('version' in parsed) ||
        (parsed as { version?: unknown }).version !== NODE_PROTOCOL_VERSION
      ) {
        this.sendError(socket, 'PROTOCOL_VERSION_UNSUPPORTED');
        return;
      }
      envelope = nodeEnvelopeSchema.parse(parsed);
    } catch {
      this.sendError(socket, 'MESSAGE_INVALID');
      return;
    }
    try {
      const currentNodeId = getNodeId();
      if (this.closed || socket.readyState !== socket.OPEN) return;
      if (envelope.type === 'register' || envelope.type === 'authenticate') {
        if (currentNodeId !== undefined || this.handshakes.has(socket)) {
          this.sendError(socket, 'MESSAGE_INVALID', envelope.id);
          return;
        }
        this.handshakes.add(socket);
        try {
          const identity =
            envelope.type === 'register'
              ? await this.register(socket, envelope)
              : await this.authenticate(socket, envelope);
          if (identity !== undefined) setNodeId(identity);
        } finally {
          this.handshakes.delete(socket);
        }
        return;
      }
      if (currentNodeId === undefined) {
        this.sendError(socket, 'NODE_UNAUTHENTICATED', envelope.id);
        return;
      }
      if (this.sockets.get(currentNodeId) !== socket) {
        this.sendStaleConnectionError(socket, envelope);
        return;
      }
      if (envelope.type === 'heartbeat') {
        if (this.sockets.get(currentNodeId) === socket)
          this.lastHeartbeatAt.set(currentNodeId, Date.now());
        await this.identityStore.updateNodeHeartbeat(currentNodeId);
        this.send(socket, 'ack', { type: 'heartbeat' }, envelope.id);
        return;
      }
      if (envelope.type === 'capabilities') {
        const capabilities = this.parseCapabilities(socket, envelope);
        if (capabilities !== undefined) {
          this.capabilities.set(currentNodeId, capabilities);
          await this.identityStore.updateNodeHeartbeat(
            currentNodeId,
            toStoredCapabilities(capabilities)
          );
          this.send(socket, 'ack', { type: 'capabilities' }, envelope.id);
        }
        return;
      }
      if (await this.handleAuthenticatedMessage(currentNodeId, socket, envelope)) return;
      if (envelope.type === 'ack') {
        return;
      }
      this.sendError(socket, 'MESSAGE_TYPE_UNKNOWN', envelope.id);
    } catch (error) {
      this.send(socket, 'error', safePublicError(error), envelope.id);
    }
  }

  protected async register(socket: WebSocket, envelope: NodeEnvelope): Promise<string | undefined> {
    if (envelope.payload === null || typeof envelope.payload !== 'object') {
      this.sendError(socket, 'MESSAGE_INVALID', envelope.id);
      return undefined;
    }
    const payload = envelope.payload as { registrationToken?: unknown; capabilities?: unknown };
    if (typeof payload.registrationToken !== 'string') {
      this.sendError(socket, 'MESSAGE_INVALID', envelope.id);
      return undefined;
    }
    const capabilities = this.parseCapabilities(socket, envelope, payload.capabilities);
    if (capabilities === undefined) return undefined;
    const result = await this.identityStore.registerNode(
      payload.registrationToken,
      toStoredCapabilities(capabilities),
      remoteAddress(socket)
    );
    if (result === undefined) {
      this.sendError(socket, 'REGISTRATION_TOKEN_INVALID', envelope.id);
      return undefined;
    }
    if (this.closed || socket.readyState !== socket.OPEN) return undefined;
    this.sockets.set(result.nodeId, socket);
    this.capabilities.set(result.nodeId, capabilities);
    this.lastHeartbeatAt.set(result.nodeId, Date.now());

    this.send(socket, 'registered', { ...result, ...this.connectionFeatures() }, envelope.id);
    this.onNodeConnected(result.nodeId, false);
    return result.nodeId;
  }

  protected async authenticate(
    socket: WebSocket,
    envelope: NodeEnvelope
  ): Promise<string | undefined> {
    if (envelope.payload === null || typeof envelope.payload !== 'object') {
      this.sendError(socket, 'MESSAGE_INVALID', envelope.id);
      return undefined;
    }
    const payload = envelope.payload as { nodeId?: unknown; credential?: unknown };
    if (typeof payload.nodeId !== 'string' || typeof payload.credential !== 'string') {
      this.sendError(socket, 'MESSAGE_INVALID', envelope.id);
      return undefined;
    }
    this.authenticating.set(socket, payload.nodeId);
    try {
      const node = await this.identityStore.authenticateNode(payload.nodeId, payload.credential);
      if (node === undefined) {
        this.sendError(socket, 'NODE_UNAUTHENTICATED', envelope.id);
        return undefined;
      }
      if (node.disabled) {
        this.sendError(socket, 'NODE_DISABLED', envelope.id);
        return undefined;
      }
      if (this.closed || socket.readyState !== socket.OPEN) return undefined;
      await this.identityStore.updateNodeHeartbeat(node.id);
      if (this.closed || socket.readyState !== socket.OPEN) return undefined;
      const previous = this.sockets.get(node.id);
      this.sockets.set(node.id, socket);
      this.lastHeartbeatAt.set(node.id, Date.now());
      const capabilities = storedCapabilities(node.metadata);
      if (capabilities === undefined) this.capabilities.delete(node.id);
      else this.capabilities.set(node.id, capabilities);

      const replaced = previous !== undefined && previous !== socket;
      if (replaced) previous.close(4000, 'NODE_CONNECTION_REPLACED');
      this.send(
        socket,
        'authenticated',
        { nodeId: node.id, ...this.connectionFeatures() },
        envelope.id
      );
      this.onNodeConnected(node.id, replaced);
      return node.id;
    } finally {
      this.authenticating.delete(socket);
    }
  }

  private parseCapabilities(
    socket: WebSocket,
    envelope: NodeEnvelope,
    value: unknown = envelope.payload
  ): NodeCapabilities | undefined {
    const parsed = nodeCapabilitiesSchema.safeParse(value);
    if (!parsed.success) {
      this.sendError(socket, 'MESSAGE_INVALID', envelope.id);
      return undefined;
    }
    return parsed.data;
  }

  protected send(socket: WebSocket, type: string, payload: unknown, replyTo?: string): void {
    if (socket.readyState === socket.OPEN) {
      const serialized = JSON.stringify(
        createEnvelope(type, payload, { ...(replyTo === undefined ? {} : { replyTo }) })
      );
      this.recordTraffic?.('out', Buffer.byteLength(serialized));
      socket.send(serialized);
    }
  }

  protected sendError(socket: WebSocket, code: string, replyTo?: string): void {
    const failure = safePublicError(new Error(code), code);
    this.send(socket, 'error', failure, replyTo);
  }
  private sendFailure(socket: WebSocket, error: unknown): void {
    this.send(socket, 'error', safePublicError(error));
  }
}
function remoteAddress(socket: WebSocket): string {
  const address = (socket as unknown as { _socket?: { remoteAddress?: unknown } })._socket
    ?.remoteAddress;
  if (typeof address !== 'string' || address.length === 0) return 'unknown';
  return address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
}

function toStoredCapabilities(capabilities: NodeCapabilities): {
  readonly metadata: string;
} {
  const metadata = {
    ...(capabilities.metadata ?? {}),
    platform: capabilities.platform,
    architecture: capabilities.architecture,
    nodeAppVersion: capabilities.nodeAppVersion ?? 'unknown',
    nodeVersion: capabilities.nodeVersion,
    codex: capabilities.codex,
    claudeCode: capabilities.claudeCode,
    ...(capabilities.openCode === undefined ? {} : { openCode: capabilities.openCode }),
    ...(capabilities.marAgent === undefined ? {} : { marAgent: capabilities.marAgent }),
    ...(capabilities.marAgentRuntimeCredentials === undefined
      ? {}
      : { marAgentRuntimeCredentials: capabilities.marAgentRuntimeCredentials }),
    ...(capabilities.chatgptLogin === undefined ? {} : { chatgptLogin: capabilities.chatgptLogin }),
    ...(capabilities.promptCompletion === undefined
      ? {}
      : { promptCompletion: capabilities.promptCompletion }),
    ...(capabilities.conversationHosting === undefined
      ? {}
      : { conversationHosting: capabilities.conversationHosting }),
    ...(capabilities.computerUse === undefined ? {} : { computerUse: capabilities.computerUse })
  };
  return {
    metadata: JSON.stringify(metadata)
  };
}

function storedCapabilities(metadata: string): NodeCapabilities | undefined {
  try {
    const parsed: unknown = JSON.parse(metadata);
    const capabilities = nodeCapabilitiesSchema.safeParse(parsed);
    return capabilities.success ? capabilities.data : undefined;
  } catch {
    return undefined;
  }
}
