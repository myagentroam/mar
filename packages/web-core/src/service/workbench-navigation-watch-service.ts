import type { WorkspaceTarget } from '../model/workbench.js';
export type NavigationWatchSurface = 'workbench' | 'extension' | 'other';

export interface NavigationWatchCoordinator {
  stopWorkspace(): void;
  stopSession(): void;
  beginExtension(): Promise<void>;
  stopExtension(): void;
  startWorkspace(workspaceId: string): Promise<void>;
  beginSession(sessionId: string): void;
}

export function createWorkbenchNavigationWatchService(options: {
  readonly coordinator: () => NavigationWatchCoordinator | undefined;
  readonly currentSurface: () => NavigationWatchSurface;
  readonly workspaceTarget: () => WorkspaceTarget | undefined;
  readonly selectedSessionId: () => string | undefined;
  readonly hasSelectedExtensionTarget: () => boolean;
}) {
  let restoreWorkspaceWatch = false;

  function requestSessionWatch(sessionId: string): void {
    if (options.workspaceTarget() === undefined || options.selectedSessionId() !== sessionId)
      return;
    if (options.currentSurface() !== 'workbench') {
      restoreWorkspaceWatch = true;
      return;
    }
    options.coordinator()?.beginSession(sessionId);
  }

  function transition(
    previousView: NavigationWatchSurface,
    nextView: NavigationWatchSurface
  ): void {
    const coordinator = options.coordinator();
    if (nextView === 'extension') {
      restoreWorkspaceWatch = true;
      coordinator?.stopWorkspace();
      coordinator?.stopSession();
      if (options.hasSelectedExtensionTarget())
        void coordinator?.beginExtension().catch(() => undefined);
      return;
    }
    if (previousView === 'extension') {
      restoreWorkspaceWatch = true;
      coordinator?.stopExtension();
    }
    if (nextView !== 'workbench' || !restoreWorkspaceWatch) return;
    restoreWorkspaceWatch = false;
    const workspaceId = options.workspaceTarget()?.workspaceId;
    if (coordinator === undefined || workspaceId === undefined) return;
    void coordinator.startWorkspace(workspaceId).then(() => {
      const sessionId = options.selectedSessionId();
      if (options.currentSurface() === 'workbench' && sessionId !== undefined)
        coordinator.beginSession(sessionId);
    });
  }

  return { transition, requestSessionWatch };
}
