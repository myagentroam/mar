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
    ): Promise<void> | void;
    restartSelectedSessionWatch(sessionId: string): Promise<void> | void;
    pauseSelectedSessionWatch(): void;
    stopSelectedSessionWatch(): void;
    handleSessionWatchVisibility(): void;
    handleEvent(event: unknown): boolean;
  };
  readonly secondary?: WorkbenchWatchCoordinatorOptions['session'];
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
    beginSession(
      sessionId: string,
      input?: { readonly skipImmediateRenew?: boolean }
    ): Promise<void> | void {
      options.extension?.stop();
      return options.session.beginSelectedSessionWatch(sessionId, input);
    },
    restartSession(sessionId: string): Promise<void> | void {
      options.extension?.stop();
      return options.session.restartSelectedSessionWatch(sessionId);
    },
    beginSecondarySession(
      sessionId: string,
      input?: { readonly skipImmediateRenew?: boolean }
    ): Promise<void> | void {
      options.extension?.stop();
      return options.secondary?.beginSelectedSessionWatch(sessionId, input);
    },
    restartSecondarySession(sessionId: string): Promise<void> | void {
      options.extension?.stop();
      return options.secondary?.restartSelectedSessionWatch(sessionId);
    },
    stopSecondarySession(): void {
      options.secondary?.stopSelectedSessionWatch();
    },
    async beginExtension(): Promise<void> {
      if (options.extension === undefined) throw new Error('WEB_WATCH_EXTENSION_REQUIRED');
      stopWorkspace();
      options.session.stopSelectedSessionWatch();
      options.secondary?.stopSelectedSessionWatch();
      return options.extension.begin();
    },
    async restartExtension(): Promise<void> {
      if (options.extension === undefined) throw new Error('WEB_WATCH_EXTENSION_REQUIRED');
      stopWorkspace();
      options.session.stopSelectedSessionWatch();
      options.secondary?.stopSelectedSessionWatch();
      return options.extension.restart();
    },
    pause(): void {
      trailing = undefined;
      options.workspace.pause();
      options.session.pauseSelectedSessionWatch();
      options.secondary?.pauseSelectedSessionWatch();
      options.extension?.pause();
    },
    stopSession: options.session.stopSelectedSessionWatch,
    stopExtension: () => options.extension?.stop(),
    handleVisibility(): void {
      stopWorkspace();
      options.session.handleSessionWatchVisibility();
      options.secondary?.handleSessionWatchVisibility();
      options.extension?.handleVisibility();
    },
    handleEvent(event: unknown): boolean {
      return (
        options.workspace.handleEvent(event) ||
        options.session.handleEvent(event) ||
        (options.secondary?.handleEvent(event) ?? false) ||
        (options.extension?.handleEvent(event) ?? false)
      );
    },
    dispose(): void {
      trailing = undefined;
      options.extension?.stop();
      options.session.stopSelectedSessionWatch();
      options.secondary?.stopSelectedSessionWatch();
      options.workspace.stop();
    }
  };
}

/** Reconcile Watch gaps and reconnects through domain commands, never writable page state. */
export function createWorkbenchWatchRecovery(input: {
  readonly view: Readonly<import('vue').Ref<string>>;
  readonly workspaceTarget: Readonly<
    import('vue').Ref<import('../model/workbench.js').WorkspaceTarget | undefined>
  >;
  readonly selectedWorkspace: Readonly<
    import('vue').Ref<import('../model/workbench.js').Workspace | undefined>
  >;
  readonly selectedSessionId: Readonly<import('vue').Ref<string | undefined>>;
  readonly hostedNodeId: Readonly<import('vue').Ref<string | undefined>>;
  readonly coordinator: () =>
    | Pick<
        ReturnType<
          typeof import('./hosted-conversation-watch-coordinator.js').createHostedConversationWatchCoordinator
        >,
        'restartHostedConversation' | 'restartWorkspace' | 'handleVisibility'
      >
    | undefined;
  readonly invalidateManifest: (nodeId: string) => void;
  readonly refreshManifest: (nodeId: string) => Promise<unknown>;
  readonly reactivate: (nodeId: string) => boolean;
  readonly discardNodeCache: (nodeId: string) => void;
  readonly resetSession: () => void;
  readonly refreshSession: () => void;
  readonly direct: { connectionLost(): void };
  readonly live: { reconnect(): void };
}) {
  const view = input.view;
  const selectedWorkspace = input.selectedWorkspace;
  const selectedSessionId = input.selectedSessionId;
  const workspaceNodeId = {
    get value() {
      return input.workspaceTarget.value?.nodeId;
    }
  };
  const activeWorkspaceId = {
    get value() {
      return input.workspaceTarget.value?.workspaceId;
    }
  };
  const hostedConversationWorkspace = { selectedNodeId: input.hostedNodeId };
  const watchCoordinator = {
    get current() {
      return input.coordinator();
    }
  };
  const invalidateNodeManifest = input.invalidateManifest;
  const refreshNodeManifest = input.refreshManifest;
  const reactivateConnectedWorkspace = input.reactivate;
  const discardNodeViewCaches = input.discardNodeCache;
  const refreshSelectedSessionSnapshot = input.refreshSession;
  function handleNodeConnected(nodeId: string, restartWatch = true): void {
    invalidateNodeManifest(nodeId);
    if (
      view.value === 'conversations' &&
      hostedConversationWorkspace.selectedNodeId.value === nodeId
    ) {
      if (restartWatch)
        void watchCoordinator.current?.restartHostedConversation().catch(() => undefined);
      return;
    }
    if (view.value !== 'nodes' || workspaceNodeId.value !== nodeId) return;
    if (
      activeWorkspaceId.value !== undefined &&
      selectedWorkspace.value === undefined &&
      reactivateConnectedWorkspace(nodeId)
    )
      return;
    void refreshNodeManifest(nodeId);
    if (!restartWatch) return;
    if (activeWorkspaceId.value !== undefined)
      void watchCoordinator.current?.restartWorkspace(activeWorkspaceId.value);
    if (selectedSessionId.value !== undefined) refreshSelectedSessionSnapshot();
  }

  function handleWorkbenchResync(nodeId: string): void {
    invalidateNodeManifest(nodeId);
    if (
      view.value === 'conversations' &&
      hostedConversationWorkspace.selectedNodeId.value === nodeId
    ) {
      void watchCoordinator.current?.restartHostedConversation().catch(() => undefined);
      return;
    }
    if (view.value !== 'nodes') return;
    discardNodeViewCaches(nodeId);
    if (workspaceNodeId.value === nodeId) void refreshNodeManifest(nodeId);
    if (workspaceNodeId.value === nodeId) {
      input.resetSession();
    }
    if (workspaceNodeId.value === nodeId && activeWorkspaceId.value !== undefined)
      void watchCoordinator.current?.restartWorkspace(activeWorkspaceId.value);
    if (workspaceNodeId.value === nodeId && selectedSessionId.value !== undefined)
      refreshSelectedSessionSnapshot();
  }

  function handleVisibility(): void {
    if (document.visibilityState === 'visible') {
      input.direct.connectionLost();
      input.live.reconnect();
    } else input.coordinator()?.handleVisibility();
  }
  return { connected: handleNodeConnected, resync: handleWorkbenchResync, handleVisibility };
}
