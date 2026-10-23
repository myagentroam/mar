import { withMarctlGuide } from '../mcp/marctl-guide.js';
import {
  CodexAppServerClient,
  CodexAppServerRpcError,
  isCodexRolloutMissingError,
  type CodexComposerInput,
  type CodexRunConfiguration,
  type JsonRpcNotification
} from '../codex-app-server.js';
import {
  AbstractRunner,
  type ExternalResumeContext,
  type ExternalResumeResult,
  type RunnerDiscoveryContext,
  type RunnerConversationHistoryPage,
  type RunnerConversationHistoryReaders,
  type RunnerConversationRewindInput,
  type RunnerHistoryImageRegistrar,
  type RunnerSessionPresentationContext,
  type RunnerSessionPresentation,
  type RunnerProjectionTitleInput
} from './abstract-runner.js';
import type {
  NodeCapabilities,
  RunnerDefaultConfiguration,
  RunnerProfile
} from '@myagentroam/protocol';
import { declaredRunnerProfiles } from '../runner-profiles.js';
import type { NodeAgentSession, NodeDatabase } from '../database.js';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { NodeWorkspace } from '../database.js';
import { discoverAllNativeSessions } from '../native-session-history.js';
import { readCodexNativeContextUsage } from '../native-session-history.js';
import {
  codexThreadCwd,
  codexThreadHistoryModes,
  codexPaginatedThread,
  codexPaginatedCursor,
  codexPaginatedConversationPage,
  deduplicateDirectSessions,
  extractCodexThreads,
  isWithinWorkspace,
  latestNativeActivity
} from './codex/conversation-parser.js';
import { codexSessionControl } from '../codex-app-server.js';
import { extractId } from '../util/runner-native-session-parsers.js';
import { nodeLog } from '../operational.js';
import { conversationClientMessageId } from '../util/conversation-identity.js';
import type { NodeConversationTurn } from '../runtime-model.js';
import type { ResponseLatencyTracker } from '../service/response-latency-tracker.js';
import type { GenerationTimingTracker } from '../service/generation-timing-tracker.js';

const CODEX_MODEL_CACHE_MS = 10 * 60 * 1_000;
const CODEX_MODEL_FAILURE_RETRY_MS = 30 * 1_000;
const CODEX_MODEL_PAGE_SIZE = 100;
const CODEX_MODEL_MAX_PAGES = 6;

interface CodexCatalogModel {
  readonly model: string;
  readonly displayName: string;
  readonly isDefault: boolean;
  readonly defaultEffort: string;
  readonly supportedEfforts: readonly string[];
}

interface CodexProfileCache {
  readonly profile: RunnerProfile;
  readonly defaultConfiguration: RunnerDefaultConfiguration;
  readonly fetchedAt: number;
  readonly successful: boolean;
  retryAt: number;
}

export class CodexRunner extends AbstractRunner<'codex'> {
  readonly name = 'codex' as const;
  readonly discoveryScope = 'ALL_WORKSPACES' as const;
  readonly execution = new CodexExecutionState();
  private fastEnabled = false;
  private readonly threadHistoryModes = new Map<string, boolean>();
  private readonly threadHistoryModeReads = new Map<string, Promise<void>>();
  private readonly runClients = new Map<string, CodexAppServerClient>();
  private readonly notificationListeners = new Set<(notification: JsonRpcNotification) => void>();
  private readonly clientNotificationDisposers = new Map<CodexAppServerClient, () => void>();
  private profileCache: CodexProfileCache | undefined;
  private profileCacheVersion: string | undefined;
  private profileCacheTimer: NodeJS.Timeout | undefined;
  private profileRefresh: Promise<RunnerProfile> | undefined;
  private profileRefreshVersion: string | undefined;
  private readonly profileClients = new Set<CodexAppServerClient>();
  private profileGeneration = 0;
  private readonly runClientFactory: () => CodexAppServerClient;

  constructor(
    client?: CodexAppServerClient,
    private readonly profileClientFactory: () => CodexAppServerClient = () =>
      new CodexAppServerClient(),
    runClientFactory?: () => CodexAppServerClient
  ) {
    super();
    this.client = client ?? new CodexAppServerClient();
    this.runClientFactory =
      runClientFactory ??
      (client === undefined ? () => new CodexAppServerClient() : () => this.client);
  }

  private readonly client: CodexAppServerClient;

  profile(capabilities: NodeCapabilities): RunnerProfile {
    const base = declaredRunnerProfiles({
      codexAvailable: capabilities.codex.available,
      claudeCodeAvailable: capabilities.claudeCode.available,
      openCodeAvailable: capabilities.openCode?.available === true
    }).find((profile) => profile.runner === this.name)!;
    return { ...base, models: this.profileCache?.profile.models ?? [] };
  }

  override cachedProfile(
    capabilities: NodeCapabilities,
    _environment: Readonly<Record<string, string>> = {}
  ): RunnerProfile {
    const base = this.profile(capabilities);
    return this.profileCache === undefined ||
      this.profileCacheVersion !== capabilities.codex.version
      ? { ...base, models: [] }
      : this.profileCache.profile;
  }

  override async refreshProfile(
    capabilities: NodeCapabilities,
    workspace?: NodeWorkspace,
    environment: Readonly<Record<string, string>> = {},
    waitForRefresh = false
  ): Promise<RunnerProfile> {
    void workspace;
    const base = this.profile(capabilities);
    if (!capabilities.codex.available) return { ...base, models: [] };
    const version = capabilities.codex.version;
    if (this.profileRefresh !== undefined && this.profileRefreshVersion !== version) {
      this.profileGeneration += 1;
      this.profileRefresh = undefined;
      this.profileRefreshVersion = undefined;
      if (this.profileCacheTimer !== undefined) clearTimeout(this.profileCacheTimer);
      this.profileCacheTimer = undefined;
    }
    const now = Date.now();
    const cached = this.profileCacheVersion === version ? this.profileCache : undefined;
    if (cached?.successful === true && now < cached.fetchedAt + CODEX_MODEL_CACHE_MS)
      return cached.profile;
    if (cached?.successful === true) {
      if (now >= cached.retryAt) {
        const refresh = this.refreshCodexProfile(version, base, environment);
        if (waitForRefresh) return refresh;
      }
      return cached.profile;
    }
    if (cached !== undefined && now < cached.retryAt) return cached.profile;
    return this.refreshCodexProfile(version, base, environment);
  }

  private refreshCodexProfile(
    version: string | undefined,
    base: RunnerProfile,
    environment: Readonly<Record<string, string>>
  ): Promise<RunnerProfile> {
    const existing = this.profileRefresh;
    if (existing !== undefined) return existing;
    const generation = this.profileGeneration;
    const refresh = this.fetchCodexProfile(base, environment)
      .then((value) => {
        const cache: CodexProfileCache = {
          ...value,
          fetchedAt: Date.now(),
          successful: true,
          retryAt: 0
        };
        if (generation === this.profileGeneration) {
          this.cacheProfile(version, cache);
          this.scheduleProfileRefresh(CODEX_MODEL_CACHE_MS, version, base, environment);
        }
        return cache.profile;
      })
      .catch((error: unknown) => {
        nodeLog('runner.codex.models.refresh-failed', {
          error: error instanceof Error ? error.message : String(error)
        });
        if (generation !== this.profileGeneration) return { ...base, models: [] };
        const cached = this.profileCacheVersion === version ? this.profileCache : undefined;
        if (cached !== undefined) {
          cached.retryAt = Date.now() + CODEX_MODEL_FAILURE_RETRY_MS;
          this.scheduleProfileRefresh(CODEX_MODEL_FAILURE_RETRY_MS, version, base, environment);
          return cached.profile;
        }
        this.cacheProfile(version, {
          profile: { ...base, models: [] },
          defaultConfiguration: emptyCodexConfiguration(),
          fetchedAt: 0,
          successful: false,
          retryAt: Date.now() + CODEX_MODEL_FAILURE_RETRY_MS
        });
        this.scheduleProfileRefresh(CODEX_MODEL_FAILURE_RETRY_MS, version, base, environment);
        return { ...base, models: [] };
      })
      .finally(() => {
        if (this.profileRefresh === refresh) {
          this.profileRefresh = undefined;
          this.profileRefreshVersion = undefined;
        }
      });
    this.profileRefresh = refresh;
    this.profileRefreshVersion = version;
    return refresh;
  }

  private cacheProfile(version: string | undefined, cache: CodexProfileCache): void {
    this.profileCache = cache;
    this.profileCacheVersion = version;
  }

  private scheduleProfileRefresh(
    delayMs: number,
    version: string | undefined,
    base: RunnerProfile,
    environment: Readonly<Record<string, string>>
  ): void {
    if (this.profileCacheTimer !== undefined) clearTimeout(this.profileCacheTimer);
    this.profileCacheTimer = setTimeout(() => {
      this.profileCacheTimer = undefined;
      void this.refreshCodexProfile(version, base, environment);
    }, delayMs);
    this.profileCacheTimer.unref();
  }

  private async fetchCodexProfile(
    base: RunnerProfile,
    environment: Readonly<Record<string, string>>
  ): Promise<{
    readonly profile: RunnerProfile;
    readonly defaultConfiguration: RunnerDefaultConfiguration;
  }> {
    const client = this.profileClientFactory();
    this.profileClients.add(client);
    if (Object.keys(environment).length > 0) client.configureEnvironment(environment);
    try {
      await client.start();
      const models: CodexCatalogModel[] = [];
      let cursor: string | null = null;
      let pages = 0;
      const cursors = new Set<string>();
      do {
        if (pages >= CODEX_MODEL_MAX_PAGES) throw new Error('CODEX_MODELS_PAGE_LIMIT');
        pages += 1;
        const page = codexModelPage(
          await client.listModels({ cursor, limit: CODEX_MODEL_PAGE_SIZE, includeHidden: false })
        );
        models.push(...page.models);
        cursor = page.nextCursor;
        if (cursor !== null && cursors.has(cursor)) throw new Error('CODEX_MODELS_CURSOR_REPEATED');
        if (cursor !== null) cursors.add(cursor);
      } while (cursor !== null);
      const uniqueModels = models.filter(
        (model, index) => models.findIndex((candidate) => candidate.model === model.model) === index
      );
      const profileModels = uniqueModels.map((model) => ({
        id: model.model,
        label: model.displayName,
        supportedEfforts: [...model.supportedEfforts],
        isDefault: model.isDefault,
        defaultEffort: model.defaultEffort
      }));
      const selected = uniqueModels.find((model) => model.isDefault) ?? uniqueModels[0];
      return {
        profile: { ...base, models: profileModels },
        defaultConfiguration:
          selected === undefined
            ? emptyCodexConfiguration()
            : {
                runner: this.name,
                model: selected.model,
                effort: selected.defaultEffort,
                access: 'on-request'
              }
      };
    } finally {
      if (this.profileClients.delete(client)) client.stop();
    }
  }

  available(capabilities: NodeCapabilities): boolean {
    return capabilities.codex.available;
  }

  override executeGlobalCommand(commandId: string, input: string): unknown {
    if (commandId !== 'fast' || !/^\/fast(?:\s+(on|off|status))?\s*$/i.test(input))
      throw new Error('RUNNER_COMMAND_INVALID');
    const argument = input.trim().split(/\s+/, 2)[1]?.toLowerCase() ?? 'status';
    if (argument === 'on') this.fastEnabled = true;
    else if (argument === 'off') this.fastEnabled = false;
    return { command: 'fast', enabled: this.fastEnabled };
  }

  override serviceTier(): 'fast' | undefined {
    return this.fastEnabled ? 'fast' : undefined;
  }

  override mcpConfiguration(
    raw: unknown,
    secrets: Readonly<Record<string, string>>,
    executionServers: readonly import('../mcp/model.js').ResolvedMcpServer[] = []
  ): unknown {
    const servers = withMarctlGuide(
      super.mcpConfiguration(
        raw,
        secrets,
        executionServers
      ) as readonly import('../mcp/model.js').ResolvedMcpServer[],
      secrets
    );
    return Object.fromEntries(
      servers.map((server) => [
        server.name,
        server.transport === 'STDIO'
          ? {
              command: server.command!,
              args: [...(server.args ?? [])],
              env: { ...(server.environment ?? {}) }
            }
          : { url: server.url!, http_headers: { ...(server.headers ?? {}) } }
      ])
    );
  }

  override usesRunnerTitleForRename(): boolean {
    return true;
  }

  override async renameNative(
    session: NodeAgentSession,
    input: { readonly title?: string | null; readonly pinned?: boolean },
    database: NodeDatabase
  ): Promise<void> {
    if (session.externalSessionId === null) return;
    if (input.title !== undefined) {
      await this.start();
      await this.setThreadName(session.externalSessionId, input.title ?? '');
    }
    database.saveNativeSessionMetadata({
      runner: this.name,
      externalSessionId: session.externalSessionId,
      workspaceId: session.workspaceId,
      ...(input.title === undefined ? {} : { runnerTitle: input.title }),
      ...(input.title === undefined
        ? {}
        : { runnerTitlePending: input.title !== null && input.title.trim().length > 0 }),
      ...(input.pinned === undefined ? {} : { pinned: input.pinned })
    });
  }

  override projectedRunnerTitle(
    metadata: ReturnType<NodeDatabase['getNativeSessionMetadata']>,
    input: RunnerProjectionTitleInput,
    database: NodeDatabase | undefined
  ): string | null {
    const cached = metadata?.runnerTitle ?? null;
    if (input.titleOrigin !== 'OFFICIAL' || input.title === undefined)
      return cached ?? input.title ?? null;
    if (metadata?.runnerTitlePending === true) {
      if (input.title === cached)
        database?.saveNativeSessionMetadata({
          runner: this.name,
          externalSessionId: input.externalSessionId,
          workspaceId: input.workspaceId,
          runnerTitle: cached,
          runnerTitlePending: false
        });
      return cached ?? input.title;
    }
    return input.title;
  }

  override async isNativeSessionMissing(session: NodeAgentSession): Promise<boolean> {
    if (session.externalSessionId === null) return false;
    await this.start();
    try {
      await this.client.readThread(session.externalSessionId);
      return false;
    } catch (error) {
      if (
        error instanceof CodexAppServerRpcError &&
        error.code === -32600 &&
        /^no rollout found for thread id\b/i.test(error.rpcMessage)
      )
        return true;
      throw error;
    }
  }

  override async readConversationHistory(
    readers: RunnerConversationHistoryReaders
  ): Promise<RunnerConversationHistoryPage | undefined> {
    const page = await readers.official();
    return page === undefined ? undefined : { ...page, source: 'official' };
  }

  override async readConversationRewind(
    input: RunnerConversationRewindInput
  ): Promise<ReadonlyMap<NodeConversationTurn['id'], NonNullable<NodeConversationTurn['rewind']>>> {
    const supplements = new Map<
      NodeConversationTurn['id'],
      NonNullable<NodeConversationTurn['rewind']>
    >();
    if (!input.firstPage || input.session.externalSessionId === null || !input.managedActive)
      return supplements;
    const candidates = input.turns.filter(
      (turn) =>
        turn.rewind === undefined &&
        ['SUCCEEDED', 'FAILED', 'CANCELLED', 'INTERRUPTED', 'LOST'].includes(turn.status) &&
        conversationClientMessageId(turn) !== null
    );
    if (candidates.length === 0) return supplements;
    const authoritative = await input.readHistory({
      limit: Math.min(500, Math.max(30, input.turns.length + 1))
    });
    if (authoritative === undefined) return supplements;
    for (const turn of candidates) {
      const messageId = conversationClientMessageId(turn);
      const native = authoritative.turns.find(
        (candidate) =>
          candidate.rewind !== undefined &&
          candidate.userItemId !== null &&
          conversationClientMessageId(candidate) === messageId
      );
      if (native?.rewind !== undefined) supplements.set(turn.id, native.rewind);
    }
    return supplements;
  }

  override async readOfficialConversation(
    session: NodeAgentSession,
    input: { readonly cursor?: string; readonly limit?: number },
    managedTurn: (
      nativeTurnId: string
    ) => import('../runtime-model.js').NodeConversationTurn | undefined,
    registerImages?: RunnerHistoryImageRegistrar
  ) {
    if (session.externalSessionId === null) return undefined;
    const threadId = session.externalSessionId;
    const cursor = codexPaginatedCursor(session.id, input.cursor);
    const limit = Math.min(Math.max(input.limit ?? 30, 1), 100);
    await this.start();
    await this.readThreadHistoryMode(threadId);
    const page = await this.client.listThreadTurns(threadId, {
      ...(cursor === undefined ? {} : { cursor }),
      limit
    });
    const nextCursor =
      typeof page === 'object' && page !== null && 'nextCursor' in page
        ? page.nextCursor
        : undefined;
    let earlierTurnId: string | null = null;
    if (typeof nextCursor === 'string') {
      const earlier = await this.client.listThreadTurns(threadId, { cursor: nextCursor, limit: 1 });
      if (
        typeof earlier !== 'object' ||
        earlier === null ||
        !('data' in earlier) ||
        !Array.isArray(earlier.data) ||
        typeof earlier.data[0]?.id !== 'string'
      )
        throw new Error('NATIVE_TRANSCRIPT_UNAVAILABLE');
      earlierTurnId = earlier.data[0].id;
    }
    return codexPaginatedConversationPage(
      session,
      page,
      earlierTurnId,
      managedTurn,
      registerImages
    );
  }

  override acceptsTruncatedNativeHistory(): boolean {
    return true;
  }

  override async readManagedRunnerTitle(
    session: NodeAgentSession,
    nativeSessionId: string
  ): Promise<string | undefined> {
    void session;
    await this.start();
    const thread = extractCodexThreads(await this.listThreads()).find(
      (candidate) => candidate.id === nativeSessionId
    );
    return thread?.titleOrigin === 'OFFICIAL' ? thread.title : undefined;
  }

  override nativeImageRoots(session: NodeAgentSession): readonly string[] {
    return [
      session.cwd,
      ...(session.externalSessionId === null
        ? []
        : [resolve(homedir(), '.codex', 'generated_images', session.externalSessionId)])
    ];
  }

  override managedRunForNativeTurn(nativeTurnId: string): string | undefined {
    return this.execution.managedTurns.get(nativeTurnId)?.runId;
  }

  protected profileForValidation(): RunnerProfile {
    return this.profile({
      platform: 'linux',
      architecture: 'validation',
      nodeAppVersion: 'validation',
      nodeVersion: 'validation',
      codex: { available: true },
      claudeCode: { available: false },
      openCode: { available: false }
    });
  }

  defaultConfiguration(
    _workspace?: NodeWorkspace,
    environment?: Readonly<Record<string, string>>
  ): RunnerDefaultConfiguration {
    return (
      this.profileCacheForEnvironment(environment)?.defaultConfiguration ??
      emptyCodexConfiguration()
    );
  }

  override supportsConfiguration(
    configuration: RunnerDefaultConfiguration,
    _workspace?: NodeWorkspace,
    environment?: Readonly<Record<string, string>>
  ): boolean {
    if (configuration.runner !== this.name) return false;
    const profile = this.profileCacheForEnvironment(environment)?.profile;
    return (
      profile !== undefined &&
      profile.models.some(
        (model) =>
          model.id === configuration.model && model.supportedEfforts.includes(configuration.effort)
      ) &&
      profile.accessOptions.some((option) => option.id === configuration.access)
    );
  }

  private profileCacheForEnvironment(
    _environment?: Readonly<Record<string, string>>
  ): CodexProfileCache | undefined {
    return this.profileCache;
  }

  async resumeExternal(
    external: NodeAgentSession,
    context: ExternalResumeContext
  ): Promise<ExternalResumeResult> {
    const threadId = external.externalSessionId;
    if (
      external.runner !== this.name ||
      external.nativeControl !== 'EXTERNAL' ||
      threadId === null ||
      !context.available
    )
      return { failureCode: 'RUNNER_UNAVAILABLE' };
    try {
      await this.withTemporaryClient((client) => client.resumeThread(threadId, external.cwd));
      const projection = context.projectionFor(external);
      if (projection !== undefined) {
        const promoted = context.promote(projection.id);
        if (promoted !== undefined)
          return { activity: 'IDLE', session: context.ensureConfiguration(promoted) };
      }
      return { activity: 'IDLE', session: context.create(external) };
    } catch {
      return { failureCode: 'RUNNER_RESUME_FAILED' };
    }
  }

  async discoverSessions(
    context: RunnerDiscoveryContext,
    workspace?: NodeWorkspace
  ): Promise<readonly NodeAgentSession[]> {
    let threads = [] as ReturnType<typeof extractCodexThreads>;
    try {
      await this.start();
      const result = await this.listThreads();
      threads = extractCodexThreads(result);
    } catch {
      // Native transcripts remain a valid read-only discovery source.
    }
    const sessions: NodeAgentSession[] = [];
    for (const thread of threads) {
      if (thread.derived || (thread.source !== 'cli' && thread.source !== 'vscode')) continue;
      let cwd: string;
      try {
        cwd = codexThreadCwd(thread.cwd);
      } catch {
        continue;
      }
      const target =
        workspace ?? context.workspaces.find((candidate) => isWithinWorkspace(cwd, candidate.path));
      if (target === undefined || !isWithinWorkspace(cwd, target.path)) continue;
      sessions.push(
        context.createProjection({
          workspace: target,
          runner: this.name,
          externalSessionId: thread.id,
          cwd,
          ...(thread.title === undefined ? {} : { title: thread.title }),
          ...(thread.titleOrigin === undefined ? {} : { titleOrigin: thread.titleOrigin })
        })
      );
    }
    for (const entry of await discoverAllNativeSessions(this.name)) {
      const target =
        workspace ??
        context.workspaces.find((candidate) => isWithinWorkspace(entry.cwd, candidate.path));
      if (target === undefined || !isWithinWorkspace(entry.cwd, target.path)) continue;
      const native = context.createProjection({
        workspace: target,
        runner: this.name,
        externalSessionId: entry.externalSessionId,
        cwd: entry.cwd,
        ...(entry.title === undefined ? {} : { title: entry.title }),
        titleOrigin: 'NATIVE',
        lastActivityAt: latestNativeActivity(entry)
      });
      const index = sessions.findIndex((candidate) => candidate.id === native.id);
      if (index < 0) sessions.push(native);
      else {
        const official = sessions[index] as NodeAgentSession;
        sessions[index] =
          official.runnerTitle === null
            ? native
            : {
                ...native,
                runnerTitle: official.runnerTitle,
                titleSource: official.titleSource
              };
      }
    }
    return deduplicateDirectSessions(sessions);
  }

  readContextUsage(session: NodeAgentSession) {
    return session.externalSessionId === null
      ? Promise.resolve(undefined)
      : readCodexNativeContextUsage(session.cwd, session.externalSessionId);
  }

  presentSession(
    session: NodeAgentSession,
    capabilities: NodeCapabilities,
    context: RunnerSessionPresentationContext
  ): RunnerSessionPresentation {
    const activeTurn = [...this.execution.runs.values()].some(
      (run) => run.sessionId === session.id && run.turnId !== undefined
    );
    const control = codexSessionControl({
      available: capabilities.codex.available,
      nativeThreadId: session.externalSessionId,
      nativeControl: session.nativeControl,
      activeTurn
    });
    const activity = context.managedActive ? 'MANAGED_ACTIVE' : 'IDLE';
    return {
      control,
      activity,
      commandStates: context.commandStates,
      runtime: {
        level: control.level,
        capabilities: [
          ...control.capabilities,
          'turn.queue',
          'run.cancel',
          'approval.respond',
          'session.rename',
          'session.remove',
          'session.pin',
          ...(session.externalSessionId === null ? [] : ['session.rewind']),
          ...(this.supportsRollback(session) ? ['session.rollback'] : [])
        ],
        reasonCode: null
      }
    };
  }

  onNotification(listener: (notification: JsonRpcNotification) => void): () => void {
    this.notificationListeners.add(listener);
    this.attachNotifications(this.client);
    for (const client of this.runClients.values()) this.attachNotifications(client);
    return () => this.notificationListeners.delete(listener);
  }

  async start(runId?: string): Promise<void> {
    const client = this.clientFor(runId);
    try {
      await client.start();
    } catch (error) {
      if (
        runId === undefined ||
        !(error instanceof Error) ||
        error.message !== 'CODEX_APP_SERVER_STOPPED' ||
        this.runClients.get(runId) !== client
      )
        throw error;
      await client.start();
    }
  }

  async recoverMissingRollout(runId: string, error: unknown): Promise<boolean> {
    if (!isCodexRolloutMissingError(error)) return false;
    const client = this.clientFor(runId);
    if (
      [...this.runClients].some(
        ([activeRunId, activeClient]) => activeRunId !== runId && activeClient === client
      )
    )
      return false;
    if (
      [...this.execution.runs].some(
        ([activeRunId]) => activeRunId !== runId && this.runClients.get(activeRunId) === client
      )
    )
      return false;
    nodeLog('runner.codex.rollout.recovering', { runId });
    await client.restart();
    return true;
  }

  prepareEnvironment(environment: Readonly<Record<string, string>>, runId: string): void {
    if (this.runClients.has(runId)) return;
    const client = this.runClientFactory();
    if (Object.keys(environment).length > 0) client.configureEnvironment(environment);
    this.attachNotifications(client);
    this.runClients.set(runId, client);
  }

  releaseEnvironment(runId: string): void {
    const client = this.runClients.get(runId);
    if (client === undefined) return;
    this.runClients.delete(runId);
    if (client !== this.client && ![...this.runClients.values()].includes(client)) {
      this.detachNotifications(client);
      client.stop();
      client.clearEnvironment();
    }
  }

  stop(): void {
    this.profileGeneration += 1;
    for (const profileClient of this.profileClients) profileClient.stop();
    this.profileClients.clear();
    for (const client of new Set(this.runClients.values()))
      if (client !== this.client) {
        this.detachNotifications(client);
        client.stop();
        client.clearEnvironment();
      }
    this.runClients.clear();
    this.threadHistoryModes.clear();
    this.threadHistoryModeReads.clear();
    this.client.stop();
    if (this.profileCacheTimer !== undefined) clearTimeout(this.profileCacheTimer);
    this.profileCacheTimer = undefined;
    this.profileCache = undefined;
    this.profileCacheVersion = undefined;
    this.profileRefresh = undefined;
    this.profileRefreshVersion = undefined;
  }

  private clientFor(runId?: string): CodexAppServerClient {
    return runId === undefined ? this.client : (this.runClients.get(runId) ?? this.client);
  }

  private async withTemporaryClient<T>(
    operation: (client: CodexAppServerClient) => Promise<T>
  ): Promise<T> {
    const client = this.runClientFactory();
    try {
      await client.start();
      return await operation(client);
    } finally {
      if (client !== this.client) await client.stopAndWait();
    }
  }

  private attachNotifications(client: CodexAppServerClient): void {
    if (this.clientNotificationDisposers.has(client)) return;
    this.clientNotificationDisposers.set(
      client,
      client.onNotification((notification) => {
        for (const listener of this.notificationListeners) listener(notification);
      })
    );
  }

  private detachNotifications(client: CodexAppServerClient): void {
    this.clientNotificationDisposers.get(client)?.();
    this.clientNotificationDisposers.delete(client);
  }

  request(method: string, params: unknown, runId?: string): Promise<unknown> {
    return this.clientFor(runId).request(method, params);
  }

  respond(requestId: string | number, result: unknown, runId?: string): void {
    this.clientFor(runId).respond(requestId, result);
  }

  async listThreads(): Promise<unknown> {
    const result = await this.client.listThreads();
    this.observeThreadHistoryModes(result);
    return result;
  }

  private observeThreadHistoryModes(result: unknown, expectedThreadId?: string): void {
    for (const descriptor of codexThreadHistoryModes(result))
      if (expectedThreadId === undefined || descriptor.id === expectedThreadId)
        this.threadHistoryModes.set(descriptor.id, descriptor.paginated);
  }

  private readThreadHistoryMode(threadId: string): Promise<void> {
    if (this.threadHistoryModes.has(threadId)) return Promise.resolve();
    const existing = this.threadHistoryModeReads.get(threadId);
    if (existing !== undefined) return existing;
    const read = this.client
      .readThread(threadId)
      .then((result) => {
        if (this.threadHistoryModeReads.get(threadId) !== read) return;
        if (!this.threadHistoryModes.has(threadId))
          this.observeThreadHistoryModes(result, threadId);
        if (!this.threadHistoryModes.has(threadId)) this.threadHistoryModes.set(threadId, false);
      })
      .catch(() => {
        // A capability probe must not make otherwise readable history unavailable.
        if (
          this.threadHistoryModeReads.get(threadId) === read &&
          !this.threadHistoryModes.has(threadId)
        )
          this.threadHistoryModes.set(threadId, false);
      })
      .finally(() => {
        if (this.threadHistoryModeReads.get(threadId) === read)
          this.threadHistoryModeReads.delete(threadId);
      });
    this.threadHistoryModeReads.set(threadId, read);
    return read;
  }

  startThread(
    cwd: string,
    configuration?: CodexRunConfiguration,
    runId?: string
  ): Promise<unknown> {
    return this.clientFor(runId)
      .startThread(cwd, configuration)
      .then((result) => {
        this.observeThreadHistoryModes(result);
        return result;
      });
  }

  forkThread(
    threadId: string,
    cwd: string,
    lastTurnId: string,
    configuration?: CodexRunConfiguration
  ): Promise<unknown> {
    return this.client.forkThread(threadId, cwd, lastTurnId, configuration);
  }

  override async forkNative(
    session: NodeAgentSession,
    boundary: string | null,
    title: string
  ): Promise<string> {
    const threadId = session.externalSessionId;
    if (threadId === null) throw new Error('SESSION_REWIND_UNAVAILABLE');
    const configuration = { model: session.model, effort: session.effort, access: session.access };
    return this.withTemporaryClient(async (client) => {
      const result =
        boundary === null
          ? await client.startThread(session.cwd, configuration)
          : await client.forkThread(threadId, session.cwd, boundary, configuration);
      const forkedThreadId = extractId(result, 'thread');
      this.observeThreadHistoryModes(result);
      await client.setThreadName(forkedThreadId, title);
      return forkedThreadId;
    });
  }

  override supportsRollback(session: NodeAgentSession): boolean {
    return (
      session.externalSessionId !== null &&
      this.threadHistoryModes.get(session.externalSessionId) === true
    );
  }

  override async rollbackNative(
    session: NodeAgentSession,
    boundary: string | null,
    targetTurnBoundary?: string
  ): Promise<number> {
    void boundary;
    if (!this.supportsRollback(session) || targetTurnBoundary === undefined)
      throw new Error('SESSION_ROLLBACK_UNAVAILABLE');
    const threadId = session.externalSessionId!;
    return this.withTemporaryClient(async (client) => {
      const resumed = await client.resumeThread(threadId, session.cwd, {
        model: session.model,
        effort: session.effort,
        access: session.access
      });
      if (!codexPaginatedThread(resumed)) {
        this.threadHistoryModes.set(threadId, false);
        throw new Error('SESSION_ROLLBACK_UNAVAILABLE');
      }
      await client.revertThread(threadId, targetTurnBoundary);
      return Date.now();
    });
  }

  resumeThread(
    threadId: string,
    cwd: string,
    configuration?: CodexRunConfiguration,
    runId?: string
  ): Promise<unknown> {
    return this.clientFor(runId)
      .resumeThread(threadId, cwd, configuration)
      .then((result) => {
        this.observeThreadHistoryModes(result, threadId);
        return result;
      });
  }

  startTurn(
    threadId: string,
    text: string,
    cwd: string,
    configuration?: CodexRunConfiguration,
    attachments?: readonly Extract<CodexComposerInput, { readonly type: 'localImage' }>[],
    runId?: string
  ): Promise<unknown> {
    return this.clientFor(runId).startTurn(threadId, text, cwd, configuration, attachments);
  }

  interruptTurn(threadId: string, turnId: string, runId?: string): Promise<unknown> {
    return this.clientFor(runId).interruptTurn(threadId, turnId);
  }

  setThreadName(threadId: string, name: string): Promise<unknown> {
    return this.client.setThreadName(threadId, name);
  }

  listCollaborationModes(runId?: string): Promise<unknown> {
    return this.clientFor(runId).listCollaborationModes();
  }
}

function emptyCodexConfiguration(): RunnerDefaultConfiguration {
  return { runner: 'codex', model: '', effort: '', access: 'on-request' };
}

function codexModelPage(value: unknown): {
  readonly models: readonly CodexCatalogModel[];
  readonly nextCursor: string | null;
} {
  if (!isPlainRecord(value) || !Array.isArray(value.data)) throw new Error('CODEX_MODELS_INVALID');
  return {
    models: value.data.flatMap((entry) => {
      if (!isPlainRecord(entry) || entry.hidden === true) return [];
      const model = typeof entry.model === 'string' ? entry.model.trim() : '';
      const displayName = typeof entry.displayName === 'string' ? entry.displayName.trim() : '';
      const defaultEffort =
        typeof entry.defaultReasoningEffort === 'string' ? entry.defaultReasoningEffort.trim() : '';
      const supportedEfforts = Array.isArray(entry.supportedReasoningEfforts)
        ? entry.supportedReasoningEfforts.flatMap((option) =>
            isPlainRecord(option) && typeof option.reasoningEffort === 'string'
              ? [option.reasoningEffort.trim()]
              : []
          )
        : [];
      if (
        model.length === 0 ||
        model.length > 128 ||
        displayName.length === 0 ||
        displayName.length > 128 ||
        defaultEffort.length === 0 ||
        defaultEffort.length > 64 ||
        supportedEfforts.length > 32 ||
        supportedEfforts.some((effort) => effort.length === 0 || effort.length > 64) ||
        !supportedEfforts.includes(defaultEffort)
      )
        return [];
      return [
        {
          model,
          displayName,
          isDefault: entry.isDefault === true,
          defaultEffort,
          supportedEfforts: [...new Set(supportedEfforts.filter(Boolean))]
        }
      ];
    }),
    nextCursor:
      typeof value.nextCursor === 'string' && value.nextCursor.length > 0 ? value.nextCursor : null
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class CodexExecutionState {
  readonly runs = new Map<
    string,
    {
      sessionId: string;
      threadId: string;
      turnId?: string;
      cwd: string;
      refreshTitle?: boolean;
      goalMcp?: boolean;
      scheduleMcp?: boolean;
      responseLatency?: ResponseLatencyTracker;
      generationTiming?: GenerationTimingTracker;
      generationKeys?: string[] | undefined;
      generationRequestSequence?: number;
      generationResponseIds?: Map<string, string>;
      completedGenerationResponseIds?: Set<string>;
      currentGenerationKey?: string | undefined;
      generationCompacting?: boolean;
      generationUsageSnapshot?: string;
    }
  >();
  readonly managedTurns = new Map<string, { sessionId: string; runId: string }>();
  readonly approvals = new Map<
    string,
    { readonly runId: string; readonly requestId: string | number }
  >();
  readonly userInputs = new Map<
    string,
    {
      readonly runId: string;
      readonly requestId: string | number;
      readonly questions: readonly {
        readonly id: string;
        readonly options: readonly string[];
        readonly allowOther: boolean;
      }[];
    }
  >();
}
