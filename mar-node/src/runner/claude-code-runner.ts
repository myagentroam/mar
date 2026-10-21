import {
  ClaudeAgentSdkAdapter,
  type ClaudeChannelRunHandle,
  type ClaudeQueryInput,
  type ClaudeRunHandle
} from '../claude-agent-sdk.js';
import {
  AbstractRunner,
  type ExternalResumeContext,
  type ExternalResumeResult,
  type RunnerDiscoveryContext,
  type RunnerConversationHistoryPage,
  type RunnerConversationHistoryReaders,
  type RunnerSessionPresentationContext,
  type RunnerSessionPresentation
} from './abstract-runner.js';
import type {
  NodeCapabilities,
  RunnerDefaultConfiguration,
  RunnerProfile
} from '@myagentroam/protocol';
import { claudeDefaultModel, declaredRunnerProfiles } from '../runner-profiles.js';
import { ClaudeChannelGate } from '../claude-channel.js';
import type { ChannelDelivery } from '../claude-channel.js';
import { claudeUserInputQuestions } from '../util/runner-native-session-parsers.js';
import { withClaudePlanTag } from '../runner-command-engine.js';
import type { NodeAgentSession, NodeWorkspace } from '../database.js';
import {
  discoverNativeSessions,
  readNativeSession,
  readClaudeNativeContextUsage,
  type NativeSessionHistory
} from '../native-session-history.js';
import {
  claudeDiscoveredSession,
  deduplicateDirectSessions,
  isNativeHistory,
  isWithinWorkspace,
  latestNativeActivity
} from './codex/conversation-parser.js';

export class ClaudeCodeRunner extends AbstractRunner<'claude-code'> {
  readonly name = 'claude-code' as const;
  readonly discoveryScope = 'WORKSPACE_REQUIRED' as const;
  readonly execution = new ClaudeExecutionState();

  constructor(
    private readonly client: ClaudeAgentSdkAdapter = new ClaudeAgentSdkAdapter(),
    private readonly environment: NodeJS.ProcessEnv = process.env
  ) {
    super();
  }

  profile(capabilities: NodeCapabilities): RunnerProfile {
    return declaredRunnerProfiles({
      codexAvailable: capabilities.codex.available,
      claudeCodeAvailable: capabilities.claudeCode.available,
      environment: this.environment,
      openCodeAvailable: capabilities.openCode?.available === true
    }).find((profile) => profile.runner === this.name)!;
  }

  available(capabilities: NodeCapabilities): boolean {
    return capabilities.claudeCode.available;
  }

  protected profileForValidation(): RunnerProfile {
    return this.profile({
      platform: 'linux',
      architecture: 'validation',
      nodeAppVersion: 'validation',
      nodeVersion: 'validation',
      codex: { available: false },
      claudeCode: { available: true },
      openCode: { available: false }
    });
  }

  defaultConfiguration(): RunnerDefaultConfiguration {
    return {
      runner: this.name,
      model: claudeDefaultModel(this.environment),
      effort: 'medium',
      access: 'default'
    };
  }

  override mcpConfiguration(
    raw: unknown,
    secrets: Readonly<Record<string, string>>,
    executionServers: readonly import('../mcp/model.js').ResolvedMcpServer[] = []
  ): unknown {
    const servers = super.mcpConfiguration(
      raw,
      secrets,
      executionServers
    ) as readonly import('../mcp/model.js').ResolvedMcpServer[];
    return Object.fromEntries(
      servers.map((server) => [
        server.name,
        server.transport === 'STDIO'
          ? {
              type: 'stdio',
              command: server.command!,
              args: [...(server.args ?? [])],
              env: { ...(server.environment ?? {}) }
            }
          : { type: 'http', url: server.url!, headers: { ...(server.headers ?? {}) } }
      ])
    );
  }

  async resumeExternal(
    external: NodeAgentSession,
    context: ExternalResumeContext
  ): Promise<ExternalResumeResult> {
    if (
      external.runner !== this.name ||
      external.nativeControl !== 'EXTERNAL' ||
      external.externalSessionId === null ||
      !context.available
    )
      return {
        failureCode: 'RUNNER_UNAVAILABLE',
        messageFailureCode: 'SESSION_RESUME_REJECTED'
      };
    const nativeAlias = context.managedAliasFor(external);
    if (nativeAlias !== undefined)
      return { session: context.ensureConfiguration(nativeAlias), activity: 'IDLE' };
    const existing = context.currentResumed(external.id);
    if (existing !== undefined)
      return { session: context.ensureConfiguration(existing), activity: 'IDLE' };
    try {
      const sessionInfo = await this.sessionInfo(external.externalSessionId, external.cwd);
      if (sessionInfo === undefined)
        return {
          failureCode: 'RUNNER_SESSION_NOT_FOUND',
          messageFailureCode: 'SESSION_RESUME_REJECTED'
        };
      const workspacePath = context.workspacePath(external.workspaceId);
      if (
        workspacePath === undefined ||
        (typeof sessionInfo.cwd === 'string' && !isWithinWorkspace(sessionInfo.cwd, workspacePath))
      )
        return {
          failureCode: 'RUNNER_SESSION_WORKSPACE_MISMATCH',
          messageFailureCode: 'SESSION_RESUME_REJECTED'
        };
      const resumed = context.currentResumed(external.id);
      if (resumed !== undefined)
        return { session: context.ensureConfiguration(resumed), activity: 'IDLE' };
      const projection = context.projectionFor(external);
      const session =
        projection === undefined ? context.create(external) : context.promote(projection.id);
      if (session === undefined)
        return {
          failureCode: 'RUNNER_RESUME_FAILED',
          messageFailureCode: 'SESSION_RESUME_REJECTED'
        };
      const configured = context.ensureConfiguration(session);
      context.rememberManagedNative(external.externalSessionId, configured.id);
      return { session: configured, activity: 'IDLE' };
    } catch {
      return {
        failureCode: 'RUNNER_RESUME_FAILED',
        messageFailureCode: 'SESSION_RESUME_REJECTED'
      };
    }
  }

  async discoverSessions(
    context: RunnerDiscoveryContext,
    workspace?: NodeWorkspace
  ): Promise<readonly NodeAgentSession[]> {
    const sessions: NodeAgentSession[] = [];
    for (const target of workspace === undefined ? context.workspaces : [workspace]) {
      let official: Awaited<ReturnType<ClaudeAgentSdkAdapter['listSessions']>> = [];
      try {
        official = await this.listSessions(target.path);
      } catch {
        // Native transcripts remain authoritative when SDK listing is unavailable.
      }
      const native = await discoverNativeSessions(this.name, target.path);
      sessions.push(
        ...this.projectDiscoveredSessions(context, target, [
          ...official.flatMap((value) => {
            const parsed = claudeDiscoveredSession(value, target.path);
            return parsed === undefined ? [] : [parsed];
          }),
          ...native
        ])
      );
    }
    return deduplicateDirectSessions(sessions);
  }

  readContextUsage(session: NodeAgentSession) {
    return session.externalSessionId === null
      ? Promise.resolve(undefined)
      : readClaudeNativeContextUsage(session.cwd, session.externalSessionId);
  }

  override async readConversationHistory(
    readers: RunnerConversationHistoryReaders
  ): Promise<RunnerConversationHistoryPage | undefined> {
    const native = await readers.native();
    return native === undefined ? undefined : { ...native, source: 'native' };
  }

  override forkNative(
    session: NodeAgentSession,
    boundary: string | null,
    title: string
  ): Promise<string | null> {
    if (session.externalSessionId === null) throw new Error('SESSION_REWIND_UNAVAILABLE');
    return boundary === null
      ? Promise.resolve(null)
      : this.client.forkSession(session.externalSessionId, session.cwd, boundary, title);
  }

  presentSession(
    session: NodeAgentSession,
    capabilities: NodeCapabilities,
    context: RunnerSessionPresentationContext
  ): RunnerSessionPresentation {
    void capabilities;
    const runtimeCapabilities = [
      'history.read',
      'events.live',
      'turn.start',
      'turn.queue',
      'turn.interrupt',
      'run.cancel',
      'approval.respond',
      'session.rename',
      'session.remove',
      'session.pin',
      ...(session.externalSessionId === null ? [] : ['session.rewind'])
    ];
    return {
      activity: context.managedActive ? 'MANAGED_ACTIVE' : 'IDLE',
      control: {
        level: 'MANAGED',
        capabilities: ['history.read', 'events.live', 'turn.start', 'turn.interrupt']
      },
      commandStates: context.commandStates,
      runtime: { level: 'MANAGED', capabilities: runtimeCapabilities, reasonCode: null }
    };
  }

  override prepareMessageInput(input: string, collaborationMode: 'default' | 'plan'): string {
    return collaborationMode === 'plan' ? withClaudePlanTag(input) : input;
  }

  override channelToken(sessionId: string): string | undefined {
    return [...this.execution.runs.values()].find((run) => run.marSessionId === sessionId)?.gate
      .token;
  }

  override deliverChannel(
    sessionId: string,
    messageId: string,
    senderId: string,
    token: string,
    content: string,
    notify: (runId: string, messageId: string, delivery: ChannelDelivery) => void
  ): ChannelDelivery {
    const found = [...this.execution.runs.entries()].find(
      ([, value]) => value.marSessionId === sessionId
    );
    if (found === undefined) return 'REJECTED';
    const [runId, active] = found;
    const prior = active.gate.delivery(messageId);
    const accepted = active.gate.accept({ id: messageId, senderId, token, content });
    if (accepted === 'REJECTED') {
      if (prior === undefined) notify(runId, messageId, 'REJECTED');
      return 'REJECTED';
    }
    if (prior === undefined && accepted === 'PENDING_RECEIPT') {
      void active.handle.deliver(content).then(
        () => notify(runId, messageId, active.gate.acknowledge({ messageId, result: 'STEERED' })),
        () => notify(runId, messageId, active.gate.acknowledge({ messageId, result: 'REJECTED' }))
      );
    }
    return accepted;
  }

  override managedAliasId(nativeSessionId: string): string | undefined {
    return this.execution.managedSessionByNativeId.get(nativeSessionId);
  }

  override nativeAliasesFor(managedSessionId: string): readonly string[] {
    return [...this.execution.managedSessionByNativeId]
      .filter(([, sessionId]) => sessionId === managedSessionId)
      .map(([nativeSessionId]) => nativeSessionId);
  }

  override forgetNativeAlias(nativeSessionId: string): void {
    this.execution.managedSessionByNativeId.delete(nativeSessionId);
    this.execution.managedNativeIds.delete(nativeSessionId);
  }

  override rememberManagedNative(session: NodeAgentSession, nativeSessionId: string): void {
    this.execution.managedNativeIds.add(nativeSessionId);
    this.execution.managedSessionByNativeId.set(nativeSessionId, session.id);
  }

  override async readManagedRunnerTitle(
    session: NodeAgentSession,
    nativeSessionId: string
  ): Promise<string | undefined> {
    let history = await readNativeSession(this.name, session.cwd, nativeSessionId);
    if (history === undefined) {
      const discovered = await discoverNativeSessions(this.name, session.cwd);
      history = discovered.find((candidate) => candidate.externalSessionId === nativeSessionId);
    }
    return history?.title;
  }

  projectDiscoveredSessions(
    context: RunnerDiscoveryContext,
    workspace: NodeWorkspace,
    discovered: readonly ClaudeDiscoveredSession[]
  ): readonly NodeAgentSession[] {
    const sessions: NodeAgentSession[] = [];
    for (const item of discovered) {
      if (!isWithinWorkspace(item.cwd, workspace.path)) continue;
      const session = context.createProjection({
        workspace,
        runner: this.name,
        externalSessionId: item.externalSessionId,
        cwd: item.cwd,
        ...(item.title === undefined ? {} : { title: item.title }),
        ...('titleOrigin' in item && item.titleOrigin !== undefined
          ? { titleOrigin: item.titleOrigin }
          : {}),
        ...(isNativeHistory(item) ? { lastActivityAt: latestNativeActivity(item) } : {})
      });
      const index = sessions.findIndex((candidate) => candidate.id === session.id);
      if (index < 0) sessions.push(session);
      else if (session.lastActivityAt >= (sessions[index] as NodeAgentSession).lastActivityAt) {
        const existing = sessions[index] as NodeAgentSession;
        sessions[index] = {
          ...session,
          runnerTitle: session.runnerTitle ?? existing.runnerTitle,
          titleSource: session.runnerTitle === null ? existing.titleSource : session.titleSource
        };
      }
    }
    return deduplicateDirectSessions(sessions);
  }

  stop(): void {
    for (const approval of this.execution.approvals.values()) {
      clearTimeout(approval.timer);
      approval.resolve('REJECTED');
    }
    this.execution.approvals.clear();
    for (const pending of this.execution.userInputs.values()) {
      clearTimeout(pending.timer);
      pending.reject('NODE_STOPPED');
    }
    this.execution.userInputs.clear();
    for (const run of this.execution.runs.values()) run.handle.cancel();
    this.execution.runs.clear();
  }

  start(input: ClaudeQueryInput): ClaudeRunHandle {
    return this.client.start(input);
  }

  startChannel(input: ClaudeQueryInput): ClaudeChannelRunHandle {
    return this.client.startChannel(input);
  }

  listSessions(cwd: string): ReturnType<ClaudeAgentSdkAdapter['listSessions']> {
    return this.client.listSessions(cwd);
  }

  sessionInfo(sessionId: string, cwd: string): ReturnType<ClaudeAgentSdkAdapter['sessionInfo']> {
    return this.client.sessionInfo(sessionId, cwd);
  }
}

export class ClaudeExecutionState {
  readonly runs = new Map<
    string,
    {
      marSessionId: string;
      nativeSessionId?: string;
      cwd: string;
      handle: ClaudeChannelRunHandle;
      gate: ClaudeChannelGate;
    }
  >();
  readonly managedNativeIds = new Set<string>();
  readonly managedSessionByNativeId = new Map<string, string>();
  readonly approvals = new Map<
    string,
    {
      readonly runId: string;
      readonly resolve: (decision: 'APPROVED' | 'REJECTED') => void;
      readonly timer: NodeJS.Timeout;
    }
  >();
  readonly userInputs = new Map<
    string,
    {
      readonly runId: string;
      readonly requestId: string;
      readonly questions: ReturnType<typeof claudeUserInputQuestions>;
      readonly input: Record<string, unknown>;
      readonly resolve: (answers: Record<string, string>) => void;
      readonly reject: (message?: string) => void;
      readonly timer: NodeJS.Timeout;
    }
  >();
}

type ClaudeDiscoveredSession =
  | NativeSessionHistory
  | {
      readonly externalSessionId: string;
      readonly cwd: string;
      readonly title?: string;
      readonly titleOrigin?: 'OFFICIAL' | 'PREVIEW';
    };
