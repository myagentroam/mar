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
