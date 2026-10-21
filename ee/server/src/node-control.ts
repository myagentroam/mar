import type { ModelUsageStore } from '@myagentroam/server-core/model-usage-store';
import { modelUsageBatchSchema } from '@myagentroam/protocol';
import {
  resolveNodeRuntimeCredential,
  runtimeCredentialConnectionError
} from '@myagentroam/server-core/runtime-credential-channel';
import { NodeIdentityControl } from '@myagentroam/server-core/node-identity-control';
import { DirectTransferCoordinator } from '@myagentroam/server-core/direct-transfer-coordinator';
import { TerminalDirectCoordinator } from '@myagentroam/server-core/terminal-direct-coordinator';
import type { WebSocket } from 'ws';
import {
  directNodeEventSchema,
  terminalDirectNodeEventSchema,
  type NodeEnvelope
} from '@myagentroam/protocol';
import type { ServerDatabase, StoredNode } from './database.js';
import type { MysqlServerDatabase } from './mysql/server-database.js';
import type { ShareWorkbenchAccess } from '@myagentroam/server-core/workbench-relay-service';
import {
  WorkbenchRelayService,
  type RelayedWorkbenchEvent,
  type UserNodeAuthorization
} from './service/workbench-relay-service.js';
import { NodeRequestBroker } from './service/node-request-broker.js';
import { GitExecutionForwarding } from '@myagentroam/server-core/git-execution-forwarding';
import type { PersonalGitService } from '@myagentroam/server-core/personal-git-service';
import { TerminalRelayService } from './service/terminal-relay-service.js';
import { NodeMessageProjector } from './service/node-message-projector.js';
import { ServerTrafficMetrics } from './service/server-traffic-metrics.js';
import type { RuntimeCredentialService } from './service/runtime-credential-service.js';
import {
  resolveScheduledRunAuthorization,
  resolveRestartRunAuthorization,
  type ScheduledRunAuthorizer,
  type RestartRunAuthorizer
} from '@myagentroam/server-core';
import { resolveMailNotification } from '@myagentroam/server-core/mail-notification-channel';
import type { MailNotificationService } from '@myagentroam/server-core/mail-notification-service';
import {
  resolveNotificationChannels,
  type NotificationChannelService
} from '@myagentroam/server-core/notification-channel-service';

export type StoredNodePresence = StoredNode & { readonly connected: boolean };

export type {
  RelayedWorkbenchEvent,
  UserNodeAuthorization
} from './service/workbench-relay-service.js';

export class NodeControl extends NodeIdentityControl {
  private modelUsage: ModelUsageStore | undefined;
  setModelUsageService(service: ModelUsageStore): void {
    this.modelUsage = service;
    this.requestBroker.setModelUsageGrants(service.grants);
  }
  protected override connectionFeatures(): Record<string, unknown> {
    return {
      ...(this.modelUsage === undefined ? {} : { modelUsage: { apiVersion: 1 } }),
      ...(this.notificationChannels === undefined
        ? {}
        : { notificationChannels: { apiVersion: 1 } })
    };
  }

  private notificationChannels?: Pick<NotificationChannelService, 'send'>;
  setNotificationChannels(service: Pick<NotificationChannelService, 'send'>): void {
    this.notificationChannels = service;
  }

  private mailNotifications?: Pick<MailNotificationService, 'send'>;
  setMailNotifications(service: Pick<MailNotificationService, 'send'>): void {
    this.mailNotifications = service;
  }
  private scheduleAuthorizer: ScheduledRunAuthorizer | undefined;
  private restartAuthorizer: RestartRunAuthorizer | undefined;
  setRestartAuthorizer(authorizer: RestartRunAuthorizer): void {
    this.restartAuthorizer = authorizer;
  }
  setScheduleAuthorizer(authorizer: ScheduledRunAuthorizer): void {
    this.scheduleAuthorizer = authorizer;
  }
  private runtimeCredentials:
    | Pick<
        RuntimeCredentialService,
        'activateNodeConnection' | 'deactivateNodeConnection' | 'resolve'
      >
    | undefined;
  private readonly requestBroker: NodeRequestBroker;
  setPersonalGitService(service: PersonalGitService): void {
    this.requestBroker.setGitForwarding(new GitExecutionForwarding(service));
  }
  private readonly workbenchRelay: WorkbenchRelayService;
  private readonly directTransfers: DirectTransferCoordinator;
  private readonly terminalDirect: TerminalDirectCoordinator;
  private readonly terminalRelay: TerminalRelayService;
  private readonly messageProjector: NodeMessageProjector;
  private notificationHandler?: (nodeId: string, payload: unknown) => Promise<boolean>;
  private hostedConversationActivityHandler?: (
    nodeId: string,
    payload: unknown
  ) => Promise<boolean>;
  private recentRunHandler?: (nodeId: string, payload: unknown) => Promise<boolean>;
  private recentRunDisconnectHandler?: (nodeId: string) => Promise<void>;

  constructor(
    private readonly database: ServerDatabase | MysqlServerDatabase,
    log?: (event: string, fields: Record<string, unknown>) => void,
    private readonly traffic?: ServerTrafficMetrics,
    runtimeCredentials?: Pick<
      RuntimeCredentialService,
      'activateNodeConnection' | 'deactivateNodeConnection' | 'resolve'
    >
  ) {
    super(database, (direction, bytes) => traffic?.record('node', direction, bytes));
    this.runtimeCredentials = runtimeCredentials;
    this.requestBroker = new NodeRequestBroker(
      database,
      (nodeId) => this.sockets.get(nodeId),
      log,
      traffic
    );
    this.workbenchRelay = new WorkbenchRelayService({
      database,
      ...(traffic === undefined ? {} : { traffic })
    });
    this.directTransfers = new DirectTransferCoordinator({
      audits: database,
      authorize: async (userId, nodeId, workspaceId) => {
        if (this.nodeCapabilities(nodeId)?.workspaceDirectTransfer === undefined) return false;
        return 'userCanRequestNode' in database
          ? database.userCanRequestNode(
              userId,
              nodeId,
              'workspace.direct-transfer',
              workspaceId === undefined ? {} : { workspaceId },
              workspaceId
            )
          : database.userOwnsNode(userId, nodeId);
      },
      sendNode: (nodeId, type, payload) => this.sendAuthenticatedNode(nodeId, type, payload),
      sendBrowser: (connectionId, message) =>
        this.workbenchRelay.sendDirectConnection(connectionId, message)
    });
    this.workbenchRelay.setDirectTransferHandler({
      message: (identity, message) => this.directTransfers.handleBrowserMessage(identity, message),
      disconnected: (connectionId) => this.directTransfers.connectionDisconnected(connectionId),
      resumed: (connectionId) => this.directTransfers.connectionResumed(connectionId),
      revoked: (connectionId, code) => this.directTransfers.revokeConnection(connectionId, code)
    });
    this.terminalRelay = new TerminalRelayService({
      database,
      ...(traffic === undefined ? {} : { traffic }),
      requestNode: (nodeId, operation, data, user) =>
        this.requestNode(nodeId, operation, data, user)
    });
    this.terminalDirect = new TerminalDirectCoordinator({
      transport: this.directTransfers,
      authorize: async (userId, nodeId, workspaceId) => {
        if (this.nodeCapabilities(nodeId)?.terminalDirect?.apiVersion !== 1) return false;
        return 'userCanRequestNode' in database
          ? database.userCanRequestNode(
              userId,
              nodeId,
              'terminal.attach.authorize',
              {},
              workspaceId
            )
          : database.userOwnsNode(userId, nodeId);
      },
      preflight: async (nodeId, terminalId, workspaceId, identity) => {
        await this.requestNode(
          nodeId,
          'terminal.direct.preflight',
          { terminalId, ...(workspaceId === undefined ? {} : { workspaceId }) },
          {
            userId: identity.userId,
            sessionHash: identity.sessionHash,
            ...(workspaceId === undefined ? {} : { workspaceId })
          }
        );
      },
      sendNode: (nodeId, message) => this.sendAuthenticatedNode(nodeId, message.type, message),
      sendBrowser: (connectionId, message) =>
        this.workbenchRelay.sendDirectConnection(connectionId, message),
      relayCount: (sessionHash) => this.terminalRelay.countSession(sessionHash)
    });
    this.terminalRelay.setDirectCoordination({
      directCount: (sessionHash) => this.terminalDirect.sessionCount(sessionHash)
    });
    this.workbenchRelay.setTerminalDirectHandler({
      message: (identity, message) => this.terminalDirect.handleBrowser(identity, message),
      revoked: (connectionId, code) => this.terminalDirect.revokeConnection(connectionId, code)
    });
    this.messageProjector = new NodeMessageProjector({
      relay: this.workbenchRelay,
      notification: (nodeId, payload) =>
        this.notificationHandler?.(nodeId, payload) ?? Promise.resolve(false),
      hostedConversationActivity: (nodeId, payload) =>
        this.hostedConversationActivityHandler?.(nodeId, payload) ?? Promise.resolve(false),
      recentRuns: (nodeId, payload) =>
        this.recentRunHandler?.(nodeId, payload) ?? Promise.resolve(false),
      sendWatchEvent: (connectionId, message) =>
        this.workbenchRelay.sendConnection(connectionId, { type: 'watch.event', event: message }),
      send: (socket, type, payload, replyTo) => this.send(socket, type, payload, replyTo),
      sendInvalid: (socket, replyTo) => this.sendError(socket, 'MESSAGE_INVALID', replyTo),
      ...(log === undefined ? {} : { log })
    });
  }

  setNotificationHandler(handler: (nodeId: string, payload: unknown) => Promise<boolean>): void {
    this.notificationHandler = handler;
  }

  setHostedConversationActivityHandler(
    handler: (nodeId: string, payload: unknown) => Promise<boolean>
  ): void {
    this.hostedConversationActivityHandler = handler;
  }

  setHostedConversationAuthorizationHandler(
    handler: (userId: number, nodeId: string, templateId: string) => Promise<boolean>
  ): void {
    this.workbenchRelay.setHostedConversationAuthorization(handler);
  }

  setRecentRunHandler(
    handler: (nodeId: string, payload: unknown) => Promise<boolean>,
    disconnected: (nodeId: string) => Promise<void>
  ): void {
    this.recentRunHandler = handler;
    this.recentRunDisconnectHandler = disconnected;
  }

  setRuntimeCredentialService(
    service: Pick<
      RuntimeCredentialService,
      'activateNodeConnection' | 'deactivateNodeConnection' | 'resolve'
    >
  ): void {
    this.runtimeCredentials = service;
    for (const nodeId of this.sockets.keys()) service.activateNodeConnection(nodeId);
  }

  runtimeCredentialCapability(nodeId: string) {
    if (!this.sockets.has(nodeId)) return undefined;
    return this.capabilities.get(nodeId)?.marAgentRuntimeCredentials;
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
    this.runtimeCredentials?.activateNodeConnection(nodeId);
    this.workbenchRelay.broadcast({
      type: 'node',
      nodeId,
      connected: true,
      ...(replaced ? { reason: 'CONNECTION_REPLACED' as const } : {})
    });
  }
  protected override onNodeDisconnected(nodeId: string): void {
    this.directTransfers.revokeNode(nodeId, 'DIRECT_NODE_OFFLINE');
    this.terminalDirect.revokeNode(nodeId, 'NODE_OFFLINE');
    this.runtimeCredentials?.deactivateNodeConnection(nodeId);
    this.requestBroker.rejectNode(nodeId, new Error('NODE_OFFLINE'));
    this.terminalRelay.disconnectNode(nodeId);
    this.workbenchRelay.broadcast({ type: 'node', nodeId, connected: false });
    void this.recentRunDisconnectHandler?.(nodeId).catch(() => undefined);
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

  override close(): void {
    this.directTransfers.close();
    this.terminalDirect.close();
    super.close();
    this.requestBroker.close();
    this.terminalRelay.close();
    this.closeAllWorkbench();
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
    timeoutMs?: number
  ): Promise<unknown> {
    return this.requestBroker.request(nodeId, operation, data, user, timeoutMs);
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
    if (envelope.type === 'usage.batch') {
      if (this.modelUsage === undefined) {
        this.sendError(socket, 'USAGE_UNSUPPORTED', envelope.id);
        return true;
      }
      const batch = modelUsageBatchSchema.safeParse(envelope.payload);
      if (!batch.success) {
        this.sendError(socket, 'USAGE_RECORD_INVALID', envelope.id);
        return true;
      }
      try {
        const ack = await this.modelUsage.consume(nodeId, batch.data);
        if (this.sockets.get(nodeId) === socket) this.send(socket, 'usage.ack', ack, envelope.id);
      } catch {
        this.sendError(socket, 'USAGE_STORAGE_UNAVAILABLE', envelope.id);
      }
      return true;
    }
    if (envelope.type === 'mail.notification.send') {
      await resolveMailNotification({
        nodeId,
        envelope,
        isCurrentConnection: () => this.sockets.get(nodeId) === socket,
        service: this.mailNotifications,
        respond: (payload) => this.send(socket, 'mail.notification.response', payload, envelope.id)
      });
      return true;
    }
    if (envelope.type === 'notification.channels.send') {
      await resolveNotificationChannels({
        nodeId,
        envelope,
        isCurrentConnection: () => this.sockets.get(nodeId) === socket,
        service: this.notificationChannels,
        respond: (payload) =>
          this.send(socket, 'notification.channels.response', payload, envelope.id)
      });
      return true;
    }
    if (envelope.type === 'restart.authorize') {
      await resolveRestartRunAuthorization({
        nodeId,
        envelope,
        isCurrentConnection: () => this.sockets.get(nodeId) === socket,
        authorize: this.restartAuthorizer,
        respond: (payload) => this.send(socket, 'restart.authorize.response', payload, envelope.id)
      });
      return true;
    }
    if (envelope.type === 'schedule.authorize') {
      await resolveScheduledRunAuthorization({
        nodeId,
        envelope,
        isCurrentConnection: () => this.sockets.get(nodeId) === socket,
        authorize: this.scheduleAuthorizer,
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
