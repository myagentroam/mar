import {
  createWorkbenchWatchCoordinator as createSharedWatchCoordinator,
  type WorkbenchWatchCoordinatorOptions
} from './workbench-watch-coordinator.js';

interface HostedConversationWatch {
  beginSelectedConversationWatch(): Promise<void>;
  restartSelectedConversationWatch(): Promise<void>;
  pauseSelectedConversationWatch(): void;
  stopSelectedConversationWatch(): void;
  handleVisibility(): void;
  handleWatchEvent(event: unknown): boolean;
}

/** Adapts the Hosted lifecycle to the shared coordinator, which owns subscription exclusivity. */
export function createHostedConversationWatchCoordinator(
  options: Omit<WorkbenchWatchCoordinatorOptions, 'extension'> & {
    readonly hosted: HostedConversationWatch;
  }
) {
  const { hosted, ...common } = options;
  const { beginExtension, restartExtension, stopExtension, ...coordinator } =
    createSharedWatchCoordinator({
      ...common,
      extension: {
        begin: () => hosted.beginSelectedConversationWatch(),
        restart: () => hosted.restartSelectedConversationWatch(),
        pause: () => hosted.pauseSelectedConversationWatch(),
        stop: () => hosted.stopSelectedConversationWatch(),
        handleVisibility: () => hosted.handleVisibility(),
        handleEvent: (event) => hosted.handleWatchEvent(event)
      }
    });
  return {
    ...coordinator,
    beginHostedConversation: beginExtension,
    restartHostedConversation: restartExtension,
    stopHostedConversation: stopExtension
  };
}

/** Selects when to recover the active Hosted target; all Watch operations go through the coordinator. */
export function createHostedConversationWatchRecovery(input: {
  readonly isActive: () => boolean;
  readonly selectedConversationId: () => string | undefined;
  readonly selectedNodeId: () => string | undefined;
  readonly coordinator: () =>
    | Pick<
        ReturnType<typeof createHostedConversationWatchCoordinator>,
        'beginHostedConversation' | 'restartHostedConversation'
      >
    | undefined;
}) {
  return {
    restoreConnection(mode: 'begin' | 'restart'): void {
      if (!input.isActive() || input.selectedConversationId() === undefined) return;
      const coordinator = input.coordinator();
      if (coordinator === undefined) return;
      const recovery =
        mode === 'begin'
          ? coordinator.beginHostedConversation()
          : coordinator.restartHostedConversation();
      void recovery.catch(() => undefined);
    },
    resyncNode(nodeId: string): void {
      if (!input.isActive() || input.selectedNodeId() !== nodeId) return;
      void input
        .coordinator()
        ?.restartHostedConversation()
        .catch(() => undefined);
    }
  };
}
