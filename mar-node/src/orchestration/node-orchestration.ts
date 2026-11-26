import type { ExtensionSessionContextProvider } from '@myagentroam/agent/extensions';
import type { OrchestrationInputSource } from './input-source.js';
import { WhiteboardService } from './whiteboard/whiteboard-service.js';

interface DeliveredBoard {
  readonly runId: string;
  readonly rootRunId: string;
  readonly boardId: string;
  readonly revision: number;
  readonly follow: object | undefined;
  readonly withChange: boolean;
}

/** Connects actual Run admission and applied inputs to Whiteboard. Session/Run state stays in Node Runtime. */
export class NodeOrchestration {
  private readonly incoming = new Map<string, Map<string, OrchestrationInputSource>>();

  constructor(readonly whiteboard: WhiteboardService) {}

  prepareInput(
    runId: string,
    clientMessageId: string | undefined,
    source: OrchestrationInputSource | undefined,
    opening: boolean
  ): () => void {
    if (!source || !clientMessageId || source.runId === runId) return () => {};
    if (opening) {
      this.whiteboard.inherit(runId, source.runId);
      return () => {};
    }
    if (!source.hasMessage || !this.whiteboard.isDetached(runId)) return () => {};
    let pending = this.incoming.get(runId);
    if (!pending) this.incoming.set(runId, (pending = new Map()));
    pending.set(clientMessageId, source);
    return () => {
      pending.delete(clientMessageId);
      if (pending.size === 0 && this.incoming.get(runId) === pending) this.incoming.delete(runId);
    };
  }

  release(runId: string, workspaceId: string): void {
    this.incoming.delete(runId);
    this.whiteboard.release(runId, workspaceId);
  }

  /** The SDK owns delivery/acknowledgement and the wait barrier; Node supplies the current view. */
  context(
    currentRun: () => string | undefined,
    children: ExtensionSessionContextProvider
  ): Pick<ExtensionSessionContextProvider, 'requestContext' | 'wake'> {
    const childWake = children.wake;
    const delivered = new Map<'own' | 'followed', DeliveredBoard>();
    const pendingWhiteboard = () => {
      const runId = currentRun();
      return (
        runId !== undefined &&
        this.whiteboard.pending(
          runId,
          [...delivered.values()].filter((item) => item.runId === runId)
        )
      );
    };
    return {
      requestContext: ({ clientMessageIds, signal }) => {
        signal.throwIfAborted();
        const runId = currentRun();
        if (!runId) return {};
        const incoming = this.incoming.get(runId);
        const adopted = incoming
          ? clientMessageIds.flatMap((id) => {
              const source = incoming.get(id);
              return source ? [{ id, source }] : [];
            })
          : [];
        const { views, accept: acceptView } = this.whiteboard.capture(
          runId,
          adopted.map(({ source }) => source.runId)
        );
        const accept = (hasClientMessage: (id: string) => boolean) => {
          if (currentRun() !== runId) return false;
          let inputsCurrent = true;
          for (const { id, source } of adopted) {
            if (!hasClientMessage(id) || incoming?.get(id) !== source) inputsCurrent = false;
          }
          if (!inputsCurrent || !acceptView()) return false;
          if (incoming) {
            for (const { id } of adopted) incoming.delete(id);
            if (incoming.size === 0 && this.incoming.get(runId) === incoming)
              this.incoming.delete(runId);
          }
          return true;
        };
        const captured = views.map(
          ({ role, rootRunId, follow, snapshot: { boardId, ...snapshot }, latestChange }) => {
            const prior = delivered.get(role);
            // Keep an already delivered revision byte-identical so it does not append again.
            const withChange =
              prior?.boardId === boardId &&
              (prior.revision === snapshot.boardRevision
                ? prior.withChange
                : prior.runId === runId &&
                  prior.rootRunId === rootRunId &&
                  prior.follow === follow);
            const lastChange =
              withChange && latestChange
                ? { actorAgentId: latestChange.actorSessionId, summary: latestChange.summary }
                : undefined;
            return {
              role,
              delivery: {
                runId,
                rootRunId,
                follow,
                boardId,
                revision: snapshot.boardRevision,
                withChange
              },
              item: {
                id: role === 'own' ? 'mar.node.whiteboard.own' : 'mar.node.whiteboard',
                content: `${role === 'own' ? `Own board (your Agent ID: ${JSON.stringify(boardId)})` : 'Followed board'}:\n${JSON.stringify({ boardAgentId: boardId, ...snapshot, lastChange })}`
              }
            };
          }
        );
        return {
          accept,
          items: captured.map(({ item }) => item),
          acknowledge: (ids) => {
            for (const { role, item, delivery } of captured) {
              if (ids.has(item.id)) delivered.set(role, delivery);
            }
          }
        };
      },
      wake: {
        pending: () => (childWake?.pending() ?? false) || pendingWhiteboard(),
        reason: () => (childWake?.pending() ? 'subagent_message' : 'context_update'),
        subscribe: (listener) => {
          const runId = currentRun();
          const unsubscribeChildren = childWake?.subscribe(listener);
          const unsubscribeBoard = runId ? this.whiteboard.subscribe(runId, listener) : undefined;
          return () => {
            unsubscribeChildren?.();
            unsubscribeBoard?.();
          };
        }
      }
    };
  }
}
