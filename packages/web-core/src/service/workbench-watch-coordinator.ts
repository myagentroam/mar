export interface WorkbenchWatchCoordinatorOptions {
  readonly workspace: {
    start(workspaceId: string, directory?: string): Promise<void>;
    restart(workspaceId: string): Promise<void>;
    pause(): void;
    stop(): void;
    handleEvent(event: unknown): boolean;
  };
  readonly session: {
    beginSelectedSessionWatch(
      sessionId: string,
      options?: { readonly skipImmediateRenew?: boolean }
    ): void;
    restartSelectedSessionWatch(sessionId: string): Promise<void> | void;
    pauseSelectedSessionWatch(): void;
    stopSelectedSessionWatch(): void;
    handleSessionWatchVisibility(): void;
    handleEvent(event: unknown): boolean;
  };
  readonly extension?: {
    begin(): Promise<void>;
    restart(): Promise<void>;
    pause(): void;
    stop(): void;
    handleVisibility(): void;
    handleEvent(event: unknown): boolean;
  };
}

/** Owns Workspace/Session watches and one mutually exclusive product surface. */
export function createWorkbenchWatchCoordinator(options: WorkbenchWatchCoordinatorOptions) {
  let reconcile: Promise<void> | undefined;
  let trailing: (() => Promise<void>) | undefined;

  function enqueue(task: () => Promise<void>): Promise<void> {
    if (reconcile !== undefined) {
      trailing = task;
      return reconcile;
    }
    reconcile = task().finally(async () => {
      reconcile = undefined;
      const next = trailing;
      trailing = undefined;
      if (next !== undefined) await enqueue(next);
    });
    return reconcile;
  }

  function stopWorkspace(): void {
    trailing = undefined;
    options.workspace.stop();
  }

  return {
    startWorkspace: (workspaceId: string, directory?: string) => {
      options.extension?.stop();
      return enqueue(() => options.workspace.start(workspaceId, directory));
    },
    restartWorkspace: (workspaceId: string) => {
      options.extension?.stop();
      return enqueue(() => options.workspace.restart(workspaceId));
    },
    stopWorkspace,
    beginSession(sessionId: string, input?: { readonly skipImmediateRenew?: boolean }): void {
      options.extension?.stop();
      options.session.beginSelectedSessionWatch(sessionId, input);
    },
    restartSession(sessionId: string): Promise<void> | void {
      options.extension?.stop();
      return options.session.restartSelectedSessionWatch(sessionId);
    },
    async beginExtension(): Promise<void> {
      if (options.extension === undefined) throw new Error('WEB_WATCH_EXTENSION_REQUIRED');
      stopWorkspace();
      options.session.stopSelectedSessionWatch();
      return options.extension.begin();
    },
    async restartExtension(): Promise<void> {
      if (options.extension === undefined) throw new Error('WEB_WATCH_EXTENSION_REQUIRED');
      stopWorkspace();
      options.session.stopSelectedSessionWatch();
      return options.extension.restart();
    },
    pause(): void {
      trailing = undefined;
      options.workspace.pause();
      options.session.pauseSelectedSessionWatch();
      options.extension?.pause();
    },
    stopSession: options.session.stopSelectedSessionWatch,
    stopExtension: () => options.extension?.stop(),
    handleVisibility(): void {
      stopWorkspace();
      options.session.handleSessionWatchVisibility();
      options.extension?.handleVisibility();
    },
    handleEvent(event: unknown): boolean {
      return (
        options.workspace.handleEvent(event) ||
        options.session.handleEvent(event) ||
        (options.extension?.handleEvent(event) ?? false)
      );
    },
    dispose(): void {
      trailing = undefined;
      options.extension?.stop();
      options.session.stopSelectedSessionWatch();
      options.workspace.stop();
    }
  };
}
