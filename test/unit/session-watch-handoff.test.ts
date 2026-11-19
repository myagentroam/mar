import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import {
  watchEventSchema,
  type WorkbenchEventCategory
} from '../../packages/protocol/src/index.js';
import { NodeConnector } from '../../mar-node/src/connector.js';
import type { NodeRuntimeState } from '../../mar-node/src/runtime-state.js';
import type {
  NodeConversationItem,
  NodeConversationTurn
} from '../../mar-node/src/runtime-model.js';
import type { NodeWorkspace } from '../../mar-node/src/workspace/contracts.js';
import type { ConversationHistoryService } from '../../mar-node/src/service/conversation-history-service.js';
import type { WorkbenchEventService } from '../../mar-node/src/service/workbench-event-service.js';
import type {
  NativeSessionWatchOptions,
  NativeSessionWatchService
} from '../../mar-node/src/service/native-session-watch-service.js';
import { conversationSegments } from '../../mar-node/src/service/conversation-segment-service.js';
import type {
  AgentRun,
  ConversationSegmentPage,
  Session
} from '../../packages/web-core/src/model/workbench.js';
import { createConversationProjectionState } from '../../packages/web-core/src/service/conversation-projection-service.js';
import { createWorkbenchConversationSnapshotService } from '../../packages/web-core/src/service/workbench-conversation-snapshot-service.js';
import { createWorkbenchEventProjectionService } from '../../packages/web-core/src/service/workbench-event-projection-service.js';
import { createWorkbenchSessionWatchController } from '../../packages/web-core/src/service/workbench-session-watch-controller.js';

type SessionFrame = Extract<
  ReturnType<typeof watchEventSchema.parse>,
  { type: 'watch.session.snapshot' | 'watch.session.event' }
>;

function gate() {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, wait };
}

describe('ordinary Session Watch Segment handoff', () => {
  it.each(['old frame in flight', 'new lease pending'] as const)(
    'keeps the omitted authoritative Segment, without replaying covered text (%s)',
    async (timing) => {
      const connector = new NodeConnector({ reconnect: false });
      const node = connector as unknown as {
        readonly runtime: NodeRuntimeState;
        readonly conversationHistoryService: ConversationHistoryService;
        readonly workbenchEventService: WorkbenchEventService;
        send(type: string, payload: unknown): void;
        readonly nativeSessionWatchService: NativeSessionWatchService;
        emitWorkbenchEvent(category: WorkbenchEventCategory, payload: unknown): void;
      };
      const operation = (method: string, input: unknown) =>
        Promise.resolve(node.nativeSessionWatchService.operations()[method]!(input));
      const workspaceId = 'workspace-1';
      const workspace: NodeWorkspace = {
        id: workspaceId,
        path: '/synthetic',
        kind: 'DIRECTORY',
        gitSummary: null
      };
      vi.spyOn(
        node.runtime as unknown as { getWorkspace(id: string): NodeWorkspace | undefined },
        'getWorkspace'
      ).mockImplementation((id) => (id === workspaceId ? workspace : undefined));
      const bootstrap = node.runtime.createAgentSession({
        workspaceId,
        runner: 'codex',
        cwd: '/synthetic'
      });
      const session = node.runtime.promoteSessionIdentity(bootstrap.id, 'synthetic-native');
      const run = node.runtime.createMessageRun({
        sessionId: session.id,
        content: 'synthetic input',
        clientMessageId: 'input-1'
      }).run;
      const turn = node.runtime.conversationTurnForRun(run.id)!;
      let admission:
        | { readonly reached: ReturnType<typeof gate>; readonly release: ReturnType<typeof gate> }
        | undefined;
      const watchOptions = (
        node.nativeSessionWatchService as unknown as { options: NativeSessionWatchOptions }
      ).options;
      vi.spyOn(watchOptions, 'resolve').mockImplementation(async (id) => {
        const blocked = admission;
        if (blocked !== undefined) {
          blocked.reached.open();
          await blocked.release.wait;
        }
        return node.runtime.getAgentSession(id);
      });
      vi.spyOn(node.conversationHistoryService, 'refreshExternalActivity').mockResolvedValue(
        undefined
      );
      const item = (
        id: string,
        kind: NodeConversationItem['kind'],
        text: string
      ): NodeConversationItem => ({
        id: `${run.id}:${id}`,
        kind,
        status: 'IN_PROGRESS',
        payload: { text },
        sessionId: session.id,
        turnId: turn.id,
        runId: run.id,
        parentItemId: null,
        sourceSequence: null,
        revision: 0,
        startedAt: 1,
        completedAt: null
      });
      let authoritative: NodeConversationTurn = {
        ...turn,
        status: 'RUNNING',
        items: Array.from({ length: 7 }, (_, index) => [
          item(`tool-${index}`, 'tool_call', `tool ${index}`),
          item(`reply-${index}`, 'assistant_message', `authoritative ${index}`)
        ]).flat()
      };
      vi.spyOn(node.runtime, 'conversationTurnForRun').mockImplementation((id) =>
        id === run.id ? authoritative : undefined
      );
      const read = async () => {
        return {
          turns: [authoritative],
          source: 'runtime' as const,
          snapshotSequence: node.workbenchEventService.snapshotSequence(),
          nextCursor: null,
          readAt: 1,
          latestVisibleAt: 1
        };
      };
      vi.spyOn(node.conversationHistoryService, 'read').mockImplementation(read);
      vi.spyOn(node.conversationHistoryService, 'readHistoryPage').mockImplementation(read);
      const frames: SessionFrame[] = [];
      const initialFailures = new Map<string, string>();
      const initialEmitted = new Map<string, ReturnType<typeof gate>>();
      vi.spyOn(node, 'send').mockImplementation((type, payload) => {
        if (type !== 'watch.event') return;
        const frame = watchEventSchema.parse(JSON.parse(JSON.stringify(payload)));
        if (frame.type === 'watch.failed') {
          initialFailures.set(frame.watchId, frame.code);
          initialEmitted.get(frame.watchId)?.open();
        }
        if (frame.type !== 'watch.session.snapshot' && frame.type !== 'watch.session.event') return;
        frames.push(frame);
        if (frame.type === 'watch.session.snapshot') initialEmitted.get(frame.watchId)?.open();
      });
      const segments = conversationSegments(authoritative);
      expect(segments).toHaveLength(7);
      const omitted = segments[0]!;
      const included = segments[6]!;
      const workspaceTarget = ref({ nodeId: 'runtime-node', workspaceId });
      const createPane = (position?: 'secondary') => {
        const selectedSessionId = ref<string | undefined>(session.id);
        const { turns, nextCursor, projection } = createConversationProjectionState({
          limitHistory: (units) => [...units],
          onRecentWindowOverflow: vi.fn()
        });
        const noEffect = () => undefined;
        const snapshots = createWorkbenchConversationSnapshotService({
          selectedSessionId,
          replaceCurrent: projection.replaceAuthoritative,
          mergeCurrent: projection.mergeLatest,
          currentWindow: () => ({ turns: turns.value, nextCursor: nextCursor.value }),
          replaceCached: noEffect
        });
        const eventProjection = createWorkbenchEventProjectionService({
          workspaceTarget,
          selectedSessionId,
          sessions: ref<Session[]>([]),
          conversationNextCursor: nextCursor,
          cacheQueue: noEffect,
          mergeQueue: noEffect,
          mergeSessions: noEffect,
          settleSessionRuns: () => false,
          observeSessionRunning: noEffect,
          updateContext: noEffect,
          syncTurnStatus: noEffect,
          cacheRun: noEffect,
          acceptRun: (value: AgentRun) => value,
          openRun: noEffect,
          markLiveTurn: projection.markLive,
          cacheTurn: noEffect,
          mergeTurns: projection.mergeLatest,
          applyConversationSnapshot: snapshots.apply,
          mergeItem: projection.mergeItem,
          mergeTextDelta: projection.mergeTextDelta,
          invalidateWorkspace: noEffect,
          onNodeConnected: noEffect
        });
        const requests: Record<string, unknown>[] = [];
        let nextRequest:
          { seen: ReturnType<typeof gate>; hold?: ReturnType<typeof gate> } | undefined;
        const watch = createWorkbenchSessionWatchController({
          ...(position === undefined ? {} : { position, enabled: () => true }),
          workspaceTarget,
          selectedSessionId,
          followConversation: ref(false),
          heartbeatMs: 60_000,
          requestTimeoutMs: 5_000,
          confirmationTimeoutMs: 5_000,
          workbenchConnectionId: () => 'connection-1',
          sessionPathId: (id) => id,
          request: async <T>(_path: string, init?: RequestInit) => {
            const body: Record<string, unknown> = {
              ...(JSON.parse(String(init?.body)) as Record<string, unknown>),
              sessionId: session.id
            };
            requests.push(body);
            if (body.mode === 'initial') {
              initialEmitted.set(String(body.watchId), gate());
              const request = nextRequest;
              request?.seen.open();
              await request?.hold?.wait;
            }
            try {
              return (await operation(
                init?.method === 'DELETE' ? 'session.unwatch' : 'session.watch',
                body
              )) as T;
            } catch (error) {
              initialFailures.set(String(body.watchId), String(error));
              initialEmitted.get(String(body.watchId))?.open();
              throw error;
            }
          },
          applyEvent: eventProjection.apply,
          applySnapshot: snapshots.apply,
          scrollAfterLayout: async () => undefined,
          refreshSnapshot: vi.fn(),
          openSession: async () => undefined
        });
        return {
          watch,
          requests,
          turns,
          nextCursor,
          projection,
          start: (hold?: ReturnType<typeof gate>) => {
            const seen = gate();
            nextRequest = { seen, ...(hold === undefined ? {} : { hold }) };
            const done = watch.initializeSelectedSessionWatch(session.id);
            void done.catch(() => undefined);
            return { seen: seen.wait, done };
          }
        };
      };
      const primary = createPane();
      const secondary = createPane('secondary');
      const initial = async (id: string) => {
        await initialEmitted.get(id)!.wait;
        expect(initialFailures.get(id)).toBeUndefined();
        const frame = frames.find(
          (entry) => entry.type === 'watch.session.snapshot' && entry.watchId === id
        )!;
        expect(frame.type).toBe('watch.session.snapshot');
        if (frame.type !== 'watch.session.snapshot') throw new Error('No initial snapshot');
        const payload = frame.payload as { kind: string; conversation: ConversationSegmentPage };
        expect(payload.kind).toBe('session-watch-snapshot');
        expect(payload.conversation.segments.map(({ id }) => id)).toEqual(
          segments.slice(1).map(({ id }) => id)
        );
        return { frame, page: payload.conversation };
      };
      const publish = (index: number, type: 'delta' | 'item', text: string) => {
        const itemId = `${type === 'delta' ? 'reply' : 'tool'}-${index}`;
        const target = `${run.id}:${itemId}`;
        const sequence = node.workbenchEventService.snapshotSequence() + 1;
        authoritative = {
          ...authoritative,
          items: authoritative.items.map((value) =>
            value.id !== target
              ? value
              : {
                  ...value,
                  revision: sequence,
                  ...(type === 'item' ? { status: 'COMPLETED', completedAt: 2 } : {}),
                  payload: {
                    text:
                      type === 'delta' ? `${(value.payload as { text: string }).text}${text}` : text
                  }
                }
          )
        };
        node.emitWorkbenchEvent('conversation', {
          event: {
            runId: run.id,
            sequence,
            eventType: type === 'delta' ? 'text.delta' : 'conversation.item',
            createdAt: 2,
            payload: type === 'delta' ? { itemId, text } : { itemId, kind: 'tool_call' }
          }
        });
      };
      const deliver = (frame: SessionFrame) => [
        primary.watch.handleEvent(frame),
        secondary.watch.handleEvent(frame)
      ];
      const eventsFor = (id: string, start: number) =>
        frames
          .slice(start)
          .filter((frame) => frame.type === 'watch.session.event' && frame.watchId === id);
      const id = (pane: typeof primary) =>
        String(pane.requests.findLast((request) => request.mode === 'initial')?.watchId);
      const expectResult = (pane: typeof primary) => {
        pane.projection.flushPendingTextDeltas();
        expect(pane.turns.value.map((value) => value.id)).toEqual(
          segments.map((value) => value.id)
        );
        const target = pane.turns.value.find((value) => value.id === omitted.id)!;
        expect(target.items).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: `${run.id}:reply-0`,
              payload: expect.objectContaining({ text: 'authoritative 0 / delta A / delta B' })
            }),
            expect.objectContaining({
              id: `${run.id}:tool-0`,
              status: 'COMPLETED',
              payload: { text: 'updated tool' }
            })
          ])
        );
        expect(target.items.filter((item) => item.id === `${run.id}:tool-0`)).toHaveLength(1);
        expect(target.items.filter((item) => item.id === `${run.id}:reply-0`)).toHaveLength(1);
        const visible = pane.turns.value.find((value) => value.id === included.id)!;
        expect(
          visible.items.find((value) => value.id === `${run.id}:reply-6`)?.payload
        ).toMatchObject({
          text: 'authoritative 6 / covered'
        });
      };

      const hold = gate();
      try {
        const first = primary.start();
        const other = secondary.start();
        await Promise.all([first.seen, other.seen]);
        const oldId = id(primary);
        const otherId = id(secondary);
        const oldInitial = await initial(oldId);
        expect(deliver(oldInitial.frame)).toEqual([true, false]);
        expect(deliver((await initial(otherId)).frame)).toEqual([false, true]);
        await Promise.all([first.done, other.done]);
        expect(primary.turns.value).toHaveLength(6);
        const offset = frames.length;
        const blocked = { reached: gate(), release: gate() };
        admission = blocked;
        const replacement = primary.start(timing === 'old frame in flight' ? hold : undefined);
        await replacement.seen;
        if (timing === 'new lease pending') await blocked.reached.wait;
        publish(0, 'delta', ' / delta A');
        publish(0, 'delta', ' / delta B');
        publish(0, 'item', 'updated tool');
        publish(6, 'delta', ' / covered');
        const seq = node.workbenchEventService.snapshotSequence();
        for (const frame of eventsFor(otherId, offset))
          expect(deliver(frame)).toEqual([false, true]);
        const newId = id(primary);
        expect(newId).not.toBe(oldId);
        const currentWire = eventsFor(timing === 'old frame in flight' ? oldId : otherId, offset);
        expect(currentWire).not.toHaveLength(0);
        const candidate = currentWire[0]!;
        for (const patch of [
          { watchId: 'unknown' },
          { workspaceId: 'other-workspace' },
          { sessionId: 'other-session' },
          { nodeId: 'other-node' },
          { nodeGeneration: 'retired-generation' },
          { workbenchConnectionId: 'other-connection' }
        ]) {
          expect(deliver({ ...candidate, ...patch })).toEqual([false, false]);
        }
        expect(deliver(oldInitial.frame)).toEqual([false, false]);
        if (timing === 'old frame in flight') {
          workspaceTarget.value = { ...workspaceTarget.value, workspaceId: 'other-workspace' };
          expect(deliver(candidate)).toEqual([false, false]);
          workspaceTarget.value = { ...workspaceTarget.value, workspaceId };
          for (const frame of currentWire) deliver(frame);
          hold.open();
          await blocked.reached.wait;
        }
        blocked.release.open();
        const fresh = await initial(newId);
        expect(fresh.page.snapshotSequence).toBeGreaterThanOrEqual(seq);
        const pendingWire = eventsFor(newId, offset);
        if (timing === 'new lease pending') {
          // The Node initial has been produced, but Web has not yet applied it.
          for (const frame of pendingWire) expect(deliver(frame)).toEqual([true, false]);
        }
        expect(deliver(fresh.frame)).toEqual([true, false]);
        await replacement.done;
        expectResult(primary);
        expectResult(secondary);
        for (const frame of pendingWire) expect(deliver(frame)).toEqual([true, false]);
        expectResult(primary);
        expect(deliver(oldInitial.frame)).toEqual([false, false]);
        expect(deliver({ ...candidate, watchId: oldId })).toEqual([false, false]);
        const renew = (pane: typeof primary, overrides = {}) =>
          operation('session.watch', {
            ...pane.requests.findLast((request) => request.mode === 'initial'),
            mode: 'renew',
            ...overrides
          });
        await expect(renew(primary)).resolves.toMatchObject({ watchId: newId });
        await expect(renew(secondary)).resolves.toMatchObject({ watchId: otherId });
        await expect(renew(primary, { watchId: oldId })).rejects.toThrow('SESSION_WATCH_NOT_FOUND');
        await expect(renew(primary, { position: 'secondary' })).rejects.toThrow(
          'SESSION_WATCH_NOT_FOUND'
        );
      } finally {
        hold.open();
        admission?.release.open();
        primary.watch.stopSelectedSessionWatch();
        secondary.watch.stopSelectedSessionWatch();
        connector.stop();
      }
    }
  );
});
