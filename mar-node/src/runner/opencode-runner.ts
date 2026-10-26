import { withMarctlGuide } from '../mcp/marctl-guide.js';
import type {
  NodeCapabilities,
  RunnerDefaultConfiguration,
  RunnerProfile
} from '@myagentroam/protocol';
import type { NodeAgentSession, NodeDatabase, NodeWorkspace } from '../database.js';
import { OpenCodeServerClient } from '../opencode-server.js';
import { openCodeContextLimits, openCodeProfileModels } from '../opencode-runtime.js';
import { declaredRunnerProfiles } from '../runner-profiles.js';
import {
  AbstractRunner,
  type ExternalResumeContext,
  type ExternalResumeResult,
  type RunnerDiscoveryContext,
  type RunnerConversationHistoryPage,
  type RunnerConversationHistoryReaders,
  type RunnerSessionPresentation,
  type RunnerSessionPresentationContext
} from './abstract-runner.js';
import { isWithinWorkspace } from '../util/runner-native-session-parsers.js';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import {
  openCodeConversationPage,
  openCodeUserMessagePreview
} from './opencode/conversation-parser.js';
import { nodeLog } from '../operational.js';
import { runnerErrorProjection } from '../util/runner-error.js';
import type { GenerationTimingTracker } from '../service/generation-timing-tracker.js';

const PROFILE_ENTRY_TTL_MS = 30 * 60_000;
const PROFILE_FAILURE_RETRY_MS = 30_000;
const PROFILE_REFRESH_TIMEOUT_MS = 90_000;
const TITLE_PREVIEW_TTL_MS = 60 * 60_000;
const MAX_TITLE_PREVIEWS = 256;

interface OpenCodeProfileCacheEntry {
  readonly expiresAt: number;
  readonly models: RunnerProfile['models'];
  readonly contextLimits: ReadonlyMap<string, number>;
}

export interface OpenCodeManagedExecution {
  readonly runId: string;
  readonly sessionId: string;
  readonly nativeSessionId: string;
  readonly cwd: string;
  readonly client: OpenCodeServerClient;
  readonly abort: AbortController;
  readonly access: string;
  readonly agent: 'plan' | 'build';
  responseLatency?: import('../service/response-latency-tracker.js').ResponseLatencyTracker;
  responsePartKinds?: Map<string, string>;
  responseStartedAt?: number;
  responseMessages?: Set<string>;
  generationTiming?: GenerationTimingTracker;
  generationRequestKeys?: Map<string, string>;
  generationPartKeys?: Map<string, string>;
  generationRequestSequence?: number;
  currentResponseMessageId?: string;
}

export class OpenCodeRunner extends AbstractRunner<'opencode'> {
  readonly name = 'opencode' as const;
  readonly discoveryScope = 'WORKSPACE_REQUIRED' as const;
  private contextLimits: ReadonlyMap<string, number> = new Map();
  private contextLimitsExpiresAt = 0;
  private profileCache: OpenCodeProfileCacheEntry | undefined;
  private profileRetryAt = 0;
  private profileRefresh: Promise<RunnerProfile> | undefined;
  private profileRefreshTimer: NodeJS.Timeout | undefined;
  private profileGeneration = 0;
  readonly execution = new Map<string, OpenCodeManagedExecution>();
  readonly managedTurns = new Map<string, string>();
  private readonly titlePreviews = new Map<
    string,
    {
      readonly updatedAt: number;
      readonly expiresAt: number;
      readonly result: Promise<string | undefined>;
    }
  >();
  private readonly environmentClients = new Map<
    string,
    { readonly client: OpenCodeServerClient; leases: number }
  >();
  private readonly stoppingClients = new Set<Promise<void>>();

  constructor(
    private readonly client: OpenCodeServerClient = new OpenCodeServerClient(),
    private readonly clientFactory: () => OpenCodeServerClient = () => new OpenCodeServerClient()
  ) {
    super();
  }

  override migrateSessionIdentity(previousId: string, nativeSessionId: string): void {
    for (const [runId, managed] of this.execution) {
      if (managed.sessionId === previousId)
        this.execution.set(runId, { ...managed, sessionId: nativeSessionId });
    }
  }

  profile(capabilities: NodeCapabilities): RunnerProfile {
    const base = declaredRunnerProfiles({
      codexAvailable: capabilities.codex.available,
      claudeCodeAvailable: capabilities.claudeCode.available,
      openCodeAvailable: capabilities.openCode?.available === true
    }).find((profile) => profile.runner === this.name)!;
    return { ...base, models: [] };
  }

  override cachedProfile(
    capabilities: NodeCapabilities,
    _environment: Readonly<Record<string, string>> = {}
  ): RunnerProfile {
    const cached = this.profileCache;
    return cached === undefined
      ? this.profile(capabilities)
      : { ...this.profile(capabilities), models: cached.models };
  }

  override async refreshProfile(
    capabilities: NodeCapabilities,
    _workspace?: NodeWorkspace,
    environment: Readonly<Record<string, string>> = {},
    _waitForRefresh = false
  ): Promise<RunnerProfile> {
    if (capabilities.openCode?.available !== true) {
      return this.profile(capabilities);
    }
    const now = Date.now();
    const cached = this.profileCache;
    if (cached !== undefined && cached.expiresAt > now) {
      nodeLog('runner.opencode.profile.cache-hit', {
        models: cached.models.length,
        remainingTtlMs: cached.expiresAt - now
      });
      this.contextLimits = cached.contextLimits;
      this.contextLimitsExpiresAt = cached.expiresAt;
      return { ...this.profile(capabilities), models: cached.models };
    }
    if (now < this.profileRetryAt)
      return cached === undefined
        ? this.profile(capabilities)
        : { ...this.profile(capabilities), models: cached.models };
    const current = this.profileRefresh;
    if (current !== undefined) {
      nodeLog('runner.opencode.profile.single-flight-joined', {});
      return current;
    }
    const generation = this.profileGeneration;
    const refresh = this.fetchProfile(capabilities, environment, generation, cached).finally(() => {
      if (this.profileRefresh === refresh) this.profileRefresh = undefined;
    });
    this.profileRefresh = refresh;
    return refresh;
  }

  private async fetchProfile(
    capabilities: NodeCapabilities,
    environment: Readonly<Record<string, string>>,
    generation: number,
    stale?: OpenCodeProfileCacheEntry
  ): Promise<RunnerProfile> {
    const client = this.managedClient(environment, 'runner-profile');
    const startedAt = performance.now();
    try {
      const catalog = await withProfileTimeout(client.providers(homedir()));
      const models = openCodeProfileModels(catalog);
      const contextLimits = openCodeContextLimits(catalog);
      const expiresAt = Date.now() + PROFILE_ENTRY_TTL_MS;
      if (generation !== this.profileGeneration) return this.profile(capabilities);
      this.contextLimits = contextLimits;
      this.contextLimitsExpiresAt = expiresAt;
      this.profileCache = {
        expiresAt,
        models,
        contextLimits
      };
      this.profileRetryAt = 0;
      this.scheduleProfileRefresh(PROFILE_ENTRY_TTL_MS, capabilities, environment);
      nodeLog('runner.opencode.profile.providers.completed', {
        models: models.length,
        durationMs: Math.round(performance.now() - startedAt)
      });
      return { ...this.profile(capabilities), models };
    } catch {
      if (generation !== this.profileGeneration) return this.profile(capabilities);
      this.profileRetryAt = Date.now() + PROFILE_FAILURE_RETRY_MS;
      this.scheduleProfileRefresh(PROFILE_FAILURE_RETRY_MS, capabilities, environment);
      nodeLog('runner.opencode.profile.providers.failed', {
        durationMs: Math.round(performance.now() - startedAt)
      });
    } finally {
      this.releaseManagedClient(client);
    }
    return stale === undefined
      ? this.profile(capabilities)
      : { ...this.profile(capabilities), models: stale.models };
  }

  available(capabilities: NodeCapabilities): boolean {
    return capabilities.openCode?.available === true;
  }

  protected profileForValidation(): RunnerProfile {
    return this.profile({
      platform: 'linux',
      architecture: 'validation',
      nodeAppVersion: 'validation',
      nodeVersion: 'validation',
      codex: { available: false },
      claudeCode: { available: false },
      openCode: { available: true }
    });
  }

  override supportsConfiguration(
    configuration: RunnerDefaultConfiguration,
    _workspace?: NodeWorkspace,
    environment: Readonly<Record<string, string>> = {}
  ): boolean {
    if (configuration.runner !== this.name) return false;
    const models = this.cachedModels(environment);
    const model = models.find((candidate) => candidate.id === configuration.model);
    return (
      model !== undefined &&
      (model.supportedEfforts.length === 0 ||
        model.supportedEfforts.includes(configuration.effort)) &&
      this.profileForValidation().accessOptions.some(
        (candidate) => candidate.id === configuration.access
      )
    );
  }

  defaultConfiguration(
    _workspace?: NodeWorkspace,
    environment: Readonly<Record<string, string>> = {}
  ): RunnerDefaultConfiguration {
    const model = this.cachedModels(environment)[0];
    return {
      runner: this.name,
      model: model?.id ?? '',
      effort: model?.supportedEfforts[0] ?? '',
      access: 'default'
    };
  }

  private cachedModels(environment: Readonly<Record<string, string>>): RunnerProfile['models'] {
    void environment;
    return this.profileCache?.models ?? [];
  }

  private scheduleProfileRefresh(
    delayMs: number,
    capabilities: NodeCapabilities,
    environment: Readonly<Record<string, string>>
  ): void {
    if (this.profileRefreshTimer !== undefined) clearTimeout(this.profileRefreshTimer);
    this.profileRefreshTimer = setTimeout(() => {
      this.profileRefreshTimer = undefined;
      void this.refreshProfile(capabilities, undefined, environment, true);
    }, delayMs);
    this.profileRefreshTimer.unref();
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
              type: 'local',
              command: [server.command!, ...(server.args ?? [])],
              environment: { ...(server.environment ?? {}) }
            }
          : {
              type: 'remote',
              url: server.url!,
              headers: { ...(server.headers ?? {}) },
              oauth: false
            }
      ])
    );
  }

  async discoverSessions(
    context: RunnerDiscoveryContext,
    workspace?: NodeWorkspace
  ): Promise<readonly NodeAgentSession[]> {
    const result: NodeAgentSession[] = [];
    for (const target of workspace === undefined ? context.workspaces : [workspace]) {
      let sessions: readonly unknown[];
      try {
        sessions = await this.client.sessions(target.path);
      } catch (error) {
        if (context.cleanup) throw error;
        continue;
      }
      for (const value of sessions) {
        const session = openCodeSession(value);
        if (
          session === undefined ||
          session.parentId !== undefined ||
          !isWithinWorkspace(session.directory, target.path)
        )
          continue;
        const title = context.cleanup
          ? { title: session.title, titleOrigin: 'OFFICIAL' as const }
          : await this.sessionTitle(session);
        result.push(
          context.createProjection({
            workspace: target,
            runner: this.name,
            externalSessionId: session.id,
            cwd: session.directory,
            title: title.title,
            titleOrigin: title.titleOrigin,
            lastActivityAt: session.updatedAt
          })
        );
      }
    }
    return result;
  }

  override async readManagedRunnerTitle(session: NodeAgentSession): Promise<string | undefined> {
    if (session.externalSessionId === null) return undefined;
    const native = openCodeSession(
      await this.client.session(session.cwd, session.externalSessionId)
    );
    if (
      native === undefined ||
      native.id !== session.externalSessionId ||
      !isWithinWorkspace(native.directory, session.cwd)
    )
      return undefined;
    return (await this.sessionTitle(native)).title;
  }

  private async sessionTitle(session: NonNullable<ReturnType<typeof openCodeSession>>): Promise<{
    readonly title: string;
    readonly titleOrigin: 'OFFICIAL' | 'PREVIEW';
  }> {
    const nativeTitle = session.title.trim();
    if (
      nativeTitle.length === 0 ||
      /^(?:new|untitled) session(?:\s*[-–—:]\s*\d{4}-\d{2}-\d{2}.*)?$/iu.test(nativeTitle)
    ) {
      try {
        const preview = await this.firstUserMessagePreview(session);
        if (preview) return { title: preview, titleOrigin: 'PREVIEW' };
      } catch (error) {
        nodeLog('runner.opencode.title.failed', {
          sessionId: session.id,
          stage: 'preview',
          code: runnerErrorProjection(error, 'OPENCODE_TITLE_PREVIEW_FAILED').code
        });
      }
    }
    return { title: session.title, titleOrigin: 'OFFICIAL' };
  }

  private async firstUserMessagePreview(
    session: NonNullable<ReturnType<typeof openCodeSession>>
  ): Promise<string | undefined> {
    const key = `${session.directory}\0${session.id}`;
    const cached = this.titlePreviews.get(key);
    if (
      cached !== undefined &&
      cached.updatedAt === session.updatedAt &&
      cached.expiresAt > Date.now()
    )
      return cached.result;
    this.titlePreviews.delete(key);
    if (this.titlePreviews.size >= MAX_TITLE_PREVIEWS)
      this.titlePreviews.delete(this.titlePreviews.keys().next().value!);
    const entry = {
      updatedAt: session.updatedAt,
      expiresAt: Date.now() + TITLE_PREVIEW_TTL_MS,
      result: (async () => {
        let before: string | undefined;
        let preview: string | undefined;
        const cursors = new Set<string>();
        for (;;) {
          const page = await this.client.messagePage(session.directory, session.id, {
            limit: 100,
            ...(before === undefined ? {} : { before })
          });
          preview = openCodeUserMessagePreview(page.messages) ?? preview;
          if (page.nextCursor === null) return preview;
          if (cursors.has(page.nextCursor)) throw new Error('OPENCODE_MESSAGE_CURSOR_INVALID');
          cursors.add(page.nextCursor);
          before = page.nextCursor;
        }
      })()
    };
    this.titlePreviews.set(key, entry);
    try {
      return await entry.result;
    } catch (error) {
      if (this.titlePreviews.get(key) === entry) this.titlePreviews.delete(key);
      throw error;
    }
  }

  async resumeExternal(
    external: NodeAgentSession,
    context: ExternalResumeContext
  ): Promise<ExternalResumeResult> {
    if (external.runner !== this.name || external.externalSessionId === null || !context.available)
      return { failureCode: 'RUNNER_UNAVAILABLE' };
    const projection = context.projectionFor(external);
    const session =
      projection === undefined ? context.create(external) : context.promote(projection.id);
    return session === undefined
      ? { failureCode: 'RUNNER_RESUME_FAILED' }
      : { activity: 'IDLE', session: context.ensureConfiguration(session) };
  }

  override async readOfficialConversation(
    session: NodeAgentSession,
    input: { readonly cursor?: string; readonly limit?: number },
    managedTurn: (
      nativeTurnId: string
    ) => import('../runtime-model.js').NodeConversationTurn | undefined
  ) {
    if (session.externalSessionId === null) return undefined;
    try {
      return openCodeConversationPage(
        session,
        await this.client.messages(session.cwd, session.externalSessionId, 500),
        input,
        managedTurn
      );
    } catch {
      return undefined;
    }
  }

  override async readConversationHistory(
    readers: RunnerConversationHistoryReaders
  ): Promise<RunnerConversationHistoryPage | undefined> {
    const official = await readers.official();
    return official === undefined ? undefined : { ...official, source: 'official' };
  }

  override managedRunForNativeTurn(nativeTurnId: string): string | undefined {
    return this.managedTurns.get(nativeTurnId);
  }

  presentSession(
    session: NodeAgentSession,
    capabilities: NodeCapabilities,
    context: RunnerSessionPresentationContext
  ): RunnerSessionPresentation {
    void capabilities;
    const activity = context.managedActive ? ('MANAGED_ACTIVE' as const) : 'IDLE';
    const runtimeCapabilities = [
      'history.read',
      'events.live',
      'turn.start',
      'turn.queue',
      'turn.interrupt',
      'run.cancel',
      'approval.respond',
      'user-input.respond',
      'session.rename',
      'session.remove',
      'session.pin',
      ...(session.externalSessionId === null ? [] : ['session.rewind'])
    ];
    return {
      activity,
      control: {
        level: 'MANAGED',
        capabilities: ['history.read', 'events.live', 'turn.start', 'turn.interrupt']
      },
      runtime: {
        level: 'MANAGED',
        capabilities: runtimeCapabilities,
        reasonCode: null
      },
      commandStates: context.commandStates
    };
  }

  override async renameNative(
    session: NodeAgentSession,
    input: { readonly title?: string | null; readonly pinned?: boolean },
    database: NodeDatabase
  ): Promise<void> {
    if (session.externalSessionId !== null && input.title !== undefined)
      await this.client.updateSession(session.cwd, session.externalSessionId, input.title ?? '');
    await super.renameNative(session, input, database);
  }

  override async removeNative(
    session: NodeAgentSession,
    nativeSessionId: string
  ): Promise<boolean> {
    await this.client.deleteSession(session.cwd, nativeSessionId);
    return true;
  }

  override async forkNative(
    session: NodeAgentSession,
    boundary: string | null,
    title: string
  ): Promise<string> {
    if (session.externalSessionId === null) throw new Error('SESSION_REWIND_UNAVAILABLE');
    const result =
      boundary === null
        ? await this.client.createSession(session.cwd, title)
        : await this.client.forkSession(session.cwd, session.externalSessionId, boundary);
    const value = object(result);
    if (typeof value?.id !== 'string') throw new Error('SESSION_REWIND_FAILED');
    if (boundary !== null) await this.client.updateSession(session.cwd, value.id, title);
    return value.id;
  }

  async executeCompact(
    session: NodeAgentSession,
    environment: Readonly<Record<string, string>>
  ): Promise<unknown> {
    if (session.externalSessionId === null || session.model === null)
      throw new Error('RUNNER_COMMAND_UNAVAILABLE');
    const client = this.managedClient(environment);
    try {
      return await client.summarize(session.cwd, session.externalSessionId, session.model);
    } finally {
      this.releaseManagedClient(client);
    }
  }

  async readContextUsage(session: NodeAgentSession) {
    if (session.externalSessionId === null) return undefined;
    const messages = await this.client.messages(session.cwd, session.externalSessionId, 100);
    const assistants = messages.flatMap((value) => {
      const entry = object(value);
      const info = object(entry?.info);
      return info?.role === 'assistant' ? [info] : [];
    });
    const latest = assistants.at(-1);
    const provider = typeof latest?.providerID === 'string' ? latest.providerID : undefined;
    const model = typeof latest?.modelID === 'string' ? latest.modelID : undefined;
    const tokens = object(latest?.tokens);
    const cache = object(tokens?.cache);
    const usedTokens = positiveNumber(tokens?.input) + positiveNumber(cache?.read);
    const modelId =
      provider !== undefined && model !== undefined ? `${provider}/${model}` : session.model;
    if (modelId === null || usedTokens <= 0) return undefined;
    const maxTokens =
      Date.now() >= this.contextLimitsExpiresAt ? undefined : this.contextLimits.get(modelId);
    return maxTokens === undefined ? undefined : { model: modelId, usedTokens, maxTokens };
  }

  async stop(): Promise<void> {
    this.profileGeneration += 1;
    for (const execution of this.execution.values()) execution.abort.abort();
    this.execution.clear();
    this.managedTurns.clear();
    this.titlePreviews.clear();
    this.profileCache = undefined;
    this.profileRefresh = undefined;
    if (this.profileRefreshTimer !== undefined) clearTimeout(this.profileRefreshTimer);
    this.profileRefreshTimer = undefined;
    this.profileRetryAt = 0;
    this.contextLimits = new Map();
    this.contextLimitsExpiresAt = 0;
    const stopping = [
      this.client.stop(),
      ...[...this.environmentClients.values()].map(({ client }) => client.stop()),
      ...this.stoppingClients
    ];
    this.environmentClients.clear();
    await Promise.allSettled(stopping);
    this.stoppingClients.clear();
  }

  managedClient(
    environment: Readonly<Record<string, string>>,
    isolationKey?: string
  ): OpenCodeServerClient {
    const entries = Object.entries(environment).sort(([left], [right]) =>
      left.localeCompare(right)
    );
    if (entries.length === 0 && isolationKey === undefined) return this.client;
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ entries, isolationKey }))
      .digest('hex');
    const existing = this.environmentClients.get(fingerprint);
    if (existing !== undefined) {
      existing.leases += 1;
      return existing.client;
    }
    const client = this.clientFactory();
    client.configureEnvironment(environment);
    this.environmentClients.set(fingerprint, { client, leases: 1 });
    return client;
  }

  releaseManagedClient(client: OpenCodeServerClient): void {
    if (client === this.client) return;
    for (const [fingerprint, entry] of this.environmentClients) {
      if (entry.client !== client) continue;
      entry.leases -= 1;
      if (entry.leases <= 0) {
        const stopping = entry.client.stop();
        this.stoppingClients.add(stopping);
        void stopping.finally(() => this.stoppingClients.delete(stopping));
        this.environmentClients.delete(fingerprint);
      }
      return;
    }
  }
}

async function withProfileTimeout<T>(operation: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('OPENCODE_PROFILE_REFRESH_TIMEOUT')),
          PROFILE_REFRESH_TIMEOUT_MS
        );
        timer.unref();
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function positiveNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function openCodeSession(value: unknown):
  | {
      readonly id: string;
      readonly directory: string;
      readonly title: string;
      readonly updatedAt: number;
      readonly parentId?: string;
    }
  | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const time =
    typeof record.time === 'object' && record.time !== null
      ? (record.time as Record<string, unknown>)
      : undefined;
  if (
    typeof record.id !== 'string' ||
    typeof record.directory !== 'string' ||
    typeof record.title !== 'string'
  )
    return undefined;
  return {
    id: record.id,
    directory: record.directory,
    title: record.title,
    updatedAt: typeof time?.updated === 'number' ? time.updated : 0,
    ...(typeof record.parentID === 'string' && record.parentID.length > 0
      ? { parentId: record.parentID }
      : {})
  };
}
