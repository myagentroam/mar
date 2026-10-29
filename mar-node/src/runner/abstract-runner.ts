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
import type {
  ExternalSessionActivationState,
  NativeSessionMetadata,
  NodeAgentSession
} from '../session/contracts.js';
import type { NodeWorkspace } from '../workspace/contracts.js';
import type { NodeConversationTurn } from '../runtime-model.js';
import type { RunnerExecutionContext } from './execution-context.js';

import type {
  RegisteredRunnerName,
  RunnerSteerInput,
  RunnerSteerResult,
  RunnerCommandContext,
  NativeSessionRemovalResult,
  RunnerHistoryImageRegistrar,
  RunnerCancellationIntent,
  RunnerControl,
  RunnerCommandControl,
  RunnerApprovalDecision,
  RunnerDiscoveryContext,
  ExternalResumeContext,
  ExternalResumeResult,
  RunnerContextUsage,
  RunnerProjectionTitleInput,
  RunnerConversationPage,
  RunnerConversationHistorySource,
  RunnerConversationHistoryReaders,
  RunnerConversationHistoryPage,
  RunnerConversationRewindInput,
  RunnerSessionPresentationContext,
  RunnerSessionPresentation,
  ChannelDelivery
} from './contracts.js';
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

  /** Models eligible for a child session, based on this runner's current profile. */
  childModels(): RunnerProfile['models'] {
    return this.profileForValidation().models;
  }

  assertChildModel(modelId: string | null): void {
    void modelId;
  }

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
    input: { readonly title?: string | null; readonly pinned?: boolean }
  ): Promise<void> {
    void [session, input];
  }

  async removeNative(
    session: NodeAgentSession,
    nativeSessionId: string
  ): Promise<NativeSessionRemovalResult> {
    void [session, nativeSessionId];
    return false;
  }

  supportsNativeBatchRemoval(): boolean {
    return false;
  }

  async removeNativeMembers(sessions: readonly NodeAgentSession[]): Promise<void> {
    void sessions;
    throw new Error('NATIVE_BATCH_REMOVE_UNAVAILABLE');
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
    targetTurnBoundary?: string,
    targetClientMessageId?: string
  ): Promise<number> {
    void [session, boundary, targetTurnBoundary, targetClientMessageId];
    throw new RunnerCapabilityError(this.name, 'session.rollback');
  }

  async clearNative(session: NodeAgentSession): Promise<number> {
    void session;
    throw new RunnerCapabilityError(this.name, 'session.clear');
  }

  projectedRunnerTitle(
    metadata: NativeSessionMetadata | undefined,
    input: RunnerProjectionTitleInput
  ): { readonly title: string | null; readonly clearPending: boolean } {
    return { title: input.title ?? metadata?.runnerTitle ?? null, clearPending: false };
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

export class RunnerCapabilityError extends Error {
  constructor(
    readonly runner: RegisteredRunnerName,
    readonly capability: string
  ) {
    super('RUNNER_CAPABILITY_UNSUPPORTED');
  }
}
