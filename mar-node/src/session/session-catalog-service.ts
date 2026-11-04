import { resolveSessionRollbackTarget } from '../service/session-rollback-target.js';
import type { NodeOperationHandler } from '../application/node-operation-contracts.js';
import type {
  WorkspaceSessionCleanupResult,
  WorkspaceSessionNavigationQuery
} from '@myagentroam/protocol';
import { sessionGroup } from './session-presentation-service.js';
import type { NodeAgentSession } from './contracts.js';
import type { NodeDatabase } from '../database.js';
import type { NodeConversationTurn } from '../runtime-model.js';
import { removeNativeSession } from '../native-session-history.js';
import { nodeLog } from '../operational.js';
import type { NodeRuntimeState } from '../runtime-state.js';
import { isTerminalRunStatus } from './runtime/type-guards.js';
import { sessionPage } from './pagination.js';
import type { NativeSessionProjectionService } from './native-session-projection-service.js';
import type { RunnerRegistry } from '../runner/runner-registry.js';
import { latestSessionActivityAt } from './session-presentation-service.js';
import { marctlSessionSummary, sessionActivityStatus } from '../service/session-recent-activity.js';
import {
  WorkspaceSessionCleanupBudget,
  WorkspaceSessionCleanupDeadline
} from '../service/workspace-session-cleanup-budget.js';

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
  readonly discoverWorkspace: (
    workspaceId: string,
    cleanup?: boolean
  ) => Promise<readonly NodeAgentSession[]>;
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

interface SessionTreeCleanup {
  readonly candidates: ReadonlyMap<string, NodeAgentSession>;
  readonly children: ReadonlyMap<string, readonly NodeAgentSession[]>;
  readonly cutoff: number;
  readonly budget: WorkspaceSessionCleanupBudget;
  readonly settled: (session: NodeAgentSession, deleted: boolean) => void;
}

type SessionNavigationQuery = WorkspaceSessionNavigationQuery & { readonly workspaceId: string };
type RegisteredSession = ReturnType<NodeDatabase['listSessionRecords']>[number];

export class SessionCatalogService {
  private rewindQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: SessionCatalogServiceOptions) {}

  operations(): Readonly<Record<string, NodeOperationHandler>> {
    return {
      'session.list': (data) => this.list(record(data)),
      'session.graph': (data) => this.graph(record(data)),
      'session.remove': (data) => this.enqueueMutation(() => this.remove(record(data))),
      'workspace.sessions.cleanup': (data) => this.cleanupWorkspaceSessions(record(data)),
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
    if (input.includeAncestors !== undefined && typeof input.includeAncestors !== 'boolean')
      throw new Error('SESSION_INVALID');
    const limit = input.limit === undefined ? 100 : input.limit;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error('SESSION_INVALID');
    const database = this.options.database();
    let root = database.getSessionRecord(input.sessionId);
    if (root === undefined || root.workspaceId !== input.workspaceId)
      throw new Error('SESSION_NOT_FOUND');
    const ancestors = new Set([root.id]);
    while (input.includeAncestors === true && typeof root.metadata.parentSessionId === 'string') {
      const parent = database.getSessionRecord(root.metadata.parentSessionId);
      if (
        parent === undefined ||
        parent.workspaceId !== input.workspaceId ||
        ancestors.has(parent.id)
      )
        throw new Error('SESSION_PARENT_INVALID');
      ancestors.add(parent.id);
      root = parent;
    }
    const { project } = this.navigationProjector(input.workspaceId, (id) =>
      sessionActivityStatus(this.options.runtime, id)
    );
    const queue = [root];
    const visited = new Set([root.id]);
    const nodes = [];
    for (let index = 0; index < queue.length && index < limit; index += 1) {
      const session = queue[index]!;
      nodes.push(project(session));
      const children = [...database.listChildSessionRecords(input.workspaceId, session.id)];
      if (input.includeAncestors === true)
        children.sort(
          (left, right) => Number(ancestors.has(right.id)) - Number(ancestors.has(left.id))
        );
      for (const child of children) {
        if (visited.has(child.id)) continue;
        visited.add(child.id);
        queue.push(child);
      }
    }
    return { rootSessionId: root.id, nodes, truncated: queue.length > nodes.length };
  }

  navigation(query: SessionNavigationQuery) {
    const database = this.options.database();
    const statuses = new Map<string, ReturnType<typeof sessionActivityStatus>>();
    const status = (id: string) => {
      const cached = statuses.get(id);
      if (cached !== undefined) return cached;
      const value = sessionActivityStatus(this.options.runtime, id);
      statuses.set(id, value);
      return value;
    };
    let projection: ReturnType<SessionCatalogService['navigationProjector']> | undefined;
    const projector = () => (projection ??= this.navigationProjector(query.workspaceId, status));
    const project = (record: RegisteredSession) => projector().project(record);
    const registered = new Map<string, RegisteredSession | undefined>();
    const get = (id: string) => {
      if (registered.has(id)) return registered.get(id);
      const record = database.getSessionRecord(id);
      const scoped = record?.workspaceId === query.workspaceId ? record : undefined;
      registered.set(id, scoped);
      return scoped;
    };
    const requestedIds = new Set([
      ...query.sessionIds,
      ...query.summaryAnchors,
      ...(query.treeAnchor === undefined ? [] : [query.treeAnchor])
    ]);
    const missingSessionIds = [...requestedIds].filter((id) => get(id) === undefined);
    const sessions = query.sessionIds.flatMap((id) => {
      const record = get(id);
      return record === undefined ? [] : [project(record)];
    });
    const descendantsByAnchor = new Map<string, ReturnType<typeof database.sessionTreeRecords>>();
    const descendants = (anchor: string) => {
      let records = descendantsByAnchor.get(anchor);
      if (records === undefined) {
        const tree = database.sessionTreeRecords(query.workspaceId, anchor);
        for (const record of tree) registered.set(record.id, record);
        records = tree.slice(1);
        descendantsByAnchor.set(anchor, records);
      }
      return records;
    };
    const summaries = query.summaryAnchors.flatMap((anchorSessionId) => {
      if (get(anchorSessionId) === undefined) return [];
      let runningCount = 0;
      let sleepingCount = 0;
      const records = descendants(anchorSessionId);
      for (const record of records) {
        const activity = status(record.id);
        if (activity === 'RUNNING') runningCount++;
        else if (activity === 'SLEEPING') sleepingCount++;
      }
      return [
        {
          anchorSessionId,
          descendantCount: records.length,
          activeCount: runningCount + sleepingCount,
          runningCount,
          sleepingCount,
          hasActiveDescendants: runningCount + sleepingCount > 0
        }
      ];
    });
    const anchor = query.treeAnchor === undefined ? undefined : get(query.treeAnchor);
    const records = anchor === undefined ? [] : descendants(anchor.id);
    const activePaths = new Set<string>();
    // Records are breadth-first: propagate activity to ancestors in one reverse pass.
    for (let index = records.length - 1; index >= 0; index--) {
      const record = records[index]!;
      if (status(record.id) !== 'IDLE' || activePaths.has(record.id)) {
        activePaths.add(record.id);
        if (typeof record.metadata.parentSessionId === 'string')
          activePaths.add(record.metadata.parentSessionId);
      }
    }
    const activity = new Map(
      records.map((record) => [record.id, projector().lastActivityAt(record)])
    );
    const compare = (left: RegisteredSession, right: RegisteredSession) =>
      Number(activePaths.has(right.id)) - Number(activePaths.has(left.id)) ||
      activity.get(right.id)! - activity.get(left.id)! ||
      (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    const prioritized = [...records].sort(compare);
    const byId = new Map(records.map((record) => [record.id, record]));
    const selected = new Map<string, RegisteredSession>();
    const fill = (candidates: readonly RegisteredSession[]) => {
      for (const record of candidates) {
        if (selected.size >= query.limit) break;
        const path: RegisteredSession[] = [];
        let current: RegisteredSession | undefined = record;
        while (current !== undefined && !selected.has(current.id)) {
          path.push(current);
          current = byId.get(current.metadata.parentSessionId ?? '');
        }
        if (path.length > query.limit - selected.size) continue;
        for (const ancestor of path.reverse()) selected.set(ancestor.id, ancestor);
      }
    };
    // An unfit path must not consume slots before another active session that can fit.
    fill(prioritized.filter((record) => status(record.id) !== 'IDLE'));
    fill(prioritized);
    const parent = anchor?.metadata.parentSessionId
      ? get(anchor.metadata.parentSessionId)
      : undefined;
    const tree =
      anchor === undefined
        ? null
        : {
            anchorSessionId: anchor.id,
            parent: parent === undefined ? null : project(parent),
            nodes: [...selected.values()].sort(compare).map(project),
            truncated: records.length > query.limit
          };
    return { sessions, summaries, tree, missingSessionIds };
  }

  private navigationProjector(
    workspaceId: string,
    status: (id: string) => ReturnType<typeof sessionActivityStatus>
  ) {
    const lookup = this.options.runtime.createSessionLookup();
    const native = this.options
      .cachedNative()
      .filter((session) => session.workspaceId === workspaceId);
    const projections = this.options.projection.projectionsForNative(native, lookup);
    const activityById = new Map<string, number>();
    for (const source of native) {
      const id = projections.get(source)?.id ?? source.id;
      activityById.set(
        id,
        latestSessionActivityAt(activityById.get(id) ?? 0, source.lastActivityAt)
      );
    }
    const current = (session: RegisteredSession) =>
      lookup.getAgentSessionById(session.id) ??
      lookup.findAgentSessionByExternalSession(session.runner, session.id, workspaceId);
    const lastActivityAt = (session: RegisteredSession) =>
      latestSessionActivityAt(
        current(session)?.lastActivityAt ?? 0,
        activityById.get(session.id) ?? 0
      );
    const projected = new Map<string, ReturnType<typeof project>>();
    const project = (session: RegisteredSession) => {
      const active = current(session);
      const live = active === undefined ? undefined : this.options.present(active);
      return {
        id: session.id,
        parentSessionId: session.metadata.parentSessionId ?? null,
        title:
          live?.customTitle ??
          session.metadata.customTitle ??
          live?.runnerTitle ??
          session.metadata.runnerTitle ??
          'Untitled session',
        runner: session.runner,
        activity: live && 'activity' in live ? live.activity : 'IDLE',
        status: status(session.id),
        lastActivityAt: latestSessionActivityAt(
          live?.lastActivityAt ?? 0,
          activityById.get(session.id) ?? 0
        )
      };
    };
    return {
      lastActivityAt,
      project: (session: RegisteredSession) => {
        let value = projected.get(session.id);
        if (value === undefined) {
          value = project(session);
          projected.set(session.id, value);
        }
        return value;
      }
    };
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
          modelId: persisted.metadata.modelId,
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
      (input.itemId !== undefined && !validRewindId(input.itemId, 128)) ||
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
    const target =
      turn === undefined
        ? undefined
        : resolveSessionRollbackTarget(turn, input.itemId as string | undefined);
    if (
      turn === undefined ||
      !terminalConversationStatus(turn.status) ||
      target === undefined ||
      turn.rewind?.before !== input.boundary
    )
      throw new Error('SESSION_ROLLBACK_TARGET_INVALID');
    const releaseMutation = this.options.runtime.beginSessionHistoryMutation(source.id);
    try {
      const lastActivityAt = await runner.rollbackNative(
        source,
        input.boundary as string | null,
        turn.rewind?.after,
        target.clientMessageId
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
      ...(source.modelId === null ? {} : { modelId: source.modelId }),
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
      await this.removeTree(session);
      return { deleted: true };
    } finally {
      this.options.invalidateWorkspaceSessions(session.workspaceId);
    }
  }

  private async removeTree(root: NodeAgentSession, cleanup?: SessionTreeCleanup): Promise<void> {
    if (root.externalSessionId === null) throw new Error('NATIVE_TRANSCRIPT_UNAVAILABLE');
    const database = this.options.database();
    const live = this.options.runtime
      .listAgentSessions()
      .filter((session) => session.workspaceId === root.workspaceId);
    const liveChildren = new Map<string, string[]>();
    for (const session of live) {
      if (session.parentSessionId == null) continue;
      const children = liveChildren.get(session.parentSessionId) ?? [];
      children.push(session.externalSessionId ?? session.id);
      liveChildren.set(session.parentSessionId, children);
    }
    const ids = [root.externalSessionId];
    const seen = new Set(ids);
    const parents = new Map<string, string>();
    const settle = (session: NodeAgentSession, deleted: boolean) => {
      if (cleanup === undefined) return;
      database.deleteSessionRecord(session.id);
      this.options.forget(session, this.options.nativeIds(session));
      cleanup.settled(session, deleted);
    };
    const releases: Array<() => void> = [];
    const locked = new Set<string>();
    const lock = (id: string) => {
      const actual = this.options.runtime.getAgentSession(id)?.id ?? id;
      if (locked.has(actual)) return;
      releases.push(
        this.options.runtime.beginSessionHistoryMutation(
          actual,
          cleanup !== undefined && actual === root.id ? undefined : { allowQueued: true }
        )
      );
      locked.add(actual);
    };
    try {
      lock(root.id);
      for (let index = 0; index < ids.length; index += 1) {
        const parent = ids[index]!;
        const children = [
          ...database.listChildSessionRecords(root.workspaceId, parent).map((record) => record.id),
          ...(cleanup?.children.get(parent) ?? [])
            .filter((session) => cleanup?.candidates.has(session.id))
            .map((session) => session.externalSessionId ?? session.id),
          ...(liveChildren.get(parent) ?? [])
        ];
        for (const child of children) {
          if (seen.has(child)) {
            if (parents.get(child) !== parent) throw new Error('SESSION_RELATION_INVALID');
            continue;
          }
          seen.add(child);
          parents.set(child, parent);
          lock(child);
          ids.push(child);
        }
      }
      const sessions: NodeAgentSession[] = [];
      for (const id of ids) {
        const session =
          cleanup?.candidates.get(id) ??
          this.options.runtime.getAgentSession(id) ??
          (await this.options.projection.resolve(id, true));
        if (session === undefined || session.workspaceId !== root.workspaceId)
          throw new Error('SESSION_NOT_FOUND');
        sessions.push(session);
      }
      // Validate every member before performing any irreversible native deletion.
      for (const session of sessions) {
        const missing = cleanup !== undefined && session.externalDiscovered === false;
        if (missing && !this.options.runnerAvailable(session.runner))
          throw new Error('NATIVE_TRANSCRIPT_UNAVAILABLE');
        await this.assertRemovable(session, cleanup?.budget, missing);
      }
      if (cleanup !== undefined && this.cleanupRootProtected(root, cleanup.cutoff)) {
        throw new Error('SESSION_WATCHING');
      }
      let batch: NodeAgentSession[] = [];
      const flushBatch = async () => {
        if (batch.length === 0) return;
        cleanup?.budget.check();
        await this.options.runners.require(batch[0]!.runner).removeNativeMembers(batch);
        for (const session of batch) settle(session, true);
        batch = [];
      };
      for (const session of [...sessions].reverse()) {
        if (
          cleanup !== undefined &&
          (session.externalSessionId === null || session.externalDiscovered === false)
        ) {
          await flushBatch();
          cleanup.budget.check();
          settle(session, true);
          continue;
        }
        if (session.externalSessionId === null) continue;
        const runner = this.options.runners.require(session.runner);
        if (runner.supportsNativeBatchRemoval?.() === true) {
          if (batch.length > 0 && batch[0]!.runner !== session.runner) await flushBatch();
          batch.push(session);
        } else {
          // Preserve descendant-first order across batch and non-batch native owners.
          await flushBatch();
          cleanup?.budget.check();
          const deleted = await this.removeNativeHistories(
            session,
            this.options.nativeIds(session)
          );
          settle(session, deleted);
        }
      }
      await flushBatch();
      // Manual deletion preserves all relationships if any native owner fails.
      if (cleanup === undefined) {
        for (const session of sessions.reverse()) {
          this.options.database().deleteSessionRecord(session.id);
          this.options.forget(session, this.options.nativeIds(session));
        }
      }
    } finally {
      for (const release of releases.reverse()) release();
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

    const workspaceId = input.workspaceId;
    const budget = new WorkspaceSessionCleanupBudget();
    const started = Promise.withResolvers<void>();
    const work = this.enqueueMutation(() => {
      started.resolve();
      return this.performWorkspaceSessionCleanup(workspaceId, inactiveDays, budget);
    });
    // A queued cleanup may expire before acquiring the mutation queue. Its late
    // callback still checks the budget and cannot start discovery or deletion.
    void work.catch(() => undefined);
    try {
      await budget.read(() => started.promise);
    } catch (error) {
      if (!(error instanceof WorkspaceSessionCleanupDeadline)) throw error;
      return { deleted: 0, skipped: 0, failed: 0, deletedByRunner: {}, timedOut: true };
    }
    return work;
  }

  private async performWorkspaceSessionCleanup(
    workspaceId: string,
    inactiveDays: number,
    budget: WorkspaceSessionCleanupBudget
  ): Promise<WorkspaceSessionCleanupResult> {
    const startedAt = performance.now();
    const cutoff = Date.now() - inactiveDays * 24 * 60 * 60 * 1000;
    let deleted = 0;
    let skipped = 0;
    let failed = 0;
    const outcomes = new Map<
      string,
      { session: NodeAgentSession; status: 'deleted' | 'skipped' | 'failed' }
    >();
    const deletedByRunner: Partial<Record<NodeAgentSession['runner'], number>> = {};
    let candidateCount: number | undefined;
    let timedOut = false;
    let discoveryMs = 0;
    try {
      const nativeSessions = await budget.read(() =>
        this.options.discoverWorkspace(workspaceId, true)
      );
      discoveryMs = Math.round(performance.now() - startedAt);
      const candidates = new Map<string, NodeAgentSession>();
      for (const native of deduplicateNativeSessions(nativeSessions)) {
        if (native.workspaceId !== workspaceId) continue;
        const session = this.cleanupCandidate(native);
        candidates.set(session.id, session);
      }
      this.mergePersisted(candidates, workspaceId, false);
      const children = new Map<string, NodeAgentSession[]>();
      for (const candidate of candidates.values()) {
        if (candidate.parentSessionId == null) continue;
        const siblings = children.get(candidate.parentSessionId) ?? [];
        siblings.push(candidate);
        children.set(candidate.parentSessionId, siblings);
      }
      candidateCount = candidates.size;
      for (const session of candidates.values()) {
        budget.check();
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
          outcomes.set(session.id, { session, status: 'skipped' });
          continue;
        }
        try {
          await this.removeTree(session, {
            candidates,
            children,
            cutoff,
            budget,
            settled: (member, wasDeleted) => {
              candidates.delete(member.id);
              outcomes.set(member.id, {
                session: member,
                status: wasDeleted ? 'deleted' : 'skipped'
              });
            }
          });
        } catch (error) {
          if (error instanceof WorkspaceSessionCleanupDeadline) throw error;
          if (isCleanupSkip(error)) outcomes.set(session.id, { session, status: 'skipped' });
          else {
            outcomes.set(session.id, { session, status: 'failed' });
            nodeLog('workspace.session.cleanup.failed', {
              workspaceId,
              sessionId: session.id,
              runner: session.runner,
              ...cleanupFailureDiagnostic(error)
            });
          }
        }
      }
      budget.check();
    } catch (error) {
      if (!(error instanceof WorkspaceSessionCleanupDeadline)) throw error;
      if (candidateCount === undefined) discoveryMs = Math.round(performance.now() - startedAt);
      timedOut = true;
    } finally {
      this.options.invalidateWorkspaceSessions(workspaceId);
    }
    for (const { session, status } of outcomes.values()) {
      if (status === 'deleted') {
        deleted += 1;
        deletedByRunner[session.runner] = (deletedByRunner[session.runner] ?? 0) + 1;
      } else if (status === 'skipped') skipped += 1;
      else failed += 1;
    }
    const result: WorkspaceSessionCleanupResult = {
      deleted,
      skipped,
      failed,
      deletedByRunner,
      ...(timedOut
        ? {
            timedOut: true,
            ...(candidateCount === undefined
              ? {}
              : { remaining: Math.max(0, candidateCount - outcomes.size) })
          }
        : {})
    };
    nodeLog('workspace.sessions.cleanup.completed', {
      workspaceId,
      ...result,
      discoveryMs,
      durationMs: Math.round(performance.now() - startedAt)
    });
    return result;
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

  private async assertRemovable(
    session: NodeAgentSession,
    budget?: WorkspaceSessionCleanupBudget,
    missing = false
  ): Promise<void> {
    if (this.options.isRecovering?.(session.id)) throw new Error('SESSION_RESTART_PENDING');
    if (
      this.options.runtime
        .listRunsForSession(session.id)
        .some((run) => !isTerminalRunStatus(run.status))
    )
      throw new Error('SESSION_ACTIVE');
    if (!missing && session.externalSessionId !== null && session.nativeControl === 'EXTERNAL') {
      const refresh = () => this.options.refreshActivity(session);
      await (budget ? budget.read(refresh) : refresh());
      if (this.options.externalActivity(session.id) === 'BUSY') throw new Error('SESSION_ACTIVE');
    }
  }

  private async removeNativeHistories(
    session: NodeAgentSession,
    nativeIds: ReadonlySet<string>
  ): Promise<boolean> {
    const runner = this.options.runners.require(session.runner);
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
    return deleted;
  }

  private cleanupRootProtected(session: NodeAgentSession, cutoff: number): boolean {
    // Pin updates and Watch admission do not share the history mutation queue.
    const pinOrder =
      session.externalSessionId === null
        ? undefined
        : this.options
            .database()
            .getNativeSessionMetadata(
              session.runner,
              session.externalSessionId,
              session.workspaceId
            )?.pinOrder;
    return (
      (session.externalDiscovered !== false &&
        latestSessionActivityAt(
          session.lastActivityAt,
          this.options.runtime.getAgentSession(session.id)?.lastActivityAt ?? 0
        ) >= cutoff) ||
      (pinOrder !== undefined && pinOrder !== null) ||
      this.options.isWatching(session.id) ||
      this.options.isRecovering?.(session.id) === true ||
      this.options.runtime.sessionQueue(session.id).itemIds.length > 0 ||
      this.options.runtime
        .listRunsForSession(session.id)
        .some((run) => !isTerminalRunStatus(run.status))
    );
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
      error.message === 'SESSION_RESTART_PENDING' ||
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
