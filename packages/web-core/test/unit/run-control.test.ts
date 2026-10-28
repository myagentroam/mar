import { workspaceTargetRef } from './support/workspace-fixture.js';
import { describe, expect, it, vi } from 'vitest';
import { computed, ref } from 'vue';
import { createRunService } from '../../src/service/run-service.js';
import { createWorkbenchRunControlService } from '../../src/service/workbench-run-control-service.js';

describe('Shared Run interrupt control', () => {
  it('does not show Goal-exit feedback when a stop succeeds and applies the Run state', async () => {
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
    runService.replaceRuns([run]);
    let resolveRequest!: (value: unknown) => void;
    const notice = vi.fn();
    const controller = createWorkbenchRunControlService({
      workspaceTarget: workspaceTargetRef(selectedNodeId, ref<string | undefined>('workspace-1')),
      selectedSessionId,
      selectedRunId: runService.selectedRunId,
      activeRun: computed(() => runService.runs.value[0]),
      notice,
      runService,
      request: vi.fn(() => new Promise((resolve) => (resolveRequest = resolve))) as never,
      sessionPathId: (value) => value,
      errorMessage: () => 'error',
      beginSubmission: () => () => true
    });

    const firstStop = controller.stopActiveRun();
    resolveRequest({
      run: { ...run, status: 'CANCELLING' }
    });
    await firstStop;
    expect(runService.runs.value[0]?.status).toBe('CANCELLING');
    expect(notice).not.toHaveBeenCalled();

    const secondStop = controller.stopActiveRun();
    selectedSessionId.value = 'session-2';
    resolveRequest({
      run: { ...run, status: 'CANCELLING' }
    });
    await secondStop;
    expect(runService.runs.value[0]?.status).toBe('CANCELLING');
    expect(notice).not.toHaveBeenCalled();
    expect(selectedNodeId.value).toBe('node-1');
  });

  it('applies a successful session interrupt before its Run snapshot arrives without feedback', async () => {
    const selectedSessionId = ref<string | undefined>('session-1');
    const runService = createRunService(selectedSessionId);
    const notice = vi.fn();
    const controller = createWorkbenchRunControlService({
      workspaceTarget: workspaceTargetRef(
        ref<string | undefined>('node-1'),
        ref<string | undefined>('workspace-1')
      ),
      selectedSessionId,
      selectedRunId: runService.selectedRunId,
      activeRun: computed(() => undefined),
      notice,
      runService,
      request: vi.fn(async () => ({
        run: {
          id: 'run-1',
          sessionId: 'session-1',
          status: 'CANCELLING',
          recoveryState: 'ACTIVE',
          clientMessageId: 'message-1'
        }
      })) as never,
      sessionPathId: (value) => value,
      errorMessage: () => 'error',
      beginSubmission: () => () => true
    });

    await controller.stopActiveRun();
    expect(runService.runs.value[0]?.status).toBe('CANCELLING');
    expect(runService.selectedRunId.value).toBe('run-1');
    expect(notice).not.toHaveBeenCalled();
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
      notice: vi.fn(),
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
    runService.replaceRuns([
      {
        id: 'run-1',
        sessionId: 'session-1',
        status: 'RUNNING',
        recoveryState: 'ACTIVE',
        clientMessageId: 'message-1'
      }
    ]);
    runService.selectedRunId.value = 'run-1';
    const notice = vi.fn();
    const error = new Error('INTERRUPT_DENIED');
    let rejectRequest!: (error: Error) => void;
    const controller = createWorkbenchRunControlService({
      workspaceTarget: workspaceTargetRef(
        ref<string | undefined>('node-1'),
        ref<string | undefined>('workspace-1')
      ),
      selectedSessionId,
      selectedRunId: runService.selectedRunId,
      activeRun: computed(() => runService.runs.value[0]),
      notice,
      runService,
      request: vi.fn(() => new Promise((_resolve, reject) => (rejectRequest = reject))) as never,
      sessionPathId: (value) => value,
      errorMessage: () => 'INTERRUPT_DENIED',
      beginSubmission: () => () => true
    });

    const stopping = controller.stopActiveRun();
    expect(runService.runs.value[0]?.status).toBe('RUNNING');
    rejectRequest(error);
    await stopping;
    expect(runService.runs.value[0]?.status).toBe('RUNNING');
    expect(runService.sessionInterruptionSettled('session-1')).toBe(false);
    expect(notice).toHaveBeenCalledWith(
      expect.stringContaining('INTERRUPT_DENIED'),
      'error',
      error
    );
  });

  it.each(['no Run snapshot', 'known Run'] as const)(
    'ignores a missing Run without changing local run history or showing feedback (%s)',
    async (snapshot) => {
      const selectedSessionId = ref<string | undefined>('session-1');
      const runService = createRunService(selectedSessionId);
      const run = {
        id: 'run-1',
        sessionId: 'session-1',
        status: 'RUNNING' as const,
        recoveryState: 'ACTIVE' as const,
        clientMessageId: 'message-1'
      };
      if (snapshot === 'known Run') {
        runService.replaceRuns([run]);
        runService.selectedRunId.value = run.id;
      }
      const notice = vi.fn();
      const error = Object.assign(new Error('RUN_NOT_FOUND'), {
        code: 'RUN_NOT_FOUND'
      });
      const controller = createWorkbenchRunControlService({
        workspaceTarget: workspaceTargetRef(
          ref<string | undefined>('node-1'),
          ref<string | undefined>('workspace-1')
        ),
        selectedSessionId,
        selectedRunId: runService.selectedRunId,
        activeRun: computed(() => runService.runs.value[0]),
        notice,
        runService,
        request: vi.fn(async () => {
          throw error;
        }) as never,
        sessionPathId: (value) => value,
        errorMessage: String,
        beginSubmission: () => () => true
      });

      await controller.stopActiveRun();

      expect(runService.runs.value).toEqual(snapshot === 'known Run' ? [run] : []);
      expect(runService.selectedRunId.value).toBe(snapshot === 'known Run' ? run.id : undefined);
      expect(runService.sessionInterruptionSettled('session-1')).toBe(false);
      expect(notice).not.toHaveBeenCalled();
    }
  );

  it('Does not roll back business state when a session-level stop is rejected', async () => {
    const selectedSessionId = ref<string | undefined>('session-1');
    const runService = createRunService(selectedSessionId);
    const notice = vi.fn();
    const error = new Error('INTERRUPT_DENIED');
    const controller = createWorkbenchRunControlService({
      workspaceTarget: workspaceTargetRef(
        ref<string | undefined>('node-1'),
        ref<string | undefined>('workspace-1')
      ),
      selectedSessionId,
      selectedRunId: runService.selectedRunId,
      activeRun: computed(() => undefined),
      notice,
      runService,
      request: vi.fn(async () => {
        throw error;
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
    expect(notice).toHaveBeenCalledWith(
      expect.stringContaining('INTERRUPT_DENIED'),
      'error',
      error
    );
  });
});
