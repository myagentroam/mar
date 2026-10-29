import type { ModelUsageStore } from '@myagentroam/server-core/model-usage-store';
import { modelUsageBatchSchema } from '@myagentroam/protocol';
import {
  resolveNodeRuntimeCredential,
  runtimeCredentialConnectionError
} from '@myagentroam/server-core/runtime-credential-channel';
import { NodeIdentityControl } from '@myagentroam/server-core/node-identity-control';
import type { DirectTransferCoordinator } from '@myagentroam/server-core/direct-transfer-coordinator';
import type { TerminalDirectCoordinator } from '@myagentroam/server-core/terminal-direct-coordinator';
import type { WebSocket } from 'ws';
import {
  directNodeEventSchema,
  marctlExecutionCredentialRequestSchema,
  terminalDirectNodeEventSchema,
  type MarctlExecutionCredentialRequest,
  type NodeCapabilities,
  type NodeEnvelope
} from '@myagentroam/protocol';
import type { NodeIdentityStore, StoredNode } from '@myagentroam/server-core/node-identity';
import type { AuditObserver } from '@myagentroam/server-core/audit';
import type { ShareWorkbenchAccess } from '@myagentroam/server-core/workbench-relay-service';
import type {
  WorkbenchRelayService,
  RelayedWorkbenchEvent
} from '@myagentroam/server-core/workbench-relay-service';
import type { NodeRequestBroker } from './service/node-request-broker.js';
import type { UserNodeAuthorization } from '@myagentroam/server-core/node-access-contracts';
import type { TerminalRelayService } from '@myagentroam/server-core/terminal-relay-service';
import type {
  NodeMessageProjector,
  NodeMessageConsumers
} from '@myagentroam/server-core/node-message-projector';
import { ServerTrafficMetrics } from './service/server-traffic-metrics.js';
import type { RuntimeCredentialService } from '@myagentroam/server-core/runtime-credential-service';
import {
  resolveScheduledRunAuthorization,
  resolveRestartRunAuthorization,
  type ScheduledRunAuthorizer,
  type RestartRunAuthorizer
} from '@myagentroam/server-core/scheduled-run-authorization-channel';
import { resolveMailNotification } from '@myagentroam/server-core/mail-notification-channel';
import type { MailNotificationService } from '@myagentroam/server-core/mail-notification-service';
import {
  resolveNotificationChannels,
  type NotificationChannelService
} from '@myagentroam/server-core/notification-channel-service';

export interface NodeControlStore extends NodeIdentityStore, AuditObserver {
  listNodes(): readonly StoredNode[] | Promise<readonly StoredNode[]>;
  listNodesForUser(userId: number): readonly StoredNode[] | Promise<readonly StoredNode[]>;
  revokeNode(nodeId: string, actorUserId: number): boolean | Promise<boolean>;
  deleteNode(nodeId: string, actorUserId: number): boolean | Promise<boolean>;
}

/** Connection facts exposed to the single request-broker owner. */
export interface NodeBrokerTransport {
  socketFor(nodeId: string): WebSocket | undefined;
  allows(socket: WebSocket, operation: string): boolean;
  encode(socket: WebSocket, envelope: NodeEnvelope): unknown;
}

export interface NodeControlTransport extends NodeBrokerTransport {
  capabilities: NodeIdentityControl['nodeCapabilities'];
  request: NodeControl['requestNode'];
  sendNode: NodeIdentityControl['sendAuthenticatedNode'];
  send(socket: WebSocket, type: string, payload: unknown, replyTo?: string): void;
  sendInvalid(socket: WebSocket, replyTo?: string): void;
}

export interface NodeControlComponents {
  readonly requestBroker: NodeRequestBroker;
  readonly workbenchRelay: WorkbenchRelayService;
  readonly directTransfers: DirectTransferCoordinator;
  readonly terminalRelay: TerminalRelayService;
  readonly terminalDirect: TerminalDirectCoordinator;
  readonly messageProjector: NodeMessageProjector;
}

export interface NodeControlConsumers extends NodeMessageConsumers {
  readonly nodeUpgradeProgress?: {
    issueReportCredential(nodeId: string, attemptId: string): Promise<string>;
    confirmConnection(nodeId: string, attemptId: string, version: string): Promise<void>;
    failBeforeHandoff(nodeId: string, attemptId: string, code: string): Promise<void>;
    markAccepted(nodeId: string, attemptId: string, activeRunCount?: number): Promise<void>;
    cancel(nodeId: string, attemptId: string): Promise<void>;
  };
  readonly authorizeHostedConversation: (
    userId: number,
    nodeId: string,
    templateId: string
  ) => Promise<boolean>;
  readonly recentRunDisconnected: (nodeId: string) => Promise<void>;
  readonly modelUsage: Pick<ModelUsageStore, 'consume'>;
  readonly mailNotifications: Pick<MailNotificationService, 'send'>;
  readonly notificationChannels: Pick<NotificationChannelService, 'send'>;
  readonly scheduleAuthorizer: ScheduledRunAuthorizer;
  readonly restartAuthorizer: RestartRunAuthorizer;
  readonly marctlExecutionCredential: (
    nodeId: string,
    request: MarctlExecutionCredentialRequest
  ) => Promise<string>;
  readonly runtimeCredentials: Pick<
    RuntimeCredentialService,
    'activateNodeConnection' | 'deactivateNodeConnection' | 'resolve'
  >;
}

export type StoredNodePresence = StoredNode & { readonly connected: boolean };

export class NodeControl extends NodeIdentityControl {
  protected override connectionFeatures(): Record<string, unknown> {
    return {
      modelUsage: { apiVersion: 1 },
      marctlExecutionCredential: { apiVersion: 1 },
      ...(this.consumers.nodeUpgradeProgress === undefined
        ? {}
        : { nodeUpgradeProgress: { apiVersion: 1 } }),
      notificationChannels: { apiVersion: 1 }
    };
  }

  private readonly runtimeCredentials: NodeControlConsumers['runtimeCredentials'];
  private readonly requestBroker: NodeRequestBroker;
  private readonly workbenchRelay: WorkbenchRelayService;
  private readonly directTransfers: DirectTransferCoordinator;
  private readonly terminalDirect: TerminalDirectCoordinator;
  private readonly terminalRelay: TerminalRelayService;
  private readonly messageProjector: NodeMessageProjector;

  constructor(
    private readonly database: NodeControlStore,
    createComponents: (transport: NodeControlTransport) => NodeControlComponents,
    private readonly consumers: NodeControlConsumers,
    private readonly traffic?: ServerTrafficMetrics
  ) {
    super(database, (direction, bytes) => traffic?.record('node', direction, bytes));
    this.runtimeCredentials = consumers.runtimeCredentials;
    let components: NodeControlComponents;
    try {
      components = createComponents({
        socketFor: (nodeId) => this.sockets.get(nodeId),
        allows: (socket, operation) =>
          this.allowsNodeBusiness(socket) ||
          operation === 'node.upgrade.request' ||
          operation === 'node.upgrade.cancel',
        encode: (socket, envelope) =>
          this.nodeWireVersion(socket) === 2 ? { ...envelope, version: 2 } : envelope,
        capabilities: (nodeId) => this.nodeCapabilities(nodeId),
        request: (nodeId, operation, data, user) => this.requestNode(nodeId, operation, data, user),
        sendNode: (nodeId, type, payload) => this.sendAuthenticatedNode(nodeId, type, payload),
        send: (socket, type, payload, replyTo) => this.send(socket, type, payload, replyTo),
        sendInvalid: (socket, replyTo) => this.sendError(socket, 'MESSAGE_INVALID', replyTo)
      });
    } catch (error) {
      try {
        super.close();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Failed to construct Node control', {
          cause: error
        });
      }
      throw error;
    }
    this.requestBroker = components.requestBroker;
    this.workbenchRelay = components.workbenchRelay;
    this.directTransfers = components.directTransfers;
    this.terminalRelay = components.terminalRelay;
    this.terminalDirect = components.terminalDirect;
    this.messageProjector = components.messageProjector;
  }

  runtimeCredentialCapability(nodeId: string) {
    return this.nodeCapabilities(nodeId)?.marAgentRuntimeCredentials;
  }

  pushUserWorkbench(userId: number, message: object): void {
    this.workbenchRelay.sendUser(userId, message);
  }

  hasUserWorkbenchConnection(userId: number): boolean {
    return this.workbenchRelay.hasUserConnection(userId);
  }

  ownsWorkbenchConnection(sessionHash: string, connectionId: string): boolean {
    return this.workbenchRelay.ownsConnection(sessionHash, connectionId);
  }

  pushWorkbenchConnection(
    connectionId: string,
    message: object
  ): Promise<'delivered' | 'unavailable' | 'authorization-revoked'> {
    return this.workbenchRelay.sendConnection(connectionId, message);
  }

  protected override onNodeConnected(nodeId: string, replaced: boolean): void {
    if (replaced) this.requestBroker.rejectNode(nodeId, new Error('NODE_CONNECTION_REPLACED'));
    this.runtimeCredentials.activateNodeConnection(nodeId);
    this.workbenchRelay.broadcast({
      type: 'node',
      nodeId,
      connected: true,
      ...(replaced ? { reason: 'CONNECTION_REPLACED' as const } : {})
    });
  }
  broadcastUpgrade(
    nodeId: string,
    snapshot: import('@myagentroam/server-core/node-upgrade-progress').NodeUpgradeSnapshot | null
  ): void {
    this.workbenchRelay.broadcast({ type: 'node.upgrade', nodeId, snapshot });
  }
  protected override async onNodeCapabilities(
    nodeId: string,
    capabilities: NodeCapabilities
  ): Promise<void> {
    const progress = this.consumers.nodeUpgradeProgress;
    if (!progress) return;
    const metadata = capabilities.metadata;
    if (metadata?.upgradeProgress?.apiVersion !== 1) return;
    if (metadata.upgradeAttemptId && capabilities.nodeAppVersion)
      await progress.confirmConnection(
        nodeId,
        metadata.upgradeAttemptId,
        capabilities.nodeAppVersion
      );
    if (
      metadata.upgrade?.attemptId &&
      (metadata.upgrade.state === 'WAITING_FOR_RUNS' ||
        metadata.upgrade.state === 'READY_TO_RESTART')
    )
      await progress.markAccepted(
        nodeId,
        metadata.upgrade.attemptId,
        metadata.upgrade.activeRunCount
      );
    if (metadata.upgrade?.state === 'IDLE' && metadata.upgrade.attemptId)
      await progress.cancel(nodeId, metadata.upgrade.attemptId);
    if (
      metadata.upgrade?.state === 'FAILED' &&
      metadata.upgrade.attemptId &&
      metadata.upgrade.errorCode
    )
      await progress.failBeforeHandoff(
        nodeId,
        metadata.upgrade.attemptId,
        metadata.upgrade.errorCode
      );
  }
  protected override onNodeDisconnected(nodeId: string): void {
    this.directTransfers.revokeNode(nodeId, 'DIRECT_NODE_OFFLINE');
    this.terminalDirect.revokeNode(nodeId, 'NODE_OFFLINE');
    this.runtimeCredentials.deactivateNodeConnection(nodeId);
    this.requestBroker.rejectNode(nodeId, new Error('NODE_OFFLINE'));
    this.terminalRelay.disconnectNode(nodeId);
    this.workbenchRelay.broadcast({ type: 'node', nodeId, connected: false });
    void this.messageProjector
      .enqueueSessionProjection(nodeId, () => this.consumers.recentRunDisconnected(nodeId))
      .catch(() => undefined);
  }

  protected override onBusinessAdmissionRevoked(nodeId: string): void {
    this.directTransfers.revokeNode(nodeId, 'DIRECT_NODE_OFFLINE');
    this.terminalDirect.revokeNode(nodeId, 'NODE_OFFLINE');
    this.runtimeCredentials.deactivateNodeConnection(nodeId);
    this.requestBroker.rejectNode(nodeId, new Error('NODE_UPGRADE_REQUIRED'));
    this.terminalRelay.disconnectNode(nodeId);
  }

  /**
   * This is deliberately a second, narrowly authenticated Node socket.  It
   * never accepts Node-control envelopes or arbitrary RPC; it only transports
   * frames for an attachment previously authorized on the control socket.
   */
  attachTerminal(socket: WebSocket): void {
    this.terminalRelay.attachNode(socket);
  }

  createTerminalTicket(input: {
    readonly nodeId: string;
    readonly terminalId: string;
    readonly user: UserNodeAuthorization;
    readonly workspaceId?: string;
    readonly afterSequence?: unknown;
    readonly readonly?: unknown;
  }): {
    readonly ticket: string;
    readonly nodeId: string;
    readonly terminalId: string;
    readonly expiresAt: number;
  } {
    return this.terminalRelay.createTicket(input);
  }

  /** Called only after Browser Origin/Cookie validation by the Fastify route. */
  attachBrowserTerminal(
    socket: WebSocket,
    ticketValue: unknown,
    user: UserNodeAuthorization
  ): void {
    this.terminalRelay.attachBrowser(socket, ticketValue, user);
  }

  /** Called only after Browser Origin/Cookie validation by the Fastify route. */
  attachBrowserWorkbench(
    socket: WebSocket,
    user: UserNodeAuthorization,
    share?: ShareWorkbenchAccess
  ): void {
    this.workbenchRelay.attach(socket, user, share);
  }

  invalidateSessionShare(shareId: string, code: string): void {
    this.workbenchRelay.invalidateShare(shareId, code);
  }

  closeUserWorkbench(sessionHash: string): void {
    this.workbenchRelay.closeSession(sessionHash);
  }

  closeUserTerminals(sessionHash: string): void {
    this.terminalRelay.closeSession(sessionHash);
    this.terminalDirect.revokeSession(sessionHash);
  }

  closeUserSessions(userId: number): void {
    this.workbenchRelay.closeUser(userId);
    this.terminalRelay.closeUser(userId);
    this.terminalDirect.revokeUser(userId);
  }

  closeAllTerminals(): void {
    this.terminalRelay.closeAllRelays();
  }

  async revalidateTerminalAuthorizations(): Promise<void> {
    await this.terminalRelay.revalidateAuthorizations();
  }

  closeAllWorkbench(): void {
    this.workbenchRelay.close();
  }

  closeTerminal(nodeId: string, terminalId: string): void {
    this.terminalRelay.closeTerminal(nodeId, terminalId);
  }

  connectedNodeIds(): readonly string[] {
    return [...this.sockets.keys()];
  }

  async listNodes(): Promise<readonly StoredNodePresence[]> {
    return this.withPresence(await this.database.listNodes());
  }

  async listNodesForUser(userId: number): Promise<readonly StoredNodePresence[]> {
    return this.withPresence(await this.database.listNodesForUser(userId));
  }

  private withPresence(nodes: readonly StoredNode[]): readonly StoredNodePresence[] {
    return nodes.map((node) => ({ ...node, connected: this.sockets.has(node.id) }));
  }

  async revokeNode(nodeId: string, actorUserId: number): Promise<boolean> {
    const revoked = await this.database.revokeNode(nodeId, actorUserId);
    if (!revoked) return false;
    this.closeNode(nodeId, 4003, 'NODE_DISABLED');
    this.terminalRelay.shutdownNode(nodeId, 4003, 'NODE_DISABLED');
    return true;
  }

  async deleteNode(nodeId: string, actorUserId: number): Promise<boolean> {
    const deleted = await this.database.deleteNode(nodeId, actorUserId);
    if (!deleted) return false;
    this.closeManagedNode(nodeId);
    return true;
  }

  closeManagedNode(nodeId: string): void {
    this.closeNode(nodeId, 4003, 'NODE_DELETED');
    this.terminalRelay.shutdownNode(nodeId, 4003, 'NODE_DELETED');
  }

  onWorkbenchEvent(listener: (event: RelayedWorkbenchEvent) => void): () => void {
    return this.workbenchRelay.onEvent(listener);
  }

  async drainProjections(): Promise<void> {
    await Promise.all([this.drainControlMessages(), this.messageProjector.drain()]);
  }

  override close(): void {
    const errors: unknown[] = [];
    for (const close of [
      () => this.directTransfers.close(),
      () => this.terminalDirect.close(),
      () => super.close(),
      () => this.requestBroker.close(),
      () => this.terminalRelay.close(),
      () => this.closeAllWorkbench()
    ]) {
      try {
        close();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1)
      throw new AggregateError(errors, 'Failed to close Node control resources', {
        cause: errors[0]
      });
  }

  /**
   * Admin-facing operations are explicit strings defined by Node.  Server only
   * authenticates, chooses the connected Node and correlates the reply; it
   * neither interprets nor persists the returned runtime data.
   */
  requestNode(
    nodeId: string,
    operation: string,
    data: unknown,
    user: UserNodeAuthorization,
    timeoutMs?: number,
    signal?: AbortSignal
  ): Promise<unknown> {
    return this.requestBroker.request(nodeId, operation, data, user, timeoutMs, signal);
  }

  requestHostedConversationNode(
    nodeId: string,
    operation: string,
    data: unknown,
    user: UserNodeAuthorization,
    timeoutMs?: number
  ): Promise<unknown> {
    return this.requestBroker.requestHostedConversation(nodeId, operation, data, user, timeoutMs);
  }

  protected override sendStaleConnectionError(socket: WebSocket, envelope: NodeEnvelope): void {
    if (envelope.type === 'marctl.execution-credential.request') {
      this.send(
        socket,
        'marctl.execution-credential.response',
        {
          error: {
            code: 'MARCTL_EXECUTION_AUTHORIZATION_INVALID',
            message: 'The Node connection is no longer valid.'
          }
        },
        envelope.id
      );
      return;
    }
    if (envelope.type === 'notification.channels.send') {
      this.send(
        socket,
        'notification.channels.response',
        {
          error: {
            code: 'NOTIFICATION_ACCESS_DENIED',
            message: 'The Node connection is no longer valid.'
          }
        },
        envelope.id
      );
      return;
    }
    if (envelope.type === 'mail.notification.send') {
      this.send(
        socket,
        'mail.notification.response',
        {
          error: {
            code: 'MAIL_SERVER_UNAVAILABLE',
            message: 'The Node connection is no longer valid.'
          }
        },
        envelope.id
      );
      return;
    }
    if (envelope.type === 'credential.resolve') {
      this.send(socket, 'credential.response', runtimeCredentialConnectionError(), envelope.id);
      return;
    }
    if (envelope.type === 'schedule.authorize' || envelope.type === 'restart.authorize') {
      const purpose = envelope.type === 'schedule.authorize' ? 'schedule' : 'restart';
      this.send(
        socket,
        `${purpose}.authorize.response`,
        {
          error: {
            code: `${purpose.toUpperCase()}_SERVER_UNAVAILABLE`,
            message: 'The Node connection is no longer valid.'
          }
        },
        envelope.id
      );
      return;
    }
    super.sendStaleConnectionError(socket, envelope);
  }

  protected override async handleAuthenticatedMessage(
    nodeId: string,
    socket: WebSocket,
    envelope: NodeEnvelope
  ): Promise<boolean> {
    if (envelope.type === 'marctl.execution-credential.request') {
      const request = marctlExecutionCredentialRequestSchema.safeParse(envelope.payload);
      let payload: unknown = {
        error: {
          code: 'MARCTL_EXECUTION_AUTHORIZATION_INVALID',
          message: 'Execution authorization could not be verified.'
        }
      };
      if (request.success) {
        try {
          payload = { token: await this.consumers.marctlExecutionCredential(nodeId, request.data) };
        } catch {
          /* Do not disclose credentials or authorization internals. */
        }
      }
      if (this.sockets.get(nodeId) === socket)
        this.send(socket, 'marctl.execution-credential.response', payload, envelope.id);
      return true;
    }
    if (envelope.type === 'node.upgrade.credential.request') {
      const payload = envelope.payload as { attemptId?: unknown } | null;
      let response: unknown = {
        error: {
          code: 'NODE_UPGRADE_CREDENTIAL_REJECTED',
          message: 'Upgrade authorization is unavailable.'
        }
      };
      if (
        this.consumers.nodeUpgradeProgress !== undefined &&
        this.upgradeCapabilities(nodeId)?.metadata?.upgradeProgress?.apiVersion === 1 &&
        typeof payload?.attemptId === 'string' &&
        /^[0-9a-f-]{36}$/u.test(payload.attemptId)
      ) {
        try {
          response = {
            token: await this.consumers.nodeUpgradeProgress.issueReportCredential(
              nodeId,
              payload.attemptId
            )
          };
        } catch {
          /* Never expose credential or authorization internals. */
        }
      }
      if (this.sockets.get(nodeId) === socket)
        this.send(socket, 'node.upgrade.credential.response', response, envelope.id);
      return true;
    }
    if (envelope.type === 'usage.batch') {
      const batch = modelUsageBatchSchema.safeParse(envelope.payload);
      if (!batch.success) {
        this.sendError(socket, 'USAGE_RECORD_INVALID', envelope.id);
        return true;
      }
      await this.messageProjector.enqueueSessionProjection(nodeId, async () => {
        try {
          const ack = await this.consumers.modelUsage.consume(nodeId, batch.data);
          if (this.sockets.get(nodeId) === socket) this.send(socket, 'usage.ack', ack, envelope.id);
        } catch {
          if (this.sockets.get(nodeId) === socket)
            this.sendError(socket, 'USAGE_STORAGE_UNAVAILABLE', envelope.id);
        }
      });
      return true;
    }
    if (envelope.type === 'mail.notification.send') {
      await this.messageProjector.enqueueSessionProjection(nodeId, () =>
        resolveMailNotification({
          nodeId,
          envelope,
          isCurrentConnection: () => this.sockets.get(nodeId) === socket,
          service: this.consumers.mailNotifications,
          respond: (payload) =>
            this.send(socket, 'mail.notification.response', payload, envelope.id)
        })
      );
      return true;
    }
    if (envelope.type === 'notification.channels.send') {
      await this.messageProjector.enqueueSessionProjection(nodeId, () =>
        resolveNotificationChannels({
          nodeId,
          envelope,
          isCurrentConnection: () => this.sockets.get(nodeId) === socket,
          service: this.consumers.notificationChannels,
          respond: (payload) =>
            this.send(socket, 'notification.channels.response', payload, envelope.id)
        })
      );
      return true;
    }
    if (envelope.type === 'restart.authorize') {
      await resolveRestartRunAuthorization({
        nodeId,
        envelope,
        isCurrentConnection: () => this.sockets.get(nodeId) === socket,
        authorize: this.consumers.restartAuthorizer,
        respond: (payload) => this.send(socket, 'restart.authorize.response', payload, envelope.id)
      });
      return true;
    }
    if (envelope.type === 'schedule.authorize') {
      await resolveScheduledRunAuthorization({
        nodeId,
        envelope,
        isCurrentConnection: () => this.sockets.get(nodeId) === socket,
        authorize: this.consumers.scheduleAuthorizer,
        respond: (payload) => this.send(socket, 'schedule.authorize.response', payload, envelope.id)
      });
      return true;
    }
    if (envelope.type === 'credential.resolve') {
      await this.resolveRuntimeCredential(nodeId, socket, envelope);
      return true;
    }
    if (envelope.type === 'node.response') {
      this.resolveNodeRequest(nodeId, envelope);
      return true;
    }
    if (envelope.type.startsWith('direct.')) {
      const event = directNodeEventSchema.safeParse({
        type: envelope.type,
        ...(typeof envelope.payload === 'object' && envelope.payload !== null
          ? envelope.payload
          : {})
      });
      if (!event.success) {
        this.sendError(socket, 'MESSAGE_INVALID', envelope.id);
        return true;
      }
      this.directTransfers.handleNodeMessage(nodeId, event.data);
      return true;
    }
    if (envelope.type === 'terminal.direct.ready') {
      const event = terminalDirectNodeEventSchema.safeParse({
        type: envelope.type,
        ...(typeof envelope.payload === 'object' && envelope.payload !== null
          ? envelope.payload
          : {})
      });
      if (!event.success) this.sendError(socket, 'MESSAGE_INVALID', envelope.id);
      else if (event.data.phase === 'ATTACHED')
        this.terminalDirect.onNodeAttached(nodeId, event.data.directSessionId);
      else await this.terminalDirect.onNodeReady(nodeId, event.data.directSessionId);
      return true;
    }
    if (this.messageProjector.handles(envelope.type)) {
      this.messageProjector.project(nodeId, socket, envelope);
      return true;
    }
    return false;
  }

  private resolveNodeRequest(nodeId: string, envelope: NodeEnvelope): void {
    this.requestBroker.resolve(nodeId, envelope);
  }

  private async resolveRuntimeCredential(
    nodeId: string,
    socket: WebSocket,
    envelope: NodeEnvelope
  ): Promise<void> {
    await resolveNodeRuntimeCredential({
      nodeId,
      envelope,
      isCurrentConnection: () => this.sockets.get(nodeId) === socket,
      capability: this.capabilities.get(nodeId)?.marAgentRuntimeCredentials,
      service: this.runtimeCredentials,
      respond: (payload) => this.send(socket, 'credential.response', payload, envelope.id)
    });
  }

  private recordWorkbenchEvent(nodeId: string, socket: WebSocket, envelope: NodeEnvelope): void {
    this.messageProjector.workbenchEvent(nodeId, socket, envelope);
  }
}
