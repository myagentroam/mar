import { workspaceTargetRef } from './support/workspace-fixture.js';
import { computed, ref } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ElMessageBox } from 'element-plus';
import type { RunnerCommand, Session } from '../../src/model/workbench.js';
import { createWorkbenchContextCommandService } from '../../src/service/WorkbenchContextCommandService.js';

vi.mock('element-plus', () => ({ ElMessageBox: { confirm: vi.fn() } }));
beforeEach(() => {
  vi.mocked(ElMessageBox.confirm)
    .mockReset()
    .mockResolvedValue('confirm' as Awaited<ReturnType<typeof ElMessageBox.confirm>>);
});

function fixture() {
  const execute = vi.fn(async () => {});
  const finish = vi.fn(() => true);
  const beginSubmission = vi.fn((): (() => boolean) | undefined => finish);
  const canCompact = ref(true);
  const selectedSession = ref({ id: 'session-1' } as Session);
  const notice = vi.fn();
  const nodeId = ref('node-1');
  const service = createWorkbenchContextCommandService({
    workspaceTarget: workspaceTargetRef(nodeId),
    selectedSession: computed(() => selectedSession.value),
    compactCommand: computed(() => ({ id: 'compact' }) as RunnerCommand),
    canCompact: computed(() => canCompact.value),
    contextUsageLabel: computed(() => '42% used; 42000 of 100000 tokens'),
    notice,
    request: vi.fn(),
    execute,
    errorMessage: () => 'denied',
    beginSubmission
  });
  return { service, execute, finish, beginSubmission, canCompact, selectedSession, notice, nodeId };
}

describe('shared context command', () => {
  it('confirms before acquiring the submission gate and executing', async () => {
    const f = fixture();
    vi.mocked(ElMessageBox.confirm).mockResolvedValue(
      'confirm' as Awaited<ReturnType<typeof ElMessageBox.confirm>>
    );
    await f.service.compactCurrentContext();
    expect(ElMessageBox.confirm).toHaveBeenCalledWith(
      expect.stringContaining('42% used; 42000 of 100000 tokens'),
      expect.any(String),
      expect.any(Object)
    );
    expect(f.beginSubmission).toHaveBeenCalledWith('session:session-1');
    expect(f.execute).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'session-1' }),
      expect.objectContaining({ id: 'compact' }),
      '/compact'
    );
    expect(f.finish).toHaveBeenCalledOnce();
    expect(f.notice).not.toHaveBeenCalled();
  });

  it('does not prompt when compact is unavailable', async () => {
    const f = fixture();
    f.canCompact.value = false;
    await f.service.compactCurrentContext();
    expect(ElMessageBox.confirm).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('does not submit after cancellation', async () => {
    const f = fixture();
    vi.mocked(ElMessageBox.confirm).mockRejectedValue('cancel');
    await f.service.compactCurrentContext();
    expect(f.beginSubmission).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.notice).not.toHaveBeenCalled();
  });

  it('does not execute while another submission owns the gate', async () => {
    const f = fixture();
    f.beginSubmission.mockReturnValue(undefined);
    await f.service.compactCurrentContext();
    expect(f.execute).not.toHaveBeenCalled();
  });

  it.each(['working', 'selection', 'node'] as const)(
    'rechecks %s after confirmation',
    async (change) => {
      const f = fixture();
      vi.mocked(ElMessageBox.confirm).mockImplementation(async () => {
        if (change === 'working') f.canCompact.value = false;
        else if (change === 'node') f.nodeId.value = 'node-2';
        else f.selectedSession.value = { id: 'session-2' } as Session;
        return 'confirm' as Awaited<ReturnType<typeof ElMessageBox.confirm>>;
      });
      await f.service.compactCurrentContext();
      expect(f.beginSubmission).not.toHaveBeenCalled();
      expect(f.execute).not.toHaveBeenCalled();
    }
  );

  it.each([true, false])(
    'reports failure only within the submission window (%s)',
    async (active) => {
      const f = fixture();
      f.finish.mockReturnValue(active);
      const error = new Error('failed');
      f.execute.mockRejectedValue(error);
      await f.service.compactCurrentContext();
      if (active)
        expect(f.notice).toHaveBeenCalledWith(expect.stringContaining('denied'), 'error', error);
      else expect(f.notice).not.toHaveBeenCalled();
    }
  );
});
