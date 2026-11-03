import { workspaceTargetRef } from './support/workspace-fixture.js';
import { ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import { createWorkbenchPerformanceService } from '../../src/service/workbench-performance-service.js';
import { createWorkbenchSessionWatchController } from '../../src/service/workbench-session-watch-controller.js';
import type { Session } from '../../src/model/workbench.js';

function fixture() {
  const view = ref('nodes');
  const nodeId = ref<string | undefined>('node');
  const workspaceId = ref<string | undefined>('workspace');
  const sessionId = ref<string | undefined>('session');
  return {
    view,
    nodeId,
    workspaceId,
    sessionId,
    service: createWorkbenchPerformanceService({ view, nodeId, workspaceId, sessionId })
  };
}

describe('Selected Workspace session performance', () => {
  it('restores active metrics through a fresh Watch after switching back and rejects stale snapshots', async () => {
    const f = fixture();
    const requests: Record<string, unknown>[] = [];
    const controller = createWorkbenchSessionWatchController({
      workspaceTarget: workspaceTargetRef(f.nodeId, f.workspaceId),
      selectedSessionId: f.sessionId,
      followConversation: ref(false),
      heartbeatMs: 15_000,
      requestTimeoutMs: 10_000,
      confirmationTimeoutMs: 45_000,
      request: async (_path, init) => {
        if (init?.method === 'POST')
          requests.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return { nodeGeneration: 'generation' } as never;
      },
      sessionPathId: (id) => id,
      applySnapshot: () => true,
      applyEvent: (event) => {
        const payload = event.payload as { sessionId?: string; performance?: unknown };
        if (event.category === 'conversation' && payload.sessionId !== undefined)
          f.service.receive(payload.sessionId, payload.performance);
      },
      scrollAfterLayout: async () => undefined,
      refreshSnapshot: vi.fn(),
      openSession: async () => undefined
    });
    const snapshot = (watchId: unknown, performance?: unknown) => ({
      type: 'watch.session.snapshot',
      workbenchConnectionId: 'local-test-connection',
      nodeGeneration: 'generation',
      nodeId: 'node',
      workspaceId: 'workspace',
      sessionId: 'session',
      watchId,
      payload: {
        kind: 'session-watch-snapshot',
        sequence: 1,
        session: { id: 'session', workspaceId: 'workspace', activity: 'MANAGED_ACTIVE' },
        runs: [{ id: 'run', sessionId: 'session', status: 'RUNNING' }],
        performance,
        conversation: { unit: 'SEGMENT', segments: [], nextCursor: null }
      }
    });
    try {
      const initial = controller.beginSelectedSessionWatch('session');
      await vi.waitFor(() => expect(requests).toHaveLength(1));
      const previousWatchId = requests[0]?.watchId;
      controller.handleEvent(snapshot(previousWatchId, { runId: 'run', latencyMs: 420 }));
      await initial;
      expect(f.service.current.value?.latencyMs).toBe(420);
      controller.stopSelectedSessionWatch();
      f.sessionId.value = 'other';
      expect(f.service.current.value).toBeUndefined();
      f.sessionId.value = 'session';
      expect(f.service.current.value).toBeUndefined();
      const reopened = controller.beginSelectedSessionWatch('session');
      await vi.waitFor(() => expect(requests).toHaveLength(2));
      expect(
        controller.handleEvent(snapshot(previousWatchId, { runId: 'run', latencyMs: 999 }))
      ).toBe(false);
      expect(f.service.current.value).toBeUndefined();
      const watchId = requests[1]?.watchId;
      controller.handleEvent(
        snapshot(watchId, { runId: 'run', latencyMs: 80, tokensPerSecond: 42 })
      );
      await reopened;
      expect(f.service.current.value).toEqual({ runId: 'run', latencyMs: 80, tokensPerSecond: 42 });
      controller.handleEvent(snapshot(watchId, { runId: 'run', latencyMs: -1 }));
      expect(f.service.current.value?.latencyMs).toBe(80);
      controller.handleEvent(snapshot(watchId));
      expect(f.service.current.value?.latencyMs).toBe(80);
    } finally {
      controller.stopSelectedSessionWatch();
      f.service.dispose();
    }
  });

  it('keeps only the latest pushed facts and accepts either metric, including zero', () => {
    const { service } = fixture();
    try {
      service.receive('session', { runId: 'run', latencyMs: 0 });
      expect(service.current.value).toEqual({ runId: 'run', latencyMs: 0 });
      service.receive('session', { runId: 'run', tokensPerSecond: 12 });
      expect(service.current.value).toEqual({ runId: 'run', latencyMs: 0, tokensPerSecond: 12 });
      service.receive('session', { runId: 'run', latencyMs: 80, tokensPerSecond: undefined });
      expect(service.current.value).toEqual({ runId: 'run', latencyMs: 80, tokensPerSecond: 12 });
      service.receive('session', { runId: 'run', tokensPerSecond: NaN });
      service.receive('session', { runId: 'run' });
      service.receive('session', { runId: 'run', ttftMs: 420 });
      service.receive('other-session', { runId: 'other', latencyMs: 99 });
      expect(service.current.value).toEqual({ runId: 'run', latencyMs: 80, tokensPerSecond: 12 });
      service.receive('session', { runId: 'run', tokensPerSecond: 0 });
      expect(service.current.value).toEqual({ runId: 'run', latencyMs: 80, tokensPerSecond: 0 });
      service.receive('session', { runId: 'new-run', latencyMs: 10 });
      expect(service.current.value).toEqual({ runId: 'new-run', latencyMs: 10 });
    } finally {
      service.dispose();
    }
  });

  it.each(['view', 'nodeId', 'workspaceId', 'sessionId'] as const)(
    'clears immediately on %s changes and does not restore metrics when returning',
    (key) => {
      const f = fixture();
      try {
        f.service.receive('session', { runId: 'run', latencyMs: 420, tokensPerSecond: 42 });
        const original = f[key].value;
        f[key].value = 'other';
        expect(f.service.current.value).toBeUndefined();
        f[key].value = original!;
        expect(f.service.current.value).toBeUndefined();
        f.service.receive('session', { runId: 'new-run', latencyMs: 8 });
        expect(f.service.current.value).toEqual({ runId: 'new-run', latencyMs: 8 });
      } finally {
        f.service.dispose();
      }
    }
  );

  it('never collects background performance outside Workspace mode', () => {
    const { service, view } = fixture();
    try {
      view.value = 'conversations';
      service.receive('session', { runId: 'run', latencyMs: 420 });
      expect(service.current.value).toBeUndefined();
      view.value = 'nodes';
      expect(service.current.value).toBeUndefined();
    } finally {
      service.dispose();
    }
  });
});
