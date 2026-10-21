import { workspaceTargetRef } from './support/workspace-fixture.js';
import { describe, expect, it, vi } from 'vitest';
import { computed, ref } from 'vue';
import { createRunService } from '../../src/service/RunService.js';
import { createWorkbenchRunControlService } from '../../src/service/WorkbenchRunControlService.js';

describe('Shared Run interrupt control', () => {
  it('shows a Node-confirmed Goal stop only for the still-selected session', async () => {
    const selectedNodeId = ref<string | undefined>('node-1');
    const selectedSessionId = ref<string | undefined>('session-1');
    const runService = createRunService(selectedSessionId);
    const run = {
      id: 'run-1',
      sessionId: 'session-1',
      status: 'RUNNING' as const,
      recoveryState: 'ACTIVE' as const,
      clientMessageId: 'message-1'
    };
    runService.runs.value = [run];
    let resolveRequest!: (value: unknown) => void;
    const onGoalExit = vi.fn();
    const controller = createWorkbenchRunControlService({
      workspaceTarget: workspaceTargetRef(selectedNodeId, ref<string | undefined>('workspace-1')),
      selectedSessionId,
      selectedRunId: runService.selectedRunId,
      activeRun: computed(() => runService.runs.value[0]),
      runs: runService.runs,
      notice: ref(''),
      runService,
      request: vi.fn(() => new Promise((resolve) => (resolveRequest = resolve))) as never,
      sessionPathId: (value) => value,
      errorMessage: () => 'error',
      beginSubmission: () => () => true,
      onGoalExit
    });

    const firstStop = controller.stopActiveRun();
    resolveRequest({
      run: { ...run, status: 'CANCELLING' },
      goalExit: { status: 'stopped', turns: 2, elapsedWallMs: 4_000 }
    });
    await firstStop;
    expect(onGoalExit).toHaveBeenCalledWith({
      status: 'stopped',
      turns: 2,
      elapsedWallMs: 4_000
    });

    const secondStop = controller.stopActiveRun();
    selectedSessionId.value = 'session-2';
    resolveRequest({
      run: { ...run, status: 'CANCELLING' },
      goalExit: { status: 'stopped', turns: 2, elapsedWallMs: 5_000 }
    });
    await secondStop;
    expect(onGoalExit).toHaveBeenCalledTimes(1);
    expect(selectedNodeId.value).toBe('node-1');
  });

  it('reports Goal stop from a session interrupt before its Run snapshot arrives', async () => {
    const selectedSessionId = ref<string | undefined>('session-1');
    const runService = createRunService(selectedSessionId);
    const onGoalExit = vi.fn();
    const controller = createWorkbenchRunControlService({
      workspaceTarget: workspaceTargetRef(
        ref<string | undefined>('node-1'),
        ref<string | undefined>('workspace-1')
      ),
      selectedSessionId,
      selectedRunId: runService.selectedRunId,
      activeRun: computed(() => undefined),
      runs: runService.runs,
      notice: ref(''),
      runService,
      request: vi.fn(async () => ({
        run: {
          id: 'run-1',
          sessionId: 'session-1',
          status: 'CANCELLING',
          recoveryState: 'ACTIVE',
          clientMessageId: 'message-1'
        },
        goalExit: { status: 'stopped', turns: 1, elapsedWallMs: 500 }
      })) as never,
      sessionPathId: (value) => value,
      errorMessage: () => 'error',
      beginSubmission: () => () => true,
      onGoalExit
    });

    await controller.stopActiveRun();
    expect(onGoalExit).toHaveBeenCalledWith({
      status: 'stopped',
      turns: 1,
      elapsedWallMs: 500
    });
  });

  it('Stops without settling business state early when the session is active but no Run snapshot has arrived', async () => {
    const selectedSessionId = ref<string | undefined>('session-1');
    const runService = createRunService(selectedSessionId);
    let resolveRequest!: (value: { run: (typeof runService.runs.value)[number] }) => void;
    const request = vi.fn(
      () =>
        new Promise<{ run: (typeof runService.runs.value)[number] }>((resolve) => {
          resolveRequest = resolve;
        })
    );
    const controller = createWorkbenchRunControlService({
      workspaceTarget: workspaceTargetRef(
        ref<string | undefined>('node-1'),
        ref<string | undefined>('workspace-1')
      ),
      selectedSessionId,
      selectedRunId: runService.selectedRunId,
      activeRun: computed(() => undefined),
      runs: runService.runs,
      notice: ref(''),
      runService,
      request: request as never,
      sessionPathId: (value) => value,
      errorMessage: () => 'error',
      beginSubmission: () => () => true
    });

    const stopping = controller.stopActiveRun();
    expect(runService.runs.value).toEqual([]);
    expect(runService.sessionInterruptionSettled('session-1')).toBe(false);
    resolveRequest({
      run: {
        id: 'run-1',
        sessionId: 'session-1',
        status: 'CANCELLING',
        recoveryState: 'ACTIVE',
        clientMessageId: 'message-1'
      }
    });
    await stopping;
    expect(runService.runs.value[0]?.status).toBe('CANCELLING');
  });

  it('Does not mark a known Run as cancelling while its stop request is in flight', async () => {
    const selectedSessionId = ref<string | undefined>('session-1');
    const runService = createRunService(selectedSessionId);
    runService.runs.value = [
      {
        id: 'run-1',
        sessionId: 'session-1',
        status: 'RUNNING',
        recoveryState: 'ACTIVE',
        clientMessageId: 'message-1'
      }
    ];
    runService.selectedRunId.value = 'run-1';
    let rejectRequest!: (error: Error) => void;
    const controller = createWorkbenchRunControlService({
      workspaceTarget: workspaceTargetRef(
        ref<string | undefined>('node-1'),
        ref<string | undefined>('workspace-1')
      ),
      selectedSessionId,
      selectedRunId: runService.selectedRunId,
      activeRun: computed(() => runService.runs.value[0]),
      runs: runService.runs,
      notice: ref(''),
      runService,
      request: vi.fn(() => new Promise((_resolve, reject) => (rejectRequest = reject))) as never,
      sessionPathId: (value) => value,
      errorMessage: () => 'INTERRUPT_DENIED',
      beginSubmission: () => () => true
    });

    const stopping = controller.stopActiveRun();
    expect(runService.runs.value[0]?.status).toBe('RUNNING');
    rejectRequest(new Error('INTERRUPT_DENIED'));
    await stopping;
    expect(runService.runs.value[0]?.status).toBe('RUNNING');
    expect(runService.sessionInterruptionSettled('session-1')).toBe(false);
  });

  it('Does not roll back business state when a session-level stop is rejected', async () => {
    const selectedSessionId = ref<string | undefined>('session-1');
    const runService = createRunService(selectedSessionId);
    const notice = ref('');
    const controller = createWorkbenchRunControlService({
      workspaceTarget: workspaceTargetRef(
        ref<string | undefined>('node-1'),
        ref<string | undefined>('workspace-1')
      ),
      selectedSessionId,
      selectedRunId: runService.selectedRunId,
      activeRun: computed(() => undefined),
      runs: runService.runs,
      notice,
      runService,
      request: vi.fn(async () => {
        throw new Error('INTERRUPT_DENIED');
      }) as never,
      sessionPathId: (value) => value,
      errorMessage: () => 'INTERRUPT_DENIED',
      beginSubmission: () => () => true
    });

    const stopping = controller.stopActiveRun();
    expect(runService.runs.value).toEqual([]);
    expect(runService.sessionInterruptionSettled('session-1')).toBe(false);
    await stopping;
    expect(runService.runs.value).toEqual([]);
    expect(runService.selectedRunId.value).toBeUndefined();
    expect(runService.sessionInterruptionSettled('session-1')).toBe(false);
    expect(notice.value).toContain('INTERRUPT_DENIED');
  });
});
