import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import type { ConversationTurn } from '../../src/model/workbench.js';
import { createConversationProjectionService } from '../../src/service/conversation-projection-service.js';
import { createWorkbenchConversationComposition } from '../../src/service/workbench-conversation-composition.js';
import { createWorkbenchSessionWatchController } from '../../src/service/workbench-session-watch-controller.js';

describe('Session history Watch reset composition', () => {
  it.each(['reset', 'initial'] as const)(
    'replaces both page projections and caches and rejects late pagination after %s',
    async (mode) => {
      const removed: ConversationTurn = {
        id: 'removed-turn',
        sessionId: 'session-1',
        runId: 'run-1',
        status: 'SUCCEEDED',
        items: [],
        startedAt: 1,
        completedAt: 2
      };
      const pages = ['page-one', 'page-two'].map((id) => {
        const workspaceTarget = ref({ nodeId: 'node-1', workspaceId: 'workspace-1' });
        const selectedSessionId = ref<string | undefined>('session-1');
        const turns = ref<ConversationTurn[]>([]);
        const nextCursor = ref<string | null>(null);
        const loadingOlder = ref(false);
        const older = Promise.withResolvers<unknown>();
        const projection = createConversationProjectionService({
          turns,
          nextCursor,
          onRecentWindowOverflow: () => undefined,
          limitHistory: (values) => [...values]
        });
        const replaceCached = vi.fn();
        const window = createWorkbenchConversationComposition({
          workspaceTarget,
          selectedSessionId,
          turns,
          nextCursor,
          loadingOlder,
          projection,
          capturePrependAnchor: () => () => undefined,
          pageSize: 3,
          recentSegmentWindowSize: 15,
          request: async <T>() => older.promise as Promise<T>,
          sessionPathId: (value) => value,
          notice: vi.fn(),
          errorMessage: String,
          replaceCached
        });
        let identity: Record<string, unknown> = {};
        const watch = createWorkbenchSessionWatchController({
          workspaceTarget,
          selectedSessionId,
          followConversation: ref(false),
          workbenchConnectionId: () => `connection-${id}`,
          heartbeatMs: 60_000,
          requestTimeoutMs: 1_000,
          confirmationTimeoutMs: 60_000,
          request: async <T>(_path: string, init?: RequestInit) => {
            if (init?.method === 'POST') identity = JSON.parse(String(init.body));
            return { nodeGeneration: 'generation-1' } as T;
          },
          sessionPathId: (value) => value,
          applySnapshot: window.applySnapshot,
          scrollAfterLayout: async () => undefined,
          refreshSnapshot: vi.fn(),
          openSession: async () => undefined
        });
        const frame = (historyReset = false, empty = historyReset) => ({
          ...identity,
          sessionId: 'session-1',
          nodeGeneration: 'generation-1',
          type: 'watch.session.snapshot',
          ...(historyReset ? { historyReset: true } : {}),
          payload: {
            unit: 'SEGMENT',
            segments: empty ? [] : [{ ...removed, turnId: removed.id, index: 0 }],
            nextCursor: empty ? null : 'older',
            snapshotSequence: empty ? 2 : 1
          }
        });
        const snapshot = (historyReset = false) => watch.handleEvent(frame(historyReset));
        const reopenAfterHttp = async () => {
          const lateOldReset = frame(true);
          watch.stopSelectedSessionWatch();
          const initial = watch.beginSelectedSessionWatch('session-1');
          expect(watch.handleEvent(lateOldReset)).toBe(false);
          expect(watch.handleEvent(frame(false, true))).toBe(true);
          await initial;
        };
        return {
          watch,
          snapshot,
          reopenAfterHttp,
          turns,
          nextCursor,
          loadingOlder,
          older,
          window,
          replaceCached
        };
      });
      try {
        const starting = pages.map((page) => page.watch.beginSelectedSessionWatch('session-1'));
        for (const page of pages) expect(page.snapshot()).toBe(true);
        await Promise.all(starting);
        const requests = pages.map((page) => page.window.paging.loadOlderConversationTurns());
        for (const page of pages) {
          expect(page.loadingOlder.value).toBe(true);
          if (mode === 'reset') expect(page.snapshot(true)).toBe(true);
          else await page.reopenAfterHttp();
          expect(page.turns.value).toEqual([]);
          expect(page.nextCursor.value).toBeNull();
          expect(page.loadingOlder.value).toBe(false);
          page.older.resolve({
            unit: 'SEGMENT',
            segments: [{ ...removed, turnId: removed.id, index: 0 }],
            nextCursor: 'older',
            snapshotSequence: 1
          });
        }
        await Promise.all(requests);
        for (const page of pages) {
          expect(page.turns.value).toEqual([]);
          expect(page.replaceCached).toHaveBeenLastCalledWith('session-1', [], null);
        }
      } finally {
        for (const page of pages) page.watch.stopSelectedSessionWatch();
      }
    }
  );
});
