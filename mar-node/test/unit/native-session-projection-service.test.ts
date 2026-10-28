import { describe, expect, it, vi } from 'vitest';
import { NodeDatabase } from '../../src/database.js';
import { CodexRunner } from '../../src/runner/codex-runner.js';
import { RunnerRegistry } from '../../src/runner/runner-registry.js';
import type { NodeAgentSession } from '../../src/session/contracts.js';
import { NativeSessionProjectionService } from '../../src/session/native-session-projection-service.js';

describe('native session metadata ownership', () => {
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
