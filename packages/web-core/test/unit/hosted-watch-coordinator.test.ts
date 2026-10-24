import { describe, expect, it, vi } from 'vitest';
import { createHostedConversationWatchCoordinator as createWorkbenchWatchCoordinator } from '../../src/service/hosted-conversation-watch-coordinator.js';

describe('Web Workbench Watch Coordinator', () => {
  it('Merge Workspace in-transit convergence and hand off events to a unique matching Watcher', async () => {
    let finish!: () => void;
    const first = new Promise<void>((resolve) => (finish = resolve));
    const start = vi
      .fn()
      .mockImplementationOnce(() => first)
      .mockResolvedValue(undefined);
    const restart = vi.fn().mockResolvedValue(undefined);
    const stopWorkspace = vi.fn();
    const handleSessionVisibility = vi.fn();
    const workspaceEvent = vi.fn(() => false);
    const sessionEvent = vi.fn(() => true);
    const hostedEvent = vi.fn(() => false);
    const coordinator = createWorkbenchWatchCoordinator({
      workspace: {
        start,
        restart,
        pause: vi.fn(),
        stop: stopWorkspace,
        handleEvent: workspaceEvent
      },
      session: {
        beginSelectedSessionWatch: vi.fn(),
        restartSelectedSessionWatch: vi.fn(),
        pauseSelectedSessionWatch: vi.fn(),
        stopSelectedSessionWatch: vi.fn(),
        handleSessionWatchVisibility: handleSessionVisibility,
        handleEvent: sessionEvent
      },
      hosted: {
        beginSelectedConversationWatch: vi.fn(),
        restartSelectedConversationWatch: vi.fn(),
        pauseSelectedConversationWatch: vi.fn(),
        stopSelectedConversationWatch: vi.fn(),
        handleVisibility: vi.fn(),
        handleWatchEvent: hostedEvent
      }
    });

    const pending = coordinator.startWorkspace('workspace-a');
    void coordinator.startWorkspace('workspace-b');
    void coordinator.startWorkspace('workspace-c');
    expect(start).toHaveBeenCalledTimes(1);
    finish();
    await pending;
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    expect(start).toHaveBeenLastCalledWith('workspace-c', undefined);
    expect(coordinator.handleEvent({ type: 'watch.session.snapshot' })).toBe(true);
    expect(workspaceEvent).toHaveBeenCalledOnce();
    expect(sessionEvent).toHaveBeenCalledOnce();
    expect(hostedEvent).not.toHaveBeenCalled();
    coordinator.handleVisibility();
    expect(stopWorkspace).toHaveBeenCalledOnce();
    expect(handleSessionVisibility).toHaveBeenCalledOnce();
  });

  it('atomically switches the unique Session Watch slot and releases the Workspace Watch in Hosted mode', async () => {
    const stopWorkspace = vi.fn();
    const stopSession = vi.fn();
    const stopHosted = vi.fn();
    const beginSession = vi.fn();
    const beginHosted = vi.fn().mockResolvedValue(undefined);
    const coordinator = createWorkbenchWatchCoordinator({
      workspace: {
        start: vi.fn().mockResolvedValue(undefined),
        restart: vi.fn().mockResolvedValue(undefined),
        pause: vi.fn(),
        stop: stopWorkspace,
        handleEvent: vi.fn(() => false)
      },
      session: {
        beginSelectedSessionWatch: beginSession,
        restartSelectedSessionWatch: vi.fn(),
        pauseSelectedSessionWatch: vi.fn(),
        stopSelectedSessionWatch: stopSession,
        handleSessionWatchVisibility: vi.fn(),
        handleEvent: vi.fn(() => false)
      },
      hosted: {
        beginSelectedConversationWatch: beginHosted,
        restartSelectedConversationWatch: vi.fn().mockResolvedValue(undefined),
        pauseSelectedConversationWatch: vi.fn(),
        stopSelectedConversationWatch: stopHosted,
        handleVisibility: vi.fn(),
        handleWatchEvent: vi.fn(() => true)
      }
    });

    await coordinator.beginHostedConversation();
    expect(stopWorkspace).toHaveBeenCalledOnce();
    expect(stopSession).toHaveBeenCalledOnce();
    expect(beginHosted).toHaveBeenCalledOnce();

    coordinator.beginSession('session-1');
    expect(stopHosted).toHaveBeenCalledOnce();
    expect(beginSession).toHaveBeenCalledWith('session-1', undefined);
    expect(coordinator.handleEvent({ type: 'watch.hosted-conversation.snapshot' })).toBe(true);
  });

  it('Cancel unimplemented Workspace Watch convergence when entering Hosted mode', async () => {
    let finishWorkspace!: () => void;
    const firstWorkspace = new Promise<void>((resolve) => (finishWorkspace = resolve));
    const startWorkspace = vi
      .fn()
      .mockImplementationOnce(() => firstWorkspace)
      .mockResolvedValue(undefined);
    const beginHosted = vi.fn().mockResolvedValue(undefined);
    const coordinator = createWorkbenchWatchCoordinator({
      workspace: {
        start: startWorkspace,
        restart: vi.fn().mockResolvedValue(undefined),
        pause: vi.fn(),
        stop: vi.fn(),
        handleEvent: vi.fn(() => false)
      },
      session: {
        beginSelectedSessionWatch: vi.fn(),
        restartSelectedSessionWatch: vi.fn(),
        pauseSelectedSessionWatch: vi.fn(),
        stopSelectedSessionWatch: vi.fn(),
        handleSessionWatchVisibility: vi.fn(),
        handleEvent: vi.fn(() => false)
      },
      hosted: {
        beginSelectedConversationWatch: beginHosted,
        restartSelectedConversationWatch: vi.fn().mockResolvedValue(undefined),
        pauseSelectedConversationWatch: vi.fn(),
        stopSelectedConversationWatch: vi.fn(),
        handleVisibility: vi.fn(),
        handleWatchEvent: vi.fn(() => false)
      }
    });

    const pending = coordinator.startWorkspace('workspace-a');
    void coordinator.startWorkspace('workspace-b');
    await coordinator.beginHostedConversation();
    finishWorkspace();
    await pending;
    await Promise.resolve();

    expect(beginHosted).toHaveBeenCalledOnce();
    expect(startWorkspace).toHaveBeenCalledOnce();
  });
});
