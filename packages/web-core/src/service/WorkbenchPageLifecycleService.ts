import type { WorkspaceTarget } from '../model/workbench.js';
import { onBeforeUnmount, onMounted, watch, watchEffect, type Ref, type WatchSource } from 'vue';
import { ElMessage } from 'element-plus';
import {
  consoleKeyboardShortcutService,
  type ConsoleShortcutResult
} from './ConsoleKeyboardShortcutService.js';

interface WorkbenchPageLifecycleOptions {
  readonly persistenceSources: WatchSource<unknown>[];
  readonly cacheSources: WatchSource<unknown>[];
  readonly routeSources: WatchSource<unknown>[];
  readonly sessionInput: Ref<string>;
  readonly documentTitle: Readonly<Ref<string>>;
  readonly newSessionRunner: WatchSource<unknown>;
  readonly newSessionModel: WatchSource<unknown>;
  readonly workspaceTarget: WatchSource<WorkspaceTarget | undefined>;
  readonly selectedSessionId: WatchSource<string | undefined>;
  readonly notice: Ref<string>;
  readonly conversationTurns: WatchSource<unknown>;
  readonly conversationScroll: Ref<HTMLElement | undefined>;
  readonly followConversation: Readonly<Ref<boolean>>;
  readonly noticeType: (value: string) => 'success' | 'warning' | 'info' | 'error';
  readonly persistWorkbenchState: () => void;
  readonly persistSessionDraft: () => void;
  readonly syncWorkbenchRoute: () => void;
  readonly normalizeNewSessionOptions: () => void;
  readonly clearRunnerCommand: () => void;
  readonly clearComposerModelEffort: () => void;
  readonly closeFileReferences: () => void;
  readonly saveCurrentWorkspaceView: () => void;
  readonly scrollConversationToLatest: () => void;
  readonly stopSelectedSessionWatch: () => void;
  readonly restoreWorkbenchState: () => void;
  readonly restoreWorkbenchEventCursors: () => void;
  readonly restoreWorkspaceUploads: () => void;
  readonly startNavigation: () => void;
  readonly handleSessionWatchVisibility: () => void;
  readonly onGlobalKeydown: (event: KeyboardEvent) => ConsoleShortcutResult;
  readonly refreshAdmin: () => Promise<unknown>;
  readonly cancelFileReferenceSearch: () => void;
  readonly disposeNavigation: () => void;
  readonly disposeWorkspaceUploads: () => void;
  readonly disposeWorkbenchNotifications: () => void;
  readonly disposeWebVersionUpdateCheck: () => void;
  readonly stopWorkspaceWatch: () => void;
  readonly closeWorkbenchLive: () => void;
  readonly disposeDirectTransport: () => void;
  readonly clearNewSessionAttachments: () => void;
  readonly releaseRunImagePreviews: () => void;
}

export function installWorkbenchPageLifecycle(options: WorkbenchPageLifecycleOptions): void {
  let conversationResizeObserver: ResizeObserver | undefined;
  let cacheSaveTimer: ReturnType<typeof setTimeout> | undefined;
  let unregisterShortcut: (() => void) | undefined;

  function scheduleWorkspaceViewSave(): void {
    if (cacheSaveTimer !== undefined) return;
    cacheSaveTimer = setTimeout(() => {
      cacheSaveTimer = undefined;
      options.saveCurrentWorkspaceView();
    }, 0);
  }

  watch(options.persistenceSources, options.persistWorkbenchState, { deep: true });
  watch(options.sessionInput, options.persistSessionDraft);
  watch(options.documentTitle, (title) => (document.title = title), { immediate: true });
  watch(options.routeSources, options.syncWorkbenchRoute);
  watch(options.newSessionRunner, () => {
    options.normalizeNewSessionOptions();
    options.clearRunnerCommand();
    options.clearComposerModelEffort();
  });
  watch(options.newSessionModel, options.normalizeNewSessionOptions);
  watch(options.workspaceTarget, options.closeFileReferences);

  watchEffect(() => {
    const value = options.notice.value;
    if (value.length === 0) return;
    ElMessage({
      message: value,
      type: options.noticeType(value),
      grouping: false,
      showClose: true
    });
  });

  watch(options.cacheSources, scheduleWorkspaceViewSave, { flush: 'post' });
  watch(
    options.conversationTurns,
    () => {
      if (options.followConversation.value) options.scrollConversationToLatest();
    },
    { deep: true, flush: 'post' }
  );
  watch(options.conversationScroll, (element) => {
    conversationResizeObserver?.disconnect();
    if (element === undefined) return;
    conversationResizeObserver = new ResizeObserver(() => {
      if (options.followConversation.value) options.scrollConversationToLatest();
    });
    conversationResizeObserver.observe(element);
  });
  watch(
    options.selectedSessionId,
    (next, previous) => {
      if (next !== previous) options.stopSelectedSessionWatch();
    },
    { flush: 'sync' }
  );

  onMounted(() => {
    options.restoreWorkbenchState();
    options.restoreWorkbenchEventCursors();
    options.restoreWorkspaceUploads();
    options.startNavigation();
    document.addEventListener('visibilitychange', options.handleSessionWatchVisibility);
    unregisterShortcut = consoleKeyboardShortcutService.register({
      priority: 10,
      handle: options.onGlobalKeydown
    });
    void options.refreshAdmin();
  });

  onBeforeUnmount(() => {
    if (cacheSaveTimer !== undefined) clearTimeout(cacheSaveTimer);
    options.cancelFileReferenceSearch();
    options.disposeNavigation();
    document.removeEventListener('visibilitychange', options.handleSessionWatchVisibility);
    unregisterShortcut?.();
    options.disposeWorkspaceUploads();
    options.disposeWorkbenchNotifications();
    options.disposeWebVersionUpdateCheck();
    conversationResizeObserver?.disconnect();
    options.stopSelectedSessionWatch();
    options.stopWorkspaceWatch();
    options.disposeDirectTransport();
    options.closeWorkbenchLive();
    options.clearNewSessionAttachments();
    options.releaseRunImagePreviews();
  });
}
