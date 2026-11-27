import { AgentError } from '@myagentroam/agent';
import type { SessionCollaborationEdge } from '@myagentroam/protocol';
import type {
  WhiteboardChange,
  WhiteboardSnapshot,
  WhiteboardStore,
  WhiteboardUpdate
} from './whiteboard-store.js';

interface Participant {
  readonly id: string;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly initiatedByUserId?: number;
}

interface Binding {
  readonly ownerSessionId: string;
  readonly rootRunId: string;
  readonly joinedAfterRevision?: number;
}

interface RevisionNotice {
  readonly writer: string;
  readonly revision: number;
}

interface BoardView {
  readonly role: 'own' | 'followed';
  readonly rootRunId: string;
  readonly follow: Binding | undefined;
  readonly snapshot: WhiteboardSnapshot;
  readonly latestChange: WhiteboardChange | undefined;
}

interface WhiteboardServiceOptions {
  store(): WhiteboardStore;
  activeRun(id: string): Participant | undefined;
  activeOwnerRunId(ownerSessionId: string): string | undefined;
  boardInWorkspace(ownerSessionId: string, workspaceId: string): boolean;
  canRecover?(participant: Participant, ownerSessionId: string): boolean;
  changed?(workspaceId: string): void;
}

/** Owns temporary board bindings and revision notices. The Node Run owner decides liveness. */
export class WhiteboardService {
  private readonly follows = new Map<string, readonly Binding[]>();
  private readonly listenersByRoot = new Map<string, Set<(writer: string) => void>>();
  // Only the two most recent distinct writers are needed to exclude self-wakes.
  private readonly notices = new Map<string, readonly RevisionNotice[]>();

  constructor(private readonly options: WhiteboardServiceOptions) {}

  private compatible(left: Participant | undefined, right: Participant | undefined): boolean {
    return (
      left !== undefined &&
      right !== undefined &&
      left.workspaceId === right.workspaceId &&
      left.initiatedByUserId !== undefined &&
      left.initiatedByUserId === right.initiatedByUserId
    );
  }

  private own(run: Participant): Binding {
    return { ownerSessionId: run.sessionId, rootRunId: run.id };
  }

  private newFollow({ ownerSessionId, rootRunId }: Binding): Binding {
    return {
      ownerSessionId,
      rootRunId,
      joinedAfterRevision: this.notices.get(rootRunId)?.[0]?.revision ?? 0
    };
  }

  private followed(run: Participant): Binding | undefined {
    const binding = this.follows.get(run.id)?.[0];
    if (!binding) return undefined;
    const root = this.options.activeRun(binding.rootRunId);
    return this.compatible(run, root) && root?.sessionId === binding.ownerSessionId
      ? binding
      : undefined;
  }

  inherit(targetRunId: string, sourceRunId: string): void {
    if (targetRunId === sourceRunId || this.follows.has(targetRunId)) return;
    const target = this.options.activeRun(targetRunId);
    const source = this.options.activeRun(sourceRunId);
    if (!target || !source || !this.compatible(target, source)) return;
    // A detached follow is still the source's choice, not an implicit leave.
    const binding = this.follows.get(source.id)?.[0] ?? this.own(source);
    if (binding.ownerSessionId !== target.sessionId) {
      this.follows.set(targetRunId, [this.newFollow(binding)]);
      this.options.changed?.(target.workspaceId);
    }
  }

  isDetached(runId: string): boolean {
    const run = this.options.activeRun(runId);
    return !!run && this.follows.has(runId) && !this.followed(run);
  }

  private requireRun(runId: string): Participant {
    const run = this.options.activeRun(runId);
    if (!run)
      throw new AgentError(
        'WHITEBOARD_UNAVAILABLE',
        'No whiteboard is available for this execution.'
      );
    return run;
  }

  private writable(run: Participant, boardId: string): Binding {
    if (boardId === run.sessionId) return this.own(run);
    const followed = this.followed(run);
    if (followed?.ownerSessionId === boardId) return followed;
    if (this.follows.get(run.id)?.[0]?.ownerSessionId === boardId) {
      const recoveryAgentId = this.options.canRecover?.(run, boardId) ? boardId : undefined;
      const message = 'You still follow this whiteboard, but you cannot edit it right now.';
      // A retained follow does not imply the caller can contact the owner or rejoin the board.
      throw new AgentError(
        'WHITEBOARD_DETACHED',
        recoveryAgentId === undefined
          ? message
          : `${message} Ask the owner to send you a new agent_send message from a run using this board, or join using the owner’s Agent ID when they have an active run.`,
        recoveryAgentId === undefined ? undefined : { details: { recoveryAgentId } }
      );
    }
    throw new AgentError(
      'WHITEBOARD_CONFLICT',
      'You can edit only your own whiteboard or the board you follow.',
      {
        details: { ownBoardAgentId: run.sessionId, followedBoardAgentId: followed?.ownerSessionId }
      }
    );
  }

  relationships(workspaceId: string, userId: number): SessionCollaborationEdge[] {
    const edges: SessionCollaborationEdge[] = [];
    for (const runId of this.follows.keys()) {
      const run = this.options.activeRun(runId);
      if (run?.workspaceId !== workspaceId || run.initiatedByUserId !== userId) continue;
      const board = this.followed(run);
      if (board)
        edges.push({ ownerSessionId: board.ownerSessionId, followerSessionId: run.sessionId });
    }
    return edges;
  }

  /** Internal data read for an already authorized Workspace, independent of Run liveness. */
  readPersisted(workspaceId: string, owner: string) {
    return this.options.boardInWorkspace(owner, workspaceId)
      ? this.options.store().read(owner)
      : undefined;
  }

  read(
    runId: string,
    boardId?: string
  ): Omit<WhiteboardSnapshot, 'boardId'> & {
    boardAgentId: string;
    recentChanges: readonly (Omit<WhiteboardChange, 'actorSessionId'> & { actorAgentId: string })[];
  } {
    const run = this.requireRun(runId);
    const owner = boardId ?? run.sessionId;
    // Read addresses a persisted Workspace resource, not another Run's state (agent_view)
    // or its live sharing permissions (join/update). Only the caller needs an active Run;
    // the owner's Run and initiating user are irrelevant. Read grants no follow or write access.
    if (owner !== run.sessionId && !this.options.boardInWorkspace(owner, run.workspaceId))
      throw new AgentError(
        'WHITEBOARD_UNAVAILABLE',
        'No whiteboard for that Agent ID is available in this Workspace.'
      );
    const { boardId: boardAgentId, recentChanges, ...snapshot } = this.options.store().read(owner);
    return {
      boardAgentId,
      ...snapshot,
      recentChanges: recentChanges.map(({ actorSessionId, ...change }) => ({
        ...change,
        actorAgentId: actorSessionId
      }))
    };
  }

  join(runId: string, boardId: string) {
    const run = this.requireRun(runId);
    if (boardId === run.sessionId || this.followed(run)?.ownerSessionId === boardId)
      return { boardAgentId: boardId, changed: false };
    const rootRunId = this.options.activeOwnerRunId(boardId);
    const root = rootRunId === undefined ? undefined : this.options.activeRun(rootRunId);
    if (
      !root ||
      root.sessionId !== boardId ||
      !this.compatible(run, root) ||
      !this.options.boardInWorkspace(boardId, run.workspaceId)
    )
      throw new AgentError(
        'WHITEBOARD_UNAVAILABLE',
        'No active whiteboard for that Agent ID can be joined.'
      );
    this.follows.set(runId, [this.newFollow(this.own(root))]);
    this.options.changed?.(run.workspaceId);
    return { boardAgentId: boardId, changed: true };
  }

  leave(runId: string) {
    const run = this.requireRun(runId);
    // A detached follow still identifies the board being left.
    const binding = this.follows.get(runId)?.[0];
    if (!binding) return { changed: false };
    this.follows.delete(runId);
    this.options.changed?.(run.workspaceId);
    return { boardAgentId: binding.ownerSessionId, changed: true };
  }

  /** Preview the view for a request, without establishing a binding for a discarded candidate. */
  capture(
    runId: string,
    sourceRunIds: readonly string[]
  ): {
    views: readonly BoardView[];
    accept(): boolean;
  } {
    const resolveFollow = (run: Participant) => {
      const current = this.followed(run);
      if (current) return { binding: current, reconnect: false };
      const detached = this.follows.get(runId)?.[0];
      if (!detached) return;
      for (const sourceRunId of sourceRunIds) {
        const source = this.options.activeRun(sourceRunId);
        if (!source || !this.compatible(run, source)) continue;
        const binding = this.subscriptions(source).find(
          ({ ownerSessionId }) => ownerSessionId === detached.ownerSessionId
        );
        if (binding) return { binding: this.newFollow(binding), reconnect: true };
      }
    };
    const run = this.options.activeRun(runId);
    const selectedFollow = this.follows.get(runId)?.[0];
    const captured = run && resolveFollow(run);
    const accept = () => {
      if (this.follows.get(runId)?.[0] !== selectedFollow) return false;
      const liveRun = this.options.activeRun(runId);
      const live = liveRun && resolveFollow(liveRun);
      if (
        liveRun?.sessionId !== run?.sessionId ||
        live?.binding.rootRunId !== captured?.binding.rootRunId ||
        live?.binding.ownerSessionId !== captured?.binding.ownerSessionId
      )
        return false;
      // An edit after capture is not in the accepted snapshot and must remain pending.
      if (liveRun && live?.reconnect && captured?.reconnect) {
        this.follows.set(runId, [captured.binding]);
        this.options.changed?.(liveRun.workspaceId);
      }
      return true;
    };
    if (!run) return { accept, views: [] };
    const store = this.options.store();
    const view = (binding: Binding, role: BoardView['role']): BoardView => {
      const { recentChanges, ...snapshot } = store.read(binding.ownerSessionId);
      return {
        role,
        rootRunId: binding.rootRunId,
        follow: role === 'followed' ? binding : undefined,
        snapshot,
        latestChange: recentChanges[0]
      };
    };
    const views = [view(this.own(run), 'own')];
    if (captured) views.push(view(captured.binding, 'followed'));
    return { accept, views };
  }

  private subscriptions(run: Participant): readonly Binding[] {
    const followed = this.followed(run);
    return followed ? [this.own(run), followed] : [this.own(run)];
  }

  pending(runId: string, delivered: readonly { rootRunId: string; revision: number }[]): boolean {
    const run = this.options.activeRun(runId);
    return (
      !!run &&
      this.subscriptions(run).some(({ rootRunId, joinedAfterRevision }) => {
        const revision = this.notices
          .get(rootRunId)
          ?.find(({ writer }) => writer !== runId)?.revision;
        return (
          revision !== undefined &&
          revision >
            Math.max(
              joinedAfterRevision ?? 0,
              delivered.find((item) => item.rootRunId === rootRunId)?.revision ?? 0
            )
        );
      })
    );
  }

  update(runId: string, input: WhiteboardUpdate) {
    const run = this.requireRun(runId);
    const binding = this.writable(run, input.expectedBoardId);
    const result = this.options.store().update(binding.ownerSessionId, run.sessionId, input);
    if (result.changed) {
      this.options.changed?.(run.workspaceId);
      const previous = this.notices.get(binding.rootRunId)?.find(({ writer }) => writer !== runId);
      const latest = { writer: runId, revision: result.boardRevision };
      this.notices.set(binding.rootRunId, previous ? [latest, previous] : [latest]);
      for (const listener of this.listenersByRoot.get(binding.rootRunId) ?? []) {
        try {
          listener(runId);
        } catch {
          /* A subscriber cannot undo a committed edit. */
        }
      }
    }
    const { boardId: boardAgentId, ...receipt } = result;
    return { boardAgentId, ...receipt };
  }

  subscribe(runId: string, listener: () => void): () => void {
    const run = this.options.activeRun(runId);
    const stops = run
      ? this.subscriptions(run).map(({ rootRunId }) => this.listen(runId, rootRunId, listener))
      : [];
    return () => stops.forEach((stop) => stop());
  }

  private listen(runId: string, rootRunId: string, listener: () => void): () => void {
    let listeners = this.listenersByRoot.get(rootRunId);
    if (!listeners) this.listenersByRoot.set(rootRunId, (listeners = new Set()));
    const receive = (writer: string) => {
      if (writer === runId) return;
      const current = this.options.activeRun(runId);
      if (current && this.subscriptions(current).some((binding) => binding.rootRunId === rootRunId))
        listener();
    };
    listeners.add(receive);
    return () => {
      listeners.delete(receive);
      if (!listeners.size) this.listenersByRoot.delete(rootRunId);
    };
  }

  release(runId: string, workspaceId: string): void {
    const hadSharing =
      this.follows.has(runId) ||
      [...this.follows.values()].some((bindings) =>
        bindings.some((binding) => binding.rootRunId === runId)
      );
    this.follows.delete(runId);
    this.notices.delete(runId);
    this.listenersByRoot.delete(runId);
    if (hadSharing) this.options.changed?.(workspaceId);
  }
}
