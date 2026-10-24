import { normalizeMarAgentUsage } from './runner/mar-agent/conversation-normalizer.js';
import { isImageAttachment } from './util/node-operation-parsers.js';
import { ModelUsageOutbox } from './service/model-usage-outbox.js';
import { NodeModelUsageService } from './service/model-usage-service.js';
import type WebSocket from 'ws';
import { dirname, resolve } from 'node:path';
import {
  createEnvelope,
  directNodeCommandSchema,
  type NodeCapabilities,
  type NodeEnvelope,
  type WorkbenchEventCategory
} from '@myagentroam/protocol';
import {
  loadNodeConfig,
  computerUseRuntimeExecutable,
  directTransferUdpPortRange,
  nodeDataDirectory,
  nodeDatabasePath,
  type NodeConfig
} from './config.js';
import { NodeMetrics, nodeLog } from './operational.js';
import { assertLocalSqlitePath } from './storage.js';
import { resolveWorkspaceExecutionDirectory } from './workspace.js';
import { detectCapabilitiesAsync, unavailableCapabilities } from './capabilities.js';
import { NodeDatabase, type NodeAgentSession } from './database.js';
import { TerminalManager } from './terminal.js';
import { NodeRuntimeState } from './runtime-state.js';
import { CommandStateStore } from './runner-command-engine.js';
import { GoalRuntime } from './service/goal-runtime.js';
import { GoalContinuationCoordinator } from './service/goal-continuation-coordinator.js';
import { GoalMcpBridge } from './service/goal-mcp-bridge.js';
import { RunnerUsageReader } from './runner-usage.js';
import { ClaudeCodeRunner } from './runner/claude-code-runner.js';
import { ClaudeManagedRunController } from './runner/claude/managed-run-controller.js';
import { CodexRunner } from './runner/codex-runner.js';
import { CodexManagedRunController } from './runner/codex/managed-run-controller.js';
import { FakeTestRunner } from './runner/fake-test-runner.js';
import type { FakeRunnerStatus } from './fake-runner.js';
import { RunnerRegistry } from './runner/runner-registry.js';
import { OpenCodeRunner } from './runner/opencode-runner.js';
import { MarAgentRunner } from './runner/mar-agent-runner.js';
import { MarAgentManagedRunController } from './runner/mar-agent/managed-run-controller.js';
import { PyAutoGuiComputerUseProvider } from './runner/mar-agent/computer-use.js';
import { ManagedComputerUseRuntime } from './computer-use-runtime.js';
import { OpenCodeManagedRunController } from './runner/opencode/managed-run-controller.js';
import { NodeOperationRouter } from './connector/node-operation-router.js';
import { SkillNodeOperationService } from './service/skill-node-operation-service.js';
import { McpNodeOperationService } from './service/mcp-node-operation-service.js';
import type { NodeConnectorOptions } from './connector/node-connector-options.js';
export type { NodeConnectorOptions } from './connector/node-connector-options.js';
import { RunnerService } from './service/runner-service.js';
import { TerminalService } from './service/terminal-service.js';
import { GitExecutionService } from './service/git-execution-service.js';
import { GitOperationService } from './service/git-operation-service.js';
import { WorkspaceService } from './service/workspace-service.js';
import { WorkspaceWatchService } from './service/workspace-watch-service.js';
import { WorkspaceFileService } from './service/workspace-file-service.js';
import { WorkspaceUploadService } from './service/workspace-upload-service.js';
import { DirectTransferService } from './service/direct-transfer-service.js';
import { WorkspaceChangeService } from './service/workspace-change-service.js';
import { WorkspaceSessionService } from './service/workspace-session-service.js';
import { WorkbenchEventService } from './service/workbench-event-service.js';
import { RunDomainState } from './service/run-domain-state.js';
import { RecentRunProjectionService } from './service/recent-run-projection-service.js';
import {
  SessionDomainState,
  type ExternalSessionActivationState
} from './service/session-domain-state.js';
import { RunEventService } from './service/run-event-service.js';
import {
  RunAttachmentService,
  type RunnerImageAttachment
} from './service/run-attachment-service.js';
import { NodeTerminalChannel } from './service/node-terminal-channel.js';
import { WorkspaceWorkbenchService } from './service/workspace-workbench-service.js';
import { NativeSessionWatchService } from './service/native-session-watch-service.js';
import { SessionWatchSlotCoordinator } from './service/session-watch-slot-coordinator.js';
import { SessionContextService } from './service/session-context-service.js';
import { WorkspaceDomainState } from './service/workspace-domain-state.js';
import { RunWorkbenchService } from './service/run-workbench-service.js';
import { SessionQueryService } from './service/session-query-service.js';
import { marctlSessionProgress } from './service/session-recent-activity.js';
import { WorkspaceQueueWorkbenchService } from './service/workspace-queue-workbench-service.js';
import { ContinuousRunCoordinator } from './service/continuous-run-coordinator.js';
import { SessionIdentityService } from './service/session-identity-service.js';
import { NativeSessionProjectionService } from './service/native-session-projection-service.js';
import {
  ConversationHistoryService,
  hasManagedActiveRun
} from './service/conversation-history-service.js';
import { ConversationSegmentService } from './service/conversation-segment-service.js';
import { RunnerInteractionService } from './service/runner-interaction-service.js';
import { SessionLifecycleService } from './service/session-lifecycle-service.js';
import { ExternalSessionResumeService } from './service/external-session-resume-service.js';
import { SessionMessageService } from './service/session-message-service.js';
import { SessionScheduleService } from './service/session-schedule-service.js';
import { ScheduledSessionCoordinator } from './service/scheduled-session-coordinator.js';
import { ScheduledSessionStore } from './service/scheduled-session-store.js';
import { RunAuthorizationControl } from './service/run-authorization-control.js';
import { PlannedRestartHandoff } from './service/planned-restart-handoff.js';
import { RestartSessionRestorer } from './service/restart-session-restorer.js';
import { ScheduleMcpBridge } from './service/schedule-mcp-bridge.js';
import { MailNotificationControl } from './service/mail-notification-control.js';
import {
  NotificationMcpBridge,
  resolveNotificationCapability
} from './service/notification-mcp-bridge.js';
import { SessionCatalogService } from './service/session-catalog-service.js';
import { SessionCommandService } from './service/session-command-service.js';
import { SessionPresentationService } from './service/session-presentation-service.js';
import {
  isPlainRecord,
  isRunnerImageAttachment,
  parseRunnerImageAttachments
} from './runner/codex/conversation-parser.js';
import { WebToolService } from './service/web-tool-service.js';

export { nodeConnectEndpoint, validatedCapabilities } from './runner/codex/conversation-parser.js';
import { NodeControlChannel } from './service/node-control-channel.js';
import { NodeControlMessageService } from './service/node-control-message-service.js';
import { NodeRequestService } from './service/node-request-service.js';
import { WorkbenchManifestService } from './service/workbench-manifest-service.js';
import { NodeRunEventBridge } from './service/node-run-event-bridge.js';
import { workbenchPayloadSessionId } from './service/workbench-event-projection.js';
import { NodeWorkspaceCoordinator } from './service/node-workspace-coordinator.js';
import { FakeManagedRunService } from './service/fake-managed-run-service.js';
import { RunnerChannelMessageService } from './service/runner-channel-message-service.js';
import { ManagedRunnerSessionService } from './service/managed-runner-session-service.js';
import { NodeConnectionLifecycleService } from './service/node-connection-lifecycle-service.js';
import {
  NodeUpgradeCoordinator,
  nodeUpgradeRequestPath
} from './service/node-upgrade-coordinator.js';
import {
  probeBubblewrap,
  type ConversationHostingProbe
} from './service/conversation-hosting-capability-service.js';
import { ConversationHostingLifecycleService } from './service/conversation-hosting-lifecycle-service.js';
import { ConversationHostingEnablementService } from './service/conversation-hosting-enablement-service.js';
import { ComputerUseEnablementService } from './service/computer-use-enablement-service.js';
import { safeErrorCode } from './util/safe-error.js';
import { RuntimeCredentialControlService } from './service/runtime-credential-control-service.js';
import { MarAgentRuntimeModelFactory } from './runner/mar-agent/runtime-model-factory.js';
import { PromptCompletionNodeService } from './service/prompt-completion-node-service.js';
import { PromptCompletionWorkspaceSource } from './service/prompt-completion-workspace-source.js';
import { MarAgentModelTransportTestService } from './service/mar-agent-model-transport-test-service.js';
import { ChatgptLoginService } from './service/chatgpt-login-service.js';

const HEARTBEAT_MS = 15_000;
const CAPABILITY_REFRESH_MS = 60_000;
const RETRY_MIN_MS = 500;
const RETRY_MAX_MS = 30_000;
const CLAUDE_APPROVAL_TIMEOUT_MS = 10 * 60_000;
const CONVERSATION_TEMPLATE_OPERATIONS = [
  'conversation.template.source.inspect',
  'conversation.template.publish',
  'conversation.template.publish.status',
  'conversation.template.version.inspect'
] as const;

const HOSTED_CONVERSATION_OPERATIONS = [
  'conversation.hosted.list',
  'conversation.hosted.create',
  'conversation.hosted.get',
  'conversation.hosted.history',
  'conversation.hosted.watch',
  'conversation.hosted.unwatch',
  'conversation.hosted.message',
  'conversation.hosted.rollback',
  'conversation.hosted.interrupt',
  'conversation.hosted.config.update',
  'conversation.hosted.metadata.update',
  'conversation.hosted.image.read',
  'conversation.hosted.tool-resource.read',
  'conversation.hosted.files.list',
  'conversation.hosted.file.read',
  'conversation.hosted.file.delete',
  'conversation.hosted.files.upload.preflight',
  'conversation.hosted.files.upload.create',
  'conversation.hosted.files.upload.chunk',
  'conversation.hosted.files.upload.status',
  'conversation.hosted.files.upload.complete',
  'conversation.hosted.files.upload.cancel',
  'conversation.hosted.delete'
] as const;
const CONVERSATION_HOSTING_MAINTENANCE_OPERATIONS = [
  'conversation.hosting.storage.inspect',
  'conversation.hosting.cleanup.preview',
  'conversation.hosting.cleanup.execute'
] as const;

export function nextReconnectDelay(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** Math.min(Math.max(attempt, 0), 16));
}

function upgradeMetadata(
  metadata: NodeCapabilities['metadata'],
  status: ReturnType<NodeUpgradeCoordinator['snapshot']>
): NonNullable<NodeCapabilities['metadata']> {
  const next = { ...(metadata ?? {}) };
  if (process.env['MAR_NODE_SUPERVISED'] === '1') next.supervisedUpgrade = true;
  else delete next.supervisedUpgrade;
  if (status.state === 'IDLE') delete next.upgrade;
  else next.upgrade = status;
  return next;
}

export class NodeConnector {
  private usageOutbox: ModelUsageOutbox | undefined;
  private readonly modelUsage = new NodeModelUsageService(
    () => this.usageOutbox,
    () => this.config?.nodeId
  );

  private readonly nodeGeneration = crypto.randomUUID().replace(/-/g, '');
  private readonly controlChannel: NodeControlChannel;
  private readonly controlMessages: NodeControlMessageService;
  private readonly scheduledRunAuthorization: RunAuthorizationControl;
  private readonly restartAuthorization: RunAuthorizationControl;
  private readonly restartHandoff: PlannedRestartHandoff;
  private readonly inFlightOperations = new Set<Promise<unknown>>();
  private readonly mailNotificationControl = new MailNotificationControl((envelope) =>
    this.sendEnvelope(envelope)
  );
  private readonly scheduledSessions: ScheduledSessionCoordinator;
  private readonly nodeRequests: NodeRequestService;
  private readonly connectionLifecycle: NodeConnectionLifecycleService;
  private readonly runtimeCredentials = new RuntimeCredentialControlService({
    send: (envelope) => this.sendEnvelope(envelope)
  });
  private readonly marAgentRuntimeModels = new MarAgentRuntimeModelFactory(this.runtimeCredentials);
  private readonly webToolService = new WebToolService(() => this.config);
  private readonly marAgentModelTransportTests = new MarAgentModelTransportTestService({
    modelFactory: this.marAgentRuntimeModels
  });
  private readonly chatgptLogins = new ChatgptLoginService(() => {
    if (!this.config) throw new Error('NODE_CONFIG_UNAVAILABLE');
    return nodeDataDirectory(this.config, this.configPath);
  });
  /** @internal Existing contract tests inject their socket through this boundary. */
  private set socket(value: WebSocket | undefined) {
    this.controlChannel.replaceSocketForTesting(value);
  }
  private stopped = false;
  private stopping: Promise<void> | undefined;
  private config: NodeConfig | undefined;
  private readonly capabilitiesProvided: boolean;
  private capabilities: NodeCapabilities;
  private readonly capabilityDetector: () => NodeCapabilities | Promise<NodeCapabilities>;
  private readonly conversationHostingProbe: ConversationHostingProbe;
  private readonly conversationHosting: ConversationHostingLifecycleService;
  private readonly configPath: string | undefined;
  private readonly reconnect: boolean;
  private readonly claudeApprovalTimeoutMs: number;
  private readonly workbenchEventService: WorkbenchEventService = new WorkbenchEventService({
    send: (envelope) => this.sendEnvelope(envelope),
    accepts: (category, payload) => {
      const sessionId = workbenchPayloadSessionId(
        (id) => this.runtime.getRun(id),
        category,
        payload
      );
      return sessionId === undefined || !this.sessionIdentityService.bootstrapIds.has(sessionId);
    },
    projection: {
      getRun: (id) => this.runtime.getRun(id),
      conversationTurnForRun: (id) => this.runtime.conversationTurnForRun(id),
      progress: (sessionId) => marctlSessionProgress(this.runtime, sessionId)
    },
    emitRealtime: (sessionId, event) =>
      this.nativeSessionWatchService.emitRealtime(sessionId, event)
  });
  private readonly fakeRunner: FakeTestRunner | undefined;
  private readonly fakeScript: NodeConnectorOptions['fakeScript'];
  private readonly runState = new RunDomainState();
  private readonly runEventBridge: NodeRunEventBridge;
  private readonly workspaceCoordinator: NodeWorkspaceCoordinator;
  private readonly sessionState = new SessionDomainState<
    NodeAgentSession,
    ExternalSessionActivationState
  >();
  private readonly sessionIdentityService: SessionIdentityService;
  private readonly nativeSessionProjectionService: NativeSessionProjectionService;
  private readonly conversationHistoryService: ConversationHistoryService;
  private readonly promptCompletion: PromptCompletionNodeService;
  private readonly conversationSegmentService: ConversationSegmentService;
  private readonly runnerInteractionService: RunnerInteractionService;
  private readonly runnerChannelMessages: RunnerChannelMessageService;
  private readonly managedRunnerSessions: ManagedRunnerSessionService;
  private readonly sessionPresentationService: SessionPresentationService;
  private readonly sessionLifecycleService: SessionLifecycleService;
  private readonly externalSessionResumeService: ExternalSessionResumeService;
  private readonly sessionMessageService: SessionMessageService;
  private readonly sessionCatalogService: SessionCatalogService;
  private readonly sessionCommandService: SessionCommandService;
  private readonly runAttachmentService: RunAttachmentService;
  private readonly terminalChannel: NodeTerminalChannel;
  private readonly codexClient: CodexRunner;
  private readonly codexRunController: CodexManagedRunController<RunnerImageAttachment>;
  private readonly claudeClient: ClaudeCodeRunner;
  private readonly openCodeClient: OpenCodeRunner;
  private readonly marAgentClient: MarAgentRunner;
  private readonly marAgentRunController: MarAgentManagedRunController;
  private readonly computerUseProvider: PyAutoGuiComputerUseProvider;
  private readonly computerUseEnablement: ComputerUseEnablementService;
  private readonly managedComputerUseRuntime: ManagedComputerUseRuntime;
  private readonly openCodeRunController: OpenCodeManagedRunController;
  private readonly claudeRunController: ClaudeManagedRunController<RunnerImageAttachment>;
  private readonly runners: RunnerRegistry;
  private readonly sessionContextService: SessionContextService;
  private readonly runWorkbenchService: RunWorkbenchService;
  private readonly sessionQueryService: SessionQueryService;
  private readonly continuousRunCoordinator: ContinuousRunCoordinator<RunnerImageAttachment>;
  private readonly workspaceQueueWorkbenchService: WorkspaceQueueWorkbenchService;
  private readonly operationRouter = new NodeOperationRouter();
  private gitExecutionService: GitExecutionService | undefined;
  private readonly gitOperationService = new GitOperationService({
    git: () => this.gitExecution(),
    workspace: async (input) => {
      const session =
        typeof input.sessionId === 'string'
          ? (this.runtime.getAgentSession(input.sessionId) ??
            (await this.nativeSessionProjectionService.resolveCurrent(input.sessionId)))
          : undefined;
      const workspaceId =
        session?.workspaceId ??
        (typeof input.workspaceId === 'string' ? input.workspaceId : undefined);
      return workspaceId === undefined ? undefined : this.database?.getWorkspace(workspaceId);
    },
    runActive: (id) => {
      const run = this.runtime.getRun(id);
      return run !== undefined && !['SUCCEEDED', 'FAILED', 'INTERRUPTED'].includes(run.status);
    }
  });
  private readonly runnerService: RunnerService;
  private readonly workbenchManifestService: WorkbenchManifestService;
  private readonly terminalService: TerminalService;
  private readonly workspaceService: WorkspaceService;
  private readonly commandStates = new CommandStateStore();
  private readonly goalRuntime = new GoalRuntime(() => undefined);
  private sessionScheduleService?: SessionScheduleService;
  private readonly goalMcpBridge = new GoalMcpBridge(this.goalRuntime, (sessionId) =>
    this.goalCoordinator.changed(sessionId)
  );
  private readonly scheduleMcpBridge = new ScheduleMcpBridge(
    () => {
      if (this.database === undefined) throw new Error('NODE_DATABASE_UNAVAILABLE');
      return new ScheduledSessionStore(this.database.raw);
    },
    (sessionId) => {
      const session = this.runtime.getAgentSession(sessionId);
      if (session !== undefined)
        this.emitSessionWorkbenchEvent({
          session: this.sessionPresentationService.present(session)
        });
      this.scheduledSessions.changed();
    },
    (sessionId, proposalId) => this.scheduledSessions.proposalCreated(sessionId, proposalId),
    (input) => {
      if (this.sessionScheduleService === undefined)
        throw new Error('SCHEDULE_SERVICE_UNAVAILABLE');
      return this.sessionScheduleService.createFromMcp(input);
    },
    (sessionId) => this.runtime.getAgentSession(sessionId)?.externalSessionId ?? sessionId
  );
  private readonly notificationMcpBridge = new NotificationMcpBridge(
    (capability) => resolveNotificationCapability(this.runtime, capability),
    (request) => this.mailNotificationControl.request(request),
    {
      supported: () => this.mailNotificationControl.supportsChannels(),
      send: (request) => this.mailNotificationControl.notification(request)
    }
  );
  private readonly runnerUsageReader: RunnerUsageReader;
  private readonly terminalManager: TerminalManager;
  private readonly upgradeCoordinator: NodeUpgradeCoordinator;
  private readonly workspaceState = new WorkspaceDomainState();
  private readonly workspaceWatchService = new WorkspaceWatchService(
    this.workspaceState,
    (workspaceId) => this.workspaceSessionService.ensureWatch(workspaceId),
    (workspaceId) => this.workspaceSessionService.stopWatch(workspaceId),
    (workspaceId) => this.workspaceWorkbenchService?.releaseWorkspace(workspaceId),
    (watch) => this.workspaceWorkbenchService?.cancelFilePrewarm(watch)
  );
  private readonly workspaceSessionService = new WorkspaceSessionService(this.workspaceState, {
    discover: (workspaceId, onRunnerDiscovered) =>
      this.discoverWorkspaceSessions(workspaceId, onRunnerDiscovered),
    listPage: (workspaceId) =>
      this.executeNodeOperation('session.list', { workspaceId, limit: 30 }),
    active: (workspaceId) => this.workspaceWatchService.topicActive(workspaceId, 'sessions'),
    invalidate: (workspaceId) =>
      void this.workspaceWorkbenchService?.invalidateTopic(workspaceId, 'sessions')
  });
  private readonly workspaceFileService = new WorkspaceFileService(
    this.workspaceState,
    (workspaceId) => {
      this.workspaceWorkbenchService?.invalidateWorkspaceFiles(workspaceId);
      this.workspaceCoordinator.invalidate(workspaceId);
    },
    {},
    (workspaceId, resourcePath) =>
      this.workspaceUploadService.fileResource(workspaceId, resourcePath) ??
      this.runAttachmentService.fileResource(workspaceId, resourcePath)
  );
  private readonly workspaceUploadService = new WorkspaceUploadService(
    this.workspaceState,
    (workspaceId) => {
      this.workspaceFileService.dispose(workspaceId);
      this.workspaceWorkbenchService?.invalidateWorkspaceFiles(workspaceId);
      this.workspaceCoordinator.invalidate(workspaceId);
    },
    () => this.attachmentTemporaryRoot()
  );
  private directTransferService: DirectTransferService | undefined;

  private attachmentTemporaryRoot(): string {
    if (this.config === undefined) throw new Error('NODE_CONFIG_UNAVAILABLE');
    return resolve(nodeDataDirectory(this.config, this.configPath), 'temp-files');
  }
  private readonly workspaceChangeService = new WorkspaceChangeService(this.workspaceState);
  private readonly workspaceWorkbenchService: WorkspaceWorkbenchService;
  private database: NodeDatabase | undefined;
  private readonly recentRunProjectionService = new RecentRunProjectionService((message) =>
    this.send('recent-runs', message)
  );
  /** Runtime/session state is intentionally not persisted to Node SQLite. */
  private readonly runtime = new NodeRuntimeState(
    () => this.config?.nodeId ?? 'runtime-node',
    (workspaceId) => this.database?.getWorkspace(workspaceId),
    Date.now,
    (run, session, userMessage) => this.recentRunProjectionService.record(run, session, userMessage)
  );
  private readonly goalCoordinator = new GoalContinuationCoordinator({
    goals: this.goalRuntime,
    runners: () => this.runners,
    runtime: this.runtime,
    commands: this.commandStates,
    queue: () => this.continuousRunCoordinator,
    submit: (input) => this.sessionMessageService.submitGoal(input),
    emitRun: (...args) => this.runEventBridge.emitRun(...args),
    present: (session) => this.sessionPresentationService.present(session),
    emitSession: (session) =>
      this.emitSessionWorkbenchEvent({ session: this.sessionPresentationService.present(session) }),
    database: () => this.database
  });
  private readonly metrics = new NodeMetrics();
  private readonly runEventService = new RunEventService({
    runtime: this.runtime,
    metrics: this.metrics,
    state: this.runState,
    isBootstrapSession: (sessionId) => this.sessionIdentityService.bootstrapIds.has(sessionId),
    presentSession: (session) => this.sessionPresentationService.present(session),
    rejectBootstrap: (sessionId, code) => this.sessionIdentityService.reject(sessionId, code),
    emitWorkbench: (category, payload) => {
      if (category === 'conversation' && isPlainRecord(payload) && 'turn' in payload)
        this.emitConversationTurn(payload.turn);
      else this.publishWorkbenchEvent(category, payload);
    },
    cleanupAttachments: (runId) => this.runAttachmentService.cleanup(runId),
    refreshAttachments: (sessionId) => this.runAttachmentService.refreshSession(sessionId),
    expireImages: (runId) => this.runAttachmentService.expire(runId),
    scheduleContextRefresh: (sessionId) => this.sessionContextService.schedule(sessionId),
    refreshWorkspaceSessions: (workspaceId) =>
      this.workspaceWorkbenchService.ensureTopicSnapshot(workspaceId, 'sessions'),
    onTerminalRun: (run, status) => {
      if (this.database !== undefined) this.scheduledSessions.executionTerminated(run, status);
    },
    dispatchQueue: async (sessionId, delayMs = 0) => {
      if (this.upgradeCoordinator.pending()) return;
      if (delayMs > 0) {
        this.continuousRunCoordinator.schedule(sessionId, delayMs);
        return;
      }
      await this.continuousRunCoordinator.dispatch(sessionId);
    },
    executionStarted: (executionId) => this.continuousRunCoordinator.executionStarted(executionId),
    keepRunActive: (sessionId) => this.goalCoordinator.keepRunActive(sessionId),
    executionTerminating: (executionId, status, permissionStop) => {
      this.gitOperationService.executionFinished(executionId);
      this.goalCoordinator.executionTerminating(executionId, status, permissionStop);
    },
    releaseExecution: (executionId) => {
      this.modelUsage.release(executionId);
      this.goalCoordinator.releaseExecution(executionId);
      this.revokeExecutionMcps(executionId);
      this.continuousRunCoordinator.remove(executionId);
    }
  });
  private revokeExecutionMcps(executionId: string): void {
    this.goalMcpBridge.revoke(executionId);
    this.scheduleMcpBridge.revoke(executionId);
    this.notificationMcpBridge.revoke(executionId);
  }

  private readonly sessionWatchSlots = new SessionWatchSlotCoordinator();
  private readonly nativeSessionWatchService = new NativeSessionWatchService({
    resolve: async (sessionId) =>
      this.runtime.getAgentSession(sessionId) ??
      this.nativeSessionProjectionService.resolveCurrent(sessionId),
    managedActive: (session) => hasManagedActiveRun(this.runtime, session),
    suspended: (sessionId) => this.externalSessionResumeService.transitioning(sessionId),
    refreshActivity: (session) => this.conversationHistoryService.refreshExternalActivity(session),
    present: (session) => this.sessionPresentationService.present(session),
    readPage: (session, limit) => this.conversationHistoryService.read(session, { limit }),
    readHistoryPage: (session, limit) =>
      this.conversationHistoryService.readHistoryPage(session, { limit }),
    projectInitialPage: (session, page, _unit, limit) => {
      const context = this.sessionContextService.snapshot(session.id);
      this.sessionContextService.schedule(session);
      return {
        kind: 'session-watch-snapshot',
        sequence: this.workbenchEventService.snapshotSequence(),
        session: this.sessionPresentationService.present(session),
        runs: this.runtime.listRunsForSession(session.id, { includeTerminal: true }),
        progress: marctlSessionProgress(this.runtime, session.id),
        performance: this.runtime.sessionPerformance(session.id),
        queue: this.workspaceQueueWorkbenchService.snapshot(session.id),
        context,
        conversation: this.conversationSegmentService.projectInitial(session, page, limit)
      };
    },
    emitSession: (session) => this.emitSessionWorkbenchEvent({ session }),
    emitPage: (session, page) =>
      this.emitWorkbenchEvent('conversation', {
        sessionId: session.id,
        snapshot: this.conversationSegmentService.projectInitial(session, page, 10)
      }),
    nodeId: () => this.config?.nodeId ?? 'runtime-node',
    nodeGeneration: () => this.nodeGeneration,
    emitWatchEvent: (payload) => this.send('watch.event', payload),
    sessionWatchSlots: this.sessionWatchSlots,
    log: nodeLog
  });

  constructor(options: NodeConnectorOptions = {}) {
    this.config = options.config;
    this.configPath = options.configPath;
    this.claudeApprovalTimeoutMs = options.claudeApprovalTimeoutMs ?? CLAUDE_APPROVAL_TIMEOUT_MS;
    this.capabilitiesProvided = options.capabilities !== undefined;
    this.capabilities = options.capabilities ?? unavailableCapabilities();
    this.conversationHostingProbe = options.conversationHostingProbe ?? probeBubblewrap;
    this.conversationHosting = new ConversationHostingLifecycleService({
      config: () => this.config,
      configPath: this.configPath,
      database: () => this.database,
      capabilities: () => this.capabilities,
      probe: this.conversationHostingProbe,
      runtime: {
        webSearch: (input, signal) => this.webToolService.webSearch(input, signal),
        webFetch: (input, signal) => this.webToolService.webFetch(input, signal, false),
        modelFactory: this.marAgentRuntimeModels,
        registerNativeImages: (runId, roots, images) =>
          this.runAttachmentService.registerNativeImages(runId, roots, images, {
            reuseCachedRunImages: false
          })
      },
      host: {
        modelUsage: (grant, usage) => {
          const runId = usage.executionId ?? usage.requestId;
          this.modelUsage.bind(runId, grant, usage.sessionId, 'mar-agent');
          this.modelUsage.record(runId, normalizeMarAgentUsage(usage));
          this.modelUsage.release(runId);
        },
        nodeGeneration: () => this.nodeGeneration,
        sessionWatchSlots: this.sessionWatchSlots,
        emitWatchEvent: (payload) => this.send('watch.event', payload),
        nextWorkbenchEvent: (payload) =>
          this.workbenchEventService.next('hosted-conversation', payload),
        emitWorkbenchEvent: (event) => this.workbenchEventService.publish(event),
        readImage: (runId, imageRef) => this.runAttachmentService.readNative(runId, imageRef)
      }
    });
    this.upgradeCoordinator = new NodeUpgradeCoordinator(
      () => {
        if (this.config === undefined) throw new Error('NODE_CONFIG_UNAVAILABLE');
        return nodeUpgradeRequestPath(nodeDatabasePath(this.config, this.configPath));
      },
      () => this.runState.active.size,
      (status) => {
        this.capabilities = {
          ...this.capabilities,
          metadata: upgradeMetadata(this.capabilities.metadata, status)
        };
        this.controlChannel?.send('capabilities', this.capabilities);
      },
      options.upgradeReady ??
        (() => {
          void this.stop().finally(() => process.exit(75));
        })
    );
    this.capabilities = {
      ...this.capabilities,
      metadata: upgradeMetadata(this.capabilities.metadata, this.upgradeCoordinator.snapshot())
    };
    const detect = options.capabilityDetector ?? detectCapabilitiesAsync;
    this.capabilityDetector = async () => {
      const capabilities = await detect();
      return this.projectComputerUseCapability(
        await this.conversationHosting.project({
          ...capabilities,
          metadata: upgradeMetadata(capabilities.metadata, this.upgradeCoordinator.snapshot())
        })
      );
    };
    this.reconnect = options.reconnect ?? true;
    this.fakeRunner =
      options.fakeRunner === undefined ? undefined : new FakeTestRunner(options.fakeRunner);
    this.fakeScript = options.fakeScript;
    this.runAttachmentService = new RunAttachmentService(
      (session) => this.runners.require(session.runner).nativeImageRoots(session),
      (sessionId) =>
        this.runtime.activeSessionRun(sessionId) !== undefined ||
        this.runtime.sessionQueue(sessionId).itemIds.length > 0,
      () => this.attachmentTemporaryRoot()
    );
    this.codexClient = new CodexRunner(
      options.codexClient,
      options.codexProfileClientFactory,
      options.codexRunClientFactory
    );
    this.codexRunController = new CodexManagedRunController(this.codexClient, {
      available: () => this.capabilities.codex.available,
      intercepted: () => this.fakeRunner !== undefined,
      active: this.runState.active,
      addActive: (runId) => this.runState.active.add(runId),
      removeActive: (runId) => this.runState.active.delete(runId),
      adopt: (input) => this.runtime.adoptRun(input),
      session: (sessionId) => this.runtime.getAgentSession(sessionId),
      runStatus: (runId) => this.runtime.getRun(runId)?.status,
      run: (runId) => this.runtime.getRun(runId),
      interrupted: (runId) => this.runState.interruptRequested.has(runId),
      parseAttachments: parseRunnerImageAttachments,
      materialize: (runId, attachments) =>
        this.runAttachmentService.materializeCodex(runId, attachments),
      completeCancelled: (runId) => this.runnerInteractionService.completeCancelledRun(runId),
      promoteSession: (sessionId, nativeSessionId) =>
        this.sessionIdentityService.promote(sessionId, nativeSessionId),
      send: (type, payload) => this.send(type, payload),
      emit: (runId, eventType, payload, status) =>
        this.runEventBridge.emitRun(runId, eventType, payload, status),
      nativeGoalUpdated: (runId, goal) => this.goalCoordinator.handleNativeGoalUpdate(runId, goal),
      cancel: (runId, threadId, turnId, cwd, status) =>
        this.runnerInteractionService.cancelCodexTurn(runId, threadId, turnId, cwd, status),
      createApproval: (input) => this.runtime.createApproval(input),
      publishApproval: (input) => this.runnerInteractionService.publishApproval(input),
      emitItem: (runId, item) => this.emitConversationItem(runId, item),
      appendImages: (runId, images) =>
        this.runAttachmentService.append(runId, images.filter(isRunnerImageAttachment)),
      syncTitle: (sessionId, nativeSessionId, cwd) =>
        this.managedRunnerSessions.refreshTitle(sessionId, nativeSessionId, cwd),
      commandState: (sessionId, commandId) => this.commandStates.get(sessionId, commandId),
      setCommandState: (sessionId, state) => this.commandStates.set(sessionId, state),
      clearCommandState: (sessionId, commandId) => this.commandStates.clear(sessionId, commandId),
      commandStates: (sessionId) => this.commandStates.list(sessionId),
      hasActiveSessionLease: (sessionId) => this.runtime.hasActiveSessionLease(sessionId),
      fast: (input) =>
        this.executeNodeOperation('runner.command.execute', {
          runner: 'codex',
          commandId: 'fast',
          input
        })
    });
    this.codexClient.onNotification((notification) =>
      this.codexRunController.handleNotification(notification)
    );
    this.claudeClient = new ClaudeCodeRunner(options.claudeClient);
    this.openCodeClient = new OpenCodeRunner(options.openCodeClient);
    this.marAgentClient = new MarAgentRunner();
    this.marAgentClient.setGeneratedImageRegistrar((session, images) =>
      this.runAttachmentService.registerNative(session, images)
    );
    this.computerUseProvider = new PyAutoGuiComputerUseProvider(() => {
      if (this.config?.computerUse?.enabled !== true) return undefined;
      const runtimeExecutable = computerUseRuntimeExecutable(this.config, this.configPath);
      return runtimeExecutable === undefined ? undefined : { enabled: true, runtimeExecutable };
    });
    this.managedComputerUseRuntime = new ManagedComputerUseRuntime(
      () => this.config,
      this.configPath
    );
    this.computerUseEnablement = new ComputerUseEnablementService({
      config: () => this.config,
      setConfig: (config) => (this.config = config),
      configPath: this.configPath,
      provider: this.computerUseProvider,
      prepareRuntime: () => this.managedComputerUseRuntime.ensure(),
      publish: (capability) => {
        this.capabilities = { ...this.capabilities, computerUse: capability };
        this.send('capabilities', this.capabilities);
      }
    });
    this.capabilities = this.projectComputerUseCapability(this.capabilities);
    this.marAgentRunController = new MarAgentManagedRunController(
      this.marAgentClient,
      {
        createApproval: (input) => this.runtime.createApproval(input),
        publishApproval: (input) => this.runnerInteractionService.publishApproval(input),
        active: this.runState.active,
        adopt: (input) => this.runtime.adoptRun(input),
        promote: (sessionId, nativeSessionId) =>
          this.sessionIdentityService.promote(sessionId, nativeSessionId),
        customTitle: (sessionId) => this.runtime.getAgentSession(sessionId)?.customTitle,
        syncTitle: (nativeSessionId, cwd) =>
          this.managedRunnerSessions.refreshTitle(nativeSessionId, nativeSessionId, cwd),
        emit: (runId, eventType, payload, status) =>
          this.runEventBridge.emitRun(runId, eventType, payload, status),
        emitItem: (runId, item) => this.emitConversationItem(runId, item),
        refreshContext: (runId) => {
          const sessionId = this.runtime.getRun(runId)?.sessionId;
          if (sessionId !== undefined) this.sessionContextService.schedule(sessionId);
        },
        run: (runId) => this.runtime.getRun(runId),
        commandState: (sessionId, commandId) => this.commandStates.get(sessionId, commandId),
        setCommandState: (sessionId, state) => this.commandStates.set(sessionId, state),
        clearCommandState: (sessionId, commandId) => this.commandStates.clear(sessionId, commandId),
        commandStates: (sessionId) => this.commandStates.list(sessionId),
        webSearch: (input, signal) => this.webToolService.webSearch(input, signal),
        webFetch: (input, signal) => this.webToolService.webFetch(input, signal),
        registerGeneratedImages: (runId, nativeSessionId, images) => {
          const turn = this.runtime.conversationTurnForRun(runId);
          const session =
            turn === undefined ? undefined : this.runtime.getAgentSession(turn.sessionId);
          return session === undefined
            ? []
            : this.marAgentClient.registerGeneratedImages(session, nativeSessionId, images);
        }
      },
      {
        modelFactory: this.marAgentRuntimeModels,
        retainEnvironment: (environment) => this.gitExecution().retain(environment),
        computerUse: this.computerUseProvider
      }
    );
    this.marAgentClient.setSessionResourceReleaser((sessionId) =>
      this.marAgentRunController.releaseSession(sessionId)
    );
    this.openCodeRunController = new OpenCodeManagedRunController(
      this.openCodeClient,
      {
        intercepted: () => this.fakeRunner !== undefined,
        active: this.runState.active,
        parseAttachments: parseRunnerImageAttachments,
        persistAttachments: async (_cwd, runId, attachments) => {
          const run = this.runtime.getRun(runId);
          if (run === undefined) throw new Error('RUN_NOT_FOUND');
          const storageRunId = `${runId}-opencode-images`;
          const paths = await this.runAttachmentService.persistFiles(
            run.workspaceId,
            storageRunId,
            attachments
          );
          this.runAttachmentService.retainSessionFiles(run.sessionId, storageRunId);
          return paths;
        },
        emit: (runId, eventType, payload, status) =>
          this.runEventBridge.emitRun(runId, eventType, payload, status),
        emitItem: (runId, item) => this.emitConversationItem(runId, item),
        adopt: (input) => this.runtime.adoptRun(input),
        run: (runId) => {
          const run = this.runtime.getRun(runId);
          if (run === undefined) throw new Error('RUN_NOT_FOUND');
          return run;
        },
        hasActiveSessionLease: (sessionId) => this.runtime.hasActiveSessionLease(sessionId),
        promote: (sessionId, nativeSessionId) =>
          this.sessionIdentityService.promote(sessionId, nativeSessionId),
        rememberNative: (nativeSessionId, sessionId) =>
          this.managedRunnerSessions.remember(nativeSessionId, sessionId),
        send: (type, payload) => this.send(type, payload),
        createApproval: (input) => this.runtime.createApproval(input),
        expireApproval: (approvalId) => {
          this.runtime.expireApproval(approvalId);
        },
        publishApproval: (input) => this.runnerInteractionService.publishApproval(input),
        commandState: (sessionId, commandId) => this.commandStates.get(sessionId, commandId),
        setCommandState: (sessionId, state) => this.commandStates.set(sessionId, state),
        clearCommandState: (sessionId, commandId) => this.commandStates.clear(sessionId, commandId),
        commandStates: (sessionId) => this.commandStates.list(sessionId)
      },
      this.claudeApprovalTimeoutMs
    );
    this.claudeRunController = new ClaudeManagedRunController(this.claudeClient, {
      intercepted: () => this.fakeRunner !== undefined,
      active: this.runState.active,
      parseAttachments: parseRunnerImageAttachments,
      emit: (runId, eventType, payload, status) =>
        this.runEventBridge.emitRun(runId, eventType, payload, status),
      adopt: (input) => this.runtime.adoptRun(input),
      run: (runId) => this.runtime.getRun(runId),
      hasActiveSessionLease: (sessionId) => this.runtime.hasActiveSessionLease(sessionId),
      session: (sessionId) => this.runtime.getAgentSession(sessionId),
      completeCancelled: (runId) => this.runnerInteractionService.completeCancelledRun(runId),
      requestUserInput: (runId, input, toolUseId) =>
        this.runnerInteractionService.requestClaudeUserInput(runId, input, toolUseId),
      requestApproval: (runId, toolName, input) =>
        this.runnerInteractionService.requestClaudeApproval(runId, toolName, input),
      rememberNative: (nativeSessionId, sessionId) =>
        this.managedRunnerSessions.remember(nativeSessionId, sessionId),
      promote: (sessionId, nativeSessionId) =>
        this.sessionIdentityService.promote(sessionId, nativeSessionId),
      send: (type, payload) => this.send(type, payload),
      emitItem: (runId, item) => this.emitConversationItem(runId, item),
      syncTitle: (sessionId, nativeSessionId, cwd) =>
        this.managedRunnerSessions.refreshTitle(sessionId, nativeSessionId, cwd),
      setChannelToken: (sessionId, token) => this.runtime.setChannelToken(sessionId, token),
      commandState: (sessionId, commandId) => this.commandStates.get(sessionId, commandId),
      setCommandState: (sessionId, state) => this.commandStates.set(sessionId, state),
      clearCommandState: (sessionId, commandId) => this.commandStates.clear(sessionId, commandId),
      commandStates: (sessionId) => this.commandStates.list(sessionId)
    });
    this.runners = new RunnerRegistry([
      this.openCodeClient,
      this.marAgentClient,
      this.codexClient,
      this.claudeClient,
      ...(this.fakeRunner === undefined ? [] : [this.fakeRunner])
    ]);
    this.managedRunnerSessions = new ManagedRunnerSessionService(
      this.runtime,
      this.runners,
      (session) =>
        this.emitSessionWorkbenchEvent({
          session: this.sessionPresentationService.present(session)
        })
    );
    this.runnerInteractionService = new RunnerInteractionService({
      runtime: this.runtime,
      state: this.runState,
      codex: () => this.codexClient,
      settleCodexUsage: (runId, turnId) => this.codexRunController.settleUsage(runId, turnId),
      claude: () => this.claudeClient,
      runners: this.runners,
      emitRun: (runId, eventType, payload, status) =>
        this.runEventBridge.emitRun(runId, eventType, payload, status),
      emitItem: (runId, item) => this.emitConversationItem(runId, item),
      approvalTimeoutMs: this.claudeApprovalTimeoutMs,
      publishApproval: (input) => this.runEventBridge.publishApproval(input)
    });
    this.runnerChannelMessages = new RunnerChannelMessageService({
      interactions: this.runnerInteractionService,
      send: (type, payload, replyTo) => this.send(type, payload, replyTo)
    });
    this.sessionPresentationService = new SessionPresentationService({
      database: () => this.database,
      runtime: this.runtime,
      commands: this.commandStates,
      runners: this.runners,
      capabilities: () => this.capabilities,
      hasManagedActiveRun: (session) => hasManagedActiveRun(this.runtime, session),
      projectionForNative: (session) =>
        this.nativeSessionProjectionService.projectionForNative(session)
    });
    this.nativeSessionProjectionService = new NativeSessionProjectionService({
      database: () => this.database,
      nodeId: () => this.config?.nodeId ?? 'recorded-session',
      runtime: this.runtime,
      runners: this.runners,
      capabilities: () => this.capabilities,
      state: this.sessionState,
      commands: this.commandStates,
      present: (session) => this.sessionPresentationService.present(session)
    });
    this.conversationHistoryService = new ConversationHistoryService({
      runtime: this.runtime,
      runners: this.runners,
      capabilities: () => this.capabilities,
      attachments: this.runAttachmentService,
      snapshotSequence: () => this.workbenchEventService.snapshotSequence(),
      hasManagedActiveRun: (session) => hasManagedActiveRun(this.runtime, session),
      setExternalActivity: (sessionId, activity) =>
        this.sessionState.externalActivity.set(sessionId, activity)
    });
    this.conversationSegmentService = new ConversationSegmentService((session, input) =>
      this.conversationHistoryService.read(session, input)
    );
    this.sessionContextService = new SessionContextService({
      runners: this.runners,
      session: (sessionId) => this.runtime.getAgentSession(sessionId),
      stopped: () => this.stopped,
      publish: (payload) => this.emitSessionWorkbenchEvent(payload)
    });
    this.runWorkbenchService = new RunWorkbenchService({
      runtime: this.runtime,
      readImage: async (runId, selector) =>
        typeof selector === 'number'
          ? this.runAttachmentService.read(runId, selector)
          : this.runAttachmentService.readNative(runId, selector),
      respondUserInput: (runId, requestId, answers) =>
        this.runnerInteractionService.respondUserInput(runId, requestId, answers),
      pauseQueue: (sessionId) => this.workspaceQueueWorkbenchService.pauseSessionQueue(sessionId),
      runInterrupted: (sessionId) => {
        const goalExit = this.goalCoordinator.clearGoalState(sessionId, 'stopped');
        return goalExit === undefined ? undefined : { goalExit };
      },
      emitRun: (runId, eventType, payload, status) =>
        this.runEventBridge.emitRun(runId, eventType, payload, status),
      control: (operation, payload) =>
        this.controlMessages.handle(JSON.stringify(createEnvelope(operation, payload))),
      markInterrupted: (runId) => this.runState.interruptRequested.add(runId)
    });
    this.sessionQueryService = new SessionQueryService({
      queuedCount: (sessionId) => this.workspaceQueueWorkbenchService.queuedCount(sessionId),
      workspace: (workspaceId) => this.database?.getWorkspace(workspaceId),
      goal: (sessionId) => this.goalRuntime.get(sessionId),
      runtime: this.runtime,
      runners: this.runners,
      resolve: (sessionId, registeredOnly) =>
        this.nativeSessionProjectionService.resolve(sessionId, registeredOnly),
      similar: (sessionId, workspaceId) =>
        this.nativeSessionProjectionService.similarSessionDetails(sessionId, workspaceId),
      present: (session) => this.sessionPresentationService.present(session),
      history: (session, input) => this.conversationHistoryService.read(session, input),
      segments: (session, input) => this.conversationSegmentService.read(session, input),
      context: this.sessionContextService,
      discover: (runner, workspaceId) =>
        this.nativeSessionProjectionService.discover(runner, workspaceId),
      workspaceIdForCwd: (cwd) =>
        this.database?.listWorkspaces().find((candidate) => candidate.path === cwd)?.id
    });
    const resolveExecutionDirectory = async (session: NodeAgentSession): Promise<string> => {
      const workspace = this.database?.getWorkspace(session.workspaceId);
      if (workspace === undefined) throw new Error('WORKSPACE_NOT_FOUND');
      const directory = await resolveWorkspaceExecutionDirectory(workspace.path, session.cwd);
      if (this.database?.getWorkspace(workspace.id)?.path !== workspace.path)
        throw new Error('WORKSPACE_NOT_FOUND');
      return directory;
    };
    this.continuousRunCoordinator = new ContinuousRunCoordinator({
      resolveExecutionDirectory,
      runtime: this.runtime,
      steer: (prepared, item, executionId) => {
        const runner = this.runners.optional(prepared.executionContext.runner);
        if (!runner?.supportsNativeSteer()) return undefined;
        const images = item.attachments.filter(isImageAttachment).map((image) => ({
          name: image.name,
          mimeType: image.mime,
          dataBase64: image.dataBase64
        }));
        return runner
          .steerManagedRun({
            expectedExecutionId: executionId,
            prompt: item.content,
            modelText: prepared.input,
            clientMessageId: item.clientMessageId,
            model: prepared.model,
            effort: prepared.effort,
            access: prepared.access,
            collaborationMode: prepared.collaborationMode,
            images
          })
          .then((result) => {
            if (result.status !== 'accepted') return result;
            const attachments = this.runAttachmentService.append(
              executionId,
              item.attachments.filter(isImageAttachment)
            );
            return {
              ...result,
              item: {
                ...result.item,
                merge: true,
                payload: { ...result.item.payload, ...(attachments.length ? { attachments } : {}) }
              }
            };
          });
      },
      emitQueue: (workspaceId, sessionId) => {
        this.runEventBridge.emitQueue(workspaceId, sessionId);
        this.runAttachmentService.refreshSession(sessionId);
      },
      clearImages: (runId) => this.runAttachmentService.clear(runId),
      cleanupAttachments: (runId) => {
        this.runAttachmentService.cleanup(runId);
        void this.runAttachmentService.discardFiles(runId);
      },
      migrateAssets: (previousId, nextId) => this.runAttachmentService.move(previousId, nextId),
      emitRun: (runId, eventType, payload, status) =>
        this.runEventBridge.emitRun(runId, eventType, payload, status),
      emitConversation: (turn) => this.emitConversationTurn(turn),
      control: (operation, payload) =>
        this.controlMessages.handle(JSON.stringify(createEnvelope(operation, payload))),
      stopped: () => this.stopped,
      markInterrupted: (runId) => this.runState.interruptRequested.add(runId),
      mcps: (workspaceId) => this.database?.effectiveMcpInstallations(workspaceId) ?? [],
      retainEnvironment: (environment) => this.gitExecution().retain(environment),
      goalCurrent: (input) =>
        input.goal === undefined ||
        this.goalCoordinator.goalGenerationCurrent(input.sessionId, input.goal),
      goalActive: (sessionId) => this.goalRuntime.get(sessionId)?.status === 'active',
      afterExecutionStarted: (input) => this.goalCoordinator.maintainGoalContinuation(input, true),
      afterExecutionSteered: (input) => this.goalCoordinator.maintainGoalContinuation(input, false),
      afterExecutionStartFailed: (input, error) => {
        nodeLog('goal.execution-start.failed', {
          sessionId: input.sessionId,
          runId: input.runId,
          goalId: input.goal?.id,
          revision: input.goal?.revision,
          code: safeErrorCode(error, 'GOAL_EXECUTION_START_FAILED')
        });
      },
      revokeExecutionMcps: (executionId) => this.revokeExecutionMcps(executionId),
      goalMcp: async (input) => {
        if (input.goal === undefined) throw new Error('GOAL_NOT_ACTIVE');
        return this.goalMcpBridge.prepare({
          executionId: input.runId,
          sessionId: input.sessionId,
          goalId: input.goal.id,
          revision: input.goal.revision
        });
      },
      scheduleMcp: async (input) => {
        if (this.database === undefined) return undefined;
        const task = new ScheduledSessionStore(this.database.raw).get(input.sessionId);
        const run = this.runtime.getRun(input.runId);
        if (run?.initiatedByUserId === undefined) return undefined;
        return this.scheduleMcpBridge.prepare({
          executionId: input.runId,
          sessionId: input.sessionId,
          workspaceId: input.workspaceId,
          ...(task === undefined ? {} : { taskId: task.id, revision: task.revision }),
          actorUserId: run.initiatedByUserId
        });
      },
      notificationMcp: async (input) => {
        const run = this.runtime.getRun(input.runId);
        if (run?.initiatedByUserId === undefined) return undefined;
        return this.notificationMcpBridge.prepare({
          executionId: input.runId,
          sessionId: input.sessionId,
          workspaceId: input.workspaceId,
          userId: run.initiatedByUserId,
          source: run.source === 'SCHEDULED' ? 'SCHEDULED' : 'MANUAL'
        });
      }
    });
    this.workspaceQueueWorkbenchService = new WorkspaceQueueWorkbenchService({
      runtime: this.runtime,
      resolve: (sessionId, registeredOnly) =>
        this.nativeSessionProjectionService.resolve(sessionId, registeredOnly),
      coordinator: this.continuousRunCoordinator,
      emit: (workspaceId, sessionId) => this.runEventBridge.emitQueue(workspaceId, sessionId),
      prepareInput: (runner, input, collaborationMode) =>
        this.runners.require(runner).prepareMessageInput(input, collaborationMode)
    });
    this.sessionIdentityService = new SessionIdentityService({
      runtime: this.runtime,
      releaseAttachments: (sessionId) => {
        void this.runAttachmentService.releaseSession(sessionId);
      },
      persist: (session, nativeSessionId) => {
        this.database?.saveNativeSessionMetadata({
          ...(session.parentSessionId == null ? {} : { parentSessionId: session.parentSessionId }),
          runner: session.runner,
          externalSessionId: nativeSessionId,
          workspaceId: session.workspaceId,
          ...(session.model === null ? {} : { model: session.model }),
          ...(session.effort === null ? {} : { effort: session.effort }),
          ...(session.access === null ? {} : { access: session.access }),
          ...(session.customTitle === null ? {} : { customTitle: session.customTitle }),
          ...(session.runnerTitle === null
            ? {}
            : { runnerTitle: session.runnerTitle.slice(0, 160) })
        });
      },
      validateCommands: (previousId, nextId) =>
        this.commandStates.validateSessionIdentityPromotion(previousId, nextId),
      migrateCommands: (previousId, nextId) =>
        this.commandStates.promoteSessionIdentity(previousId, nextId),
      migrateAttachments: (previousId, nextId) =>
        this.runAttachmentService.migrateSession(previousId, nextId),
      migrateGoal: (previousId, nextId) => {
        this.goalCoordinator.migrateSession(previousId, nextId);
        this.goalMcpBridge.migrateSession(previousId, nextId);
      },
      migrateQueue: (previousId, nextId) =>
        this.continuousRunCoordinator.migrateSession(previousId, nextId),
      migrateRunnerState: (previousId, nextId) => {
        this.modelUsage.promoteSession(previousId, nextId);
        this.runners.migrateSessionIdentity(previousId, nextId);
      },
      emitSession: (session) => this.emitSessionWorkbenchEvent({ session }),
      emitRun: (run) => this.emitWorkbenchEvent('run', { run }),
      emitQueue: (sessionId) => this.continuousRunCoordinator.publish(sessionId),
      emitTurn: (turn) => this.emitConversationTurn(turn)
    });
    this.sessionLifecycleService = new SessionLifecycleService({
      database: () => {
        if (this.database === undefined) throw new Error('NODE_DATABASE_UNAVAILABLE');
        return this.database;
      },
      runtime: this.runtime,
      runners: this.runners,
      projection: this.nativeSessionProjectionService,
      identity: this.sessionIdentityService,
      present: (session) => this.sessionPresentationService.present(session),
      emitSession: (session) =>
        this.publishWorkbenchEvent('session', {
          session: this.sessionPresentationService.present(session)
        }),
      invalidateWorkspaceSessions: (workspaceId) => {
        void this.workspaceWorkbenchService?.invalidateTopic(workspaceId, 'sessions');
      },
      execute: (operation, data) =>
        this.modelUsage.withGrant(isPlainRecord(data) ? data.__usageGrant : undefined, () =>
          this.executeNodeOperation(operation, data)
        ),
      interceptedSessionId: (clientMessageId) =>
        this.fakeRunner === undefined ? undefined : `fake:${clientMessageId}`
    });
    this.externalSessionResumeService = new ExternalSessionResumeService({
      resolveExecutionDirectory,
      runtime: this.runtime,
      runners: this.runners,
      state: this.sessionState,
      available: (runner) => this.runners.require(runner).available(this.capabilities),
      projectionFor: (session) => this.nativeSessionProjectionService.projectionForNative(session),
      managedAliasFor: (session) => this.nativeSessionProjectionService.managedForNative(session),
      ensureConfiguration: (session) =>
        this.nativeSessionProjectionService.ensureResumedConfiguration(session),
      configuration: (session) => this.nativeSessionProjectionService.resumedConfiguration(session),
      workspacePath: (workspaceId) => this.database?.getWorkspace(workspaceId)?.path,
      rememberNative: (nativeSessionId, sessionId) =>
        this.managedRunnerSessions.remember(nativeSessionId, sessionId),
      resolve: (sessionId) => this.nativeSessionProjectionService.resolve(sessionId)
    });
    this.sessionCommandService = new SessionCommandService({
      runtime: this.runtime,
      runners: this.runners,
      projection: this.nativeSessionProjectionService,
      resolveForCommand: (sessionId) =>
        this.externalSessionResumeService.resolveForMessage(sessionId),
      profiles: () => this.runnerService.profiles(),
      mcps: (workspaceId) => this.database?.effectiveMcpInstallations(workspaceId) ?? [],
      present: (session) => this.sessionPresentationService.present(session),
      resumeQueueAfterCommandRun: (sessionId) =>
        this.workspaceQueueWorkbenchService.resumeAfterCommandRun(sessionId),
      invalidateHistory: (sessionId) => this.nativeSessionWatchService.invalidate(sessionId),
      invalidateWorkspaceSessions: (workspaceId) => {
        this.workspaceSessionService.invalidateCache(workspaceId);
        void this.workspaceWorkbenchService?.invalidateTopic(workspaceId, 'sessions');
      },
      emitSession: (session) =>
        this.emitSessionWorkbenchEvent({
          session: this.sessionPresentationService.present(session)
        }),
      beginGoal: (session) => this.goalCoordinator.begin(session),
      goal: (input) => this.goalCoordinator.start(input),
      clearGoal: (session) => this.goalCoordinator.clear(session)
    });
    this.sessionMessageService = new SessionMessageService({
      resolveExecutionDirectory,
      runtime: this.runtime,
      uploads: this.workspaceUploadService,
      attachments: this.runAttachmentService,
      commands: this.commandStates,
      coordinator: this.continuousRunCoordinator,
      runners: this.runners,
      resolve: (sessionId) => this.externalSessionResumeService.acceptForMessage(sessionId),
      workspacePath: (workspaceId) => this.database?.getWorkspace(workspaceId)?.path,
      present: (session) => this.sessionPresentationService.present(session),
      emitSession: (session) =>
        this.emitSessionWorkbenchEvent({
          session: this.sessionPresentationService.present(session)
        }),
      channelToken: (sessionId) => {
        const session = this.runtime.getAgentSession(sessionId);
        return session?.channelToken ?? undefined;
      },
      goalMessage: (session, content, intent) =>
        this.goalCoordinator.goalMessage(session, content, intent),
      prepareGoalInsertion: (sessionId, submissionId, goal) =>
        this.goalCoordinator.prepareInsertion(sessionId, submissionId, goal),
      goalPreparationFailed: (session, goal, activated) =>
        this.goalCoordinator.handleGoalPreparationFailed(session, goal, activated)
    });
    const inputState = (
      entry: import('./service/planned-restart-handoff.js').RestartSession,
      message: import('./service/planned-restart-handoff.js').RestartMessage
    ) => this.marAgentClient.restartInputState(entry.session.id, message.clientMessageId);
    const restorer = new RestartSessionRestorer({
      runtime: this.runtime,
      goals: this.goalRuntime,
      commands: this.commandStates,
      coordinator: this.continuousRunCoordinator,
      messages: this.sessionMessageService,
      resolve: (id) => this.externalSessionResumeService.resolveForMessage(id),
      authorize: async (request) => {
        const context = await this.restartAuthorization.authorize(request);
        return {
          secretEnvironment: context.secretEnvironment,
          personalInstructions: context.personalInstructions,
          usageGrant: context.usageGrant,
          executionContext: this.runners.require(request.runner).prepareExecutionContext(context)
        };
      },
      inputState,
      withGrant: (context, work) => this.modelUsage.withGrant(context.usageGrant, work),
      publishGoal: (session, goal) => this.goalCoordinator.publishGoalState(session, goal),
      goalReference: (sessionId) => this.goalCoordinator.reference(sessionId),
      publishQueue: (session) => this.continuousRunCoordinator.publish(session.id)
    });
    this.restartHandoff = new PlannedRestartHandoff({
      directory: () => nodeDataDirectory(this.config!, this.configPath),
      identity: () => ({ nodeId: this.config!.nodeId!, serverUrl: this.config!.serverUrl }),
      runtime: this.runtime,
      coordinator: this.continuousRunCoordinator,
      goals: this.goalRuntime,
      commandActive: (id, command) => this.commandStates.get(id, command)?.active === true,
      inputState,
      restore: (entry, id) => restorer.restore(entry, id),
      diagnose: (code, sessionId) => nodeLog('node.restart.diagnostic', { code, sessionId })
    });
    this.sessionCatalogService = new SessionCatalogService({
      resolveExecutionDirectory,
      database: () => {
        if (this.database === undefined) throw new Error('NODE_DATABASE_UNAVAILABLE');
        return this.database;
      },
      nodeId: () => this.config?.nodeId ?? 'recorded-session',
      runtime: this.runtime,
      runners: this.runners,
      runnerAvailable: (runner) => this.runners.require(runner).available(this.capabilities),
      projection: this.nativeSessionProjectionService,
      cachedNative: () => [...this.sessionState.directNative.values()],
      cachedWorkspace: (workspaceId) => this.workspaceCoordinator.cachedSessions(workspaceId),
      discoveryPending: (workspaceId) => this.workspaceSessionService.discoveryPending(workspaceId),
      discoverWorkspace: (workspaceId) =>
        this.nativeSessionProjectionService.discoverWorkspace(workspaceId),
      present: (session) => this.sessionPresentationService.present(session),
      nativeIds: (session) => this.nativeSessionProjectionService.nativeIds(session),
      forget: (session, nativeIds) => {
        this.nativeSessionProjectionService.forget(session, nativeIds);
        this.promptCompletion.invalidateSession(session.workspaceId, session.id);
        void this.runAttachmentService.releaseSession(session.id);
      },
      refreshActivity: (session) =>
        this.conversationHistoryService.refreshExternalActivity(session),
      externalActivity: (sessionId) => this.sessionState.externalActivity.get(sessionId),
      isWatching: (sessionId) => this.nativeSessionWatchService.isWatching(sessionId),
      isRecovering: (sessionId) => this.restartHandoff.blocks(sessionId),
      history: (session, input) => this.conversationHistoryService.read(session, input),
      invalidateHistory: (sessionId, workspaceId) => {
        this.nativeSessionWatchService.invalidate(sessionId);
        this.promptCompletion.invalidateSession(workspaceId, sessionId);
      },
      invalidateWorkspaceSessions: (workspaceId) => {
        this.workspaceSessionService.invalidateCache(workspaceId);
        void this.workspaceWorkbenchService?.invalidateTopic(workspaceId, 'sessions');
      },
      emitSession: (session) =>
        this.emitSessionWorkbenchEvent({
          session: this.sessionPresentationService.present(session)
        })
    });
    this.codexClient.bindControl({
      start: (envelope) => this.codexRunController.start(envelope),
      cancel: (runId, intent) => {
        const run = this.codexClient.execution.runs.get(runId);
        if (run?.turnId === undefined) return false;
        void this.runnerInteractionService.cancelCodexTurn(
          runId,
          run.threadId,
          run.turnId,
          run.cwd,
          intent === 'CANCEL' ? 'CANCELLED' : 'INTERRUPTED'
        );
        return true;
      },
      decideApproval: (input) =>
        this.runnerInteractionService.decideCodexApproval(input.approvalId, input.decision)
    });
    this.claudeClient.bindControl({
      start: (envelope) => this.claudeRunController.start(envelope),
      cancel: (runId, intent) => this.runnerInteractionService.cancelClaudeRun(runId, intent),
      decideApproval: (input) =>
        this.runnerInteractionService.decideClaudeApproval(input.approvalId, input.decision)
    });
    this.openCodeClient.bindControl({
      start: (envelope) => this.openCodeRunController.start(envelope),
      cancel: (runId, intent) => this.openCodeRunController.cancel(runId, intent),
      decideApproval: (input) => this.openCodeRunController.decideApproval(input),
      respondUserInput: (runId, requestId, answers) =>
        this.openCodeRunController.respondUserInput(runId, requestId, answers)
    });
    this.marAgentClient.bindControl({
      steer: (input) => this.marAgentRunController.steer(input),
      decideApproval: (input) => this.marAgentRunController.decideApproval(input),
      start: (envelope) => this.marAgentRunController.start(envelope),
      cancel: (runId, intent) => this.marAgentRunController.cancel(runId, intent),
      respondUserInput: (runId, requestId, answers) =>
        this.marAgentRunController.respondUserInput(runId, requestId, answers)
    });
    this.codexClient.bindCommandControl({
      execute: (session, command, input, context) =>
        this.codexRunController.executeCommand(session, command, input, context)
    });
    this.claudeClient.bindCommandControl({
      execute: (session, command, input, context) =>
        this.claudeRunController.executeCommand(session, command, input, context)
    });
    this.openCodeClient.bindCommandControl({
      execute: (session, command, _input, context) =>
        this.openCodeRunController.executeCommand(session, command, context)
    });
    this.marAgentClient.bindCommandControl({
      execute: (session, command, input, context) =>
        this.marAgentRunController.executeCommand(session, command, input, context)
    });
    const fakeRuns =
      this.fakeRunner === undefined || this.fakeScript === undefined
        ? undefined
        : new FakeManagedRunService({
            runner: this.fakeRunner,
            script: this.fakeScript,
            runners: this.runners,
            runtime: this.runtime,
            state: this.runState,
            emitRun: (runId, type, payload, status) =>
              this.runEventBridge.emitRun(runId, type, payload, status),
            publishApproval: (input) => this.runnerInteractionService.publishApproval(input),
            disconnect: () => this.controlChannel.close(4010, 'FAKE_RUNNER_DISCONNECT')
          });
    this.fakeRunner?.bindControl({
      start: (envelope) => fakeRuns?.start(envelope),
      cancel: (runId, intent) =>
        intent === 'CANCEL'
          ? (this.fakeRunner?.cancel(runId) ?? false)
          : (this.fakeRunner?.interrupt(runId) ?? false),
      decideApproval: (input) =>
        this.fakeRunner?.decide(input.runId, input.approvalId, input.decision) ?? false
    });
    this.runnerUsageReader = options.runnerUsageReader ?? new RunnerUsageReader();
    this.database = options.database;
    this.terminalManager =
      options.terminalManager ??
      new TerminalManager({
        platform:
          this.capabilities.platform === 'windows'
            ? 'win32'
            : this.capabilities.platform === 'macos'
              ? 'darwin'
              : 'linux'
      });
    this.terminalManager.onSummary((summary) => this.workspaceCoordinator.persistTerminal(summary));
    this.terminalChannel = new NodeTerminalChannel({
      config: () => this.config,
      controlConnected: () => this.controlChannel.connected(),
      stopped: () => this.stopped,
      reconnect: this.reconnect,
      reconnectDelay: nextReconnectDelay,
      manager: this.terminalManager
    });
    this.controlChannel = new NodeControlChannel({
      config: () => this.config,
      capabilities: () => this.capabilities,
      stopped: () => this.stopped,
      reconnect: this.reconnect,
      reconnectDelay: nextReconnectDelay,
      onConnecting: (attempt) => {
        this.metrics.connectedAttempt();
        nodeLog('node.connecting', { attempt });
      },
      onReconnectScheduled: () => this.metrics.reconnectScheduled(),
      onMessage: (raw) => this.handleMessage(raw),
      onClose: (code, reason) => {
        this.promptCompletion?.disconnect();
        this.usageOutbox?.disconnected();
        this.directTransferService?.close('DIRECT_TRANSFER_CONTROL_UNAVAILABLE');
        this.runtimeCredentials.disconnected();
        this.chatgptLogins.close();
        this.scheduledRunAuthorization.disconnected();
        this.restartAuthorization.disconnected();
        this.mailNotificationControl.disconnected();
        this.notificationMcpBridge.revokeAll();
        this.terminalChannel.disconnect();
        if (code === 4000 && reason === 'NODE_CONNECTION_REPLACED')
          nodeLog('node.connection.replaced', {
            message:
              'This Node connection was replaced by a newer instance with the same identity. Check for duplicate processes.'
          });
        // Credential revocation ends terminals, but the control channel can still reconnect.
        // Only final Node disposal shuts down the manager and its idle collector.
        if (code === 4003) void this.terminalManager.closeAll();
      }
    });
    this.controlMessages = new NodeControlMessageService({
      config: () => this.config,
      register: async (nodeId, credential, payload) => {
        await this.connectionLifecycle.register(nodeId, credential);
        this.mailNotificationControl.setFeatures(payload);
        this.usageOutbox?.connected(payload);
      },
      usageAck: (payload) => this.usageOutbox?.handle(createEnvelope('usage.ack', payload)),
      bindUsage: (payload) => {
        if (
          !isPlainRecord(payload) ||
          typeof payload.runId !== 'string' ||
          typeof payload.sessionId !== 'string'
        )
          return;
        const runner = this.runtime.getAgentSession(payload.sessionId)?.runner;
        if (runner)
          this.modelUsage.bind(payload.runId, payload.usageGrant, payload.sessionId, runner);
      },
      connected: (payload) => {
        this.usageOutbox?.connected(payload);
        this.connectionLifecycle.connected();
        this.mailNotificationControl.setFeatures(payload);
      },
      close: (code, reason) => this.controlChannel.close(code, reason),
      inspectWorkspace: (envelope) => this.workspaceCoordinator.inspect(envelope),
      handleNodeRequest: (envelope) => this.nodeRequests.handle(envelope),
      handleRuntimeCredentialResponse: (envelope) => this.runtimeCredentials.handle(envelope),
      handleScheduledRunAuthorizeResponse: (envelope) =>
        this.scheduledRunAuthorization.handle(envelope) ||
        this.restartAuthorization.handle(envelope),
      handleMailNotificationResponse: (envelope) => this.mailNotificationControl.handle(envelope),
      handleDirectTransfer: (envelope) => this.handleDirectTransfer(envelope),
      handleTerminalDirect: (envelope) => this.handleTerminalDirect(envelope),
      reconcileRuns: (envelope) => this.runEventBridge.reconcile(envelope),
      runners: this.runners,
      deliverSessionChannelMessage: (envelope) => this.runnerChannelMessages.handle(envelope),
      completeUncontrolledCancellation: (runId) => {
        const run = this.runtime.getRun(runId);
        if (run?.status === 'CANCELLING') this.runnerInteractionService.completeCancelledRun(runId);
      },
      send: (type, payload, replyTo) => this.send(type, payload, replyTo)
    });
    this.nodeRequests = new NodeRequestService({
      nodeId: () => this.config?.nodeId,
      databaseAvailable: () => this.database !== undefined,
      execute: (operation, data) =>
        this.modelUsage.withGrant(isPlainRecord(data) ? data.__usageGrant : undefined, () =>
          this.executeNodeOperation(operation, data)
        ),
      send: (type, payload, replyTo) => this.send(type, payload, replyTo)
    });
    this.workspaceCoordinator = new NodeWorkspaceCoordinator({
      config: () => this.config,
      database: () => this.database,
      watches: this.workspaceWatchService,
      sessions: this.workspaceSessionService,
      changes: this.workspaceChangeService,
      emit: (workspaceId, topic) =>
        void this.workspaceWorkbenchService?.invalidateTopic(workspaceId, topic),
      send: (type, payload, replyTo) => this.send(type, payload, replyTo)
    });
    this.runEventBridge = new NodeRunEventBridge({
      bindModelUsage: (runId) => {
        const run = this.runtime.getRun(runId);
        const session = run ? this.runtime.getAgentSession(run.sessionId) : undefined;
        if (session) this.modelUsage.bindInherited(runId, session.id, session.runner);
      },
      modelUsage: (runId, payload) => this.modelUsage.record(runId, payload),
      runtime: this.runtime,
      state: this.runState,
      events: this.runEventService,
      emitWorkbench: (category, payload) => this.publishWorkbenchEvent(category, payload),
      queues: this.workspaceQueueWorkbenchService,
      send: (type, payload, replyTo) => this.send(type, payload, replyTo)
    });
    this.connectionLifecycle = new NodeConnectionLifecycleService({
      config: () => this.config,
      setConfig: (config) => (this.config = config),
      configPath: this.configPath,
      capabilities: () => this.capabilities,
      detectCapabilities: this.capabilityDetector,
      capabilitiesProvided: this.capabilitiesProvided,
      stopped: () => this.stopped,
      setCapabilities: (capabilities) =>
        (this.capabilities = {
          ...capabilities,
          metadata: upgradeMetadata(capabilities.metadata, this.upgradeCoordinator.snapshot())
        }),
      control: this.controlChannel,
      terminal: this.terminalChannel,
      metrics: this.metrics,
      heartbeatMs: HEARTBEAT_MS,
      refreshMs: CAPABILITY_REFRESH_MS,
      onRegistered: async () => {
        await this.conversationHosting.initialize();
        this.capabilities = await this.conversationHosting.project(this.capabilities);
        this.computerUseEnablement.initialize();
      },
      onConnected: () => {
        this.runtimeCredentials.connected();
        this.scheduledRunAuthorization.connected();
        this.scheduledSessions.connected();
        this.restartAuthorization.connected();
        if (!this.stopped) void this.restartHandoff.recover();
        this.mailNotificationControl.connected();
        this.recentRunProjectionService.publishSnapshot();
      }
    });
    const requireDatabase = () => {
      if (this.database === undefined) throw new Error('NODE_DATABASE_UNAVAILABLE');
      return this.database;
    };
    this.scheduledRunAuthorization = new RunAuthorizationControl((envelope) =>
      this.controlChannel.sendEnvelope(envelope)
    );
    this.restartAuthorization = new RunAuthorizationControl(
      (envelope) => this.controlChannel.sendEnvelope(envelope),
      'restart'
    );
    this.scheduledSessions = new ScheduledSessionCoordinator({
      store: () => new ScheduledSessionStore(requireDatabase().raw),
      busy: (task) =>
        this.stopped ||
        this.restartHandoff.blocks(task.sessionId) ||
        this.runtime.activeSessionRun(task.sessionId) !== undefined ||
        this.runtime.sessionQueue(task.sessionId).itemIds.length > 0,
      authorize: async (task, occurrenceId) => {
        const session =
          this.runtime.getAgentSession(task.sessionId) ??
          (await this.nativeSessionProjectionService.resolveCurrent(task.sessionId));
        if (
          session === undefined ||
          session.workspaceId !== task.workspaceId ||
          session.runner !== task.runner
        )
          throw new Error('SCHEDULE_SESSION_NOT_FOUND');
        const configuredSession =
          this.nativeSessionProjectionService.ensureResumedConfiguration(session);
        const context = await this.scheduledRunAuthorization.authorize({
          taskId: task.id,
          revision: task.revision,
          occurrenceId,
          sessionId: task.sessionId,
          workspaceId: task.workspaceId,
          ownerUserId: task.ownerUserId,
          runner: task.runner,
          model: configuredSession.model
        });
        return {
          secretEnvironment: context.secretEnvironment,
          personalInstructions: context.personalInstructions,
          usageGrant: context.usageGrant,
          executionContext: this.runners.require(task.runner).prepareExecutionContext(context)
        };
      },
      submit: async (task, occurrenceId, context) => {
        const result = (await this.sessionMessageService.submitScheduled({
          sessionId: task.sessionId,
          occurrenceId,
          objective: task.objective,
          initiatedByUserId: task.ownerUserId,
          secretEnvironment: context.secretEnvironment,
          personalInstructions: context.personalInstructions,
          ...(context.usageGrant === undefined ? {} : { usageGrant: context.usageGrant }),
          executionContext: context.executionContext
        })) as { run: { id: string } };
        return { runId: result.run.id };
      },
      sessionTitle: (sessionId) => {
        const session = this.runtime.getAgentSession(sessionId);
        return session?.customTitle ?? session?.runnerTitle ?? sessionId;
      },
      emitNotification: (payload) => this.emitWorkbenchEvent('conversation', payload)
    });
    this.runnerService = new RunnerService(
      requireDatabase,
      () => this.capabilities,
      this.runners,
      this.runnerUsageReader
    );
    this.workbenchManifestService = new WorkbenchManifestService({
      capabilities: () => this.capabilities,
      nodeGeneration: () => this.nodeGeneration,
      runners: this.runnerService,
      terminals: this.terminalManager
    });
    this.terminalService = new TerminalService(
      requireDatabase,
      this.terminalManager,
      (environment) => this.gitExecution().retain(environment)
    );
    this.workspaceService = new WorkspaceService(
      requireDatabase,
      () => {
        if (this.config === undefined) throw new Error('NODE_CONFIG_UNAVAILABLE');
        return this.config;
      },
      this.runtime,
      (workspaceId) => {
        this.terminalManager.removeWorkspaceAssociation(workspaceId);
        this.workspaceFileService.dispose(workspaceId);
        this.workspaceCoordinator.invalidateChanges(workspaceId);
        this.workspaceSessionService.invalidate(workspaceId);
        this.workspaceCoordinator.clearWatches(workspaceId);
        this.workspaceWorkbenchService.clearWorkspace(workspaceId);
        this.promptCompletion?.invalidateWorkspace(workspaceId);
      },
      (workspaceId) => this.workspaceCoordinator.gitPolicyChanged(workspaceId)
    );
    this.workspaceWorkbenchService = new WorkspaceWorkbenchService({
      requireWorkspace: (workspaceId) => this.workspaceCoordinator.require(workspaceId),
      inspectWorkspace: (workspace) => this.workspaceCoordinator.inspectMetadata(workspace),
      commitWorkspace: (workspace, inspection) =>
        this.workspaceCoordinator.commitMetadata(workspace, inspection),
      watch: this.workspaceWatchService,
      files: this.workspaceFileService,
      uploads: this.workspaceUploadService,
      changes: this.workspaceChangeService,
      listSessions: (workspaceId) =>
        this.executeNodeOperation('session.list', { workspaceId, limit: 30 }),
      invalidate: (workspaceId) => {
        this.workspaceFileService.dispose(workspaceId);
        this.workspaceWorkbenchService.invalidateWorkspaceFiles(workspaceId);
        this.workspaceCoordinator.invalidate(workspaceId);
      },
      nodeId: () => this.config?.nodeId ?? 'runtime-node',
      nodeGeneration: () => this.nodeGeneration,
      emitWatchEvent: (payload) => this.send('watch.event', payload)
    });
    const completionWorkspace = new PromptCompletionWorkspaceSource({
      requireWorkspace: (workspaceId) => this.workspaceCoordinator.require(workspaceId),
      observesWorkspace: (workspaceId, actor, connectionId) =>
        this.workspaceWatchService.observes(workspaceId, actor.sessionHash, connectionId),
      observesSession: (workspaceId, sessionId, actor, connectionId) =>
        this.nativeSessionWatchService.observes(
          actor.sessionHash,
          connectionId,
          workspaceId,
          sessionId
        ),
      resolveSession: (sessionId) => this.nativeSessionProjectionService.resolve(sessionId),
      cachedSessions: (workspaceId) =>
        this.workspaceState.sessionCache.get(workspaceId)?.sessions ?? [],
      readHistory: (session, limit) => this.conversationHistoryService.read(session, { limit })
    });
    this.promptCompletion = new PromptCompletionNodeService({
      generation: () => this.nodeGeneration,
      readAttentionFile: (input, _actor, event) => {
        return this.workspaceWorkbenchService.readPredictionFile(
          input.target.workspaceId,
          event.path,
          event.worktreePath
        );
      },
      taskState: (input) => {
        const id = input.sessionId;
        if (!id || !this.runtime.getAgentSession(id)) return { goal: 'UNKNOWN', queue: 'UNKNOWN' };
        const queue = this.runtime.sessionQueue(id);
        const run = this.runtime.activeSessionRun(id) ?? this.runtime.listRunsForSession(id)[0];
        const goal = this.goalRuntime.get(id);
        return {
          ...(run ? { runStatus: run.status } : {}),
          goal: goal
            ? {
                id: goal.id,
                objective: goal.objective,
                status: goal.status,
                revision: goal.revision
              }
            : null,
          queue: {
            version: queue.version,
            paused: queue.paused,
            items: queue.itemIds.flatMap((itemId) => {
              const item = this.runtime.getQueueItem(itemId);
              return item ? [{ queueItemId: item.id, content: item.content }] : [];
            })
          }
        };
      },
      modelFactory: this.marAgentRuntimeModels,
      usage: this.modelUsage,
      observed: (input, actor) => completionWorkspace.observed(input, actor),
      readPage: (input, actor, signal) => completionWorkspace.readPage(input, actor, signal),
      references: (workspaceId, _actor, signal) =>
        completionWorkspace.references(workspaceId, signal)
    });
    this.operationRouter.registerAll(this.promptCompletion.operations());
    for (const operation of CONVERSATION_TEMPLATE_OPERATIONS)
      this.operationRouter.register(operation, (data) => {
        const handler = this.conversationHosting.handler(operation);
        if (handler === undefined) throw new Error('CONVERSATION_HOSTING_UNAVAILABLE');
        return handler(data);
      });
    for (const operation of HOSTED_CONVERSATION_OPERATIONS)
      this.operationRouter.register(operation, (data) => {
        const handler = this.conversationHosting.handler(operation);
        if (handler === undefined) throw new Error('CONVERSATION_HOSTING_UNAVAILABLE');
        return handler(data);
      });
    for (const operation of CONVERSATION_HOSTING_MAINTENANCE_OPERATIONS)
      this.operationRouter.register(operation, (data) => {
        const handler = this.conversationHosting.handler(operation);
        if (handler === undefined) throw new Error('CONVERSATION_HOSTING_UNAVAILABLE');
        return handler(data);
      });
    this.operationRouter.registerAll(this.runnerService.operations());
    this.operationRouter.registerAll(this.terminalService.operations());
    this.operationRouter.registerAll(this.workspaceService.operations());
    this.operationRouter.registerAll(this.workspaceWorkbenchService.operations());
    this.operationRouter.registerAll(this.runWorkbenchService.operations());
    this.operationRouter.registerAll(this.nativeSessionWatchService.operations());
    this.operationRouter.registerAll(this.sessionQueryService.operations());
    this.operationRouter.registerAll(this.sessionLifecycleService.operations());
    this.sessionScheduleService = new SessionScheduleService({
      database: requireDatabase,
      runtime: this.runtime,
      projection: this.nativeSessionProjectionService,
      awaitNativeSessionId: (sessionId) => {
        const nativeId = this.runtime.getAgentSession(sessionId)?.externalSessionId;
        return nativeId === null || nativeId === undefined
          ? this.sessionIdentityService.wait(sessionId)
          : Promise.resolve(nativeId);
      },
      present: (session) => this.sessionPresentationService.present(session),
      emitSession: (session) =>
        this.emitSessionWorkbenchEvent({
          session: this.sessionPresentationService.present(session)
        }),
      changed: () => this.scheduledSessions.changed(),
      proposed: (sessionId, proposalId) =>
        this.scheduledSessions.proposalCreated(sessionId, proposalId)
    });
    this.operationRouter.registerAll(this.sessionScheduleService.operations());
    this.operationRouter.registerAll(this.sessionMessageService.operations());
    this.operationRouter.registerAll(this.sessionCatalogService.operations());
    this.operationRouter.registerAll(this.sessionCommandService.operations());
    this.operationRouter.registerAll(this.workspaceQueueWorkbenchService.operations());
    this.operationRouter.registerAll(this.marAgentModelTransportTests.operations());
    this.operationRouter.registerAll(this.chatgptLogins.operations());
    this.operationRouter.registerAll(
      new ConversationHostingEnablementService({
        config: () => this.config,
        setConfig: (config) => (this.config = config),
        configPath: this.configPath,
        platform: () => this.capabilities.platform,
        capability: () => this.capabilities.conversationHosting,
        initialize: async () => {
          await this.conversationHosting.initialize();
          this.capabilities = await this.conversationHosting.project(this.capabilities);
        },
        prepareForDisable: () => this.conversationHosting.prepareForDisable(),
        publishCapabilities: () => this.send('capabilities', this.capabilities)
      }).operations()
    );
    this.operationRouter.registerAll(this.computerUseEnablement.operations());
    this.operationRouter.registerAll(
      new SkillNodeOperationService(requireDatabase, () => {
        if (this.config === undefined) throw new Error('NODE_CONFIG_UNAVAILABLE');
        return this.config;
      }).operations()
    );
    this.operationRouter.registerAll(new McpNodeOperationService(requireDatabase).operations());
    this.operationRouter.register('node.metrics', () => ({
      metrics: {
        ...this.metrics.snapshot(),
        activeRuns: this.runState.active.size,
        workspaceLeases: this.runtime.activeWorkspaceLeaseCount()
      }
    }));
    this.operationRouter.register('node.upgrade.request', (data) =>
      this.upgradeCoordinator.request(data)
    );
    this.operationRouter.register('node.upgrade.cancel', () => this.upgradeCoordinator.cancel());
    this.operationRouter.register('node.workbench.capabilities', async () => ({
      manifest: await this.workbenchManifestService.read(),
      binaryTerminal: true
    }));
  }

  private projectComputerUseCapability(capabilities: NodeCapabilities): NodeCapabilities {
    return {
      ...capabilities,
      computerUse: this.computerUseEnablement.capability()
    };
  }

  async start(): Promise<void> {
    if (this.stopping !== undefined) await this.stopping;
    this.stopping = undefined;
    this.stopped = false;
    this.continuousRunCoordinator.resumeScheduling();
    this.sessionMessageService.setAccepting(true);
    this.config ??= await loadNodeConfig(this.configPath);
    this.promptCompletion.initializeJournal(nodeDataDirectory(this.config, this.configPath));
    await this.upgradeCoordinator.loadResult(
      resolve(dirname(nodeDatabasePath(this.config, this.configPath)), 'upgrade-result.json')
    );
    await assertLocalSqlitePath(nodeDatabasePath(this.config, this.configPath));
    this.database ??= new NodeDatabase(
      nodeDatabasePath(this.config, this.configPath),
      () => this.config?.nodeId ?? 'unregistered'
    );
    this.usageOutbox?.disconnected();
    this.usageOutbox = new ModelUsageOutbox({
      database: () => this.database?.raw,
      namespace: () =>
        this.config?.nodeId
          ? JSON.stringify([this.config.serverUrl, this.config.nodeId])
          : undefined,
      send: (type, payload) => this.send(type, payload),
      diagnose: (code) => nodeLog('model.usage.diagnostic', { code })
    });
    this.usageOutbox.recoverInterrupted();
    this.database.closeRunningTerminalSessions();
    await this.restartHandoff.load();
    this.scheduledSessions.recoverInterrupted();
    this.scheduledSessions.start();
    await this.conversationHosting.initialize();
    this.capabilities = await this.conversationHosting.project(this.capabilities);
    this.computerUseEnablement.initialize();
    this.directTransferService ??= await this.createDirectTransferService();
    this.connectionLifecycle.start();
    this.controlChannel.connect();
  }

  private async createDirectTransferService(): Promise<DirectTransferService | undefined> {
    try {
      return await DirectTransferService.create({
        nodeGeneration: () => this.nodeGeneration,
        send: (type, payload) => this.send(type, payload),
        terminalManager: this.terminalManager,
        sendTerminalReady: (directSessionId, phase) =>
          this.send('terminal.direct.ready', { directSessionId, ...(phase ? { phase } : {}) }),
        udpPortRange: () => directTransferUdpPortRange(this.config),
        openUpload: async (descriptor) => {
          if (descriptor.direction !== 'UPLOAD' || descriptor.resource.kind !== 'WORKSPACE_FILE')
            throw new Error('DIRECT_RESOURCE_UNSUPPORTED');
          const workspace = this.workspaceCoordinator.require(descriptor.resource.workspaceId);
          const upload = await this.workspaceUploadService.createDirect(workspace, {
            path: descriptor.resource.path,
            size: descriptor.size,
            sha256: descriptor.sha256,
            overwrite: descriptor.overwrite === true,
            ...(descriptor.composerAttachment === undefined
              ? {}
              : { composerAttachment: descriptor.composerAttachment })
          });
          return {
            offset: upload.receivedBytes,
            write: (bytes) => this.workspaceUploadService.writeDirect(upload.uploadId, bytes),
            complete: (size, signal) =>
              this.workspaceUploadService.completeDirect(upload.uploadId, size, signal),
            cancel: () => this.workspaceUploadService.cancel(upload.uploadId)
          };
        },
        openDownload: async (descriptor) => {
          if (this.workspaceWorkbenchService === undefined)
            throw new Error('DIRECT_RESOURCE_UNAVAILABLE');
          return this.workspaceWorkbenchService.directDownload(descriptor);
        }
      });
    } catch (error: unknown) {
      if (!(error instanceof Error) || error.message !== 'DIRECT_UDP_PORT_UNAVAILABLE') throw error;
      const range = directTransferUdpPortRange(this.config);
      nodeLog('direct-transfer.udp-unavailable', {
        portRangeBegin: range.begin,
        portRangeEnd: range.end
      });
      return undefined;
    }
  }

  private handleDirectTransfer(envelope: NodeEnvelope): boolean {
    const command = {
      type: envelope.type,
      ...(typeof envelope.payload === 'object' && envelope.payload !== null ? envelope.payload : {})
    };
    if (this.directTransferService !== undefined) return this.directTransferService.handle(command);
    const parsed = directNodeCommandSchema.safeParse(command);
    if (!parsed.success) return false;
    this.send('direct.error', {
      type: 'direct.error',
      directSessionId: parsed.data.directSessionId,
      code: 'DIRECT_UDP_PORT_UNAVAILABLE',
      message: 'The configured direct-transfer UDP port range is unavailable.'
    });
    return true;
  }

  private handleTerminalDirect(envelope: NodeEnvelope): boolean {
    const command = {
      type: envelope.type,
      ...(typeof envelope.payload === 'object' && envelope.payload !== null ? envelope.payload : {})
    };
    return this.directTransferService?.handleTerminal(command) ?? false;
  }

  stop(options: { readonly handoff?: boolean } = {}): Promise<void> {
    if (this.stopping !== undefined) return this.stopping;
    this.stopped = true;
    this.continuousRunCoordinator.suspend();
    this.goalCoordinator.freeze();
    this.scheduledSessions.stop();
    this.stopping = (async () => {
      let snapshot: ReturnType<PlannedRestartHandoff['capture']> | undefined;
      try {
        // In-flight recovery must rebuild accepted inputs before preparation closes.
        await this.restartHandoff.wait();
        this.sessionMessageService.setAccepting(false);
        await Promise.allSettled([...this.inFlightOperations]);
        await this.sessionMessageService.drain();
        if (options.handoff && this.config?.nodeId) snapshot = this.restartHandoff.capture();
      } finally {
        await this.disposeRuntime();
      }
      if (snapshot !== undefined) await this.restartHandoff.publish(snapshot);
    })();
    return this.stopping;
  }

  private disposeRuntime(): Promise<void> {
    this.recentRunProjectionService.dispose();
    this.upgradeCoordinator.stop();
    this.connectionLifecycle.stop();
    this.nativeSessionWatchService.clear();
    this.promptCompletion.dispose();
    this.sessionIdentityService.dispose();
    this.sessionLifecycleService.clear();
    this.continuousRunCoordinator.clear();
    this.gitOperationService.clear();
    this.goalCoordinator.dispose();
    this.runEventService.clear();
    this.sessionContextService.dispose();
    this.runAttachmentService.dispose();
    const marAgentDrain = this.marAgentRunController.dispose();
    const conversationHostingDrain = this.conversationHosting.dispose();
    const uploadDrain = this.workspaceUploadService.shutdown();
    this.workspaceFileService.dispose();
    this.workspaceWatchService.clearAll();
    this.workspaceWorkbenchService.clear();
    this.workspaceSessionService.clear();
    this.workspaceChangeService.clear();
    const runnerDrain = this.runners.stop();
    const goalMcpDrain = this.goalMcpBridge.close();
    const scheduleMcpDrain = this.scheduleMcpBridge.close();
    // close() transitions metadata before awaiting process-tree termination,
    // so the lifecycle is persisted before this synchronous shutdown returns.
    const terminalDrain = this.terminalManager.shutdown();
    this.terminalChannel.stop();
    this.runtimeCredentials.close();
    this.chatgptLogins.close();
    const scheduledDrain = this.scheduledSessions.stop();
    this.scheduledRunAuthorization.close();
    this.restartAuthorization.close();
    this.mailNotificationControl.close();
    const notificationMcpDrain = this.notificationMcpBridge.close();
    const webToolDrain = this.webToolService.close();
    this.directTransferService?.dispose();
    this.directTransferService = undefined;
    this.controlChannel.stop();
    const database = this.database;
    const drains = Promise.allSettled([
      scheduledDrain,
      marAgentDrain,
      runnerDrain,
      terminalDrain,
      uploadDrain,
      goalMcpDrain,
      scheduleMcpDrain,
      notificationMcpDrain,
      webToolDrain
    ]);
    return (async () => {
      let failed: PromiseRejectedResult | undefined;
      try {
        await conversationHostingDrain;
      } finally {
        const results = await drains;
        this.database = undefined;
        await this.gitExecutionService?.close();
        this.usageOutbox?.disconnected();
        this.usageOutbox = undefined;
        this.modelUsage.clear();
        database?.close();
        failed = results.find((result) => result.status === 'rejected');
      }
      if (failed !== undefined) throw failed.reason;
    })();
  }

  /** @internal Thin compatibility delegates; all behavior remains in the extracted services. */
  private readonly handleMessage = (raw: string): void => this.controlMessages.handle(raw);
  private readonly emitRunEvent = (
    runId: string,
    eventType: string,
    payload: unknown,
    status?: FakeRunnerStatus
  ): void => this.runEventBridge.emitRun(runId, eventType, payload, status);
  private readonly emitConversationItem = (runId: string, item: unknown): void => {
    this.goalCoordinator.executionProgress(runId, item);
    this.runEventBridge.emitConversationItem(runId, item);
  };
  private readonly emitConversationTurn = (turn: unknown): void => {
    this.emitWorkbenchEvent('conversation', { turn });
  };
  private readonly publishWorkbenchEvent = (
    category: WorkbenchEventCategory,
    payload: unknown
  ): void => {
    if (category === 'session') {
      this.emitSessionWorkbenchEvent(payload);
      return;
    }
    this.emitWorkbenchEvent(category, payload);
  };
  private readonly emitSessionWorkbenchEvent = (payload: unknown): void => {
    if (isPlainRecord(payload) && isPlainRecord(payload.session)) {
      const workspaceId = payload.session.workspaceId;
      if (typeof workspaceId === 'string') {
        this.workspaceSessionService.markCacheStale(workspaceId);
        void this.workspaceWorkbenchService?.invalidateTopic(workspaceId, 'sessions');
      }
    }
    this.emitWorkbenchEvent('session', payload);
  };
  private readonly emitWorkbenchEvent = (
    category: WorkbenchEventCategory,
    payload: unknown
  ): void => this.workbenchEventService.dispatch(category, payload);
  private readonly discoverWorkspaceSessions = (
    workspaceId: string,
    onRunnerDiscovered?: (
      runner: NodeAgentSession['runner'],
      sessions: readonly NodeAgentSession[]
    ) => void
  ): Promise<readonly NodeAgentSession[]> =>
    this.nativeSessionProjectionService.discoverWorkspace(workspaceId, onRunnerDiscovered);
  private readonly invalidateWorkspaceWatchTopics = (workspaceId: string): void =>
    this.workspaceCoordinator.invalidate(workspaceId);
  private readonly reconcilePersistedRuns = (): void => undefined;
  private readonly startCapabilityRefresh = (): void =>
    this.connectionLifecycle.startCapabilityRefresh();
  private readonly refreshCapabilities = (): Promise<void> =>
    this.connectionLifecycle.refreshCapabilities();

  private async executeNodeOperation(operation: string, data: unknown): Promise<unknown> {
    if (this.stopped) throw new Error('NODE_STOPPED');
    const input = isPlainRecord(data) ? data : {};
    const sessionId = typeof input.sessionId === 'string' ? input.sessionId : undefined;
    if (this.restartHandoff.blocksOperation(operation, input))
      throw new Error('SESSION_RESTART_PENDING');
    if (this.database === undefined) throw new Error('NODE_DATABASE_UNAVAILABLE');
    if (this.upgradeCoordinator.blocks(operation)) throw new Error('NODE_UPGRADE_PENDING');
    nodeLog('node.operation', { nodeId: this.config?.nodeId, operation });
    const task = this.gitOperationService.execute(operation, data, (input) =>
      this.operationRouter.execute(operation, input)
    );
    this.inFlightOperations.add(task);
    try {
      const result = await task;
      if (
        (operation === 'session.command.execute' || operation === 'session.message') &&
        sessionId !== undefined &&
        Number.isSafeInteger(input.__requestUserId)
      )
        this.restartHandoff.rememberUser(sessionId, input.__requestUserId as number);
      return result;
    } finally {
      this.inFlightOperations.delete(task);
    }
  }

  private gitExecution(): GitExecutionService {
    this.gitExecutionService ??= new GitExecutionService({
      ...(this.config === undefined
        ? {}
        : { directory: resolve(nodeDataDirectory(this.config, this.configPath), 'git-runtime') })
    });
    return this.gitExecutionService;
  }

  private send(type: string, payload: unknown, replyTo?: string): void {
    this.controlChannel.send(type, payload, replyTo);
  }

  private sendEnvelope(envelope: NodeEnvelope): void {
    this.controlChannel.sendEnvelope(envelope);
  }
}
