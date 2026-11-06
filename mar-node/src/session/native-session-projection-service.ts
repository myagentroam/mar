import type { NodeCapabilities, RunnerDefaultConfiguration } from '@myagentroam/protocol';
import type { RunnerSessionControl } from '../runner/contracts.js';
import type { NativeSessionProjectionStore, NodeAgentSession } from './contracts.js';
import type { AgentSessionLookup, NodeRuntimeState } from '../runtime-state.js';
import type { RunnerRegistry } from '../runner/runner-registry.js';
import type { RunnerDiscoveryContext } from '../runner/contracts.js';
import type { CommandStateStore } from '../runner-command-engine.js';
import { deduplicateDirectSessions } from './runner-native-session-parsers.js';

interface NativeSessionProjectionServiceOptions {
  readonly database: () => NativeSessionProjectionStore | undefined;
  readonly nodeId: () => string;
  readonly runtime: NodeRuntimeState;
  readonly runners: RunnerRegistry;
  readonly capabilities: () => NodeCapabilities;
  readonly commands: CommandStateStore;
  readonly releaseResumeState: (
    directIds: ReadonlySet<string>,
    projectionIds: ReadonlySet<string>
  ) => void;
  readonly present: (
    session: NodeAgentSession
  ) => NodeAgentSession & { readonly control: RunnerSessionControl };
}

/** Owns native identity/metadata projection, not Runner execution.
 * Discovery borrows its caller's lifetime; cancellation revokes database projection before
 * releasing the wait on a third-party read that may not itself support interruption.
 */
export class NativeSessionProjectionService {
  private readonly directNative = new Map<string, NodeAgentSession>();

  cachedNative(): readonly NodeAgentSession[] {
    return [...this.directNative.values()];
  }
  constructor(private readonly options: NativeSessionProjectionServiceOptions) {}

  async discover(
    runnerName: NodeAgentSession['runner'],
    workspaceId?: string,
    cleanup = false,
    signal?: AbortSignal
  ): Promise<readonly NodeAgentSession[]> {
    signal?.throwIfAborted();
    const database = this.requireDatabase();
    const workspace = workspaceId === undefined ? undefined : database.getWorkspace(workspaceId);
    if (workspaceId !== undefined && workspace === undefined)
      throw new Error('WORKSPACE_NOT_FOUND');
    const runner = this.options.runners.product(runnerName);
    if (runner === undefined || !runner.available(this.options.capabilities()))
      throw new Error('RUNNER_UNAVAILABLE');
    const sessions = await awaitDiscovery(
      runner.discoverSessions(
        {
          ...(signal === undefined ? {} : { signal }),
          ...(cleanup ? { cleanup: true } : {}),
          workspaces: database.listWorkspaces(),
          createProjection: (input) => {
            signal?.throwIfAborted();
            return this.project(input);
          }
        },
        workspace
      ),
      signal
    );
    signal?.throwIfAborted();
    const ordered = deduplicateDirectSessions(sessions);
    if (!cleanup) {
      this.remember(ordered);
      return ordered.flatMap((session) => {
        const accepted = this.directNative.get(session.id);
        return accepted === undefined ? [] : [accepted];
      });
    }
    const candidates = new Map(ordered.map((session) => [session.id, session]));
    return ordered.flatMap((session) => {
      const record = database.getSessionRecord(session.id);
      if (record === undefined && !this.validParent(session, candidates)) return [];
      return [
        {
          ...session,
          parentSessionId:
            record === undefined
              ? (session.parentSessionId ?? null)
              : (record.metadata.parentSessionId ?? null)
        }
      ];
    });
  }

  async discoverCodex(workspaceId?: string): Promise<{
    readonly sessions: readonly (NodeAgentSession & { readonly control: RunnerSessionControl })[];
  }> {
    const sessions = await this.discover('codex', workspaceId);
    return { sessions: sessions.map(this.options.present) };
  }

  async list(): Promise<
    readonly (NodeAgentSession & { readonly control: RunnerSessionControl })[]
  > {
    const discovered = await Promise.all(
      this.options.runners
        .advertised()
        .filter((runner) => runner.available(this.options.capabilities()))
        .map((runner) => this.discover(runner.name as NodeAgentSession['runner']))
    );
    const sessions = deduplicateDirectSessions(discovered.flat());
    this.remember(sessions);
    return sessions.map(this.options.present);
  }

  async discoverWorkspace(
    workspaceId: string,
    onRunnerDiscovered?: (
      runner: NodeAgentSession['runner'],
      sessions: readonly NodeAgentSession[]
    ) => void,
    cleanup = false,
    signal?: AbortSignal
  ): Promise<readonly NodeAgentSession[]> {
    signal?.throwIfAborted();
    const discovered = await Promise.allSettled(
      this.options.runners
        .advertised()
        .filter((runner) => runner.available(this.options.capabilities()))
        .map(async (runner) => {
          const name = runner.name as NodeAgentSession['runner'];
          const sessions = await this.discover(name, workspaceId, cleanup, signal);
          signal?.throwIfAborted();
          onRunnerDiscovered?.(name, sessions);
          return sessions;
        })
    );
    signal?.throwIfAborted();
    const failed = discovered.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    const sessions = deduplicateDirectSessions(
      discovered.flatMap((result) => (result.status === 'fulfilled' ? result.value : []))
    );
    if (!cleanup) this.remember(sessions);
    return sessions;
  }

  async resolve(sessionId: string, registeredOnly = false): Promise<NodeAgentSession | undefined> {
    const cached = this.directNative.get(sessionId);
    if (cached !== undefined) return cached;
    const database = this.options.database();
    const record = database?.getSessionRecord(sessionId);
    if (record === undefined)
      return registeredOnly
        ? undefined
        : (await this.list()).find((session) => session.id === sessionId);
    const workspace = database?.getWorkspace(record.workspaceId);
    if (workspace === undefined) return undefined;
    return {
      id: record.id,
      nodeId: this.options.nodeId(),
      workspaceId: record.workspaceId,
      runner: record.runner,
      externalSessionId: record.id,
      nativeControl: 'EXTERNAL',
      channelToken: null,
      cwd: workspace.path,
      modelId: record.metadata.modelId,
      effort: record.metadata.effort,
      access: record.metadata.access,
      customTitle: record.metadata.customTitle,
      parentSessionId: record.metadata.parentSessionId ?? null,
      sessionPrompt: record.metadata.sessionPrompt ?? null,
      runnerTitle: record.metadata.runnerTitle,
      pinnedAt: record.pinOrder === null ? null : 1,
      pinOrder: record.pinOrder,
      externalDiscovered: false,
      titleSource: record.metadata.customTitle === null ? 'RUNNER' : 'CUSTOM',
      lastActivityAt: 0,
      createdAt: 0
    };
  }

  async resolveCurrent(sessionId: string): Promise<NodeAgentSession | undefined> {
    const direct = await this.resolve(sessionId);
    return direct === undefined ? undefined : (this.projectionForNative(direct) ?? direct);
  }

  async createMetadataProjection(sessionId: string): Promise<NodeAgentSession | undefined> {
    const direct = await this.resolve(sessionId);
    if (direct === undefined || direct.externalSessionId === null) return undefined;
    const existing = this.options.runtime.findAgentSessionByExternalSession(
      direct.runner,
      direct.externalSessionId
    );
    if (existing !== undefined && existing.workspaceId === direct.workspaceId) return existing;
    return this.options.runtime.createAgentSession({
      workspaceId: direct.workspaceId,
      runner: direct.runner,
      externalSessionId: direct.externalSessionId,
      nativeControl: 'EXTERNAL',
      cwd: direct.cwd,
      createdAt: direct.createdAt,
      lastActivityAt: direct.lastActivityAt,
      ...(direct.modelId === null ? {} : { modelId: direct.modelId }),
      ...(direct.effort === null ? {} : { effort: direct.effort }),
      ...(direct.access === null ? {} : { access: direct.access }),
      ...(direct.runnerTitle === null ? {} : { title: direct.runnerTitle }),
      ...(direct.customTitle === null ? {} : { customTitle: direct.customTitle }),
      sessionPrompt: direct.sessionPrompt ?? null,
      parentSessionId: direct.parentSessionId ?? null
    });
  }

  resumedConfiguration(session: NodeAgentSession): RunnerDefaultConfiguration {
    const workspace = this.options.database()?.getWorkspace(session.workspaceId);
    const runner = this.options.runners.require(session.runner);
    const saved = this.options
      .database()
      ?.getRunnerDefaults()
      .find((value) => value.runner === session.runner);
    const fallback = saved ?? runner.defaultConfiguration(workspace);
    const configuration: RunnerDefaultConfiguration = {
      runner: session.runner,
      modelId:
        typeof session.modelId === 'string' && session.modelId.trim().length > 0
          ? session.modelId
          : fallback.modelId,
      effort: typeof session.effort === 'string' ? session.effort : fallback.effort,
      access: runner.restoreStoredAccess(session.access, fallback.access)
    };
    return configuration;
  }

  ensureResumedConfiguration(session: NodeAgentSession): NodeAgentSession {
    const configuration = this.resumedConfiguration(session);
    if (
      session.modelId === configuration.modelId &&
      session.effort === configuration.effort &&
      session.access === configuration.access
    )
      return session;
    return this.options.runtime.updateAgentSessionConfiguration({
      sessionId: session.id,
      modelId: configuration.modelId,
      effort: configuration.effort,
      access: configuration.access
    });
  }

  async rename(
    session: NodeAgentSession,
    input: { readonly title?: string | null; readonly pinned?: boolean }
  ): Promise<void> {
    if (session.externalSessionId === null) return;
    const runner = this.options.runners.require(session.runner);
    const database = this.requireDatabase();
    await runner.renameNative(session, input);
    const runnerTitle = runner.usesRunnerTitleForRename();
    database.saveNativeSessionMetadata({
      runner: session.runner,
      externalSessionId: session.externalSessionId,
      workspaceId: session.workspaceId,
      ...(input.title === undefined
        ? {}
        : runnerTitle
          ? {
              runnerTitle: input.title,
              runnerTitlePending: input.title !== null && input.title.trim().length > 0
            }
          : { customTitle: input.title }),
      ...(input.pinned === undefined ? {} : { pinned: input.pinned })
    });
  }

  project(input: Parameters<RunnerDiscoveryContext['createProjection']>[0]): NodeAgentSession {
    const timestamp = input.lastActivityAt ?? 0;
    const database = this.options.database();
    const metadata = database?.getNativeSessionMetadata(
      input.runner,
      input.externalSessionId,
      input.workspace.id
    );
    const projection = this.options.runners.require(input.runner).projectedRunnerTitle(metadata, {
      externalSessionId: input.externalSessionId,
      workspaceId: input.workspace.id,
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.titleOrigin === undefined ? {} : { titleOrigin: input.titleOrigin })
    });
    if (projection.clearPending) {
      database?.saveNativeSessionMetadata({
        runner: input.runner,
        externalSessionId: input.externalSessionId,
        workspaceId: input.workspace.id,
        runnerTitle: projection.title,
        runnerTitlePending: false
      });
    }
    const runnerTitle = projection.title;
    return {
      id: input.externalSessionId,
      nodeId: this.options.nodeId(),
      workspaceId: input.workspace.id,
      runner: input.runner,
      externalSessionId: input.externalSessionId,
      nativeControl: 'EXTERNAL',
      channelToken: null,
      cwd: input.cwd,
      modelId: metadata?.modelId ?? null,
      effort: metadata?.effort ?? null,
      access: metadata?.access ?? null,
      customTitle: metadata?.customTitle ?? null,
      sessionPrompt: metadata?.sessionPrompt ?? null,
      parentSessionId:
        metadata === undefined
          ? (input.parentSessionId ?? null)
          : (metadata.parentSessionId ?? null),
      runnerTitle,
      pinnedAt: metadata?.pinnedAt ?? null,
      pinOrder: metadata?.pinOrder ?? null,
      externalDiscovered: true,
      titleSource:
        metadata?.customTitle === null || metadata?.customTitle === undefined
          ? runnerTitle === null
            ? 'AUTO'
            : input.titleOrigin === 'PREVIEW'
              ? 'AUTO'
              : 'RUNNER'
          : 'CUSTOM',
      lastActivityAt: timestamp,
      createdAt: timestamp
    };
  }

  private validParent(
    session: NodeAgentSession,
    candidates: ReadonlyMap<string, NodeAgentSession>
  ): boolean {
    const database = this.options.database();
    const visited = new Set([session.id]);
    let parentId = session.parentSessionId ?? null;
    let depth = 1;
    while (parentId !== null) {
      if (visited.has(parentId) || ++depth > 3) return false;
      visited.add(parentId);
      const stored = database?.getSessionRecord(parentId);
      const candidate = stored === undefined ? candidates.get(parentId) : undefined;
      if ((stored?.workspaceId ?? candidate?.workspaceId) !== session.workspaceId) return false;
      parentId =
        stored === undefined
          ? (candidate?.parentSessionId ?? null)
          : (stored.metadata.parentSessionId ?? null);
    }
    return true;
  }

  remember(sessions: readonly NodeAgentSession[]): void {
    const database = this.options.database();
    const candidates = new Map(sessions.map((session) => [session.id, session]));
    const valid = new Map(
      sessions.map((session) => [session.id, this.validParent(session, candidates)])
    );
    const accepted = sessions.flatMap((proposed) => {
      const metadata =
        database === undefined || proposed.externalSessionId === null
          ? undefined
          : database.getNativeSessionMetadata(
              proposed.runner,
              proposed.externalSessionId,
              proposed.workspaceId
            );
      if (
        metadata === undefined &&
        proposed.parentSessionId != null &&
        (database === undefined || !valid.get(proposed.id))
      )
        return [];
      const parentSessionId =
        metadata !== undefined
          ? (metadata.parentSessionId ?? null)
          : database !== undefined && valid.get(proposed.id)
            ? (proposed.parentSessionId ?? null)
            : null;
      return [{ ...proposed, parentSessionId }];
    });
    const acceptedById = new Map(accepted.map((session) => [session.id, session]));
    const ordered: NodeAgentSession[] = [];
    const visited = new Set<string>();
    const visit = (session: NodeAgentSession): void => {
      if (visited.has(session.id)) return;
      visited.add(session.id);
      const parent =
        session.parentSessionId == null ? undefined : acceptedById.get(session.parentSessionId);
      if (parent !== undefined) visit(parent);
      ordered.push(session);
    };
    for (const session of accepted) visit(session);
    for (const session of ordered) {
      this.directNative.set(session.id, session);
      if (database === undefined || session.externalSessionId === null) continue;
      const metadata = database.getNativeSessionMetadata(
        session.runner,
        session.externalSessionId,
        session.workspaceId
      );
      const title = session.runnerTitle?.trim().slice(0, 160) || undefined;
      if (
        metadata === undefined ||
        (title !== undefined && title !== metadata.runnerTitle && !metadata.runnerTitlePending)
      )
        database.saveNativeSessionMetadata({
          runner: session.runner,
          externalSessionId: session.externalSessionId,
          workspaceId: session.workspaceId,
          ...(metadata === undefined && session.parentSessionId != null
            ? { parentSessionId: session.parentSessionId }
            : {}),
          ...(title === undefined || metadata?.runnerTitlePending ? {} : { runnerTitle: title })
        });
    }
  }

  similarSessionDetails(sessionId: string, workspaceId: string): string | undefined {
    if (sessionId.length < 8 || sessionId.length > 128) return undefined;
    const records = this.options.database()?.listSessionRecords(workspaceId) ?? [];
    const recordById = new Map(records.map((record) => [record.id, record]));
    const known = new Map(
      records.map((record) => [
        record.id,
        record.metadata.customTitle ?? record.metadata.runnerTitle ?? 'Untitled session'
      ])
    );
    for (const session of [
      ...this.directNative.values(),
      ...this.options.runtime.listAgentSessions()
    ]) {
      if (session.workspaceId !== workspaceId) continue;
      const metadata = recordById.get(session.id)?.metadata;
      known.set(
        session.id,
        metadata?.customTitle ??
          session.customTitle ??
          session.runnerTitle ??
          metadata?.runnerTitle ??
          'Untitled session'
      );
    }
    const maximum = Math.min(3, Math.floor(sessionId.length / 8));
    const candidates = [...known]
      .map(([id, title]) => ({
        id,
        title,
        distance: sessionIdDistance(sessionId.toLowerCase(), id.toLowerCase(), maximum)
      }))
      .filter((candidate) => candidate.distance <= maximum)
      .sort((left, right) => left.distance - right.distance || left.id.localeCompare(right.id))
      .slice(0, 3);
    return candidates.length === 0
      ? undefined
      : [
          'Similar Sessions (suggestions only; no action was redirected):',
          ...candidates.map(
            ({ id, title }) =>
              // eslint-disable-next-line no-control-regex -- Strip ASCII controls from user titles.
              id + ' ' + title.replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 160)
          )
        ].join('\n');
  }

  projectionForNative(native: NodeAgentSession): NodeAgentSession | undefined {
    return this.resolveNativeProjection(native, this.options.runtime, false);
  }

  projectionsForNative(
    native: readonly NodeAgentSession[],
    lookup: AgentSessionLookup = this.options.runtime.createSessionLookup()
  ): ReadonlyMap<NodeAgentSession, NodeAgentSession | undefined> {
    return new Map(
      native.map((session) => [session, this.resolveNativeProjection(session, lookup, false)])
    );
  }

  managedForNative(native: NodeAgentSession): NodeAgentSession | undefined {
    return this.resolveNativeProjection(native, this.options.runtime, true);
  }

  private resolveNativeProjection(
    native: NodeAgentSession,
    lookup: AgentSessionLookup,
    managedOnly: boolean
  ): NodeAgentSession | undefined {
    if (native.externalSessionId === null) return undefined;
    const exact = lookup.findAgentSessionByExternalSession(
      native.runner,
      native.externalSessionId,
      native.workspaceId
    );
    if (
      exact !== undefined &&
      exact.runner === native.runner &&
      exact.workspaceId === native.workspaceId &&
      exact.externalSessionId === native.externalSessionId &&
      (!managedOnly || exact.nativeControl === 'MAR_MANAGED')
    )
      return exact;
    const aliasId = this.options.runners
      .require(native.runner)
      .managedAliasId(native.externalSessionId);
    const alias = aliasId === undefined ? undefined : lookup.getAgentSessionById(aliasId);
    // The Runner supplied the verified alias; Runtime may have promoted its old ID.
    return alias !== undefined &&
      alias.nativeControl === 'MAR_MANAGED' &&
      alias.runner === native.runner &&
      alias.workspaceId === native.workspaceId
      ? alias
      : undefined;
  }

  nativeIds(session: NodeAgentSession): ReadonlySet<string> {
    const ids = new Set<string>();
    if (session.externalSessionId !== null) ids.add(session.externalSessionId);
    for (const nativeId of this.options.runners
      .require(session.runner)
      .nativeAliasesFor(session.id))
      ids.add(nativeId);
    return ids;
  }

  forget(session: NodeAgentSession, knownNativeIds: ReadonlySet<string>): void {
    const projectionIds = new Set<string>([session.id]);
    const nativeIds = new Set(knownNativeIds);
    const runner = this.options.runners.require(session.runner);
    for (const nativeId of runner.nativeAliasesFor(session.id)) {
      const managedId = runner.managedAliasId(nativeId);
      if (managedId !== undefined && (nativeIds.has(nativeId) || managedId === session.id)) {
        projectionIds.add(managedId);
        nativeIds.add(nativeId);
        runner.forgetNativeAlias(nativeId);
      }
    }
    const directIds = new Set<string>();
    for (const [directId, direct] of this.directNative) {
      if (
        direct.runner === session.runner &&
        direct.cwd === session.cwd &&
        direct.externalSessionId !== null &&
        nativeIds.has(direct.externalSessionId)
      ) {
        directIds.add(directId);
        this.directNative.delete(directId);
      }
    }
    for (const projectionId of projectionIds) {
      if (this.options.runtime.getAgentSession(projectionId) !== undefined)
        this.options.runtime.removeAgentSession(projectionId);
      this.options.commands.removeSession(projectionId);
    }
    this.options.releaseResumeState(directIds, projectionIds);
  }

  private requireDatabase(): NativeSessionProjectionStore {
    const database = this.options.database();
    if (database === undefined) throw new Error('NODE_DATABASE_UNAVAILABLE');
    return database;
  }
}

/** The callback capability is revoked by discover(); late SDK outcomes are still consumed. */
function awaitDiscovery(
  read: Promise<readonly NodeAgentSession[]>,
  signal?: AbortSignal
): Promise<readonly NodeAgentSession[]> {
  if (signal === undefined) return read;
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    read.then(
      (sessions) => {
        signal.removeEventListener('abort', abort);
        resolve(sessions);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      }
    );
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

function sessionIdDistance(left: string, right: string, maximum: number): number {
  if (Math.abs(left.length - right.length) > maximum) return maximum + 1;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1)
      current[column] = Math.min(
        current[column - 1]! + 1,
        previous[column]! + 1,
        previous[column - 1]! + (left[row - 1] === right[column - 1] ? 0 : 1)
      );
    if (Math.min(...current) > maximum) return maximum + 1;
    previous = current;
  }
  return previous[right.length]!;
}
