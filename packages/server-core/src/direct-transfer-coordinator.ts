import { randomBytes } from 'node:crypto';
import { emitAudit, type AuditObserver } from './audit.js';
import type {
  DirectBrowserMessage,
  DirectNodeEvent,
  DirectPrepareRequest,
  DirectServerMessage,
  DirectSignal,
  DirectTransferDescriptor
} from '@myagentroam/protocol';

const TRANSPORT_LEASE_MS = 60_000;
const TRANSFER_TTL_MS = 24 * 60 * 60 * 1000;
const OPEN_TTL_MS = 60_000;
const DISCONNECTED_GRACE_MS = 30_000;
const SWEEP_MS = 5_000;
const MAX_TRANSPORTS_PER_NODE = 128;
const MAX_TRANSFERS_PER_CONNECTION = 32;
const MAX_TRANSFERS_PER_NODE = 128;
const MAX_CANDIDATES_PER_ENDPOINT = 32;

export interface DirectTransferBrowserIdentity {
  readonly userId: number;
  readonly sessionHash: string;
  readonly workbenchConnectionId: string;
}

interface DirectSessionBase extends DirectTransferBrowserIdentity {
  readonly directSessionId: string;
  readonly nodeId: string;
  readonly nodeGeneration: string;
  readonly createdAt: number;
  expiresAt: number;
  disconnected: boolean;
  disconnectedAt?: number;
}

interface DirectTransportSession extends DirectSessionBase {
  readonly purpose: 'TRANSPORT';
  browserFingerprint?: string;
  nodeFingerprint?: string;
  browserConnected?: boolean;
  nodeConnected?: boolean;
  readonly browserCandidates: Set<string>;
  readonly nodeCandidates: Set<string>;
}

interface DirectFileTransferSession extends DirectSessionBase {
  readonly purpose: 'TRANSFER';
  readonly transportSessionId: string;
  readonly transfer: DirectTransferDescriptor;
  grant?: string;
}

type DirectSession = DirectTransportSession | DirectFileTransferSession;

export interface DirectTransferCoordinatorOptions {
  readonly audits?: Partial<AuditObserver>;
  readonly authorize: (
    userId: number,
    nodeId: string,
    workspaceId: string | undefined
  ) => boolean | Promise<boolean>;
  readonly sendNode: (nodeId: string, type: string, payload: unknown) => boolean;
  readonly sendBrowser: (
    connectionId: string,
    message: DirectServerMessage
  ) => Promise<'delivered' | 'unavailable' | 'authorization-revoked'>;
  readonly now?: () => number;
  readonly randomId?: () => string;
}

export class DirectTransferCoordinator {
  private readonly sessions = new Map<string, DirectSession>();
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly sweep: NodeJS.Timeout;

  constructor(private readonly options: DirectTransferCoordinatorOptions) {
    this.now = options.now ?? Date.now;
    this.randomId = options.randomId ?? (() => randomBytes(24).toString('base64url'));
    this.sweep = setInterval(() => this.expire(), SWEEP_MS);
    this.sweep.unref();
  }

  async handleBrowserMessage(
    identity: DirectTransferBrowserIdentity,
    message: DirectBrowserMessage
  ): Promise<void> {
    this.expire();
    if (message.type === 'direct.prepare') {
      await this.prepare(identity, message);
      return;
    }
    const session = this.sessionForBrowser(identity, message.directSessionId);
    if (session === undefined) {
      await this.error(identity.workbenchConnectionId, {
        directSessionId: message.directSessionId,
        code: 'DIRECT_TRANSFER_SESSION_NOT_FOUND',
        message: 'The direct transfer session is unavailable.'
      });
      return;
    }
    if (message.type === 'direct.signal') {
      if (session.purpose !== 'TRANSPORT') {
        await this.closeSession(session, 'DIRECT_TRANSFER_STAGE_INVALID');
        return;
      }
      if (!this.acceptSignalCandidates(session, 'browser', message.signal)) {
        await this.closeSession(session, 'DIRECT_TRANSFER_CANDIDATE_REJECTED');
        return;
      }
      this.captureFingerprint(session, 'browser', message.signal);
      if (!this.options.sendNode(session.nodeId, 'direct.signal', message))
        await this.closeSession(session, 'DIRECT_NODE_OFFLINE');
      return;
    }
    if (message.type === 'direct.connected') {
      if (session.purpose !== 'TRANSPORT') {
        await this.closeSession(session, 'DIRECT_TRANSFER_STAGE_INVALID');
        return;
      }
      session.browserConnected = true;
      await this.markTransportReady(session);
      return;
    }
    if (message.type === 'direct.heartbeat') {
      if (!(await this.isAuthorized(session))) {
        await this.closeSession(session, 'DIRECT_TRANSFER_NOT_AUTHORIZED');
        return;
      }
      if (session.purpose === 'TRANSPORT') session.expiresAt = this.now() + TRANSPORT_LEASE_MS;
      if (
        !this.options.sendNode(session.nodeId, 'direct.heartbeat', {
          ...message,
          expiresAt: session.expiresAt
        })
      ) {
        await this.closeSession(session, 'DIRECT_NODE_OFFLINE');
        return;
      }
      await this.options.sendBrowser(session.workbenchConnectionId, {
        type: 'direct.heartbeat',
        directSessionId: session.directSessionId,
        alive: true,
        expiresAt: session.expiresAt
      });
      return;
    }
    if (message.type === 'direct.cancel') {
      this.auditUpload(session, 'workspace.files.upload.cancel');
      await this.closeSession(session, 'DIRECT_TRANSFER_CANCELLED');
      return;
    }
    if (session.purpose !== 'TRANSFER') {
      await this.closeSession(session, 'DIRECT_TRANSFER_STAGE_INVALID');
      return;
    }
    this.options.sendNode(session.nodeId, message.type, message);
  }

  handleNodeMessage(nodeId: string, event: DirectNodeEvent): void {
    this.expire();
    const session = this.sessions.get(event.directSessionId);
    if (session === undefined || session.nodeId !== nodeId) return;
    if (event.type === 'direct.signal') {
      if (session.purpose !== 'TRANSPORT') {
        void this.closeSession(session, 'DIRECT_TRANSFER_STAGE_INVALID');
        return;
      }
      if (!this.acceptSignalCandidates(session, 'node', event.signal)) {
        void this.closeSession(session, 'DIRECT_TRANSFER_CANDIDATE_REJECTED');
        return;
      }
      this.captureFingerprint(session, 'node', event.signal);
      void this.options.sendBrowser(session.workbenchConnectionId, event);
      return;
    }
    if (event.type === 'direct.connected') {
      if (session.purpose !== 'TRANSPORT') {
        void this.closeSession(session, 'DIRECT_TRANSFER_STAGE_INVALID');
        return;
      }
      session.nodeConnected = true;
      void this.markTransportReady(session);
      return;
    }
    if (event.type === 'direct.error') {
      this.auditUpload(session, 'workspace.files.upload.complete', event.code);
      void this.options.sendBrowser(session.workbenchConnectionId, event).finally(() => {
        void this.closeSession(session, event.code, false);
      });
      return;
    }
    if (session.purpose !== 'TRANSFER') return;
    void this.options.sendBrowser(session.workbenchConnectionId, event);
    if (event.type === 'direct.complete') {
      this.auditUpload(session, 'workspace.files.upload.complete');
      this.sessions.delete(session.directSessionId);
    }
  }

  private auditUpload(session: DirectSession, eventType: string, errorCode?: string): void {
    if (session.purpose !== 'TRANSFER' || session.transfer.direction !== 'UPLOAD') return;
    emitAudit(this.options.audits ?? {}, {
      eventType,
      actorUserId: session.userId,
      nodeId: session.nodeId,
      workspaceId: session.transfer.resource.workspaceId,
      targetType: 'WORKSPACE',
      targetId: session.transfer.resource.workspaceId,
      operationId: session.directSessionId,
      result: errorCode ? 'FAILED' : 'SUCCESS',
      ...(errorCode ? { errorCode } : {}),
      metadata: JSON.stringify({
        action: eventType,
        relativePath: session.transfer.resource.path,
        fileName: session.transfer.fileName,
        sizeBytes: session.transfer.size
      })
    });
  }

  connectionDisconnected(connectionId: string): void {
    for (const session of this.sessions.values())
      if (session.workbenchConnectionId === connectionId) {
        session.disconnected = true;
        session.disconnectedAt = this.now();
      }
  }

  connectionResumed(connectionId: string): void {
    for (const session of this.sessions.values())
      if (session.workbenchConnectionId === connectionId) {
        session.disconnected = false;
        delete session.disconnectedAt;
      }
  }

  revokeConnection(connectionId: string, code: string): void {
    for (const session of [...this.sessions.values()])
      if (session.workbenchConnectionId === connectionId) void this.closeSession(session, code);
  }

  revokeNode(nodeId: string, code: string): void {
    for (const session of [...this.sessions.values()])
      if (session.nodeId === nodeId) void this.closeSession(session, code);
  }

  close(): void {
    clearInterval(this.sweep);
    for (const session of [...this.sessions.values()])
      void this.closeSession(session, 'DIRECT_SERVER_SHUTDOWN');
  }

  terminalTransport(
    identity: DirectTransferBrowserIdentity,
    transportSessionId: string,
    nodeId: string,
    nodeGeneration: string
  ):
    | {
        readonly browserFingerprint: string;
        readonly nodeFingerprint: string;
      }
    | undefined {
    const session = this.sessionForBrowser(identity, transportSessionId);
    if (
      session?.purpose !== 'TRANSPORT' ||
      session.nodeId !== nodeId ||
      session.nodeGeneration !== nodeGeneration ||
      session.disconnected ||
      session.expiresAt <= this.now() ||
      !transportReady(session)
    )
      return undefined;
    return {
      browserFingerprint: session.browserFingerprint!,
      nodeFingerprint: session.nodeFingerprint!
    };
  }

  private async prepare(
    identity: DirectTransferBrowserIdentity,
    request: DirectPrepareRequest
  ): Promise<void> {
    const workspaceId =
      request.purpose === 'TRANSFER' ? request.transfer.resource.workspaceId : undefined;
    if (!(await this.options.authorize(identity.userId, request.nodeId, workspaceId))) {
      await this.error(identity.workbenchConnectionId, {
        requestId: request.requestId,
        code: 'DIRECT_TRANSFER_NOT_AUTHORIZED',
        message: 'The direct transfer target is not authorized.'
      });
      return;
    }
    if (request.purpose === 'TRANSPORT') {
      await this.prepareTransport(identity, request);
      return;
    }
    await this.prepareTransfer(identity, request);
  }

  private async prepareTransport(
    identity: DirectTransferBrowserIdentity,
    request: Extract<DirectPrepareRequest, { purpose: 'TRANSPORT' }>
  ): Promise<void> {
    const existing = [...this.sessions.values()].find(
      (session): session is DirectTransportSession =>
        session.purpose === 'TRANSPORT' &&
        session.workbenchConnectionId === identity.workbenchConnectionId &&
        session.nodeId === request.nodeId &&
        session.nodeGeneration === request.nodeGeneration
    );
    if (existing !== undefined) {
      await this.sendPrepared(identity.workbenchConnectionId, request.requestId, existing);
      return;
    }
    if (
      this.countSessions(
        (session) => session.purpose === 'TRANSPORT' && session.nodeId === request.nodeId
      ) >= MAX_TRANSPORTS_PER_NODE
    ) {
      await this.limitError(identity.workbenchConnectionId, request.requestId);
      return;
    }
    const createdAt = this.now();
    const transport: DirectTransportSession = {
      ...identity,
      directSessionId: this.randomId(),
      nodeId: request.nodeId,
      nodeGeneration: request.nodeGeneration,
      purpose: 'TRANSPORT',
      createdAt,
      expiresAt: createdAt + TRANSPORT_LEASE_MS,
      disconnected: false,
      browserCandidates: new Set(),
      nodeCandidates: new Set()
    };
    this.sessions.set(transport.directSessionId, transport);
    if (!this.sendPrepareNode(transport, undefined)) {
      this.sessions.delete(transport.directSessionId);
      await this.nodeOffline(
        identity.workbenchConnectionId,
        request.requestId,
        transport.directSessionId
      );
      return;
    }
    await this.sendPrepared(identity.workbenchConnectionId, request.requestId, transport);
  }

  private async prepareTransfer(
    identity: DirectTransferBrowserIdentity,
    request: Extract<DirectPrepareRequest, { purpose: 'TRANSFER' }>
  ): Promise<void> {
    const transport = this.sessionForBrowser(identity, request.transportSessionId);
    if (
      transport?.purpose !== 'TRANSPORT' ||
      transport.nodeId !== request.nodeId ||
      transport.nodeGeneration !== request.nodeGeneration ||
      !transportReady(transport)
    ) {
      await this.error(identity.workbenchConnectionId, {
        requestId: request.requestId,
        code: 'DIRECT_TRANSFER_UNAVAILABLE',
        message: 'The direct transport is unavailable.'
      });
      return;
    }
    if (
      this.countSessions(
        (session) =>
          session.purpose === 'TRANSFER' &&
          session.workbenchConnectionId === identity.workbenchConnectionId
      ) >= MAX_TRANSFERS_PER_CONNECTION ||
      this.countSessions(
        (session) => session.purpose === 'TRANSFER' && session.nodeId === request.nodeId
      ) >= MAX_TRANSFERS_PER_NODE
    ) {
      await this.limitError(identity.workbenchConnectionId, request.requestId);
      return;
    }
    const createdAt = this.now();
    const transfer: DirectFileTransferSession = {
      ...identity,
      directSessionId: this.randomId(),
      transportSessionId: transport.directSessionId,
      nodeId: request.nodeId,
      nodeGeneration: request.nodeGeneration,
      purpose: 'TRANSFER',
      transfer: request.transfer,
      createdAt,
      expiresAt: createdAt + TRANSFER_TTL_MS,
      disconnected: false
    };
    this.sessions.set(transfer.directSessionId, transfer);
    if (!this.sendPrepareNode(transfer, transport)) {
      this.sessions.delete(transfer.directSessionId);
      await this.nodeOffline(
        identity.workbenchConnectionId,
        request.requestId,
        transfer.directSessionId
      );
      return;
    }
    await this.sendPrepared(identity.workbenchConnectionId, request.requestId, transfer);
    await this.issueTransferGrant(transfer, transport);
  }

  private sendPrepareNode(
    session: DirectSession,
    transport: DirectTransportSession | undefined
  ): boolean {
    return this.options.sendNode(session.nodeId, 'direct.prepare', {
      type: 'direct.prepare',
      directSessionId: session.directSessionId,
      ...(session.purpose === 'TRANSFER'
        ? { transportSessionId: session.transportSessionId, transfer: session.transfer }
        : {}),
      workbenchConnectionId: session.workbenchConnectionId,
      nodeGeneration: session.nodeGeneration,
      purpose: session.purpose,
      expiresAt: session.expiresAt,
      userAuthorization: { userId: session.userId, sessionHash: session.sessionHash },
      ...(transport === undefined ? {} : {})
    });
  }

  private async sendPrepared(
    connectionId: string,
    requestId: string,
    session: DirectSession
  ): Promise<void> {
    await this.options.sendBrowser(connectionId, {
      type: 'direct.prepared',
      requestId,
      directSessionId: session.directSessionId,
      nodeId: session.nodeId,
      nodeGeneration: session.nodeGeneration,
      purpose: session.purpose,
      expiresAt: session.expiresAt,
      ...(session.purpose === 'TRANSFER'
        ? {
            transportSessionId: session.transportSessionId,
            ...(session.transfer.direction === 'UPLOAD' &&
            session.transfer.resumeOffset !== undefined
              ? { resumeOffset: session.transfer.resumeOffset }
              : {})
          }
        : {})
    });
  }

  private async markTransportReady(transport: DirectTransportSession): Promise<void> {
    if (!transportReady(transport)) return;
    transport.expiresAt = this.now() + TRANSPORT_LEASE_MS;
    await this.options.sendBrowser(transport.workbenchConnectionId, {
      type: 'direct.opened',
      directSessionId: transport.directSessionId,
      offset: 0
    });
  }

  private async issueTransferGrant(
    transfer: DirectFileTransferSession,
    transport: DirectTransportSession
  ): Promise<void> {
    if (transfer.grant !== undefined || !transportReady(transport)) return;
    if (!(await this.isAuthorized(transfer))) {
      await this.closeSession(transfer, 'DIRECT_TRANSFER_NOT_AUTHORIZED');
      return;
    }
    const openExpiresAt = Math.min(this.now() + OPEN_TTL_MS, transfer.expiresAt);
    const grant = `${this.randomId()}.${this.randomId()}`;
    transfer.grant = grant;
    const command = {
      type: 'direct.grant' as const,
      directSessionId: transfer.directSessionId,
      transportSessionId: transport.directSessionId,
      grant,
      browserFingerprint: transport.browserFingerprint!,
      nodeFingerprint: transport.nodeFingerprint!,
      openExpiresAt,
      expiresAt: transfer.expiresAt
    };
    if (!this.options.sendNode(transfer.nodeId, 'direct.grant', command)) {
      await this.closeSession(transfer, 'DIRECT_NODE_OFFLINE');
      return;
    }
    await this.options.sendBrowser(transfer.workbenchConnectionId, {
      type: 'direct.grant',
      directSessionId: transfer.directSessionId,
      grant,
      openExpiresAt,
      expiresAt: transfer.expiresAt
    });
  }

  private captureFingerprint(
    session: DirectTransportSession,
    endpoint: 'browser' | 'node',
    signal: DirectSignal
  ): void {
    if (signal.kind !== 'OFFER' && signal.kind !== 'ANSWER') return;
    if (endpoint === 'browser') session.browserFingerprint = signal.fingerprint;
    else session.nodeFingerprint = signal.fingerprint;
  }

  private acceptSignalCandidates(
    session: DirectTransportSession,
    endpoint: 'browser' | 'node',
    signal: DirectSignal
  ): boolean {
    const candidates = endpoint === 'browser' ? session.browserCandidates : session.nodeCandidates;
    for (const candidate of signalCandidates(signal)) {
      if (!/\styp host(?:\s|$)/u.test(candidate)) return false;
      candidates.add(candidate);
      if (candidates.size > MAX_CANDIDATES_PER_ENDPOINT) return false;
    }
    return true;
  }

  private sessionForBrowser(
    identity: DirectTransferBrowserIdentity,
    directSessionId: string
  ): DirectSession | undefined {
    const session = this.sessions.get(directSessionId);
    return session !== undefined &&
      session.userId === identity.userId &&
      session.sessionHash === identity.sessionHash &&
      session.workbenchConnectionId === identity.workbenchConnectionId
      ? session
      : undefined;
  }

  private countSessions(predicate: (session: DirectSession) => boolean): number {
    let count = 0;
    for (const session of this.sessions.values()) if (predicate(session)) count += 1;
    return count;
  }

  private async isAuthorized(session: DirectSession): Promise<boolean> {
    return this.options.authorize(
      session.userId,
      session.nodeId,
      session.purpose === 'TRANSFER' ? session.transfer.resource.workspaceId : undefined
    );
  }

  private expire(): void {
    const now = this.now();
    for (const session of [...this.sessions.values()])
      if (session.expiresAt <= now)
        void this.closeSession(session, 'DIRECT_TRANSFER_SESSION_EXPIRED');
      else if (
        session.disconnectedAt !== undefined &&
        session.disconnectedAt + DISCONNECTED_GRACE_MS <= now
      )
        void this.closeSession(session, 'DIRECT_TRANSFER_CONTROL_UNAVAILABLE');
  }

  private async closeSession(
    session: DirectSession,
    code: string,
    notifyBrowser = true
  ): Promise<void> {
    if (!this.sessions.delete(session.directSessionId)) return;
    if (session.purpose === 'TRANSPORT')
      for (const child of [...this.sessions.values()])
        if (child.purpose === 'TRANSFER' && child.transportSessionId === session.directSessionId)
          await this.closeSession(child, code, notifyBrowser);
    this.options.sendNode(session.nodeId, 'direct.cancel', {
      type: 'direct.cancel',
      directSessionId: session.directSessionId,
      code
    });
    if (notifyBrowser)
      await this.options.sendBrowser(session.workbenchConnectionId, {
        type: 'direct.closed',
        directSessionId: session.directSessionId,
        code
      });
  }

  private limitError(connectionId: string, requestId: string): Promise<unknown> {
    return this.error(connectionId, {
      requestId,
      code: 'DIRECT_SESSION_LIMIT_REACHED',
      message: 'The direct transfer session limit has been reached.'
    });
  }

  private nodeOffline(
    connectionId: string,
    requestId: string,
    directSessionId: string
  ): Promise<unknown> {
    return this.error(connectionId, {
      requestId,
      directSessionId,
      code: 'DIRECT_NODE_OFFLINE',
      message: 'The Node is unavailable for direct transfer.'
    });
  }

  private error(
    connectionId: string,
    error: Omit<Extract<DirectServerMessage, { type: 'direct.error' }>, 'type'>
  ): Promise<'delivered' | 'unavailable' | 'authorization-revoked'> {
    return this.options.sendBrowser(connectionId, { type: 'direct.error', ...error });
  }
}

function transportReady(session: DirectTransportSession): boolean {
  return (
    session.browserFingerprint !== undefined &&
    session.nodeFingerprint !== undefined &&
    session.browserConnected === true &&
    session.nodeConnected === true
  );
}

function signalCandidates(signal: DirectSignal): readonly string[] {
  if (signal.kind === 'CANDIDATE') return [signal.candidate.candidate.trim()];
  if (signal.kind !== 'OFFER' && signal.kind !== 'ANSWER') return [];
  return signal.sdp
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('a=candidate:'))
    .map((line) => line.slice(2).trim());
}
