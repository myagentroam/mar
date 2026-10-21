import { describe, expect, it, vi } from 'vitest';
import { createWorkbenchNavigationWatchService } from '../../src/service/WorkbenchNavigationWatchService.js';

function fixture() {
  let surface: 'workbench' | 'extension' | 'other' = 'workbench';
  const coordinator = {
    stopWorkspace: vi.fn(),
    stopSession: vi.fn(),
    beginExtension: vi.fn().mockResolvedValue(undefined),
    stopExtension: vi.fn(),
    startWorkspace: vi.fn().mockResolvedValue(undefined),
    beginSession: vi.fn()
  };
  const service = createWorkbenchNavigationWatchService({
    coordinator: () => coordinator,
    currentSurface: () => surface,
    workspaceTarget: () => ({ nodeId: 'node-1', workspaceId: 'workspace-1' }),
    selectedSessionId: () => 'session-1',
    hasSelectedExtensionTarget: () => true
  });
  function select(next: typeof surface) {
    const previous = surface;
    surface = next;
    service.transition(previous, next);
  }
  return { coordinator, service, select };
}

describe('Public Navigation Watch Recovery', () => {
  it('After exiting the mutually exclusive extension across intermediate pages, only one normal Workspace and Session will be restored', async () => {
    const f = fixture();
    f.select('extension');
    expect(f.coordinator.stopWorkspace).toHaveBeenCalledOnce();
    expect(f.coordinator.stopSession).toHaveBeenCalledOnce();
    expect(f.coordinator.beginExtension).toHaveBeenCalledOnce();
    f.select('other');
    expect(f.coordinator.stopExtension).toHaveBeenCalledOnce();
    expect(f.coordinator.startWorkspace).not.toHaveBeenCalled();
    f.select('workbench');
    await vi.waitFor(() => expect(f.coordinator.beginSession).toHaveBeenCalledWith('session-1'));
    expect(f.coordinator.startWorkspace).toHaveBeenCalledWith('workspace-1');
    f.select('other');
    f.select('workbench');
    expect(f.coordinator.startWorkspace).toHaveBeenCalledOnce();
  });

  it('Normal menu switching does not rebuild Watch, missing extension target does not start extension observation', () => {
    const f = fixture();
    f.select('other');
    f.select('workbench');
    expect(f.coordinator.startWorkspace).not.toHaveBeenCalled();
    const service = createWorkbenchNavigationWatchService({
      coordinator: () => f.coordinator,
      currentSurface: () => 'extension',
      workspaceTarget: () => undefined,
      selectedSessionId: () => undefined,
      hasSelectedExtensionTarget: () => false
    });
    service.transition('workbench', 'extension');
    expect(f.coordinator.stopWorkspace).toHaveBeenCalledOnce();
    expect(f.coordinator.beginExtension).not.toHaveBeenCalled();
    service.transition('extension', 'workbench');
    expect(f.coordinator.startWorkspace).not.toHaveBeenCalled();
  });

  it('does not start a Session Watch when Workspace recovery completes after leaving the Workbench', async () => {
    const f = fixture();
    let finish!: () => void;
    f.coordinator.startWorkspace.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    f.select('extension');
    f.select('workbench');
    f.select('extension');
    finish();
    await Promise.resolve();
    expect(f.coordinator.beginSession).not.toHaveBeenCalled();
  });
});
