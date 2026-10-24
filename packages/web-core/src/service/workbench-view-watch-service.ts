import type { WorkspaceTarget } from '../model/workbench.js';
import type { WorkbenchView } from '../util/workbench-route.js';
import { createWorkbenchNavigationWatchService } from './workbench-navigation-watch-service.js';

interface WorkbenchViewWatchCoordinator {
  stopWorkspace(): void;
  stopSession(): void;
  beginHostedConversation(): Promise<void>;
  stopHostedConversation(): void;
  startWorkspace(workspaceId: string): Promise<void>;
  beginSession(sessionId: string): void;
}

export function createWorkbenchViewWatchService(options: {
  readonly coordinator: () => WorkbenchViewWatchCoordinator | undefined;
  readonly currentView: () => WorkbenchView;
  readonly workspaceTarget: () => WorkspaceTarget | undefined;
  readonly selectedSessionId: () => string | undefined;
  readonly selectedHostedConversationId: () => string | undefined;
}) {
  const surface = (view: WorkbenchView) =>
    view === 'nodes' ? 'workbench' : view === 'conversations' ? 'extension' : 'other';
  const service = createWorkbenchNavigationWatchService({
    coordinator: () => {
      const coordinator = options.coordinator();
      if (coordinator === undefined) return undefined;
      return {
        stopWorkspace: () => coordinator.stopWorkspace(),
        stopSession: () => coordinator.stopSession(),
        startWorkspace: (workspaceId) => coordinator.startWorkspace(workspaceId),
        beginSession: (sessionId) => coordinator.beginSession(sessionId),
        beginExtension: () => coordinator.beginHostedConversation(),
        stopExtension: () => coordinator.stopHostedConversation()
      };
    },
    currentSurface: () => surface(options.currentView()),
    workspaceTarget: options.workspaceTarget,
    selectedSessionId: options.selectedSessionId,
    hasSelectedExtensionTarget: () => options.selectedHostedConversationId() !== undefined
  });
  return {
    requestSessionWatch: service.requestSessionWatch,
    transition: (previous: WorkbenchView, next: WorkbenchView) =>
      service.transition(surface(previous), surface(next))
  };
}
