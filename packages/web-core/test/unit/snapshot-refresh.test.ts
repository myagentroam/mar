import { ref } from 'vue';
import { workspaceTargetRef } from './support/workspace-fixture.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSessionSnapshotRefreshService } from '../../src/service/session-snapshot-refresh-service.js';
describe('Shared Session Snapshot Refresh', () => {
  afterEach(() => vi.useRealTimers());
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
