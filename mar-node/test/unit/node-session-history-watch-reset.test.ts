import { describe, expect, it, vi } from 'vitest';
import type { NodeAgentSession } from '../../src/database.js';
import { createTestSessionWatch } from './support/conversation-watch.js';

describe('Session history Watch reset', () => {
  it('does not publish a pre-reset initial read into the replacement lease', async () => {
    const session = {
      id: 'session-reset',
      workspaceId: 'workspace-reset',
      runner: 'codex',
      externalSessionId: 'native-reset'
    } as NodeAgentSession;
    const stale = Promise.withResolvers<{ turns: [{ id: string }] }>();
    const readPage = vi
      .fn()
      .mockImplementationOnce(() => stale.promise)
      .mockResolvedValue({ turns: [] });
    const frames: Array<Record<string, unknown>> = [];
    const watch = createTestSessionWatch({
      resolve: async () => session,
      managedActive: () => false,
      refreshActivity: async () => undefined,
      present: () => session,
      readPage,
      projectInitialPage: (_session, page) => page,
      emitSession: vi.fn(),
      emitPage: vi.fn(),
      emitWatchEvent: (frame) => frames.push(frame as Record<string, unknown>)
    });
    try {
      await watch.operations()['session.watch']!({
        sessionId: session.id,
        workspaceId: session.workspaceId,
        workbenchConnectionId: 'connection-page',
        watchId: 'watch-page',
        mode: 'initial',
        unit: 'SEGMENT'
      });
      await vi.waitFor(() => expect(readPage).toHaveBeenCalledTimes(1));
      watch.invalidate(session.id);
      await vi.waitFor(() => expect(frames).toHaveLength(1));
      stale.resolve({ turns: [{ id: 'deleted-turn' }] });
      await stale.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(frames).toEqual([
        expect.objectContaining({
          historyReset: true,
          payload: expect.objectContaining({ turns: [] })
        })
      ]);
    } finally {
      watch.clear();
    }
  });

  it('keeps both page leases and pushes reset snapshots without waiting for renewal', async () => {
    const session = {
      id: 'session-reset',
      workspaceId: 'workspace-reset',
      runner: 'codex',
      externalSessionId: 'native-reset'
    } as NodeAgentSession;
    const frames: Array<Record<string, unknown>> = [];
    let removed = false;
    const watch = createTestSessionWatch({
      resolve: async () => session,
      managedActive: () => false,
      refreshActivity: async () => undefined,
      present: () => session,
      readPage: async () => ({ turns: removed ? [] : [{ id: 'removed-turn' }] }),
      projectInitialPage: (_session, page) => page,
      emitSession: vi.fn(),
      emitPage: vi.fn(),
      emitWatchEvent: (frame) => frames.push(frame as Record<string, unknown>)
    });
    const inputs = ['page-one', 'page-two'].map((page) => ({
      sessionId: session.id,
      workspaceId: session.workspaceId,
      workbenchConnectionId: `connection-${page}`,
      watchId: `watch-${page}`,
      mode: 'initial',
      unit: 'SEGMENT'
    }));
    try {
      await Promise.all(inputs.map((input) => watch.operations()['session.watch']!(input)));
      await vi.waitFor(() => expect(frames).toHaveLength(2));
      frames.length = 0;
      removed = true;
      watch.invalidate(session.id);
      await vi.waitFor(() => expect(frames).toHaveLength(2));
      expect(frames).toEqual(
        inputs.map((input) =>
          expect.objectContaining({
            type: 'watch.session.snapshot',
            workbenchConnectionId: input.workbenchConnectionId,
            watchId: input.watchId,
            historyReset: true,
            payload: expect.objectContaining({ turns: [] })
          })
        )
      );
      for (const input of inputs)
        await expect(
          watch.operations()['session.watch']!({ ...input, mode: 'renew' })
        ).resolves.toMatchObject({ accepted: true });
    } finally {
      watch.clear();
    }
  });
});
