import { ref } from 'vue';
import { workspaceTargetRef } from './support/workspace-fixture.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSessionSnapshotRefreshService } from '../../src/service/session-snapshot-refresh-service.js';
describe('Shared Session Snapshot Refresh', () => {
  afterEach(() => vi.useRealTimers());
  it('cancels in-flight observers on clear without overlapping the next refresh', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const refresh = vi.fn().mockReturnValueOnce(pending).mockResolvedValue(undefined);
    const service = createSessionSnapshotRefreshService({
      workspaceTarget: ref({ nodeId: 'node-1', workspaceId: 'workspace-1' }),
      selectedSessionId: ref('session-1'),
      refresh
    });
    service.schedule();
    await vi.runOnlyPendingTimersAsync();
    const cancelled = service.whenSettled();
    service.clear();
    await expect(cancelled).resolves.toBe(false);
    service.schedule();
    await vi.runOnlyPendingTimersAsync();
    expect(refresh).toHaveBeenCalledTimes(1);
    const next = service.whenSettled();
    finish();
    await expect(next).resolves.toBe(true);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('waits through the scheduled refresh and its merged follow-up', async () => {
    vi.useFakeTimers();
    const finish: (() => void)[] = [];
    const refresh = vi.fn(() => new Promise<void>((resolve) => finish.push(resolve)));
    const service = createSessionSnapshotRefreshService({
      workspaceTarget: ref({ nodeId: 'node-1', workspaceId: 'workspace-1' }),
      selectedSessionId: ref('session-1'),
      refresh
    });
    service.schedule();
    const settled = vi.fn();
    const waiting = service.whenSettled().then(settled);
    await vi.runOnlyPendingTimersAsync();
    service.schedule();
    await vi.runOnlyPendingTimersAsync();
    expect(refresh).toHaveBeenCalledOnce();
    expect(settled).not.toHaveBeenCalled();
    finish[0]!();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    expect(settled).not.toHaveBeenCalled();
    finish[1]!();
    await waiting;
    expect(settled).toHaveBeenCalledOnce();
  });

  it.each(['clear', 'selection', 'replacement'] as const)(
    'settles a scheduled refresh invalidated by %s',
    async (action) => {
      vi.useFakeTimers();
      const selectedSessionId = ref<string | undefined>('session-1');
      const refresh = vi.fn();
      const service = createSessionSnapshotRefreshService({
        workspaceTarget: ref({ nodeId: 'node-1', workspaceId: 'workspace-1' }),
        selectedSessionId,
        refresh
      });
      service.schedule(100);
      const waiting = service.whenSettled();
      if (action === 'clear') service.clear();
      else {
        selectedSessionId.value = undefined;
        if (action === 'replacement') service.schedule();
      }
      await vi.runOnlyPendingTimersAsync();
      await waiting;
      expect(refresh).not.toHaveBeenCalled();
      await service.whenSettled();
    }
  );

  it('A delayed refresh only applies to the Workspace and Session selected when it was scheduled', async () => {
    vi.useFakeTimers();
    const selectedNodeId = { value: 'node-1' };
    const selectedSessionId = { value: 'session-1' };
    const refresh = vi.fn();
    const service = createSessionSnapshotRefreshService({
      workspaceTarget: workspaceTargetRef(selectedNodeId),
      selectedSessionId: selectedSessionId as never,
      refresh
    });
    service.schedule(100, true);
    selectedSessionId.value = 'session-2';
    await vi.advanceTimersByTimeAsync(100);
    expect(refresh).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('does not schedule a first-generation A refresh after A to B to A', async () => {
    vi.useFakeTimers();
    const workspaceTarget = ref({ nodeId: 'node-1', workspaceId: 'workspace-1' });
    const refresh = vi.fn();
    const service = createSessionSnapshotRefreshService({
      workspaceTarget,
      selectedSessionId: ref('session-1'),
      refresh
    });
    service.schedule(100);
    workspaceTarget.value = { nodeId: 'node-1', workspaceId: 'workspace-2' };
    workspaceTarget.value = { nodeId: 'node-1', workspaceId: 'workspace-1' };
    await vi.advanceTimersByTimeAsync(100);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('Repeated session resynchronization in one event loop triggers only the final authoritative refresh', async () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    const service = createSessionSnapshotRefreshService({
      workspaceTarget: workspaceTargetRef({ value: 'node-1' }),
      selectedSessionId: { value: 'session-1' } as never,
      refresh
    });

    service.schedule();
    service.schedule();
    service.schedule();
    await vi.runOnlyPendingTimersAsync();

    expect(refresh).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledWith('session-1', false);
  });

  it('Repeated resynchronization during an authoritative refresh merges into one follow-up refresh', async () => {
    vi.useFakeTimers();
    let finishFirst!: () => void;
    const first = new Promise<void>((resolve) => (finishFirst = resolve));
    const refresh = vi
      .fn()
      .mockImplementationOnce(() => first)
      .mockResolvedValue(undefined);
    const service = createSessionSnapshotRefreshService({
      workspaceTarget: workspaceTargetRef({ value: 'node-1' }),
      selectedSessionId: { value: 'session-1' } as never,
      refresh
    });

    service.schedule();
    await vi.runOnlyPendingTimersAsync();
    service.schedule();
    service.schedule();
    await vi.runOnlyPendingTimersAsync();
    expect(refresh).toHaveBeenCalledOnce();

    finishFirst();
    await first;
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
  });
});
