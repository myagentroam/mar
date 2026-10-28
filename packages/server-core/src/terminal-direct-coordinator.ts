import { randomBytes } from 'node:crypto';
import type {
  TerminalDirectBrowserMessage,
  TerminalDirectNodeCommand,
  TerminalDirectServerMessage
} from '@myagentroam/protocol';
import type {
  DirectTransferBrowserIdentity,
  DirectTransferCoordinator
} from './direct-transfer-coordinator.js';
import { NodeRequestError } from './node-request-error.js';

const LEASE_MS = 30_000;
const OPEN_MS = 15_000;
const SWEEP_MS = 5_000;
const MAX_TERMINALS_PER_SESSION = 10;

type Prepare = Extract<TerminalDirectBrowserMessage, { type: 'terminal.direct.prepare' }>;

interface DirectTerminalSession extends DirectTransferBrowserIdentity {
  readonly requestId: string;
  readonly directSessionId: string;
  readonly nodeId: string;
  readonly nodeGeneration: string;
  readonly transportSessionId: string;
  readonly terminalId: string;
  readonly workspaceId?: string;
  readonly readonly: boolean;
  readonly grant: string;
  readonly openExpiresAt: number;
  ready: boolean;
  attached?: boolean;
  expiresAt: number;
}

export interface TerminalDirectCoordinatorOptions {
  readonly transport: Pick<DirectTransferCoordinator, 'terminalTransport'>;
  readonly authorize: (
    userId: number,
    nodeId: string,
    workspaceId: string | undefined
  ) => boolean | Promise<boolean>;
  readonly preflight: (
    nodeId: string,
    terminalId: string,
    workspaceId: string | undefined,
    identity: DirectTransferBrowserIdentity
  ) => Promise<void>;
  readonly sendNode: (nodeId: string, message: TerminalDirectNodeCommand) => boolean;
  readonly sendBrowser: (
    connectionId: string,
    message: TerminalDirectServerMessage
  ) => Promise<'delivered' | 'unavailable' | 'authorization-revoked'>;
  readonly relayCount?: (sessionHash: string) => number;
  readonly now?: () => number;
}

export class TerminalDirectCoordinator {
  private readonly sessions = new Map<string, DirectTerminalSession>();
  private readonly now: () => number;
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly options: TerminalDirectCoordinatorOptions) {
    this.now = options.now ?? Date.now;
    this.timer = setInterval(() => void this.expire(), SWEEP_MS);
    this.timer.unref();
  }

  async handleBrowser(
    identity: DirectTransferBrowserIdentity,
    message: TerminalDirectBrowserMessage
  ): Promise<void> {
    if (message.type === 'terminal.direct.prepare') {
      await this.prepare(identity, message);
      return;
    }
    const session = this.sessions.get(message.directSessionId);
    if (
      session === undefined ||
      session.userId !== identity.userId ||
      session.sessionHash !== identity.sessionHash ||
      session.workbenchConnectionId !== identity.workbenchConnectionId
    )
      return;
    if (message.type === 'terminal.direct.cancel') {
      await this.closeSession(session, 'TERMINAL_DIRECT_CANCELLED');
      return;
    }
    if (!(await this.authorized(session))) {
      await this.closeSession(session, 'TERMINAL_NOT_AUTHORIZED');
      return;
    }
    if (this.sessions.get(session.directSessionId) !== session || session.expiresAt <= this.now())
      return;
    session.expiresAt = this.now() + LEASE_MS;
    if (
      !this.options.sendNode(session.nodeId, {
        type: 'terminal.direct.heartbeat',
        directSessionId: session.directSessionId,
        expiresAt: session.expiresAt
      })
    ) {
      await this.closeSession(session, 'NODE_OFFLINE');
      return;
    }
    const delivered = await this.options.sendBrowser(session.workbenchConnectionId, {
      type: 'terminal.direct.heartbeat',
      directSessionId: session.directSessionId,
      expiresAt: session.expiresAt
    });
    if (delivered !== 'delivered')
      await this.closeSession(
        session,
        delivered === 'authorization-revoked'
          ? 'TERMINAL_NOT_AUTHORIZED'
          : 'TERMINAL_DIRECT_CONTROL_UNAVAILABLE'
      );
  }

  async onNodeReady(nodeId: string, directSessionId: string): Promise<void> {
    const session = this.sessions.get(directSessionId);
    if (session?.nodeId !== nodeId || session.ready) return;
    if (!(await this.authorized(session))) {
      await this.closeSession(session, 'TERMINAL_NOT_AUTHORIZED');
      return;
    }
    if (this.sessions.get(directSessionId) !== session || session.openExpiresAt <= this.now())
      return;
    session.ready = true;
    const delivery = await this.options.sendBrowser(session.workbenchConnectionId, {
      type: 'terminal.direct.prepared',
      requestId: session.requestId,
      directSessionId: session.directSessionId,
      grant: session.grant,
      openExpiresAt: session.openExpiresAt,
      expiresAt: session.expiresAt
    });
    if (delivery !== 'delivered')
      await this.closeSession(
        session,
        delivery === 'authorization-revoked'
          ? 'TERMINAL_NOT_AUTHORIZED'
          : 'TERMINAL_DIRECT_CONTROL_UNAVAILABLE'
      );
  }

  onNodeAttached(nodeId: string, directSessionId: string): void {
    const session = this.sessions.get(directSessionId);
    if (!session || session.nodeId !== nodeId || !session.ready || session.attached) return;
    session.attached = true;
  }

  sessionCount(sessionHash: string): number {
    return [...this.sessions.values()].filter((item) => item.sessionHash === sessionHash).length;
  }

  revokeConnection(connectionId: string, code: string): void {
    for (const session of [...this.sessions.values()])
      if (session.workbenchConnectionId === connectionId) void this.closeSession(session, code);
  }

  revokeSession(sessionHash: string): void {
    for (const session of [...this.sessions.values()])
      if (session.sessionHash === sessionHash)
        void this.closeSession(session, 'TERMINAL_NOT_AUTHORIZED');
  }

  revokeUser(userId: number): void {
    for (const session of [...this.sessions.values()])
      if (session.userId === userId) void this.closeSession(session, 'TERMINAL_NOT_AUTHORIZED');
  }

  revokeNode(nodeId: string, code: string): void {
    for (const session of [...this.sessions.values()])
      if (session.nodeId === nodeId) void this.closeSession(session, code);
  }

  close(): void {
    clearInterval(this.timer);
    for (const session of [...this.sessions.values()])
      void this.closeSession(session, 'TERMINAL_SERVER_SHUTDOWN');
  }

  private async prepare(identity: DirectTransferBrowserIdentity, request: Prepare): Promise<void> {
    const transport = this.options.transport.terminalTransport(
      identity,
      request.transportSessionId,
      request.nodeId,
      request.nodeGeneration
    );
    if (transport === undefined) {
      await this.error(
        identity.workbenchConnectionId,
        request.requestId,
        'TERMINAL_DIRECT_UNAVAILABLE'
      );
      return;
    }
    if (!(await this.options.authorize(identity.userId, request.nodeId, request.workspaceId))) {
      await this.error(
        identity.workbenchConnectionId,
        request.requestId,
        'TERMINAL_NOT_AUTHORIZED'
      );
      return;
    }
    if (
      this.sessionCount(identity.sessionHash) +
        (this.options.relayCount?.(identity.sessionHash) ?? 0) >=
      MAX_TERMINALS_PER_SESSION
    ) {
      await this.error(
        identity.workbenchConnectionId,
        request.requestId,
        'TERMINAL_RELAY_LIMIT_REACHED'
      );
      return;
    }
    try {
      await this.options.preflight(
        request.nodeId,
        request.terminalId,
        request.workspaceId,
        identity
      );
    } catch (error) {
      const reason = error instanceof NodeRequestError ? error.code : '';
      const code = [
        'TERMINAL_NOT_FOUND',
        'TERMINAL_CLOSED',
        'TERMINAL_WORKSPACE_MISMATCH',
        'TERMINAL_GIT_OWNER_REQUIRED'
      ].includes(reason)
        ? reason
        : ['NODE_ACCESS_DENIED', 'WORKSPACE_ACCESS_DENIED', 'USER_AUTHORIZATION_REQUIRED'].includes(
              reason
            )
          ? 'TERMINAL_NOT_AUTHORIZED'
          : 'TERMINAL_DIRECT_UNAVAILABLE';
      await this.error(identity.workbenchConnectionId, request.requestId, code);
      return;
    }
    const current = this.options.transport.terminalTransport(
      identity,
      request.transportSessionId,
      request.nodeId,
      request.nodeGeneration
    );
    if (current === undefined) {
      await this.error(
        identity.workbenchConnectionId,
        request.requestId,
        'TERMINAL_DIRECT_UNAVAILABLE'
      );
      return;
    }
    if (!(await this.options.authorize(identity.userId, request.nodeId, request.workspaceId))) {
      await this.error(
        identity.workbenchConnectionId,
        request.requestId,
        'TERMINAL_NOT_AUTHORIZED'
      );
      return;
    }
    if (
      this.sessionCount(identity.sessionHash) +
        (this.options.relayCount?.(identity.sessionHash) ?? 0) >=
      MAX_TERMINALS_PER_SESSION
    ) {
      await this.error(
        identity.workbenchConnectionId,
        request.requestId,
        'TERMINAL_RELAY_LIMIT_REACHED'
      );
      return;
    }
    const now = this.now();
    const session: DirectTerminalSession = {
      ...identity,
      requestId: request.requestId,
      directSessionId: randomBytes(24).toString('base64url'),
      nodeId: request.nodeId,
      nodeGeneration: request.nodeGeneration,
      transportSessionId: request.transportSessionId,
      terminalId: request.terminalId,
      ...(request.workspaceId === undefined ? {} : { workspaceId: request.workspaceId }),
      readonly: request.readonly,
      grant: randomBytes(32).toString('base64url'),
      openExpiresAt: now + OPEN_MS,
      ready: false,
      expiresAt: now + LEASE_MS
    };
    this.sessions.set(session.directSessionId, session);
    if (
      !this.options.sendNode(session.nodeId, {
        type: 'terminal.direct.prepare',
        directSessionId: session.directSessionId,
        transportSessionId: session.transportSessionId,
        workbenchConnectionId: session.workbenchConnectionId,
        nodeGeneration: session.nodeGeneration,
        terminalId: session.terminalId,
        ...(session.workspaceId === undefined ? {} : { workspaceId: session.workspaceId }),
        afterSequence: request.afterSequence,
        readonly: request.readonly,
        grant: session.grant,
        browserFingerprint: current.browserFingerprint,
        nodeFingerprint: current.nodeFingerprint,
        openExpiresAt: session.openExpiresAt,
        expiresAt: session.expiresAt
      })
    ) {
      await this.closeSession(session, 'NODE_OFFLINE');
      await this.error(identity.workbenchConnectionId, request.requestId, 'NODE_OFFLINE');
      return;
    }
  }

  private async authorized(session: DirectTerminalSession): Promise<boolean> {
    return (
      session.expiresAt > this.now() &&
      this.options.transport.terminalTransport(
        session,
        session.transportSessionId,
        session.nodeId,
        session.nodeGeneration
      ) !== undefined &&
      (await this.options.authorize(session.userId, session.nodeId, session.workspaceId))
    );
  }

  private async expire(): Promise<void> {
    for (const session of [...this.sessions.values()])
      if (session.openExpiresAt <= this.now() && !session.ready)
        await this.closeSession(session, 'TERMINAL_DIRECT_TIMEOUT');
      else if (!(await this.authorized(session)))
        await this.closeSession(session, 'TERMINAL_DIRECT_LEASE_EXPIRED');
  }

  private async closeSession(session: DirectTerminalSession, code: string): Promise<void> {
    if (!this.sessions.delete(session.directSessionId)) return;
    this.options.sendNode(session.nodeId, {
      type: 'terminal.direct.cancel',
      directSessionId: session.directSessionId,
      code
    });
    await this.options.sendBrowser(session.workbenchConnectionId, {
      type: 'terminal.direct.closed',
      directSessionId: session.directSessionId,
      code
    });
  }

  private async error(connectionId: string, requestId: string, code: string): Promise<void> {
    const message =
      {
        TERMINAL_DIRECT_UNAVAILABLE: 'The direct Terminal connection is unavailable.',
        TERMINAL_NOT_AUTHORIZED: 'Access to this Terminal is no longer authorized.',
        TERMINAL_RELAY_LIMIT_REACHED: 'Too many Terminal attachments are active.',
        TERMINAL_NOT_FOUND: 'The requested Terminal no longer exists.',
        TERMINAL_CLOSED: 'The requested Terminal has ended.',
        TERMINAL_WORKSPACE_MISMATCH: 'The Terminal belongs to another Workspace.',
        TERMINAL_GIT_OWNER_REQUIRED: 'This Terminal belongs to another user.',
        NODE_OFFLINE: 'The Node is not connected.'
      }[code] ?? 'The Terminal attachment could not be prepared.';
    await this.options.sendBrowser(connectionId, {
      type: 'terminal.direct.error',
      requestId,
      code,
      message
    });
  }
}
