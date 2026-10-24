import type { ResolvedMcpServer } from '../mcp/model.js';
import { resolveMcpServers } from '../mcp/configuration.js';
import type {
  NodeCapabilities,
  RunnerDefaultConfiguration,
  RunnerCommandDescriptor,
  NodeEnvelope,
  RunnerName,
  RunnerProfile,
  RunnerCommandState,
  SessionActivityState
} from '@myagentroam/protocol';
import type { NodeAgentSession, NodeDatabase, NodeWorkspace } from '../database.js';
import type { NodeConversationTurn } from '../runtime-model.js';
import type { ChannelDelivery } from '../claude-channel.js';
import type { CodexSessionControl } from '../codex-app-server.js';
import type { ExternalSessionActivationState } from '../service/session-domain-state.js';
import type { NativeTranscriptImageAttachment } from '../native-session-history.js';
import type { RunnerExecutionContext } from './execution-context.js';

export type RegisteredRunnerName = RunnerName | 'fake';
export interface RunnerSteerInput {
  readonly expectedExecutionId: string;
  readonly prompt: string;
  readonly modelText: string;
  readonly clientMessageId: string;
  readonly model: string | null;
  readonly effort: string | null;
  readonly access: string | null;
  readonly collaborationMode: 'default' | 'plan';
  readonly images: readonly {
    readonly name: string;
    readonly mimeType: string;
    readonly dataBase64: string;
  }[];
}
export type RunnerSteerResult =
  | {
      readonly status: 'accepted';
      readonly item: {
        readonly itemId: string;
        readonly kind: 'user_message';
        readonly status: 'COMPLETED';
        readonly payload: Record<string, unknown>;
      };
    }
  | { readonly status: 'handled' | 'notAccepted' };

export interface RunnerCommandContext {
  readonly secretEnvironment: Readonly<Record<string, string>>;
  readonly mcpInstallations?: unknown;
  readonly executionContext?: RunnerExecutionContext;
  readonly initiatedByUserId?: number;
}
export type NativeSessionRemovalResult = boolean | 'MISSING';
export type RunnerHistoryImageRegistrar = (
  images: readonly NativeTranscriptImageAttachment[]
) => readonly Record<string, unknown>[];

/**
 * Stable lifecycle boundary for every Node Runner implementation.
 *
 * Vendor clients and payload decoders stay behind subclasses. Domain services
 * depend on this boundary (or a capability interface implemented by it), never
 * on an SDK/App Server client directly.
 */
export abstract class AbstractRunner<TName extends RegisteredRunnerName = RegisteredRunnerName> {
  private control: RunnerControl | undefined;
  private commandControl: RunnerCommandControl | undefined;
  abstract readonly name: TName;

  /** Test-only runners are registered explicitly but never advertised. */
  readonly advertised: boolean = true;
  readonly interceptsRuns: boolean = false;
  abstract readonly discoveryScope: 'ALL_WORKSPACES' | 'WORKSPACE_REQUIRED';

  abstract profile(capabilities: NodeCapabilities): RunnerProfile | undefined;

  cachedProfile(
    capabilities: NodeCapabilities,
    environment: Readonly<Record<string, string>> = {}
  ): RunnerProfile | undefined {
    void environment;
    return this.profile(capabilities);
  }

  async refreshProfile(
    capabilities: NodeCapabilities,
    workspace?: NodeWorkspace,
    environment: Readonly<Record<string, string>> = {},
    waitForRefresh = false
  ): Promise<RunnerProfile | undefined> {
    void [workspace, environment, waitForRefresh];
    return this.profile(capabilities);
  }

  abstract available(capabilities: NodeCapabilities): boolean;

  abstract defaultConfiguration(
    workspace?: NodeWorkspace,
    environment?: Readonly<Record<string, string>>
  ): RunnerDefaultConfiguration;

  goalAccess(currentAccess: string | null): {
    readonly access: string;
    readonly accessChanged: boolean;
  } {
    return { access: 'auto', accessChanged: currentAccess !== 'auto' };
  }

  /** Restore persisted values only; never normalize fresh configuration input. */
  restoreStoredAccess(access: string | null, fallbackAccess: string): string {
    return access !== null && access.trim().length > 0 ? access : fallbackAccess;
  }

  supportsConfiguration(
    configuration: RunnerDefaultConfiguration,
    workspace?: NodeWorkspace,
    environment?: Readonly<Record<string, string>>
  ): boolean {
    void [workspace, environment];
    const profile = this.profileForValidation();
    const model = profile.models.find((candidate) => candidate.id === configuration.model);
    return (
      configuration.runner === this.name &&
      model !== undefined &&
      model.supportedEfforts.includes(configuration.effort) &&
      profile.accessOptions.some((candidate) => candidate.id === configuration.access)
    );
  }

  protected abstract profileForValidation(): RunnerProfile;

  abstract resumeExternal(
    session: NodeAgentSession,
    context: ExternalResumeContext
  ): Promise<ExternalResumeResult>;

  abstract discoverSessions(
    context: RunnerDiscoveryContext,
    workspace?: NodeWorkspace
  ): Promise<readonly NodeAgentSession[]>;

  abstract readContextUsage(session: NodeAgentSession): Promise<RunnerContextUsage | undefined>;

  presentSession(
    session: NodeAgentSession,
    capabilities: NodeCapabilities,
    context: RunnerSessionPresentationContext
  ): RunnerSessionPresentation {
    void [session, capabilities, context];
    throw new RunnerCapabilityError(this.name, 'session.presentation');
  }

  prepareMessageInput(input: string, collaborationMode: 'default' | 'plan'): string {
    void collaborationMode;
    return input;
  }

  mcpConfiguration(
    rawInstallations: unknown,
    secretEnvironment: Readonly<Record<string, string>>,
    executionServers: readonly ResolvedMcpServer[] = []
  ): unknown {
    return resolveMcpServers(rawInstallations, secretEnvironment, executionServers);
  }

  channelToken(sessionId: string): string | undefined {
    void sessionId;
    return undefined;
  }

  deliverChannel(
    sessionId: string,
    messageId: string,
    senderId: string,
    token: string,
    content: string,
    notify: (runId: string, messageId: string, delivery: ChannelDelivery) => void
  ): ChannelDelivery {
    void [sessionId, messageId, senderId, token, content, notify];
    return 'REJECTED';
  }

  executeGlobalCommand(commandId: string, input: string): unknown {
    void [commandId, input];
    throw new RunnerCapabilityError(this.name, 'global-command');
  }

  serviceTier(): 'fast' | undefined {
    return undefined;
  }

  usesRunnerTitleForRename(): boolean {
    return false;
  }

  async renameNative(
    session: NodeAgentSession,
    input: { readonly title?: string | null; readonly pinned?: boolean },
    database: NodeDatabase
  ): Promise<void> {
    if (session.externalSessionId === null) return;
    database.saveNativeSessionMetadata({
      runner: session.runner,
      externalSessionId: session.externalSessionId,
      workspaceId: session.workspaceId,
      ...(input.title === undefined ? {} : { customTitle: input.title }),
      ...(input.pinned === undefined ? {} : { pinned: input.pinned })
    });
  }

  async isNativeSessionMissing(session: NodeAgentSession): Promise<boolean> {
    void session;
    return false;
  }

  async removeNative(
    session: NodeAgentSession,
    nativeSessionId: string
  ): Promise<NativeSessionRemovalResult> {
    void [session, nativeSessionId];
    return false;
  }

  async forkNative(
    session: NodeAgentSession,
    boundary: string | null,
    title: string
  ): Promise<string | null> {
    void [session, boundary, title];
    throw new RunnerCapabilityError(this.name, 'session.rewind');
  }

  supportsRollback(session: NodeAgentSession): boolean {
    void session;
    return false;
  }

  async rollbackNative(
    session: NodeAgentSession,
    boundary: string | null,
    targetTurnBoundary?: string
  ): Promise<number> {
    void [session, boundary, targetTurnBoundary];
    throw new RunnerCapabilityError(this.name, 'session.rollback');
  }

  async clearNative(session: NodeAgentSession): Promise<number> {
    void session;
    throw new RunnerCapabilityError(this.name, 'session.clear');
  }

  projectedRunnerTitle(
    metadata: ReturnType<NodeDatabase['getNativeSessionMetadata']>,
    input: RunnerProjectionTitleInput,
    database: NodeDatabase | undefined
  ): string | null {
    void database;
    return input.title ?? metadata?.runnerTitle ?? null;
  }

  managedAliasId(nativeSessionId: string): string | undefined {
    void nativeSessionId;
    return undefined;
  }

  nativeAliasesFor(managedSessionId: string): readonly string[] {
    void managedSessionId;
    return [];
  }

  forgetNativeAlias(nativeSessionId: string): void {
    void nativeSessionId;
  }

  rememberManagedNative(session: NodeAgentSession, nativeSessionId: string): void {
    void [session, nativeSessionId];
  }

  async readManagedRunnerTitle(
    session: NodeAgentSession,
    nativeSessionId: string
  ): Promise<string | undefined> {
    void [session, nativeSessionId];
    return undefined;
  }

  async readOfficialConversation(
    session: NodeAgentSession,
    input: { readonly cursor?: string; readonly limit?: number },
    managedTurn: (nativeTurnId: string) => NodeConversationTurn | undefined,
    registerImages?: RunnerHistoryImageRegistrar
  ): Promise<RunnerConversationPage | undefined> {
    void [session, input, managedTurn, registerImages];
    return undefined;
  }

  async readConversationHistory(
    readers: RunnerConversationHistoryReaders
  ): Promise<RunnerConversationHistoryPage | undefined> {
    const page = await readers.native();
    return page === undefined ? undefined : { ...page, source: 'native' };
  }

  async readConversationRewind(
    input: RunnerConversationRewindInput
  ): Promise<ReadonlyMap<NodeConversationTurn['id'], NonNullable<NodeConversationTurn['rewind']>>> {
    void input;
    return new Map();
  }

  async readExternalActivity(
    session: NodeAgentSession
  ): Promise<ExternalSessionActivationState | undefined> {
    void session;
    return undefined;
  }

  async readToolResultResource(
    session: NodeAgentSession,
    input: import('@myagentroam/protocol').ToolResultResourceInput
  ): Promise<import('@myagentroam/protocol').ToolResultResourcePage> {
    void [session, input];
    throw new Error('TOOL_RESOURCE_UNSUPPORTED');
  }

  acceptsTruncatedNativeHistory(): boolean {
    return true;
  }

  nativeImageRoots(session: NodeAgentSession): readonly string[] {
    void session;
    return [];
  }

  managedRunForNativeTurn(nativeTurnId: string): string | undefined {
    void nativeTurnId;
    return undefined;
  }

  abstract stop(): void | Promise<void>;

  /** Synchronously migrate Runner-owned state without I/O or event publication. */
  migrateSessionIdentity(previousId: string, nativeSessionId: string): void {
    void previousId;
    void nativeSessionId;
  }

  bindControl(control: RunnerControl): void {
    if (this.control !== undefined) throw new Error(`RUNNER_CONTROL_ALREADY_BOUND:${this.name}`);
    this.control = control;
  }

  acceptsRun(runner: unknown): boolean {
    return this.interceptsRuns || runner === this.name;
  }

  prepareExecutionContext(input: Readonly<Record<string, unknown>>): RunnerExecutionContext {
    void input;
    return { runner: this.name };
  }

  startManagedRun(envelope: NodeEnvelope): void {
    if (this.control === undefined) throw new Error(`RUNNER_CONTROL_NOT_BOUND:${this.name}`);
    this.control.start(envelope);
  }

  cancelManagedRun(runId: string, intent: RunnerCancellationIntent): boolean {
    return this.control?.cancel(runId, intent) === true;
  }
  supportsNativeSteer(): boolean {
    return this.control?.steer !== undefined;
  }
  steerManagedRun(input: RunnerSteerInput): Promise<RunnerSteerResult> {
    return this.control?.steer?.(input) ?? Promise.resolve({ status: 'notAccepted' });
  }

  decideApproval(input: RunnerApprovalDecision): boolean {
    return this.control?.decideApproval?.(input) === true;
  }

  respondUserInput(runId: string, requestId: string, answers: Record<string, unknown>): boolean {
    return this.control?.respondUserInput?.(runId, requestId, answers) === true;
  }

  bindCommandControl(control: RunnerCommandControl): void {
    if (this.commandControl !== undefined)
      throw new Error(`RUNNER_COMMAND_CONTROL_ALREADY_BOUND:${this.name}`);
    this.commandControl = control;
  }

  executeCommand(
    session: NodeAgentSession,
    command: RunnerCommandDescriptor,
    input: string,
    context: RunnerCommandContext
  ): Promise<unknown> {
    if (this.commandControl === undefined)
      return Promise.reject(new Error('RUNNER_COMMAND_UNAVAILABLE'));
    return this.commandControl.execute(session, command, input, context);
  }
}

export type RunnerCancellationIntent = 'CANCEL' | 'INTERRUPT';

export interface RunnerControl {
  steer?(input: RunnerSteerInput): Promise<RunnerSteerResult>;
  start(envelope: NodeEnvelope): void;
  cancel(runId: string, intent: RunnerCancellationIntent): boolean;
  decideApproval?(input: RunnerApprovalDecision): boolean;
  respondUserInput?(runId: string, requestId: string, answers: Record<string, unknown>): boolean;
}

export interface RunnerCommandControl {
  execute(
    session: NodeAgentSession,
    command: RunnerCommandDescriptor,
    input: string,
    context: RunnerCommandContext
  ): Promise<unknown>;
}

export interface RunnerApprovalDecision {
  readonly runId: string;
  readonly approvalId: string;
  readonly decision: 'APPROVED' | 'REJECTED';
}

export interface RunnerDiscoveryContext {
  readonly workspaces: readonly NodeWorkspace[];
  createProjection(input: {
    readonly workspace: NodeWorkspace;
    readonly runner: RunnerName;
    readonly externalSessionId: string;
    readonly cwd: string;
    readonly title?: string;
    readonly titleOrigin?: 'OFFICIAL' | 'PREVIEW' | 'NATIVE';
    readonly lastActivityAt?: number;
  }): NodeAgentSession;
}

export interface ExternalResumeContext {
  readonly available: boolean;
  projectionFor(session: NodeAgentSession): NodeAgentSession | undefined;
  managedAliasFor(session: NodeAgentSession): NodeAgentSession | undefined;
  currentResumed(sessionId: string): NodeAgentSession | undefined;
  promote(sessionId: string): NodeAgentSession | undefined;
  ensureConfiguration(session: NodeAgentSession): NodeAgentSession;
  create(session: NodeAgentSession): NodeAgentSession;
  workspacePath(workspaceId: string): string | undefined;
  rememberManagedNative(nativeSessionId: string, sessionId: string): void;
}

export interface ExternalResumeResult {
  readonly session?: NodeAgentSession;
  readonly activity?: ExternalSessionActivationState;
  readonly failureCode?: string;
  readonly failureDetail?: string;
  readonly messageFailureCode?: string;
}

export interface RunnerContextUsage {
  readonly model?: string | null;
  readonly usedTokens: number;
  readonly maxTokens: number;
}

export interface RunnerProjectionTitleInput {
  readonly externalSessionId: string;
  readonly workspaceId: string;
  readonly title?: string;
  readonly titleOrigin?: 'OFFICIAL' | 'PREVIEW' | 'NATIVE';
}

export interface RunnerConversationPage {
  readonly turns: readonly NodeConversationTurn[];
  readonly nextCursor: string | null;
}

export type RunnerConversationHistorySource = 'native' | 'official';

export interface RunnerConversationHistoryReaders {
  readonly session?: NodeAgentSession;
  readonly native: () => Promise<RunnerConversationPage | undefined>;
  readonly official: () => Promise<RunnerConversationPage | undefined>;
}

export interface RunnerConversationHistoryPage extends RunnerConversationPage {
  readonly source: RunnerConversationHistorySource;
}

export interface RunnerConversationRewindInput {
  readonly session: Readonly<NodeAgentSession>;
  readonly turns: readonly NodeConversationTurn[];
  readonly managedActive: boolean;
  readonly firstPage: boolean;
  readonly readHistory: (input: {
    readonly limit: number;
  }) => Promise<RunnerConversationHistoryPage | undefined>;
}

export interface RunnerSessionPresentationContext {
  readonly managedActive: boolean;
  readonly commandStates: readonly RunnerCommandState[];
}

export interface RunnerSessionPresentation {
  readonly activity: SessionActivityState;
  readonly control: {
    readonly level: CodexSessionControl['level'];
    readonly capabilities: CodexSessionControl['capabilities'];
  };
  readonly runtime: {
    readonly level: CodexSessionControl['level'];
    readonly capabilities: readonly string[];
    readonly reasonCode: string | null;
  };
  readonly commandStates: readonly RunnerCommandState[];
}

export class RunnerCapabilityError extends Error {
  constructor(
    readonly runner: RegisteredRunnerName,
    readonly capability: string
  ) {
    super('RUNNER_CAPABILITY_UNSUPPORTED');
  }
}
