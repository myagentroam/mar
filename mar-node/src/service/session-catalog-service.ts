import type { NodeOperationHandler } from '../connector/node-operation-router.js';
import { sessionGroup } from './session-presentation-service.js';
import type { NodeAgentSession, NodeDatabase } from '../database.js';
import type { NodeConversationTurn } from '../runtime-model.js';
import { removeNativeSession } from '../native-session-history.js';
import { nodeLog } from '../operational.js';
import type { NodeRuntimeState } from '../runtime-state.js';
import { isTerminalRunStatus, sessionPage } from '../util/node-operation-parsers.js';
import type { NativeSessionProjectionService } from './native-session-projection-service.js';
import type { RunnerRegistry } from '../runner/runner-registry.js';
import { latestSessionActivityAt } from './session-presentation-service.js';
import { marctlSessionSummary } from './session-recent-activity.js';

interface SessionCatalogServiceOptions {
  readonly resolveExecutionDirectory?: (session: NodeAgentSession) => Promise<string>;
  readonly database: () => NodeDatabase;
  readonly nodeId: () => string;
  readonly runtime: NodeRuntimeState;
  readonly runners: RunnerRegistry;
  readonly runnerAvailable: (runner: NodeAgentSession['runner']) => boolean;
  readonly projection: NativeSessionProjectionService;
  readonly cachedNative: () => readonly NodeAgentSession[];
  readonly cachedWorkspace: (workspaceId: string) => Promise<readonly NodeAgentSession[]>;
  readonly discoveryPending: (workspaceId: string) => boolean;
  readonly discoverWorkspace: (workspaceId: string) => Promise<readonly NodeAgentSession[]>;
  readonly present: (session: NodeAgentSession) => NodeAgentSession;
  readonly nativeIds: (session: NodeAgentSession) => ReadonlySet<string>;
  readonly forget: (session: NodeAgentSession, nativeIds: ReadonlySet<string>) => void;
  readonly refreshActivity: (session: NodeAgentSession) => Promise<void>;
  readonly externalActivity: (sessionId: string) => unknown;
  readonly isWatching: (sessionId: string) => boolean;
  readonly isRecovering?: (sessionId: string) => boolean;
  readonly history: (
    session: NodeAgentSession,
    input: { readonly cursor?: string; readonly limit?: number }
  ) => Promise<{
    readonly turns: readonly NodeConversationTurn[];
    readonly nextCursor: string | null;
  }>;
  readonly invalidateHistory: (sessionId: string, workspaceId: string) => void;
  readonly invalidateWorkspaceSessions: (workspaceId: string) => void;
  readonly emitSession: (session: NodeAgentSession) => void;
}

export class SessionCatalogService {
  private rewindQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: SessionCatalogServiceOptions) {}

  operations(): Readonly<Record<string, NodeOperationHandler>> {
    return {
      'session.list': (data) => this.list(record(data)),
      'session.graph': (data) => this.graph(record(data)),
      'session.remove': (data) => this.enqueueMutation(() => this.remove(record(data))),
      'workspace.sessions.cleanup': (data) =>
        this.enqueueMutation(() => this.cleanupWorkspaceSessions(record(data))),
      'session.rewind': (data) => this.enqueueMutation(() => this.rewind(record(data))),
      'session.rollback': (data) => this.enqueueMutation(() => this.rollback(record(data)))
    };
  }

  private async list(input: Record<string, unknown>): Promise<unknown> {
    if (
      input.sessionGroup !== undefined &&
      input.sessionGroup !== 'MAIN' &&
      input.sessionGroup !== 'CHILD'
    )
      throw new Error('SESSION_INVALID');
    const sessions = await this.collect(input);
    const runningCounts = { MAIN: 0, CHILD: 0 };
    for (const session of sessions)
      if ('activity' in session && session.activity === 'MANAGED_ACTIVE')
        runningCounts[sessionGroup(session)] += 1;
    const query =
      typeof input.query === 'string'
        ? input.query.trim().normalize('NFKC').toLocaleLowerCase()
        : '';
    const page = sessionPage(
      sessions.filter(
        (session) =>
          (input.parentSessionId === undefined ||
            session.parentSessionId === input.parentSessionId) &&
          (input.sessionGroup === undefined || sessionGroup(session) === input.sessionGroup) &&
          (query.length === 0 ||
            (session.customTitle ?? session.runnerTitle ?? '')
              .normalize('NFKC')
              .toLocaleLowerCase()
              .includes(query))
      ),
      input
    );
    return input.view === 'marctl'
      ? {
          view: 'marctl',
          sessions: page.sessions.map((session) =>
            marctlSessionSummary(this.options.runtime, session)
          ),
          nextCursor: page.nextCursor
        }
      : { ...page, runningCounts };
  }

  private async graph(input: Record<string, unknown>): Promise<unknown> {
    if (typeof input.workspaceId !== 'string') throw new Error('WORKSPACE_NOT_FOUND');
    if (typeof input.sessionId !== 'string') throw new Error('SESSION_INVALID');
    const limit = input.limit === undefined ? 100 : input.limit;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error('SESSION_INVALID');
    const sessions = await this.collect({ workspaceId: input.workspaceId, registeredOnly: true });
    const root = sessions.find((session) => session.id === input.sessionId);
    if (root === undefined) throw new Error('SESSION_NOT_FOUND');
    const children = new Map<string, NodeAgentSession[]>();
    for (const session of sessions) {
      if (session.parentSessionId == null) continue;
      const siblings = children.get(session.parentSessionId) ?? [];
      siblings.push(session);
      children.set(session.parentSessionId, siblings);
    }
    const queue = [root];
    const visited = new Set([root.id]);
    const nodes = [];
    for (let index = 0; index < queue.length && index < limit; index += 1) {
      const session = queue[index]!;
      nodes.push({
        id: session.id,
        parentSessionId: session.parentSessionId ?? null,
        title: session.customTitle ?? session.runnerTitle ?? 'Untitled session',
        runner: session.runner,
        ...('activity' in session ? { activity: session.activity } : {})
      });
      for (const child of children.get(session.id) ?? []) {
        if (visited.has(child.id)) continue;
        visited.add(child.id);
        queue.push(child);
      }
    }
    return { rootSessionId: root.id, nodes, truncated: queue.length > nodes.length };
  }

  private async collect(input: Record<string, unknown>): Promise<NodeAgentSession[]> {
    const workspaceId = typeof input.workspaceId === 'string' ? input.workspaceId : undefined;
    const registeredOnly = input.registeredOnly === true;
    if (registeredOnly && workspaceId === undefined) throw new Error('WORKSPACE_NOT_FOUND');
    const query =
      typeof input.query === 'string' && input.query.trim().length > 0
        ? input.query.trim().normalize('NFKC').toLocaleLowerCase()
        : undefined;
    const nativeSessions =
      registeredOnly || workspaceId === undefined
        ? this.options.cachedNative()
        : query === undefined
          ? await this.options.cachedWorkspace(workspaceId)
          : await this.options.discoverWorkspace(workspaceId);
    const inWorkspace = (session: NodeAgentSession) =>
      workspaceId === undefined || session.workspaceId === workspaceId;
    const native = nativeSessions
      .filter(inWorkspace)
      .map((session) => ({ ...session, externalDiscovered: true }));
    const projections = this.options.projection.projectionsForNative(native);
    const sources = new Map<string, NodeAgentSession>();
    for (const candidate of native) {
      const projection = projections.get(candidate);
      if (projection !== undefined && !sources.has(projection.id))
        sources.set(projection.id, candidate);
    }
    const projected = this.options.runtime
      .listAgentSessions()
      .filter(inWorkspace)
      .filter(
        (session) =>
          session.nativeControl === 'MAR_MANAGED' ||
          (session.nativeControl === 'EXTERNAL' && session.externalSessionId !== null)
      )
      .map((session) => {
        const source = sources.get(session.id);
        const synchronized =
          session.titleSource !== 'AUTO' ||
          source?.runnerTitle === undefined ||
          source.runnerTitle === null
            ? session
            : source.titleSource === 'AUTO'
              ? this.options.runtime.setTemporaryTitleIfMissing(session.id, source.runnerTitle)
              : this.options.runtime.setRunnerTitleFromNative(session.id, source.runnerTitle);
        return this.options.present(
          source === undefined
            ? synchronized
            : {
                ...synchronized,
                pinnedAt: source.pinnedAt,
                pinOrder: source.pinOrder ?? null,
                externalDiscovered: true,
                lastActivityAt: latestSessionActivityAt(
                  synchronized.lastActivityAt,
                  source.lastActivityAt
                )
              }
        );
      });
    const merged = new Map(
      [
        ...projected,
        ...native
          .filter(
            (candidate) =>
              candidate.externalSessionId === null || projections.get(candidate) === undefined
          )
          .map((session) => this.options.present(session))
      ].map((session) => [session.id, session] as const)
    );
    if (workspaceId !== undefined)
      this.mergePersisted(
        merged,
        workspaceId,
        !registeredOnly && query === undefined && this.options.discoveryPending(workspaceId)
      );
    const sessions = [...merged.values()];
    return workspaceId === undefined
      ? sessions
      : sessions.filter((session) => session.workspaceId === workspaceId);
  }

  private mergePersisted(
    merged: Map<string, NodeAgentSession>,
    workspaceId: string,
    discoveryPending: boolean
  ): void {
    const database = this.options.database();
    const workspace = database.getWorkspace(workspaceId);
    if (workspace === undefined) throw new Error('WORKSPACE_NOT_FOUND');
    for (const persisted of database.listSessionRecords(workspaceId)) {
      if (merged.has(persisted.id)) continue;
      // A metadata record alone does not establish a discovered native Session.
      if (discoveryPending) continue;
      merged.set(
        persisted.id,
        this.options.present({
          id: persisted.id,
          nodeId: this.options.nodeId(),
          workspaceId,
          runner: persisted.runner,
          externalSessionId: persisted.id,
          nativeControl: 'EXTERNAL',
          channelToken: null,
          cwd: workspace.path,
          model: persisted.metadata.model,
          effort: persisted.metadata.effort,
          access: persisted.metadata.access,
          customTitle: persisted.metadata.customTitle,
          sessionPrompt: persisted.metadata.sessionPrompt ?? null,
          parentSessionId: persisted.metadata.parentSessionId ?? null,
          runnerTitle: persisted.metadata.runnerTitle,
          pinnedAt: persisted.pinOrder === null ? null : 1,
          pinOrder: persisted.pinOrder,
          externalDiscovered: false,
          titleSource: persisted.metadata.customTitle === null ? 'RUNNER' : 'CUSTOM',
          lastActivityAt: 0,
          createdAt: 0
        })
      );
    }
  }

  private enqueueMutation(operation: () => Promise<unknown>): Promise<unknown> {
    const result = this.rewindQueue.then(operation);
    this.rewindQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async rollback(input: Record<string, unknown>): Promise<unknown> {
    if (
      !validRewindId(input.sessionId, 128) ||
      !validRewindId(input.turnId, 128) ||
      (input.boundary !== null && !validRewindId(input.boundary, 256))
    )
      throw new Error('SESSION_ROLLBACK_INVALID');
    const source =
      this.options.runtime.getAgentSession(input.sessionId) ??
      (await this.options.projection.resolve(input.sessionId));
    if (source === undefined) throw new Error('SESSION_NOT_FOUND');
    const runner = this.options.runners.require(source.runner);
    if (!runner.supportsRollback(source)) throw new Error('SESSION_ROLLBACK_UNAVAILABLE');
    if (
      this.options.runtime
        .listRunsForSession(source.id)
        .some((run) => !isTerminalRunStatus(run.status))
    )
      throw new Error('SESSION_ACTIVE');
    if (this.options.runtime.sessionQueue(source.id).itemIds.length > 0)
      throw new Error('SESSION_QUEUE_NOT_EMPTY');

    const turn = await this.findTurn(source, input.turnId);
    const userMessage = turn?.items.find(
      (item) => item.kind === 'user_message' && item.status === 'COMPLETED'
    );
    if (
      turn === undefined ||
      !terminalConversationStatus(turn.status) ||
      userMessage === undefined ||
      turn.rewind?.before !== input.boundary
    )
      throw new Error('SESSION_ROLLBACK_TARGET_INVALID');
    const releaseMutation = this.options.runtime.beginSessionHistoryMutation(source.id);
    try {
      const lastActivityAt = await runner.rollbackNative(
        source,
        input.boundary as string | null,
        turn.rewind?.after
      );
      const runtimeSession = this.options.runtime.getAgentSession(source.id);
      const session =
        runtimeSession === undefined
          ? { ...source, lastActivityAt }
          : this.options.runtime.resetAgentSessionHistory(runtimeSession.id, lastActivityAt);
      this.options.projection.remember([session]);
      this.options.invalidateHistory(session.id, session.workspaceId);
      this.options.invalidateWorkspaceSessions(session.workspaceId);
      this.options.emitSession(session);
      return { session: this.options.present(session) };
    } finally {
      releaseMutation();
    }
  }

  private async rewind(input: Record<string, unknown>): Promise<unknown> {
    if (
      !validRewindId(input.sessionId, 128) ||
      !validRewindId(input.turnId, 128) ||
      (input.position !== 'BEFORE' && input.position !== 'AFTER') ||
      (input.boundary !== null && !validRewindId(input.boundary, 256))
    )
      throw new Error('SESSION_REWIND_INVALID');
    const source =
      this.options.runtime.getAgentSession(input.sessionId) ??
      (await this.options.projection.resolve(input.sessionId));
    if (source === undefined) throw new Error('SESSION_NOT_FOUND');
    if (source.externalSessionId === null) throw new Error('SESSION_REWIND_UNAVAILABLE');

    const turn = await this.findTurn(source, input.turnId);
    const expected = input.position === 'BEFORE' ? turn?.rewind?.before : turn?.rewind?.after;
    if (turn === undefined || expected !== input.boundary)
      throw new Error('SESSION_REWIND_TARGET_INVALID');
    const title = rewindTitle(
      source.customTitle ?? source.runnerTitle ?? 'Untitled session',
      this.options.runtime
        .listAgentSessions()
        .flatMap((candidate) => [candidate.customTitle ?? candidate.runnerTitle].filter(isString))
    );
    const runner = this.options.runners.require(source.runner);
    const cwd = this.options.resolveExecutionDirectory
      ? await this.options.resolveExecutionDirectory(source)
      : source.cwd;
    const nativeId = await runner.forkNative(
      { ...source, cwd },
      input.boundary as string | null,
      title
    );
    const session = this.options.runtime.createAgentSession({
      workspaceId: source.workspaceId,
      runner: source.runner,
      cwd,
      nativeControl: 'MAR_MANAGED',
      ...(nativeId === null ? {} : { externalSessionId: nativeId }),
      ...(source.model === null ? {} : { model: source.model }),
      ...(source.effort === null ? {} : { effort: source.effort }),
      ...(source.access === null ? {} : { access: source.access }),
      title
    });
    if (nativeId !== null) runner.rememberManagedNative(session, nativeId);
    this.options.emitSession(session);
    return { session: this.options.present(session) };
  }

  private async findTurn(
    session: NodeAgentSession,
    turnId: string
  ): Promise<NodeConversationTurn | undefined> {
    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
      const page = await this.options.history(session, {
        ...(cursor === undefined ? {} : { cursor }),
        limit: 100
      });
      const turn = page.turns.find((candidate) => candidate.id === turnId);
      if (turn !== undefined || page.nextCursor === null) return turn;
      cursor = page.nextCursor;
    }
    throw new Error('SESSION_REWIND_TARGET_INVALID');
  }

  private async remove(input: Record<string, unknown>): Promise<unknown> {
    if (typeof input.sessionId !== 'string') throw new Error('SESSION_INVALID');
    const session =
      this.options.runtime.getAgentSession(input.sessionId) ??
      (await this.options.projection.resolve(input.sessionId));
    if (session === undefined) throw new Error('SESSION_NOT_FOUND');
    try {
      await this.removeResolved(session);
      return { deleted: true };
    } finally {
      this.options.invalidateWorkspaceSessions(session.workspaceId);
    }
  }

  private async cleanupWorkspaceSessions(input: Record<string, unknown>): Promise<unknown> {
    const inactiveDays = input.inactiveDays;
    if (
      typeof input.workspaceId !== 'string' ||
      typeof inactiveDays !== 'number' ||
      !Number.isInteger(inactiveDays) ||
      inactiveDays < 1 ||
      inactiveDays > 365
    )
      throw new Error('WORKSPACE_SESSION_CLEANUP_INVALID');
    if (this.options.database().getWorkspace(input.workspaceId) === undefined)
      throw new Error('WORKSPACE_NOT_FOUND');

    const cutoff = Date.now() - inactiveDays * 24 * 60 * 60 * 1000;
    const nativeSessions = await this.options.discoverWorkspace(input.workspaceId);
    const candidates = new Map<string, NodeAgentSession>();
    for (const native of deduplicateNativeSessions(nativeSessions)) {
      if (native.workspaceId !== input.workspaceId) continue;
      const session = this.cleanupCandidate(native);
      candidates.set(session.id, session);
    }
    this.mergePersisted(candidates, input.workspaceId, false);
    let deleted = 0;
    let skipped = 0;
    let failed = 0;
    const deletedByRunner: Partial<Record<NodeAgentSession['runner'], number>> = {};
    try {
      for (const session of candidates.values()) {
        const missingCandidate = session.externalDiscovered === false;
        if (
          session.externalSessionId === null ||
          (missingCandidate &&
            (!this.options.runnerAvailable(session.runner) ||
              this.options.runtime.getAgentSession(session.id) !== undefined)) ||
          (!missingCandidate &&
            Number.isFinite(session.lastActivityAt) &&
            session.lastActivityAt > 0 &&
            session.lastActivityAt >= cutoff) ||
          (session.pinOrder !== null && session.pinOrder !== undefined) ||
          this.options.isWatching(session.id) ||
          this.options.isRecovering?.(session.id) ||
          this.options.runtime.sessionQueue(session.id).itemIds.length > 0 ||
          this.options.runtime
            .listRunsForSession(session.id)
            .some((run) => !isTerminalRunStatus(run.status)) ||
          this.options.externalActivity(session.id) === 'BUSY'
        ) {
          skipped += 1;
          continue;
        }
        try {
          if ((await this.removeResolved(session, true)) === 'deleted') {
            deleted += 1;
            deletedByRunner[session.runner] = (deletedByRunner[session.runner] ?? 0) + 1;
          } else skipped += 1;
        } catch (error) {
          if (isCleanupSkip(error)) skipped += 1;
          else {
            failed += 1;
            nodeLog('workspace.session.cleanup.failed', {
              workspaceId: input.workspaceId,
              sessionId: session.id,
              runner: session.runner,
              ...cleanupFailureDiagnostic(error)
            });
          }
        }
      }
      return { deleted, skipped, failed, deletedByRunner };
    } finally {
      this.options.invalidateWorkspaceSessions(input.workspaceId);
    }
  }

  private cleanupCandidate(native: NodeAgentSession): NodeAgentSession {
    const projected = this.options.projection.projectionForNative(native);
    if (projected === undefined) return native;
    return {
      ...projected,
      pinnedAt: native.pinnedAt ?? projected.pinnedAt,
      pinOrder: native.pinOrder ?? projected.pinOrder ?? null,
      externalDiscovered: native.externalDiscovered ?? true,
      lastActivityAt: latestSessionActivityAt(projected.lastActivityAt, native.lastActivityAt)
    };
  }

  private async removeResolved(
    session: NodeAgentSession,
    requireCleanupSafety = false
  ): Promise<'deleted' | 'skipped'> {
    if (session.externalSessionId === null) throw new Error('NATIVE_TRANSCRIPT_UNAVAILABLE');
    const releaseMutation = this.options.runtime.beginSessionHistoryMutation(
      session.id,
      requireCleanupSafety ? undefined : { allowQueued: true }
    );
    try {
      if (this.options.isRecovering?.(session.id)) throw new Error('SESSION_RESTART_PENDING');
      const runner = this.options.runners.require(session.runner);
      const missingCandidate = requireCleanupSafety && session.externalDiscovered === false;
      if (missingCandidate && !(await runner.isNativeSessionMissing(session))) return 'skipped';
      if (
        this.options.runtime
          .listRunsForSession(session.id)
          .some((run) => !isTerminalRunStatus(run.status))
      )
        throw new Error('SESSION_ACTIVE');
      if (session.nativeControl === 'EXTERNAL') {
        await this.options.refreshActivity(session);
        if (this.options.externalActivity(session.id) === 'BUSY') throw new Error('SESSION_ACTIVE');
      }
      if (requireCleanupSafety) {
        if (this.options.isWatching(session.id)) throw new Error('SESSION_WATCHING');
        if (this.options.runtime.sessionQueue(session.id).itemIds.length > 0)
          throw new Error('SESSION_QUEUE_NOT_EMPTY');
        if (
          this.options.runtime
            .listRunsForSession(session.id)
            .some((run) => !isTerminalRunStatus(run.status))
        )
          throw new Error('SESSION_ACTIVE');
      }
      const nativeIds = this.options.nativeIds(session);
      if (missingCandidate) {
        this.options.database().deleteSessionRecord(session.id);
        this.options.forget(session, nativeIds);
        return 'deleted';
      }
      let deleted = false;
      for (const externalSessionId of nativeIds) {
        try {
          const result = await runner.removeNative(session, externalSessionId);
          if (result === true) deleted = true;
          else if (result === false) {
            await removeNativeSession(session.runner, session.cwd, externalSessionId);
            deleted = true;
          }
        } catch (error) {
          if (!(error instanceof Error) || error.message !== 'NATIVE_TRANSCRIPT_UNAVAILABLE')
            throw error;
        }
      }
      this.options.database().deleteSessionRecord(session.id);
      this.options.forget(session, nativeIds);
      return deleted ? 'deleted' : 'skipped';
    } finally {
      releaseMutation();
    }
  }
}

export function rewindTitle(sourceTitle: string, existingTitles: readonly string[] = []): string {
  const base = sourceTitle.replace(/ \(Copy \d+\)$/u, '');
  const existing = new Set(existingTitles);
  for (let sequence = 1; sequence < Number.MAX_SAFE_INTEGER; sequence += 1) {
    const suffix = ` (Copy ${sequence})`;
    const candidate = `${base.slice(0, 160 - suffix.length)}${suffix}`;
    if (!existing.has(candidate)) return candidate;
  }
  throw new Error('SESSION_REWIND_TITLE_UNAVAILABLE');
}

function validRewindId(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}

function terminalConversationStatus(value: string): boolean {
  return ['SUCCEEDED', 'FAILED', 'CANCELLED', 'INTERRUPTED', 'LOST'].includes(value);
}

function isString(value: string | null): value is string {
  return value !== null;
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function deduplicateNativeSessions(
  sessions: readonly NodeAgentSession[]
): readonly NodeAgentSession[] {
  return [...new Map(sessions.map((session) => [session.id, session] as const)).values()];
}

function isCleanupSkip(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message === 'SESSION_ACTIVE' ||
      error.message === 'SESSION_NOT_FOUND' ||
      error.message === 'SESSION_QUEUE_NOT_EMPTY' ||
      error.message === 'SESSION_WATCHING' ||
      error.message === 'NATIVE_TRANSCRIPT_UNAVAILABLE')
  );
}

function cleanupFailureDiagnostic(error: unknown): {
  readonly errorCode: string;
  readonly error: string;
} {
  const record =
    error !== null && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  const code = typeof record.code === 'string' ? record.code : undefined;
  const message = error instanceof Error ? error.message : String(error);
  return {
    errorCode: (code ?? 'WORKSPACE_SESSION_CLEANUP_DELETE_FAILED').slice(0, 80),
    error: message.slice(0, 500)
  };
}
