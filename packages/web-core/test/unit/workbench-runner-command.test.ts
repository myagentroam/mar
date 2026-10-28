import { ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import type { AgentRun, Session, WorkspaceTarget } from '../../src/model/workbench.js';
import { createWorkbenchRunnerCommandService } from '../../src/service/workbench-runner-command-service.js';
import { createRunService } from '../../src/service/run-service.js';
import { createWorkspaceViewCacheService } from '../../src/service/workspace-view-cache-service.js';

describe('Workbench runner command', () => {
  it.each(['retained', 'removed', 'reopened'] as const)(
    'delivers a late reply only to its original %s cache instance',
    async (state) => {
      const workspaceTarget = ref<WorkspaceTarget | undefined>({
        nodeId: 'node-1',
        workspaceId: 'workspace-1'
      });
      const selectedSessionId = ref<string | undefined>('session-1');
      const runService = createRunService(selectedSessionId);
      const cache = createWorkspaceViewCacheService((node, workspace) => `${node}:${workspace}`);
      const session: Session = {
        id: 'session-1',
        workspaceId: 'workspace-1',
        runner: 'codex',
        externalSessionId: 'native'
      };
      const openCache = () => {
        cache.activate('node-1', 'workspace-1');
        cache.captureActive(
          {
            sessions: [session],
            selectedSessionId: session.id,
            detail: {
              sessionId: session.id,
              runs: [],
              turns: [],
              nextCursor: null,
              contextUsage: null,
              lastAccessedAt: 1
            }
          },
          5
        );
      };
      openCache();
      let revision = 1;
      let finish!: (value: unknown) => void;
      const service = createWorkbenchRunnerCommandService({
        workspaceTarget,
        selectedSessionId,
        currentSelectionRevision: () => revision,
        acceptRun: runService.acceptRun,
        captureCacheTarget: cache.captureCommandTarget,
        request: (() => new Promise((resolve) => (finish = resolve))) as never,
        sessionPathId: (id) => id,
        acceptSession: vi.fn(),
        configure: vi.fn(),
        resetHistory: vi.fn(),
        openRun: vi.fn(),
        notifyGoalAlreadyActive: vi.fn()
      });
      const pending = service.execute(session, 'goal', '');
      if (state !== 'retained') cache.remove('node-1', 'workspace-1');
      workspaceTarget.value = {
        nodeId: 'node-1',
        workspaceId: state === 'reopened' ? 'workspace-1' : 'workspace-2'
      };
      revision += 2;
      if (state === 'reopened') openCache();
      finish({
        session: { ...session, customTitle: 'old response' },
        run: { id: 'old-run', sessionId: session.id, status: 'RUNNING' }
      });
      await pending;
      expect(runService.runs.value).toEqual([]);
      if (state === 'removed') {
        expect(cache.has('node-1', 'workspace-1')).toBe(false);
      } else if (state === 'reopened') {
        expect(cache.detail('node-1', 'workspace-1', session.id)?.runs).toEqual([]);
        expect(cache.view('node-1', 'workspace-1').sessions).toEqual([session]);
      } else {
        expect(
          cache.detail('node-1', 'workspace-1', session.id)?.runs.map((run) => run.id)
        ).toEqual(['old-run']);
        expect(cache.view('node-1', 'workspace-1').sessions[0]?.customTitle).toBe('old response');
      }
    }
  );

  it('does not apply an old reply after the user switches away and returns to the same Session', async () => {
    const workspaceTarget = ref<WorkspaceTarget | undefined>({
      nodeId: 'node-1',
      workspaceId: 'workspace-1'
    });
    const selectedSessionId = ref<string | undefined>('session-1');
    const runService = createRunService(selectedSessionId);
    let revision = 1;
    let resolve!: (value: unknown) => void;
    const request = vi.fn(() => new Promise((done) => (resolve = done)));
    const resetHistory = vi.fn();
    const configure = vi.fn();
    const openRun = vi.fn();
    const cacheRun = vi.fn();
    const acceptSession = vi.fn();
    const service = createWorkbenchRunnerCommandService({
      workspaceTarget,
      selectedSessionId,
      currentSelectionRevision: () => revision,
      acceptRun: runService.acceptRun,
      request: request as never,
      sessionPathId: (id) => id,
      acceptSession,
      configure,
      resetHistory,
      openRun,
      captureCacheTarget: (node, workspace) => ({
        isCurrent: () => true,
        replaceSession: vi.fn(),
        cacheRun: (run) => cacheRun(node, workspace, run)
      }),
      notifyGoalAlreadyActive: vi.fn()
    });
    const session = { id: 'session-1', workspaceId: 'workspace-1', runner: 'codex' } as Session;
    const run = { id: 'run-1', sessionId: session.id, status: 'RUNNING' } as AgentRun;
    const operation = service.execute(session, 'clear', '', true);
    selectedSessionId.value = 'session-2';
    revision += 1;
    selectedSessionId.value = 'session-1';
    revision += 1;
    resolve({ session, run });
    await operation;
    expect(acceptSession).toHaveBeenCalledWith('node-1', 'workspace-1', session.id, session, false);
    expect(cacheRun).toHaveBeenCalledWith('node-1', 'workspace-1', run);
    expect(configure).not.toHaveBeenCalled();
    expect(resetHistory).not.toHaveBeenCalled();
    expect(openRun).not.toHaveBeenCalled();
    expect(runService.runs.value).toEqual([]);
  });

  it('does not project a Run into a different workspace while destructive history reload is pending', async () => {
    const workspaceTarget = ref<WorkspaceTarget | undefined>({
      nodeId: 'node-1',
      workspaceId: 'workspace-1'
    });
    const selectedSessionId = ref<string | undefined>('session-1');
    const runService = createRunService(selectedSessionId);
    const runs = runService.runs;
    const session = { id: 'session-1', workspaceId: 'workspace-1', runner: 'codex' } as Session;
    const run = { id: 'run-1', sessionId: session.id, status: 'RUNNING' } as AgentRun;
    let finishReload!: () => void;
    const resetHistory = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishReload = resolve;
        })
    );
    const cacheRun = vi.fn();
    const openRun = vi.fn();
    const service = createWorkbenchRunnerCommandService({
      workspaceTarget,
      selectedSessionId,
      currentSelectionRevision: () => 0,
      acceptRun: runService.acceptRun,
      request: vi.fn().mockResolvedValue({ run }) as never,
      sessionPathId: (id) => id,
      acceptSession: vi.fn(),
      configure: vi.fn(),
      resetHistory,
      openRun,
      captureCacheTarget: (node, workspace) => ({
        isCurrent: () => true,
        replaceSession: vi.fn(),
        cacheRun: (run) => cacheRun(node, workspace, run)
      }),
      notifyGoalAlreadyActive: vi.fn()
    });
    const operation = service.execute(session, 'clear', '', true);
    await vi.waitFor(() => expect(resetHistory).toHaveBeenCalledOnce());
    workspaceTarget.value = { nodeId: 'node-1', workspaceId: 'workspace-2' };
    selectedSessionId.value = 'session-2';
    finishReload();
    await operation;
    expect(openRun).not.toHaveBeenCalled();
    expect(cacheRun).toHaveBeenCalledWith('node-1', 'workspace-1', run);
    expect(runs.value).toEqual([]);
  });

  it('does not adopt a later visit to the same Session while its own history reload is pending', async () => {
    const workspaceTarget = ref<WorkspaceTarget | undefined>({
      nodeId: 'node-1',
      workspaceId: 'workspace-1'
    });
    const selectedSessionId = ref<string | undefined>('session-1');
    const runService = createRunService(selectedSessionId);
    let revision = 1;
    let finishReload!: () => void;
    const resetHistory = vi.fn(() => {
      revision += 1;
      return new Promise<void>((resolve) => (finishReload = resolve));
    });
    const openRun = vi.fn();
    const cacheRun = vi.fn();
    const session = { id: 'session-1', workspaceId: 'workspace-1', runner: 'codex' } as Session;
    const run = { id: 'run-1', sessionId: session.id, status: 'RUNNING' } as AgentRun;
    const service = createWorkbenchRunnerCommandService({
      workspaceTarget,
      selectedSessionId,
      currentSelectionRevision: () => revision,
      acceptRun: runService.acceptRun,
      request: vi.fn().mockResolvedValue({ run }) as never,
      sessionPathId: (id) => id,
      acceptSession: vi.fn(),
      configure: vi.fn(),
      resetHistory,
      openRun,
      captureCacheTarget: (node, workspace) => ({
        isCurrent: () => true,
        replaceSession: vi.fn(),
        cacheRun: (run) => cacheRun(node, workspace, run)
      }),
      notifyGoalAlreadyActive: vi.fn()
    });
    const operation = service.execute(session, 'clear', '', true);
    await vi.waitFor(() => expect(resetHistory).toHaveBeenCalledOnce());
    selectedSessionId.value = 'session-2';
    revision += 1;
    selectedSessionId.value = 'session-1';
    revision += 1;
    finishReload();
    await operation;
    expect(openRun).not.toHaveBeenCalled();
    expect(cacheRun).toHaveBeenCalledWith('node-1', 'workspace-1', run);
    expect(runService.runs.value).toEqual([]);
  });

  it('applies a current command result and preserves run convergence', async () => {
    const workspaceTarget = ref<WorkspaceTarget | undefined>({
      nodeId: 'node-1',
      workspaceId: 'workspace-1'
    });
    const selectedSessionId = ref<string | undefined>('session-1');
    const session = {
      id: 'session-1',
      workspaceId: 'workspace-1',
      runner: 'mar-agent',
      model: 'model-1'
    } as Session;
    const run = { id: 'run-1', sessionId: session.id, status: 'RUNNING', version: 3 } as AgentRun;
    const runService = createRunService(selectedSessionId);
    runService.replaceRuns([run]);
    const runs = runService.runs;
    const request = vi
      .fn()
      .mockResolvedValue({ session, run: { ...run, status: 'STARTING', version: 2 } });
    const configure = vi.fn();
    const openRun = vi.fn();
    let revision = 1;
    const resetHistory = vi.fn(async () => {
      revision += 1;
    });
    const service = createWorkbenchRunnerCommandService({
      workspaceTarget,
      selectedSessionId,
      currentSelectionRevision: () => revision,
      acceptRun: runService.acceptRun,
      request: request as never,
      sessionPathId: (id) => id,
      acceptSession: vi.fn(),
      configure,
      resetHistory,
      openRun,
      captureCacheTarget: () => ({
        isCurrent: () => true,
        replaceSession: vi.fn(),
        cacheRun: vi.fn()
      }),
      notifyGoalAlreadyActive: vi.fn()
    });
    await service.execute(session, 'compact', 'input', true);
    expect(JSON.parse(String(request.mock.calls[0]![1].body))).toMatchObject({
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      commandId: 'compact',
      input: 'input',
      model: 'model-1'
    });
    expect(configure).toHaveBeenCalledWith(session);
    expect(resetHistory).toHaveBeenCalledWith('node-1', session);
    expect(openRun).toHaveBeenCalledWith('run-1');
    expect(runs.value).toEqual([run]);
  });

  it('settles a late command on its original workspace without altering the new selection', async () => {
    const workspaceTarget = ref<WorkspaceTarget | undefined>({
      nodeId: 'node-1',
      workspaceId: 'workspace-1'
    });
    const selectedSessionId = ref<string | undefined>('session-1');
    const runService = createRunService(selectedSessionId);
    const runs = runService.runs;
    let resolve!: (value: unknown) => void;
    const request = vi.fn(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    const acceptSession = vi.fn();
    const configure = vi.fn();
    const resetHistory = vi.fn();
    const openRun = vi.fn();
    const cacheRun = vi.fn();
    const service = createWorkbenchRunnerCommandService({
      workspaceTarget,
      selectedSessionId,
      currentSelectionRevision: () => 0,
      acceptRun: runService.acceptRun,
      request: request as never,
      sessionPathId: (id) => id,
      acceptSession,
      configure,
      resetHistory,
      openRun,
      captureCacheTarget: (node, workspace) => ({
        isCurrent: () => true,
        replaceSession: vi.fn(),
        cacheRun: (run) => cacheRun(node, workspace, run)
      }),
      notifyGoalAlreadyActive: vi.fn()
    });
    const session = { id: 'session-1', workspaceId: 'workspace-1', runner: 'codex' } as Session;
    const run = { id: 'run-1', sessionId: session.id, status: 'RUNNING' } as AgentRun;
    const operation = service.execute(session, 'clear', '', true);
    workspaceTarget.value = { nodeId: 'node-1', workspaceId: 'workspace-2' };
    selectedSessionId.value = 'session-2';
    resolve({ session: { ...session, title: 'updated' }, run });
    await operation;

    expect(acceptSession).toHaveBeenCalledWith(
      'node-1',
      'workspace-1',
      session.id,
      {
        ...session,
        title: 'updated'
      },
      false
    );
    expect(cacheRun).toHaveBeenCalledWith('node-1', 'workspace-1', run);
    expect(configure).not.toHaveBeenCalled();
    expect(resetHistory).not.toHaveBeenCalled();
    expect(openRun).not.toHaveBeenCalled();
    expect(runs.value).toEqual([]);
  });
});
