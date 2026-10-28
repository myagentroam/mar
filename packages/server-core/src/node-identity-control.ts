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
import {
  legacyNodeUpgradeEnvelope,
  parseLegacyNodeUpgradeEnvelope
} from './legacy-node-upgrade-wire.js';
import { compareStableVersions, MIN_NODE_BUSINESS_VERSION } from './node-version.js';
const NODE_HEARTBEAT_TIMEOUT_MS = 45_000;
const NODE_HEARTBEAT_SWEEP_MS = 15_000;

export class NodeIdentityControl {
  protected readonly sockets = new Map<string, WebSocket>();
  protected readonly capabilities = new Map<string, NodeCapabilities>();
  private readonly lastHeartbeatAt = new Map<string, number>();
  private readonly attached = new Set<WebSocket>();
  private closed = false;
  private readonly authenticating = new Map<WebSocket, string>();
  private readonly identityWrites = new Map<string, Promise<void>>();
  private readonly controlMessages = new Set<Promise<void>>();
  private readonly handshakes = new WeakSet<WebSocket>();
  private readonly wireVersions = new WeakMap<WebSocket, 2 | 3>();
  private readonly businessAdmission = new WeakSet<WebSocket>();
  private readonly revokedBusinessAdmission = new WeakSet<WebSocket>();
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
  protected onBusinessAdmissionRevoked(nodeId: string): void {
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
  private async serializeIdentity<T>(nodeId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.identityWrites.get(nodeId);
    const current = previous === undefined ? work() : previous.then(work);
    const settled = current.then(
      () => undefined,
      () => undefined
    );
    this.identityWrites.set(nodeId, settled);
    void settled.then(() => {
      if (this.identityWrites.get(nodeId) === settled) this.identityWrites.delete(nodeId);
    });
    return current;
  }

  protected async drainControlMessages(): Promise<void> {
    await Promise.all(this.controlMessages);
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
    const errors: unknown[] = [];
    for (const nodeId of [...this.sockets.keys()]) {
      try {
        this.disconnect(nodeId);
      } catch (error) {
        errors.push(error);
      }
    }
    this.attached.clear();
    for (const socket of sockets) {
      try {
        socket.close(1001, 'SERVER_SHUTDOWN');
      } catch (error) {
        errors.push(error);
        try {
          socket.terminate();
        } catch (terminateError) {
          errors.push(terminateError);
          this.attached.add(socket);
        }
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1)
      throw new AggregateError(errors, 'Failed to close Node connections', { cause: errors[0] });
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
      const handling = this.handleMessage(
        socket,
        serialized,
        (value) => {
          nodeId = value;
        },
        () => nodeId
      ).catch((error: unknown) => {
        this.sendFailure(socket, error);
      });
      // Observe every admitted handler, including reverse requests that can refresh
      // credentials or perform authorization reads after the socket is closed.
      // Tracking does not serialize independent messages or their responses.
      const settled = handling.then(
        () => undefined,
        () => undefined
      );
      this.controlMessages.add(settled);
      void settled.then(() => this.controlMessages.delete(settled));
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

  isNodeUpgradeOnly(nodeId: string): boolean {
    const socket = this.sockets.get(nodeId);
    return socket !== undefined && !this.businessAdmission.has(socket);
  }

  nodeCapabilities(nodeId: string): NodeCapabilities | undefined {
    const socket = this.sockets.get(nodeId);
    return socket !== undefined && this.businessAdmission.has(socket)
      ? this.capabilities.get(nodeId)
      : undefined;
  }

  protected allowsNodeBusiness(socket: WebSocket): boolean {
    return this.businessAdmission.has(socket);
  }

  protected nodeWireVersion(socket: WebSocket): 2 | 3 | undefined {
    return this.wireVersions.get(socket);
  }

  sendAuthenticatedNode(nodeId: string, type: string, payload: unknown): boolean {
    const socket = this.sockets.get(nodeId);
    if (socket === undefined || socket.readyState !== socket.OPEN) return false;
    if (!this.businessAdmission.has(socket)) return false;
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
      const version =
        typeof parsed === 'object' && parsed !== null && 'version' in parsed
          ? (parsed as { version?: unknown }).version
          : undefined;
      const previousVersion = this.wireVersions.get(socket);
      if (
        (version !== 2 && version !== NODE_PROTOCOL_VERSION) ||
        (previousVersion !== undefined && previousVersion !== version)
      ) {
        this.sendError(socket, 'PROTOCOL_VERSION_UNSUPPORTED');
        return;
      }
      this.wireVersions.set(socket, version as 2 | 3);
      envelope =
        version === 2
          ? { ...parseLegacyNodeUpgradeEnvelope(parsed), version: NODE_PROTOCOL_VERSION }
          : nodeEnvelopeSchema.parse(parsed);
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
          if (this.wireVersions.get(socket) === 2 && envelope.type === 'register') {
            this.sendError(socket, 'PROTOCOL_VERSION_UNSUPPORTED', envelope.id);
            return;
          }
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
        await this.serializeIdentity(currentNodeId, async () => {
          if (this.closed || this.sockets.get(currentNodeId) !== socket) return;
          this.lastHeartbeatAt.set(currentNodeId, Date.now());
          await this.identityStore.updateNodeHeartbeat(currentNodeId);
          if (this.sockets.get(currentNodeId) === socket)
            this.send(socket, 'ack', { type: 'heartbeat' }, envelope.id);
        });
        return;
      }
      if (envelope.type === 'capabilities') {
        await this.serializeIdentity(currentNodeId, async () => {
          if (this.closed || this.sockets.get(currentNodeId) !== socket) return;
          if (this.wireVersions.get(socket) === 2) {
            const capabilities = envelope.payload as {
              readonly metadata?: Record<string, unknown>;
              readonly platform?: string;
              readonly architecture?: string;
              readonly nodeAppVersion?: string;
              readonly nodeVersion?: string;
            };
            await this.identityStore.updateNodeHeartbeat(currentNodeId, {
              metadata: JSON.stringify({
                ...capabilities.metadata,
                ...capabilities,
                metadata: undefined
              })
            });
            if (this.sockets.get(currentNodeId) === socket) {
              this.capabilities.delete(currentNodeId);
              this.send(socket, 'ack', { type: 'capabilities' }, envelope.id);
            }
            return;
          }
          const capabilities = this.parseCapabilities(socket, envelope);
          if (capabilities !== undefined) {
            const admitted = this.businessAdmission.has(socket);
            this.setBusinessAdmission(socket, capabilities.nodeAppVersion);
            if (admitted && !this.businessAdmission.has(socket)) {
              this.revokedBusinessAdmission.add(socket);
              this.onBusinessAdmissionRevoked(currentNodeId);
            } else if (
              !admitted &&
              this.businessAdmission.has(socket) &&
              this.revokedBusinessAdmission.delete(socket)
            ) {
              this.onNodeConnected(currentNodeId, false);
            }
            this.capabilities.set(currentNodeId, capabilities);
            await this.identityStore.updateNodeHeartbeat(
              currentNodeId,
              toStoredCapabilities(capabilities)
            );
            if (this.sockets.get(currentNodeId) === socket)
              this.send(socket, 'ack', { type: 'capabilities' }, envelope.id);
          }
        });
        return;
      }
      if (!this.businessAdmission.has(socket) && envelope.type !== 'node.response') {
        this.sendError(socket, 'NODE_UPGRADE_REQUIRED', envelope.id);
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
    this.setBusinessAdmission(socket, capabilities.nodeAppVersion);
    if (!this.businessAdmission.has(socket)) {
      this.sendError(socket, 'NODE_UPGRADE_REQUIRED', envelope.id);
      return undefined;
    }
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
    const nodeId = payload.nodeId;
    const credential = payload.credential;
    this.authenticating.set(socket, nodeId);
    try {
      return await this.serializeIdentity(nodeId, async () => {
        if (this.closed || socket.readyState !== socket.OPEN) return undefined;
        const node = await this.identityStore.authenticateNode(nodeId, credential);
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
        // Persisted capabilities describe the previous connection, not this binary.
        // Admit business only after this connection reports its own version.
        this.businessAdmission.delete(socket);

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
      });
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

  private setBusinessAdmission(socket: WebSocket, version: string | undefined): void {
    const comparison = compareStableVersions(version ?? '', MIN_NODE_BUSINESS_VERSION);
    if (
      this.wireVersions.get(socket) === NODE_PROTOCOL_VERSION &&
      comparison !== undefined &&
      comparison >= 0
    )
      this.businessAdmission.add(socket);
    else this.businessAdmission.delete(socket);
  }

  protected send(socket: WebSocket, type: string, payload: unknown, replyTo?: string): void {
    if (socket.readyState === socket.OPEN) {
      const options = replyTo === undefined ? {} : { replyTo };
      const serialized = JSON.stringify(
        this.wireVersions.get(socket) === 2
          ? legacyNodeUpgradeEnvelope(type, payload, options)
          : createEnvelope(type, payload, options)
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
