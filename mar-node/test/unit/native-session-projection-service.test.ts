import { describe, expect, it, vi } from 'vitest';
import { NodeDatabase } from '../../src/database.js';
import { CodexRunner } from '../../src/runner/codex-runner.js';
import { RunnerRegistry } from '../../src/runner/runner-registry.js';
import type { NodeAgentSession } from '../../src/session/contracts.js';
import { NativeSessionProjectionService } from '../../src/session/native-session-projection-service.js';

describe('native session metadata ownership', () => {
  it('discovers unregistered children for cleanup without registering them or accepting invalid relationships', async () => {
    const database = new NodeDatabase(':memory:', 'native-cleanup-children');
    try {
      const workspace = database.saveWorkspace({
        path: '/workspace',
        kind: 'DIRECTORY',
        gitSummary: null
      });
      const runner = new CodexRunner();
      const runners = new RunnerRegistry();
      runners.register(runner);
      vi.spyOn(runner, 'available').mockReturnValue(true);
      vi.spyOn(runner, 'discoverSessions').mockImplementation(async (context) =>
        [
          ['root', undefined],
          ['child', 'root'],
          ['grandchild', 'child'],
          ['orphan', 'missing'],
          ['too-deep', 'grandchild']
        ].map(([id, parent]) =>
          context.createProjection({
            workspace,
            runner: 'codex',
            externalSessionId: id!,
            cwd: workspace.path,
            ...(parent === undefined ? {} : { parentSessionId: parent })
          })
        )
      );
      const service = new NativeSessionProjectionService({
        database: () => database,
        nodeId: () => 'node',
        runners,
        capabilities: () => ({})
      } as unknown as ConstructorParameters<typeof NativeSessionProjectionService>[0]);
      const sessions = await service.discover('codex', workspace.id, true);
      expect(sessions.map(({ id, parentSessionId }) => [id, parentSessionId])).toEqual([
        ['root', null],
        ['child', 'root'],
        ['grandchild', 'child']
      ]);
      expect(database.listSessionRecords(workspace.id)).toEqual([]);
      expect(service.cachedNative()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it('imports a native parent snapshot once without replacing a Node relationship', () => {
    const database = new NodeDatabase(':memory:', 'native-parent-test');
    try {
      const workspace = database.saveWorkspace({
        path: '/workspace/native-parent',
        kind: 'DIRECTORY',
        gitSummary: null
      });
      const runners = new RunnerRegistry();
      runners.register(new CodexRunner());
      const service = new NativeSessionProjectionService({
        database: () => database,
        nodeId: () => 'node',
        runners
      } as unknown as ConstructorParameters<typeof NativeSessionProjectionService>[0]);
      const input = {
        runner: 'codex' as const,
        externalSessionId: 'child',
        workspace,
        cwd: workspace.path,
        parentSessionId: 'native-parent'
      };
      database.saveNativeSessionMetadata({
        runner: 'codex',
        externalSessionId: 'native-parent',
        workspaceId: workspace.id
      });
      const child = service.project(input);
      expect(child.parentSessionId).toBe('native-parent');
      service.remember([child]);
      expect(
        database.getNativeSessionMetadata('codex', 'child', workspace.id)?.parentSessionId
      ).toBe('native-parent');
      database.saveNativeSessionMetadata({
        runner: 'codex',
        externalSessionId: 'other-child',
        workspaceId: workspace.id,
        parentSessionId: 'node-parent'
      });
      const authoritative = service.project({ ...input, externalSessionId: 'other-child' });
      expect(authoritative.parentSessionId).toBe('node-parent');
      service.remember([authoritative]);
      expect(
        database.getNativeSessionMetadata('codex', 'other-child', workspace.id)?.parentSessionId
      ).toBe('node-parent');
      database.saveNativeSessionMetadata({
        runner: 'codex',
        externalSessionId: 'known-root',
        workspaceId: workspace.id
      });
      const root = service.project({ ...input, externalSessionId: 'known-root' });
      expect(root.parentSessionId).toBeNull();
      service.remember([root]);
      expect(
        database.getNativeSessionMetadata('codex', 'known-root', workspace.id)?.parentSessionId
      ).toBeNull();
      const invalid = service.project({
        ...input,
        externalSessionId: 'orphan',
        parentSessionId: 'missing'
      });
      service.remember([invalid]);
      expect(service.cachedNative().find((session) => session.id === 'orphan')).toBeUndefined();
      expect(database.getNativeSessionMetadata('codex', 'orphan', workspace.id)).toBeUndefined();
      service.remember([
        service.project({
          workspace,
          runner: 'codex',
          externalSessionId: 'missing',
          cwd: input.cwd
        })
      ]);
      service.remember([
        service.project({ ...input, externalSessionId: 'orphan', parentSessionId: 'missing' })
      ]);
      expect(
        database.getNativeSessionMetadata('codex', 'orphan', workspace.id)?.parentSessionId
      ).toBe('missing');
      const batch = [
        service.project({
          ...input,
          externalSessionId: 'batch-grandchild',
          parentSessionId: 'batch-child'
        }),
        service.project({
          ...input,
          externalSessionId: 'batch-child',
          parentSessionId: 'batch-root'
        }),
        service.project({
          workspace,
          runner: 'codex',
          externalSessionId: 'batch-root',
          cwd: input.cwd
        })
      ];
      const save = vi.spyOn(database, 'saveNativeSessionMetadata');
      service.remember(batch);
      expect(save.mock.calls.map(([entry]) => entry.externalSessionId)).toEqual([
        'batch-root',
        'batch-child',
        'batch-grandchild'
      ]);
      expect(
        database.getNativeSessionMetadata('codex', 'batch-grandchild', workspace.id)
          ?.parentSessionId
      ).toBe('batch-child');
      const tooDeep = service.project({
        ...input,
        externalSessionId: 'too-deep',
        parentSessionId: 'batch-grandchild'
      });
      service.remember([tooDeep]);
      expect(database.getNativeSessionMetadata('codex', 'too-deep', workspace.id)).toBeUndefined();
      expect(service.cachedNative().find((session) => session.id === 'too-deep')).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it('persists a native rename only after the runner accepts it and clears pending on confirmation', async () => {
    const database = new NodeDatabase(':memory:', 'native-projection-test');
    try {
      const workspace = database.saveWorkspace({
        path: '/workspace/native-projection',
        kind: 'DIRECTORY',
        gitSummary: null
      });
      const runner = new CodexRunner();
      const rename = vi.spyOn(runner, 'renameNative');
      const runners = new RunnerRegistry();
      runners.register(runner);
      const service = new NativeSessionProjectionService({
        database: () => database,
        nodeId: () => 'node',
        runners
      } as unknown as ConstructorParameters<typeof NativeSessionProjectionService>[0]);
      const session = {
        runner: 'codex',
        workspaceId: workspace.id,
        externalSessionId: 'thread'
      } as NodeAgentSession;

      rename.mockRejectedValueOnce(new Error('native rename failed'));
      await expect(service.rename(session, { title: 'New title', pinned: true })).rejects.toThrow(
        'native rename failed'
      );
      expect(database.getNativeSessionMetadata('codex', 'thread', workspace.id)).toBeUndefined();

      rename.mockResolvedValueOnce(undefined);
      await service.rename(session, { title: 'New title', pinned: true });
      expect(database.getNativeSessionMetadata('codex', 'thread', workspace.id)).toMatchObject({
        runnerTitle: 'New title',
        runnerTitlePending: true,
        pinnedAt: expect.any(Number)
      });
      const input = {
        runner: 'codex' as const,
        externalSessionId: 'thread',
        workspace,
        cwd: workspace.path,
        title: 'Old title',
        titleOrigin: 'OFFICIAL' as const
      };
      expect(service.project(input).runnerTitle).toBe('New title');
      expect(
        database.getNativeSessionMetadata('codex', 'thread', workspace.id)?.runnerTitlePending
      ).toBe(true);
      expect(service.project({ ...input, title: 'New title' }).runnerTitle).toBe('New title');
      expect(
        database.getNativeSessionMetadata('codex', 'thread', workspace.id)?.runnerTitlePending
      ).toBe(false);
    } finally {
      database.close();
    }
  });
});
