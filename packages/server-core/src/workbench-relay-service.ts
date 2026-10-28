import type { NodeRequestAuthorization, UserNodeAuthorization } from './node-access-contracts.js';
import { randomBytes } from 'node:crypto';
import type { WebSocket } from 'ws';
import {
  directBrowserMessageSchema,
  terminalDirectBrowserMessageSchema,
  sessionShareVisitorSchema,
  type SessionShareTarget,
  type SessionShareVisitor,
  type DirectBrowserMessage,
  type TerminalDirectBrowserMessage,
  type WorkbenchEvent
} from '@myagentroam/protocol';

const MAX_CONNECTIONS_PER_USER = 8;
const MAX_SOCKET_BUFFERED_BYTES = 1024 * 1024;
const MAX_BROADCASTS_PER_TURN = 32;
const MAX_BROADCAST_BYTES_PER_TURN = 256 * 1024;
const DISCONNECTED_GRACE_MS = 25_000;

interface WorkbenchConnection {
  readonly id: string;
  readonly resumeToken: string;
  readonly user: UserNodeAuthorization;
  readonly share?: ShareWorkbenchAccess;
  socket?: WebSocket;
  releaseTimer?: NodeJS.Timeout;
}

export interface ShareWorkbenchAccess {
  readonly shareId: string;
  readonly ownerUserId: number;
  readonly account?: { readonly userId: number; readonly name: string };
  readonly target: SessionShareTarget;
  readonly expiresAt: number | null;
  readonly validate: () => Promise<boolean>;
  visitor: SessionShareVisitor;
}

export interface RelayedWorkbenchEvent extends WorkbenchEvent {
  readonly nodeId: string;
}

export interface WorkbenchRelayOptions {
  readonly authorizeNodeRequest: NodeRequestAuthorization;
  readonly traffic?: {
    record(channel: 'workbench', direction: 'in' | 'out', bytes: number): void;
    backpressure(channel: 'workbench', bytes: number): void;
  };
  readonly authorizeHostedConversation?: (
    userId: number,
    nodeId: string,
    templateId: string
  ) => Promise<boolean>;
}

export interface WorkbenchDirectTransferIdentity extends UserNodeAuthorization {
  readonly workbenchConnectionId: string;
}

export interface WorkbenchDirectTransferHandler {
  readonly message: (
    identity: WorkbenchDirectTransferIdentity,
    message: DirectBrowserMessage
  ) => void | Promise<void>;
  readonly disconnected?: (connectionId: string) => void;
  readonly resumed?: (connectionId: string) => void;
  readonly revoked?: (connectionId: string, code: string) => void;
}

export interface WorkbenchTerminalDirectHandler {
  readonly message: (
    identity: WorkbenchDirectTransferIdentity,
    message: TerminalDirectBrowserMessage
  ) => void | Promise<void>;
  readonly revoked?: (connectionId: string, code: string) => void;
}

export class WorkbenchRelayService {
  private readonly attached = new Map<WebSocket, UserNodeAuthorization>();
  private readonly shareSockets = new Map<WebSocket, ShareWorkbenchAccess>();
  private readonly shareTimers = new Map<string, NodeJS.Timeout>();
  private readonly browsers = new Map<WebSocket, UserNodeAuthorization>();
  private readonly socketConnections = new Map<WebSocket, WorkbenchConnection>();
  private readonly connections = new Map<string, WorkbenchConnection>();
  private readonly queues = new Map<string, object[]>();
  private readonly broadcastTails = new Map<WebSocket, Promise<void>>();
  private readonly directedTails = new Map<string, Promise<void>>();
  private scheduled = false;
  private readonly listeners = new Set<(event: RelayedWorkbenchEvent) => void>();
  private readonly authorizeHostedConversation:
    ((userId: number, nodeId: string, templateId: string) => Promise<boolean>) | undefined;
  private directTransferHandler: WorkbenchDirectTransferHandler | undefined;
  private terminalDirectHandler: WorkbenchTerminalDirectHandler | undefined;

  constructor(private readonly options: WorkbenchRelayOptions) {
    this.authorizeHostedConversation = options.authorizeHostedConversation;
  }

  setDirectTransferHandler(handler: WorkbenchDirectTransferHandler): void {
    this.directTransferHandler = handler;
  }

  setTerminalDirectHandler(handler: WorkbenchTerminalDirectHandler): void {
    this.terminalDirectHandler = handler;
  }

  attach(socket: WebSocket, user: UserNodeAuthorization, share?: ShareWorkbenchAccess): void {
    if (share !== undefined) {
      this.shareSockets.set(socket, share);
      this.armShareExpiration(share);
    }
    this.attached.set(socket, user);
    socket.on('message', (raw, isBinary) => {
      const serialized = raw.toString();
      this.options.traffic?.record('workbench', 'in', Buffer.byteLength(serialized));
      if (isBinary) {
        socket.close(4002, 'WORKBENCH_MESSAGE_INVALID');
        return;
      }
      void this.handleMessage(socket, user, serialized).catch(() =>
        socket.close(1011, 'WORKBENCH_MESSAGE_FAILED')
      );
    });
    socket.on('close', () => this.disconnect(socket));
  }

  publish(event: RelayedWorkbenchEvent): void {
    for (const listener of this.listeners) listener(event);
    this.enqueue(event.nodeId, { type: 'event', event });
  }

  broadcast(message: object): void {
    this.scheduleBroadcast(message, JSON.stringify(message));
  }

  sendUser(userId: number, message: object): void {
    const serialized = JSON.stringify(message);
    for (const [socket, user] of this.browsers)
      if (user.userId === userId && !this.shareSockets.has(socket))
        this.sendSerialized(socket, serialized);
  }

  /** Only a ready physical browser socket suppresses offline delivery. */
  hasUserConnection(userId: number): boolean {
    for (const [socket, user] of this.browsers)
      if (
        user.userId === userId &&
        !this.shareSockets.has(socket) &&
        socket.readyState === socket.OPEN
      )
        return true;
    return false;
  }

  ownsConnection(sessionHash: string, connectionId: string): boolean {
    return this.connections.get(connectionId)?.user.sessionHash === sessionHash;
  }

  async sendConnection(
    connectionId: string,
    message: object
  ): Promise<'delivered' | 'unavailable' | 'authorization-revoked'> {
    const previous = this.directedTails.get(connectionId) ?? Promise.resolve();
    const delivery = previous
      .catch(() => undefined)
      .then(() => this.deliverConnection(connectionId, message));
    const tail = delivery.then(
      () => undefined,
      () => undefined
    );
    this.directedTails.set(connectionId, tail);
    void tail.finally(() => {
      if (this.directedTails.get(connectionId) === tail) this.directedTails.delete(connectionId);
    });
    return delivery;
  }

  sendDirectConnection(
    connectionId: string,
    message: object
  ): Promise<'delivered' | 'unavailable' | 'authorization-revoked'> {
    const connection = this.connections.get(connectionId);
    const socket = connection?.socket;
    if (connection?.share !== undefined) return Promise.resolve('authorization-revoked');
    if (connection === undefined) return Promise.resolve('authorization-revoked');
    if (socket === undefined || socket.readyState !== socket.OPEN)
      return Promise.resolve('unavailable');
    this.send(socket, message);
    return Promise.resolve('delivered');
  }

  private async deliverConnection(
    connectionId: string,
    message: object
  ): Promise<'delivered' | 'unavailable' | 'authorization-revoked'> {
    const connection = this.connections.get(connectionId);
    const socket = connection?.socket;
    if (socket === undefined || socket.readyState !== socket.OPEN) return 'unavailable';
    const nodeId = messageNodeId(message);
    if (nodeId === undefined || connection === undefined) return 'authorization-revoked';
    if (connection.share !== undefined) {
      if (!matchesShareWatch(connection, message)) return 'authorization-revoked';
      if (!(await connection.share.validate())) {
        this.invalidateShare(connection.share.shareId, 'SESSION_SHARE_ACCESS_INVALID');
        return 'authorization-revoked';
      }
    }
    const hosted = hostedConversationWatchTarget(message);
    const allowed =
      hosted === undefined
        ? await this.options.authorizeNodeRequest(
            connection.user.userId,
            nodeId,
            'workbench.event.receive',
            message,
            messageWorkspaceId(message)
          )
        : hosted === null
          ? false
          : this.authorizeHostedConversation !== undefined &&
            (await this.authorizeHostedConversation(
              connection.user.userId,
              nodeId,
              hosted.templateId
            ));
    if (!allowed) return 'authorization-revoked';
    const currentSocket = this.connections.get(connectionId)?.socket;
    if (currentSocket === undefined || currentSocket.readyState !== currentSocket.OPEN)
      return 'unavailable';
    this.send(currentSocket, message);
    return 'delivered';
  }

  onEvent(listener: (event: RelayedWorkbenchEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  closeSession(sessionHash: string): void {
    for (const connection of [...this.connections.values()])
      if (connection.user.sessionHash === sessionHash)
        this.revokeConnection(connection, 'USER_SESSION_CLOSED');
    for (const [socket, user] of [...this.attached])
      if (user.sessionHash === sessionHash) {
        this.attached.delete(socket);
        socket.close(1000, 'USER_SESSION_CLOSED');
      }
  }

  closeUser(userId: number): void {
    for (const connection of [...this.connections.values()])
      if (connection.user.userId === userId)
        this.revokeConnection(connection, 'USER_SESSIONS_CLOSED');
    for (const [socket, user] of [...this.attached])
      if (user.userId === userId) {
        this.attached.delete(socket);
        socket.close(1000, 'USER_SESSIONS_CLOSED');
      }
  }

  close(): void {
    for (const timer of this.shareTimers.values()) clearTimeout(timer);
    this.shareTimers.clear();
    this.shareSockets.clear();
    this.queues.clear();
    this.directedTails.clear();
    const attached = [...this.attached.keys()];
    this.attached.clear();
    for (const socket of attached) socket.close(1000, 'USER_SESSIONS_CLOSED');
    this.browsers.clear();
    this.broadcastTails.clear();
    for (const connection of this.connections.values())
      if (connection.releaseTimer !== undefined) clearTimeout(connection.releaseTimer);
    this.connections.clear();
    this.socketConnections.clear();
  }

  private enqueue(nodeId: string, message: object): void {
    const queue = this.queues.get(nodeId) ?? [];
    queue.push(message);
    this.queues.set(nodeId, queue);
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => this.flush());
  }

  private flush(): void {
    this.scheduled = false;
    let sent = 0;
    let bytes = 0;
    while (sent < MAX_BROADCASTS_PER_TURN) {
      const nodeIds = [...this.queues.keys()];
      if (nodeIds.length === 0) break;
      let progressed = false;
      for (const nodeId of nodeIds) {
        const queue = this.queues.get(nodeId);
        const message = queue?.[0];
        if (queue === undefined || message === undefined) {
          this.queues.delete(nodeId);
          continue;
        }
        const serialized = JSON.stringify(message);
        const size = Buffer.byteLength(serialized);
        if (sent > 0 && bytes + size > MAX_BROADCAST_BYTES_PER_TURN) break;
        queue.shift();
        this.queues.delete(nodeId);
        if (queue.length > 0) this.queues.set(nodeId, queue);
        this.scheduleBroadcast(message, serialized);
        sent += 1;
        bytes += size;
        progressed = true;
        if (sent >= MAX_BROADCASTS_PER_TURN) break;
      }
      if (!progressed || bytes >= MAX_BROADCAST_BYTES_PER_TURN) break;
    }
    if (this.queues.size > 0 && !this.scheduled) {
      this.scheduled = true;
      setImmediate(() => this.flush());
    }
  }

  private async handleMessage(
    socket: WebSocket,
    user: UserNodeAuthorization,
    raw: string
  ): Promise<void> {
    if (this.attached.get(socket) !== user) return;
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      socket.close(4002, 'WORKBENCH_MESSAGE_INVALID');
      return;
    }
    if (this.socketConnections.has(socket)) {
      if (
        record(message) &&
        message.type === 'ping' &&
        typeof message.id === 'string' &&
        message.id.length > 0 &&
        message.id.length <= 64
      ) {
        this.send(socket, { type: 'pong', id: message.id });
        return;
      }
      const share = this.shareSockets.get(socket);
      if (share !== undefined) {
        const visitor =
          record(message) && message.type === 'session-share.visitor'
            ? sessionShareVisitorSchema.safeParse(message.visitor)
            : undefined;
        if (visitor?.success && visitor.data.visitorId === share.visitor.visitorId) {
          for (const current of this.shareSockets.values())
            if (
              sameShareTarget(current.target, share.target) &&
              current.visitor.visitorId === share.visitor.visitorId
            )
              current.visitor = visitor.data;
          this.publishShareParticipants(share.target);
        } else socket.close(4002, 'WORKBENCH_MESSAGE_INVALID');
        return;
      }
      const direct = directBrowserMessageSchema.safeParse(message);
      if (direct.success) {
        const connection = this.socketConnections.get(socket);
        if (connection === undefined || this.directTransferHandler === undefined) {
          socket.close(4002, 'WORKBENCH_MESSAGE_INVALID');
          return;
        }
        await this.directTransferHandler.message(
          {
            ...connection.user,
            workbenchConnectionId: connection.id
          },
          direct.data
        );
        return;
      }
      const terminal = terminalDirectBrowserMessageSchema.safeParse(message);
      if (terminal.success) {
        const connection = this.socketConnections.get(socket);
        if (connection === undefined || this.terminalDirectHandler === undefined) {
          socket.close(4002, 'WORKBENCH_MESSAGE_INVALID');
          return;
        }
        await this.terminalDirectHandler.message(
          { ...connection.user, workbenchConnectionId: connection.id },
          terminal.data
        );
        return;
      }
      socket.close(
        4002,
        record(message) && message.type === 'resume'
          ? 'WORKBENCH_ALREADY_READY'
          : 'WORKBENCH_MESSAGE_INVALID'
      );
      return;
    }
    if (!record(message) || message.type !== 'resume') {
      socket.close(4002, 'WORKBENCH_MESSAGE_INVALID');
      return;
    }
    const requestedId =
      typeof message.workbenchConnectionId === 'string' ? message.workbenchConnectionId : undefined;
    const requestedToken =
      typeof message.workbenchResumeToken === 'string' ? message.workbenchResumeToken : undefined;
    const existing = requestedId === undefined ? undefined : this.connections.get(requestedId);
    const canResume =
      existing !== undefined &&
      existing.user.sessionHash === user.sessionHash &&
      existing.resumeToken === requestedToken;
    if (!canResume && this.connectionCount(user.sessionHash) >= MAX_CONNECTIONS_PER_USER) {
      socket.close(4008, 'WORKBENCH_CONNECTION_LIMIT_REACHED');
      return;
    }
    const share = this.shareSockets.get(socket);
    const connection =
      canResume && existing !== undefined ? existing : this.createConnection(user, share);
    if (connection.releaseTimer !== undefined) clearTimeout(connection.releaseTimer);
    delete connection.releaseTimer;
    const previous = connection.socket;
    connection.socket = socket;
    this.browsers.set(socket, user);
    this.socketConnections.set(socket, connection);
    if (previous !== undefined && previous !== socket) {
      this.attached.delete(previous);
      this.shareSockets.delete(previous);
      this.browsers.delete(previous);
      this.broadcastTails.delete(previous);
      this.socketConnections.delete(previous);
      previous.close(4000, 'WORKBENCH_CONNECTION_REPLACED');
    }
    this.send(socket, {
      type: 'workbench.ready',
      workbenchConnectionId: connection.id,
      workbenchResumeToken: connection.resumeToken,
      resumed: canResume
    });
    if (canResume) this.directTransferHandler?.resumed?.(connection.id);
    if (share !== undefined) this.publishShareParticipants(share.target);
  }

  private async broadcastToSocket(
    socket: WebSocket,
    user: UserNodeAuthorization,
    message: object,
    serialized: string
  ): Promise<void> {
    const share = this.shareSockets.get(socket);
    if (share !== undefined) {
      if (
        !record(message) ||
        message.type !== 'node' ||
        message.nodeId !== share.target.nodeId ||
        typeof message.connected !== 'boolean'
      )
        return;
      if (!(await share.validate())) {
        this.invalidateShare(share.shareId, 'SESSION_SHARE_ACCESS_INVALID');
        return;
      }
      if (this.shareSockets.get(socket) !== share || this.browsers.get(socket) !== user) return;
      this.send(socket, {
        type: 'node',
        nodeId: message.nodeId,
        connected: message.connected,
        ...(message.reason === 'CONNECTION_REPLACED' ? { reason: 'CONNECTION_REPLACED' } : {})
      });
      return;
    }
    const nodeId = messageNodeId(message);
    if (nodeId !== undefined) {
      const workspaceId = messageWorkspaceId(message);
      let allowed = false;
      try {
        allowed = await this.options.authorizeNodeRequest(
          user.userId,
          nodeId,
          messageWorkspaceOperation(message),
          message,
          workspaceId
        );
      } catch {
        // Authorization failures deny this delivery without breaking later broadcasts.
      }
      if (!allowed) return;
    }
    if (this.browsers.get(socket) !== user) return;
    this.sendSerialized(socket, serialized);
  }

  private scheduleBroadcast(message: object, serialized: string): void {
    // Per-connection sequence deduplication requires authorized events to stay in Node order.
    for (const [socket, user] of [...this.browsers]) {
      const previous = this.broadcastTails.get(socket) ?? Promise.resolve();
      const pending = previous.then(() =>
        this.broadcastToSocket(socket, user, message, serialized)
      );
      this.broadcastTails.set(socket, pending);
      void pending.then(() => {
        if (this.broadcastTails.get(socket) === pending) this.broadcastTails.delete(socket);
      });
    }
  }

  private send(socket: WebSocket, message: object): void {
    this.sendSerialized(socket, JSON.stringify(message));
  }

  private sendSerialized(socket: WebSocket, serialized: string): void {
    if (socket.readyState !== socket.OPEN) return;
    if (socket.bufferedAmount > MAX_SOCKET_BUFFERED_BYTES) {
      this.options.traffic?.backpressure('workbench', socket.bufferedAmount);
      this.browsers.delete(socket);
      socket.close(4009, 'WORKBENCH_BACKPRESSURE');
      return;
    }
    try {
      this.options.traffic?.record('workbench', 'out', Buffer.byteLength(serialized));
      socket.send(serialized);
    } catch {
      this.browsers.delete(socket);
      socket.close(1011, 'WORKBENCH_SEND_FAILED');
    }
  }

  private connectionCount(sessionHash: string): number {
    return [...this.connections.values()].filter(
      (connection) => connection.user.sessionHash === sessionHash
    ).length;
  }

  private createConnection(
    user: UserNodeAuthorization,
    share?: ShareWorkbenchAccess
  ): WorkbenchConnection {
    const connection: WorkbenchConnection = {
      id: randomBytes(24).toString('base64url'),
      resumeToken: randomBytes(32).toString('base64url'),
      user,
      ...(share === undefined ? {} : { share })
    };
    this.connections.set(connection.id, connection);
    return connection;
  }

  private disconnect(socket: WebSocket): void {
    const share = this.shareSockets.get(socket);
    this.shareSockets.delete(socket);
    if (share !== undefined) this.refreshSharePresence(share);
    this.attached.delete(socket);
    this.browsers.delete(socket);
    this.broadcastTails.delete(socket);
    const connection = this.socketConnections.get(socket);
    this.socketConnections.delete(socket);
    if (connection === undefined || connection.socket !== socket) return;
    delete connection.socket;
    connection.releaseTimer = setTimeout(() => {
      if (connection.socket !== undefined) return;
      this.connections.delete(connection.id);
      this.directTransferHandler?.revoked?.(connection.id, 'DIRECT_PAGE_CONNECTION_CLOSED');
      this.terminalDirectHandler?.revoked?.(connection.id, 'TERMINAL_PAGE_CONNECTION_CLOSED');
    }, DISCONNECTED_GRACE_MS);
    connection.releaseTimer.unref();
    this.directTransferHandler?.disconnected?.(connection.id);
  }

  private revokeConnection(connection: WorkbenchConnection, reason: string): void {
    if (connection.releaseTimer !== undefined) clearTimeout(connection.releaseTimer);
    this.connections.delete(connection.id);
    this.directTransferHandler?.revoked?.(connection.id, directRevocationCode(reason));
    this.terminalDirectHandler?.revoked?.(connection.id, 'TERMINAL_PAGE_CONNECTION_CLOSED');
    const socket = connection.socket;
    delete connection.socket;
    if (socket === undefined) return;
    this.attached.delete(socket);
    const share = this.shareSockets.get(socket);
    this.shareSockets.delete(socket);
    if (share !== undefined) this.refreshSharePresence(share);
    this.browsers.delete(socket);
    this.broadcastTails.delete(socket);
    this.socketConnections.delete(socket);
    socket.close(1000, reason);
  }

  invalidateShare(shareId: string, code: string): void {
    const affected = [...this.shareSockets.values()].find((share) => share.shareId === shareId);
    for (const connection of [...this.connections.values()]) {
      if (connection.share?.shareId !== shareId) continue;
      if (connection.socket !== undefined)
        this.send(connection.socket, { type: 'session-share.invalidated', code });
      this.revokeConnection(connection, code);
    }
    for (const [socket, share] of [...this.shareSockets]) {
      if (share.shareId !== shareId) continue;
      this.shareSockets.delete(socket);
      this.attached.delete(socket);
      socket.close(4001, code);
    }
    if (affected !== undefined) this.refreshSharePresence(affected);
  }

  private publishShareParticipants(target: SessionShareTarget): void {
    const online = [...this.shareSockets].filter(
      ([socket, share]) => sameShareTarget(share.target, target) && this.browsers.has(socket)
    );
    const participants = new Map<string, SessionShareVisitor>();
    for (const [, share] of online) participants.set(share.visitor.visitorId, share.visitor);
    for (const [socket, share] of online)
      this.send(socket, {
        type: 'session-share.participants',
        canRename: true,
        sharerOnline: online.some(([, person]) => person.account?.userId === share.ownerUserId),
        participants: [...participants.values()]
      });
  }

  private refreshSharePresence(removed: ShareWorkbenchAccess): void {
    this.publishShareParticipants(removed.target);
    if (![...this.shareSockets.values()].some((share) => share.shareId === removed.shareId)) {
      clearTimeout(this.shareTimers.get(removed.shareId));
      this.shareTimers.delete(removed.shareId);
    }
  }

  private armShareExpiration(share: ShareWorkbenchAccess): void {
    if (share.expiresAt === null || this.shareTimers.has(share.shareId)) return;
    const remaining = share.expiresAt - Date.now();
    const timer = setTimeout(
      () => {
        this.shareTimers.delete(share.shareId);
        if (share.expiresAt! <= Date.now())
          this.invalidateShare(share.shareId, 'SESSION_SHARE_EXPIRED');
        else this.armShareExpiration(share);
      },
      Math.min(Math.max(0, remaining), 2_147_483_647)
    );
    timer.unref();
    this.shareTimers.set(share.shareId, timer);
  }
}

function sameShareTarget(left: SessionShareTarget, right: SessionShareTarget): boolean {
  return (
    left.nodeId === right.nodeId &&
    left.workspaceId === right.workspaceId &&
    left.sessionId === right.sessionId
  );
}

function matchesShareWatch(connection: WorkbenchConnection, message: object): boolean {
  if (!record(message) || message.type !== 'watch.event' || !record(message.event)) return false;
  const event = message.event;
  const target = connection.share!.target;
  return (
    (event.type === 'watch.session.snapshot' ||
      event.type === 'watch.session.event' ||
      (event.type === 'watch.failed' && event.watchType === 'session')) &&
    event.nodeId === target.nodeId &&
    event.workspaceId === target.workspaceId &&
    event.sessionId === target.sessionId &&
    event.workbenchConnectionId === connection.id
  );
}

function directRevocationCode(reason: string): string {
  if (reason === 'USER_SESSION_CLOSED') return 'DIRECT_USER_SESSION_CLOSED';
  if (reason === 'USER_SESSIONS_CLOSED') return 'DIRECT_USER_SESSIONS_CLOSED';
  return 'DIRECT_PAGE_CONNECTION_CLOSED';
}

function messageNodeId(message: object): string | undefined {
  const candidate = message as { nodeId?: unknown; event?: { nodeId?: unknown } };
  if (typeof candidate.nodeId === 'string') return candidate.nodeId;
  return typeof candidate.event?.nodeId === 'string' ? candidate.event.nodeId : undefined;
}

function messageWorkspaceId(message: object): string | undefined {
  const candidate = message as {
    workspaceId?: unknown;
    event?: { workspaceId?: unknown; payload?: { workspaceId?: unknown } };
  };
  if (typeof candidate.workspaceId === 'string') return candidate.workspaceId;
  if (typeof candidate.event?.workspaceId === 'string') return candidate.event.workspaceId;
  return typeof candidate.event?.payload?.workspaceId === 'string'
    ? candidate.event.payload.workspaceId
    : undefined;
}

function messageWorkspaceOperation(message: object): string {
  return (message as { type?: unknown }).type === 'node'
    ? 'workbench.node.receive'
    : 'workbench.event.receive';
}

function hostedConversationWatchTarget(
  message: object
): { readonly templateId: string } | null | undefined {
  if (!record(message) || message.type !== 'watch.event' || !record(message.event))
    return undefined;
  const event = message.event;
  const hosted =
    event.type === 'watch.hosted-conversation.snapshot' ||
    event.type === 'watch.hosted-conversation.event' ||
    (event.type === 'watch.failed' && event.watchType === 'hosted-conversation');
  if (!hosted) return undefined;
  return typeof event.templateId === 'string' && event.templateId.length > 0
    ? { templateId: event.templateId }
    : null;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
