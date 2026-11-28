import { randomUUID } from 'node:crypto';
import type { ModelUsageStore } from '@myagentroam/server-core/model-usage-store';
import {
  resolveNodeRuntimeCredential,
  runtimeCredentialConnectionError
} from '@myagentroam/server-core/runtime-credential-channel';
import { NodeIdentityControl } from '@myagentroam/server-core/node-identity-control';
import { NodeFileRelay } from '@myagentroam/server-core/node-file-relay';
import { NodeRelayChannel } from '@myagentroam/server-core/node-relay-channel';
import type { DirectTransferCoordinator } from '@myagentroam/server-core/direct-transfer-coordinator';
import type { TerminalDirectCoordinator } from '@myagentroam/server-core/terminal-direct-coordinator';
import type { RemoteDesktopDirectCoordinator } from '@myagentroam/server-core/remote-desktop-direct-coordinator';
import type { RemoteDesktopRelayCoordinator } from '@myagentroam/server-core/remote-desktop-relay-coordinator';
import type { RemoteDesktopRelayPairing } from '@myagentroam/server-core/remote-desktop-relay-pairing';
import type { RemoteDesktopRelaySockets } from '@myagentroam/server-core/remote-desktop-relay-sockets';
import type { WebSocket } from 'ws';
import {
  MODEL_USAGE_BATCH_BYTES,
  browserUseCheckSchema,
  directNodeEventSchema,
  marctlExecutionCredentialRequestSchema,
  modelUsageBatchSchema,
  scheduledTasksApiVersion,
  terminalDirectNodeEventSchema,
  remoteDesktopDirectNodeEventSchema,
  remoteDesktopRelayNodeEventSchema,
  type MarctlExecutionCredentialRequest,
  type DirectTransferDescriptor,
  type NodeCapabilities,
  type NodeEnvelope,
  type PublicError
} from '@myagentroam/protocol';
import type { NodeIdentityStore, StoredNode } from '@myagentroam/server-core/node-identity';
import type { AuditObserver } from '@myagentroam/server-core/audit';
import type { ShareWorkbenchAccess } from '@myagentroam/server-core/workbench-relay-service';
import type {
  WorkbenchRelayService,
  RelayedWorkbenchEvent
} from '@myagentroam/server-core/workbench-relay-service';
import type { NodeRequestBroker } from './service/node-request-broker.js';
import { WorkspaceFileStreamTickets } from './service/workspace-file-stream-tickets.js';
import { FileStreamTickets } from './service/file-stream-tickets.js';
import { TcpForwardRelay } from './service/tcp-forward-relay.js';
import { tcpForwardControlKind, tcpForwardDataKind } from '@myagentroam/protocol/tcp-forward';
import type { HostedFileStreamTicket } from '@myagentroam/server-core/hosted-conversation-routes';
import { NodeRequestAdmissionError } from '@myagentroam/server-core/node-request-error';
import type {
  NodeResourceScope,
  UserNodeAuthorization
} from '@myagentroam/server-core/node-access-contracts';
import type { NodeStreamAuthorizer } from '@myagentroam/server-core/node-relay-channel';
import type { TerminalRelayService } from '@myagentroam/server-core/terminal-relay-service';
import type {
  NodeMessageProjector,
  NodeMessageConsumers
} from '@myagentroam/server-core/node-message-projector';
import { ServerTrafficMetrics } from './service/server-traffic-metrics.js';
import type { RuntimeCredentialService } from '@myagentroam/server-core/runtime-credential-service';
import type { BrowserWorkbenchService } from './service/browser-workbench-service.js';
import {
  resolveScheduledRunAuthorization,
  resolveExecutionPreparation,
  type ExecutionPreparer,
  type ScheduledRunAuthorizer
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
}

export interface NodeControlTransport extends NodeBrokerTransport {
  fileSocketFor(nodeId: string): WebSocket | undefined;
  capabilities: NodeIdentityControl['nodeCapabilities'];
  supportsScheduledTasks: NodeControl['supportsScheduledTasks'];
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
  readonly desktopDirect: RemoteDesktopDirectCoordinator;
  readonly desktopRelay: RemoteDesktopRelayCoordinator;
  readonly desktopPairing: RemoteDesktopRelayPairing;
  readonly desktopRelaySockets: RemoteDesktopRelaySockets;
  readonly browser?: BrowserWorkbenchService;
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
  readonly scheduledTaskConnectionChanged?: (nodeId: string) => void;
  readonly executionPreparer?: ExecutionPreparer;
  readonly browserUseAllowed?: (
    nodeId: string,
    scope: { userId: number; workspaceId: string }
  ) => Promise<boolean>;
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
      marctlExecutionCredential: { apiVersion: 2 },
      ...(this.consumers.browserUseAllowed === undefined ? {} : { browserUse: { apiVersion: 1 } }),
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
  private readonly desktopDirect: RemoteDesktopDirectCoordinator;
  private readonly desktopRelay: RemoteDesktopRelayCoordinator;
  private readonly desktopPairing: RemoteDesktopRelayPairing;
  private readonly desktopRelaySockets: RemoteDesktopRelaySockets;
  private readonly browser: BrowserWorkbenchService | undefined;
  private readonly terminalRelay: TerminalRelayService;
  private readonly fileRelay: NodeFileRelay;
  private readonly dataRelay: NodeRelayChannel;
  private readonly tcpForwardRelay = new TcpForwardRelay();
  private readonly fileStreamTickets: WorkspaceFileStreamTickets;
  private readonly hostedFileTickets: FileStreamTickets<HostedFileStreamTicket>;
  private readonly dataClients = new Map<WebSocket, UserNodeAuthorization>();
  private readonly shareDataClients = new Map<WebSocket, string>();
  private readonly dataControlBindings = new WeakMap<WebSocket, string>();
  private readonly messageProjector: NodeMessageProjector;

  constructor(
    private readonly database: NodeControlStore,
    createComponents: (transport: NodeControlTransport) => NodeControlComponents,
    private readonly consumers: NodeControlConsumers,
    private readonly traffic?: ServerTrafficMetrics
  ) {
    super(database, (direction, bytes) => traffic?.record('node', direction, bytes));
    this.runtimeCredentials = consumers.runtimeCredentials;
    this.dataRelay = new NodeRelayChannel({
      canWaitForNode: (nodeId) => {
        const control = this.sockets.get(nodeId);
        // A fresh control socket can still report compatible capabilities; a known upgrade-only one cannot admit Relay.
        return (
          control !== undefined &&
          control.readyState === control.OPEN &&
          (this.allowsNodeBusiness(control) || this.upgradeCapabilities(nodeId) === undefined)
        );
      },
      admitNode: async ({ nodeId, credential, controlBinding }) => {
        const control = this.currentDataControl(nodeId, controlBinding);
        if (control === undefined) return undefined;
        const node = await database.authenticateNode(nodeId, credential);
        if (node?.id !== nodeId || node.disabled) return undefined;
        return () => this.currentDataControl(nodeId, controlBinding) === control;
      },
      maxStreams: { perClient: 24, perNode: 256 },
      maxBufferedBytes: 8 * 1024 * 1024,
      ...(traffic === undefined
        ? {}
        : {
            traffic: {
              record: (direction, bytes) => traffic.record('node', direction, bytes),
              backpressure: (bytes) => traffic.backpressure('node', bytes)
            }
          })
    });
    this.fileRelay = new NodeFileRelay({
      database,
      recordIncoming: (bytes) => traffic?.record('node', 'in', bytes),
      currentControl: (nodeId, binding) => this.currentDataControl(nodeId, binding),
      response: (nodeId, socket, envelope, bytes, declaredLength) =>
        this.requestBroker.resolveFile(nodeId, socket, envelope, bytes, declaredLength),
      disconnected: (socket) => this.requestBroker.rejectFileSocket(socket)
    });
    let components: NodeControlComponents;
    try {
      components = createComponents({
        socketFor: (nodeId) => this.sockets.get(nodeId),
        fileSocketFor: (nodeId) => this.fileRelay.socketFor(nodeId),
        allows: (socket, operation) =>
          this.allowsNodeBusiness(socket) ||
          operation === 'node.upgrade.request' ||
          operation === 'node.upgrade.cancel',
        capabilities: (nodeId) => this.nodeCapabilities(nodeId),
        supportsScheduledTasks: (nodeId) => this.supportsScheduledTasks(nodeId),
        request: (nodeId, operation, data, user, timeoutMs, signal) =>
          this.requestNode(nodeId, operation, data, user, timeoutMs, signal),
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
    this.fileStreamTickets = new WorkspaceFileStreamTickets({
      audits: database,
      allowed: (userId, nodeId, workspaceId) =>
        this.requestBroker.canUseWorkspaceFile(userId, nodeId, workspaceId),
      prepare: ({ nodeId, user, descriptor, share }, signal) =>
        this.requestNode(
          nodeId,
          'workspace.file.stream.prepare',
          {
            workspaceId: descriptor.resource.workspaceId,
            descriptor,
            ...(share !== undefined && { sessionId: share.sessionId })
          },
          user,
          undefined,
          signal
        )
    });
    this.hostedFileTickets = new FileStreamTickets({
      kind: (ticket) => ticket.kind,
      allowed: (ticket) => ticket.allowed(),
      prepare: async (ticket, signal) => {
        const { nodeId, user, templateId, allowed } = ticket;
        if (!(await allowed().catch(() => false)))
          throw new NodeRequestAdmissionError('RESOURCE_DENIED');
        signal.throwIfAborted();
        const [operation, data] =
          ticket.kind === 'hosted-file-upload'
            ? ([
                'conversation.hosted.files.upload.stream.prepare',
                { conversationId: ticket.conversationId, uploadId: ticket.uploadId }
              ] as const)
            : (['conversation.hosted.file.stream.prepare', ticket.descriptor] as const);
        return this.requestBroker.requestHostedConversation(
          nodeId,
          operation,
          {
            ...data,
            __sourceTemplateId: templateId
          },
          user,
          undefined,
          signal
        );
      }
    });
    this.workbenchRelay = components.workbenchRelay;
    this.directTransfers = components.directTransfers;
    this.terminalRelay = components.terminalRelay;
    this.terminalDirect = components.terminalDirect;
    this.desktopDirect = components.desktopDirect;
    this.desktopRelay = components.desktopRelay;
    this.desktopPairing = components.desktopPairing;
    this.desktopRelaySockets = components.desktopRelaySockets;
    this.browser = components.browser;
    this.messageProjector = components.messageProjector;
  }

  protected override capabilityAckPayload(socket: WebSocket): Record<string, unknown> {
    const payload = super.capabilityAckPayload(socket);
    if (!this.allowsNodeBusiness(socket)) return payload;
    // Do not pair a delayed handshake with a different control connection for the same Node.
    const dataControlBinding = this.dataControlBindings.get(socket) ?? randomUUID();
    this.dataControlBindings.set(socket, dataControlBinding);
    return { ...payload, dataControlBinding, fileControlBinding: dataControlBinding };
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
    if (replaced) {
      this.dataRelay.disconnectNode(nodeId);
      this.fileRelay.disconnectNode(nodeId);
      this.requestBroker.rejectNode(nodeId, new Error('NODE_CONNECTION_REPLACED'));
      this.directTransfers.revokeNode(nodeId, 'NODE_CONNECTION_REPLACED');
      this.terminalDirect.revokeNode(nodeId, 'NODE_CONNECTION_REPLACED');
      this.terminalRelay.disconnectNode(nodeId);
      this.desktopDirect.revokeNode(nodeId, 'NODE_CONNECTION_REPLACED');
      this.desktopRelay.revokeNode(nodeId);
      this.browser?.revokeNode(nodeId);
    }
    this.runtimeCredentials.activateNodeConnection(nodeId);
    this.consumers.scheduledTaskConnectionChanged?.(nodeId);
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
    // Pending Relay handshakes may predate the first capability report.
    if (this.isNodeUpgradeOnly(nodeId)) this.dataRelay.disconnectNode(nodeId);
    this.consumers.scheduledTaskConnectionChanged?.(nodeId);
    const generation = this.nodeCapabilities(nodeId)?.remoteDesktop?.nodeGeneration;
    if (generation) {
      this.desktopDirect.retireOtherGenerations(nodeId, generation);
      this.desktopRelay.retireOtherGenerations(nodeId, generation);
    }
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
    this.dataRelay.disconnectNode(nodeId);
    this.fileRelay.disconnectNode(nodeId);
    this.consumers.scheduledTaskConnectionChanged?.(nodeId);
    this.browser?.revokeNode(nodeId);
    this.directTransfers.revokeNode(nodeId, 'DIRECT_NODE_OFFLINE');
    this.terminalDirect.revokeNode(nodeId, 'NODE_OFFLINE');
    this.desktopDirect.revokeNode(nodeId, 'NODE_OFFLINE');
    this.desktopRelay.revokeNode(nodeId);
    this.runtimeCredentials.deactivateNodeConnection(nodeId);
    this.requestBroker.rejectNode(nodeId, new Error('NODE_OFFLINE'));
    this.terminalRelay.disconnectNode(nodeId);
    this.workbenchRelay.broadcast({ type: 'node', nodeId, connected: false });
    void this.messageProjector
      .enqueueSessionProjection(nodeId, () => this.consumers.recentRunDisconnected(nodeId))
      .catch(() => undefined);
  }

  protected override onBusinessAdmissionRevoked(nodeId: string): void {
    const control = this.sockets.get(nodeId);
    if (control) this.dataControlBindings.delete(control);
    this.dataRelay.disconnectNode(nodeId);
    this.fileRelay.disconnectNode(nodeId);
    this.browser?.revokeNode(nodeId);
    this.directTransfers.revokeNode(nodeId, 'DIRECT_NODE_OFFLINE');
    this.terminalDirect.revokeNode(nodeId, 'NODE_OFFLINE');
    this.desktopDirect.revokeNode(nodeId, 'NODE_OFFLINE');
    this.desktopRelay.revokeNode(nodeId);
    this.runtimeCredentials.deactivateNodeConnection(nodeId);
    this.requestBroker.rejectNode(nodeId, new Error('NODE_UPGRADE_REQUIRED'));
    this.terminalRelay.disconnectNode(nodeId);
  }

  attachFileRelay(socket: WebSocket): void {
    this.fileRelay.attach(socket);
  }

  attachNodeRelay(socket: WebSocket): void {
    this.dataRelay.attachNode(socket);
  }

  private currentDataControl(nodeId: string, binding: string): WebSocket | undefined {
    const control = this.sockets.get(nodeId);
    return control &&
      control.readyState === control.OPEN &&
      this.allowsNodeBusiness(control) &&
      this.dataControlBindings.get(control) === binding
      ? control
      : undefined;
  }

  createTerminalTicket(input: {
    readonly nodeId: string;
    readonly terminalId: string;
    readonly user: UserNodeAuthorization;
    readonly workspaceId?: string;
    readonly afterSequence?: unknown;
    readonly readonly?: unknown;
    readonly computer?: boolean;
    readonly cli?: boolean;
  }): {
    readonly ticket: string;
    readonly nodeId: string;
    readonly terminalId: string;
    readonly expiresAt: number;
  } {
    return this.terminalRelay.createTicket(input);
  }

  attachClientRelay(
    socket: WebSocket,
    nodeId: string,
    user: UserNodeAuthorization,
    cliExpiresAt?: number,
    hostedOnly = false,
    allowTcpForward?: () => Promise<boolean>
  ): void {
    if (socket.readyState !== socket.OPEN) return;
    if (cliExpiresAt !== undefined && cliExpiresAt <= Date.now()) {
      socket.close(1008, 'UNAUTHENTICATED');
      return;
    }
    this.dataClients.set(socket, user);
    const expiry =
      cliExpiresAt === undefined
        ? undefined
        : setTimeout(() => socket.terminate(), Math.min(2_147_483_647, cliExpiresAt - Date.now()));
    expiry?.unref();
    socket.once('close', () => {
      clearTimeout(expiry);
      this.dataClients.delete(socket);
    });
    const forward =
      cliExpiresAt !== undefined && !hostedOnly && allowTcpForward !== undefined
        ? this.tcpForwardRelay.forCarrier(nodeId, allowTcpForward)
        : undefined;
    const authorize: NodeStreamAuthorizer = async ({ kind, grant }, signal) => {
      if (kind === tcpForwardControlKind || kind === tcpForwardDataKind)
        return forward?.({ kind, grant }, signal);
      if (
        (kind === 'hosted-file-upload' || kind === 'hosted-file-download') &&
        cliExpiresAt === undefined
      )
        return this.hostedFileTickets.authorize(kind, grant, nodeId, user, signal);
      if (hostedOnly) return undefined;
      if (cliExpiresAt === undefined && kind === 'browser-rfb')
        return this.browser?.authorizePictureStream(grant, nodeId, user, signal);
      if (
        cliExpiresAt === undefined &&
        (kind === 'browser-file-download' || kind === 'browser-file-upload')
      )
        return this.browser?.authorizeFileStream(kind, grant, nodeId, user, signal);
      if (kind === 'terminal')
        return this.terminalRelay.authorizeStream(
          grant,
          nodeId,
          user,
          cliExpiresAt !== undefined,
          signal
        );
      if (cliExpiresAt === undefined && (kind === 'file-upload' || kind === 'file-download'))
        return this.fileStreamTickets.authorize(kind, grant, nodeId, user, signal);
      return undefined;
    };
    this.dataRelay.attachClient(socket, nodeId, async (open, signal) => {
      if (!this.dataClients.has(socket)) return { code: 'SESSION_UNAUTHENTICATED' };
      const admission = await authorize(open, signal);
      // An authenticated carrier owns bytes, not permission to start a new operation.
      return this.dataClients.has(socket) ? admission : { code: 'SESSION_UNAUTHENTICATED' };
    });
  }

  attachShareFileRelay(
    socket: WebSocket,
    access: {
      shareId: string;
      nodeId: string;
      user: UserNodeAuthorization;
      expiresAt: number | null;
    }
  ): void {
    if (socket.readyState !== socket.OPEN) return;
    const { shareId, nodeId, user, expiresAt } = access;
    this.shareDataClients.set(socket, shareId);
    const expire = () => {
      if (expiresAt === null) return;
      const remaining = expiresAt - Date.now();
      if (remaining <= 0) socket.close(1008, 'SESSION_SHARE_EXPIRED');
      else expiry = setTimeout(expire, Math.min(2_147_483_647, remaining)).unref();
    };
    let expiry: NodeJS.Timeout | undefined;
    socket.once('close', () => {
      clearTimeout(expiry);
      this.shareDataClients.delete(socket);
    });
    expire();
    this.dataRelay.attachClient(socket, nodeId, async ({ kind, grant }, signal) =>
      kind === 'file-upload' || kind === 'file-download'
        ? this.fileStreamTickets.authorize(kind, grant, nodeId, user, signal)
        : undefined
    );
  }

  createShareFileStreamTicket(
    nodeId: string,
    user: UserNodeAuthorization,
    descriptor: DirectTransferDescriptor,
    share: { sessionId: string; allowed: () => Promise<boolean> }
  ) {
    return this.fileStreamTickets.issue({ nodeId, user, descriptor, share });
  }

  createHostedFileStreamTicket(ticket: HostedFileStreamTicket): Promise<string> {
    return this.hostedFileTickets.issue(ticket);
  }

  createWorkspaceFileStreamTicket(
    nodeId: string,
    user: UserNodeAuthorization,
    descriptor: DirectTransferDescriptor
  ): Promise<string> {
    return this.fileStreamTickets.issue({ nodeId, user, descriptor });
  }

  attachNodeDesktopRelay(socket: WebSocket): void {
    this.desktopRelaySockets.attachNode(socket);
  }

  uploadBrowserFile(
    user: UserNodeAuthorization,
    connectionId: string,
    upload: Parameters<BrowserWorkbenchService['upload']>[2]
  ): Promise<void> {
    if (!this.browser) return Promise.reject(new Error('BROWSER_UNAVAILABLE'));
    return this.browser.upload(user, connectionId, upload);
  }

  downloadBrowserFile(
    user: UserNodeAuthorization,
    connectionId: string,
    download: Parameters<BrowserWorkbenchService['download']>[2]
  ): Promise<unknown> {
    if (!this.browser) return Promise.reject(new Error('BROWSER_UNAVAILABLE'));
    return this.browser.download(user, connectionId, download);
  }

  createBrowserDownloadTicket(
    ...args: Parameters<BrowserWorkbenchService['createDownloadTicket']>
  ) {
    if (!this.browser) throw new Error('BROWSER_UNAVAILABLE');
    return this.browser.createDownloadTicket(...args);
  }

  createBrowserUploadTicket(...args: Parameters<BrowserWorkbenchService['createUploadTicket']>) {
    if (!this.browser) throw new Error('BROWSER_UNAVAILABLE');
    return this.browser.createUploadTicket(...args);
  }

  openBrowserDirectFile(...args: Parameters<BrowserWorkbenchService['openDirectFile']>) {
    if (!this.browser) throw new Error('BROWSER_UNAVAILABLE');
    return this.browser.openDirectFile(...args);
  }

  closeBrowserDirectFile(...args: Parameters<BrowserWorkbenchService['closeDirectFile']>) {
    this.browser?.closeDirectFile(...args);
  }

  /** Called only after Browser Origin/Cookie validation. */
  attachBrowserDesktopRelay(socket: WebSocket, user: UserNodeAuthorization): void {
    this.desktopRelaySockets.attachBrowser(socket, user);
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
    for (const [socket, id] of this.shareDataClients) if (id === shareId) socket.terminate();
  }

  invalidateLoginSession(sessionHash: string): void {
    // Retire the login's admission, not the shared carrier or unrelated credentials.
    for (const [socket, user] of this.dataClients)
      if (user.sessionHash === sessionHash) this.dataClients.delete(socket);
    this.terminalRelay.closeSession(sessionHash);
    this.terminalDirect.revokeSession(sessionHash);
    this.workbenchRelay.closeSession(sessionHash);
  }

  closeUserSessions(userId: number): void {
    for (const [socket, user] of this.dataClients)
      if (user.userId === userId) this.dataClients.delete(socket);
    this.workbenchRelay.closeUser(userId);
    this.terminalRelay.closeUser(userId);
    this.terminalDirect.revokeUser(userId);
    this.desktopDirect.revokeUser(userId);
    this.desktopRelay.revokeUser(userId);
  }

  revalidateHostedFileAuthorizations(templateId: string): Promise<void> {
    return this.hostedFileTickets.revalidate((ticket) => ticket.templateId === templateId);
  }

  async revalidateDataAuthorizations(scope: NodeResourceScope): Promise<void> {
    await Promise.all([
      this.terminalRelay.revalidateAuthorizations(scope),
      this.terminalDirect.revalidateAuthorizations(scope),
      this.directTransfers.revalidateAuthorizations(scope),
      this.fileStreamTickets.revalidateResource(scope),
      this.browser?.revalidateAuthorizations(scope),
      ...(scope.workspaceId === undefined
        ? [
            this.tcpForwardRelay.revalidate(scope.nodeId),
            this.hostedFileTickets.revalidate((ticket) => ticket.nodeId === scope.nodeId)
          ]
        : [])
    ]);
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
  }

  onWorkbenchEvent(listener: (event: RelayedWorkbenchEvent) => void): () => void {
    return this.workbenchRelay.onEvent(listener);
  }

  async drainProjections(): Promise<void> {
    await Promise.all([
      this.drainControlMessages(),
      this.messageProjector.drain(),
      this.fileRelay.drainAuthentications(),
      this.dataRelay.drainAuthentications()
    ]);
  }

  override close(): void {
    const errors: unknown[] = [];
    for (const close of [
      () => this.browser?.close(),
      () => this.directTransfers.close(),
      () => this.terminalDirect.close(),
      () => this.desktopRelaySockets.close(),
      () => this.desktopRelay.close(),
      () => this.desktopPairing.close(),
      () => this.desktopDirect.close(),
      () => super.close(),
      () => this.requestBroker.close(),
      () => this.terminalRelay.close(),
      () => this.fileStreamTickets.close(),
      () => this.hostedFileTickets.close(),
      () => this.fileRelay.close(),
      () => this.dataRelay.close(),
      () => this.workbenchRelay.close()
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

  supportsScheduledTasks(nodeId: string): boolean {
    return this.nodeCapabilities(nodeId)?.scheduledTasks?.apiVersion === scheduledTasksApiVersion;
  }

  /** Opaque identity for committing read projections from the current business connection. */
  scheduledTaskConnection(nodeId: string): object | undefined {
    const socket = this.sockets.get(nodeId);
    return socket !== undefined &&
      socket.readyState === socket.OPEN &&
      this.supportsScheduledTasks(nodeId)
      ? socket
      : undefined;
  }

  requestScheduledTaskIndex(
    nodeId: string,
    connection: object,
    scope: { workspaceId: string; afterTaskId?: string }
  ): Promise<unknown> {
    if (this.scheduledTaskConnection(nodeId) !== connection)
      return Promise.reject(new Error('NODE_CONNECTION_REPLACED'));
    return this.requestBroker.requestScheduledTaskIndex(nodeId, scope);
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
    if (envelope.type === 'execution.prepare' || envelope.type === 'schedule.authorize') {
      this.send(
        socket,
        `${envelope.type}.response`,
        {
          error: {
            code:
              envelope.type === 'execution.prepare'
                ? 'EXECUTION_SERVER_UNAVAILABLE'
                : 'SCHEDULE_SERVER_UNAVAILABLE',
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
    if (envelope.type === 'browser.use.check') {
      const scope = browserUseCheckSchema.safeParse(envelope.payload);
      const enabled =
        scope.success && this.consumers.browserUseAllowed !== undefined
          ? await this.consumers.browserUseAllowed(nodeId, scope.data).catch(() => false)
          : false;
      if (this.sockets.get(nodeId) === socket)
        this.send(socket, 'browser.use.result', { enabled }, envelope.id);
      return true;
    }
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
      const bytes = Buffer.byteLength(JSON.stringify(envelope.payload));
      if (bytes > MODEL_USAGE_BATCH_BYTES) {
        this.send(
          socket,
          'error',
          {
            code: 'USAGE_RECORD_INVALID',
            message: 'Usage batch exceeds the byte limit.',
            details: `Received ${bytes} UTF-8 bytes; the limit is ${MODEL_USAGE_BATCH_BYTES}.`
          } satisfies PublicError,
          envelope.id
        );
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
    if (envelope.type === 'schedule.authorize') {
      await resolveScheduledRunAuthorization({
        nodeId,
        envelope,
        isCurrentConnection: () => this.sockets.get(nodeId) === socket,
        authorize: this.supportsScheduledTasks(nodeId)
          ? this.consumers.scheduleAuthorizer
          : undefined,
        respond: (payload) => this.send(socket, 'schedule.authorize.response', payload, envelope.id)
      });
      return true;
    }
    if (envelope.type === 'execution.prepare') {
      await resolveExecutionPreparation({
        nodeId,
        envelope,
        isCurrentConnection: () => this.sockets.get(nodeId) === socket,
        authorize: this.consumers.executionPreparer,
        respond: (payload) => this.send(socket, 'execution.prepare.response', payload, envelope.id)
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
    if (envelope.type === 'desktop.direct.ready' || envelope.type === 'desktop.direct.closed') {
      if (this.sockets.get(nodeId) !== socket) return true;
      const event = remoteDesktopDirectNodeEventSchema.safeParse({
        ...(typeof envelope.payload === 'object' && envelope.payload !== null
          ? envelope.payload
          : {}),
        type: envelope.type
      });
      if (!event.success) {
        this.sendError(socket, 'MESSAGE_INVALID', envelope.id);
        return true;
      }
      const generation = this.nodeCapabilities(nodeId)?.remoteDesktop?.nodeGeneration;
      if (generation === undefined || event.data.nodeGeneration !== generation) return true;
      await this.desktopDirect.onNodeEvent(nodeId, generation, event.data);
      return true;
    }
    if (envelope.type === 'desktop.relay.ready' || envelope.type === 'desktop.relay.closed') {
      if (this.sockets.get(nodeId) !== socket) return true;
      const event = remoteDesktopRelayNodeEventSchema.safeParse({
        ...(typeof envelope.payload === 'object' && envelope.payload !== null
          ? envelope.payload
          : {}),
        type: envelope.type
      });
      if (!event.success) {
        this.sendError(socket, 'MESSAGE_INVALID', envelope.id);
        return true;
      }
      const generation = this.nodeCapabilities(nodeId)?.remoteDesktop?.nodeGeneration;
      if (generation === undefined || event.data.nodeGeneration !== generation) return true;
      await this.desktopRelay.onNodeEvent(nodeId, generation, event.data);
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
