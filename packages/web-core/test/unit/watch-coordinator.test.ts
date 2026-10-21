import { describe, expect, it, vi } from 'vitest';
import { createWorkbenchWatchCoordinator } from '../../src/service/WorkbenchWatchCoordinator.js';

function fixture(withExtension = false) {
  const calls: string[] = [];
  const workspace = {
    start: vi.fn(async () => {
      calls.push('workspace.start');
    }),
    restart: vi.fn(async () => {
      calls.push('workspace.restart');
    }),
    pause: vi.fn(() => {
      calls.push('workspace.pause');
    }),
    stop: vi.fn(() => {
      calls.push('workspace.stop');
    }),
    handleEvent: vi.fn(() => false)
  };
  const session = {
    beginSelectedSessionWatch: vi.fn(() => {
      calls.push('session.begin');
    }),
    restartSelectedSessionWatch: vi.fn(() => {
      calls.push('session.restart');
    }),
    pauseSelectedSessionWatch: vi.fn(() => {
      calls.push('session.pause');
    }),
    stopSelectedSessionWatch: vi.fn(() => {
      calls.push('session.stop');
    }),
    handleSessionWatchVisibility: vi.fn(),
    handleEvent: vi.fn(() => false)
  };
  const extension = {
    begin: vi.fn(async () => {
      calls.push('extension.begin');
    }),
    restart: vi.fn(async () => {
      calls.push('extension.restart');
    }),
    pause: vi.fn(() => {
      calls.push('extension.pause');
    }),
    stop: vi.fn(() => {
      calls.push('extension.stop');
    }),
    handleVisibility: vi.fn(),
    handleEvent: vi.fn(() => true)
  };
  const coordinator = createWorkbenchWatchCoordinator({
    workspace,
    session,
    ...(withExtension ? { extension } : {})
  });
  return { coordinator, workspace, session, extension, calls };
}

describe('shared Workbench Watch coordination', () => {
  it('supports ordinary Workspace/Session watches without a product extension', async () => {
    const f = fixture();
    await f.coordinator.startWorkspace('workspace-1');
    f.coordinator.beginSession('session-1');
    expect(f.calls).toEqual(['workspace.start', 'session.begin']);
    expect(f.coordinator.handleEvent({ type: 'unknown' })).toBe(false);
    await expect(f.coordinator.beginExtension()).rejects.toThrow('WEB_WATCH_EXTENSION_REQUIRED');
    await expect(f.coordinator.restartExtension()).rejects.toThrow('WEB_WATCH_EXTENSION_REQUIRED');
    expect(f.calls).toEqual(['workspace.start', 'session.begin']);
    f.coordinator.dispose();
    expect(f.calls.slice(-2)).toEqual(['session.stop', 'workspace.stop']);
  });

  it('releases public watches before entering the exclusive extension and stops it before restoring Work', async () => {
    const f = fixture(true);
    await f.coordinator.beginExtension();
    expect(f.calls).toEqual(['workspace.stop', 'session.stop', 'extension.begin']);
    await f.coordinator.restartExtension();
    expect(f.calls.slice(-3)).toEqual(['workspace.stop', 'session.stop', 'extension.restart']);
    f.coordinator.beginSession('session-1');
    expect(f.calls.slice(-2)).toEqual(['extension.stop', 'session.begin']);
    await f.coordinator.startWorkspace('workspace-1');
    expect(f.calls.slice(-2)).toEqual(['extension.stop', 'workspace.start']);
  });

  it('coalesces pending Workspace work and cancels the trailing operation on extension entry', async () => {
    const f = fixture(true);
    let finish!: () => void;
    f.workspace.start.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    const pending = f.coordinator.startWorkspace('first');
    void f.coordinator.startWorkspace('superseded');
    void f.coordinator.startWorkspace('latest');
    await f.coordinator.beginExtension();
    finish();
    await pending;
    expect(f.workspace.start).toHaveBeenCalledOnce();
    expect(f.extension.begin).toHaveBeenCalledOnce();
  });

  it('runs only the latest queued Workspace selection after the active request finishes', async () => {
    const f = fixture();
    let finish!: () => void;
    f.workspace.start.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    const pending = f.coordinator.startWorkspace('first');
    void f.coordinator.startWorkspace('superseded');
    void f.coordinator.startWorkspace('latest');
    finish();
    await pending;
    expect(f.workspace.start).toHaveBeenCalledTimes(2);
    expect(f.workspace.start).toHaveBeenLastCalledWith('latest', undefined);
  });

  it('releases the queue after a failed start and permits a subsequent recovery', async () => {
    const f = fixture();
    f.workspace.start.mockRejectedValueOnce(new Error('WATCH_FAILED'));
    await expect(f.coordinator.startWorkspace('failed')).rejects.toThrow('WATCH_FAILED');
    await f.coordinator.restartWorkspace('recovered');
    expect(f.workspace.restart).toHaveBeenCalledWith('recovered');
  });

  it('dispatches events once and pauses all configured watch lifecycles', () => {
    const f = fixture(true);
    f.session.handleEvent.mockReturnValueOnce(true);
    expect(f.coordinator.handleEvent({ type: 'session' })).toBe(true);
    expect(f.extension.handleEvent).not.toHaveBeenCalled();
    expect(f.coordinator.handleEvent({ type: 'extension' })).toBe(true);
    expect(f.extension.handleEvent).toHaveBeenCalledOnce();
    f.coordinator.pause();
    expect(f.calls).toEqual(['workspace.pause', 'session.pause', 'extension.pause']);
  });
});
