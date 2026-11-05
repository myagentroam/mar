import { getCurrentScope, onScopeDispose, ref, watch } from 'vue';
import type { WorkspaceTarget } from '../model/workbench.js';
import {
  STANDALONE_FILE_OPEN_EVENT,
  standaloneFileOpenIntent,
  type StandaloneFileOpenIntent
} from './standalone-file-window-service.js';

export function createStandaloneFileBootstrapController(input: {
  authenticated: () => boolean;
  hasNodes: () => boolean;
  nodeId: () => string | undefined;
  workspaceId: () => string | undefined;
  filesReady: () => boolean;
  manifestLoading: () => boolean;
  selectWorkspace: (target: WorkspaceTarget) => Promise<boolean>;
  open: (intent: StandaloneFileOpenIntent) => Promise<void>;
  captureRoute: () => void;
}) {
  const initialStandaloneFileIntent =
    typeof location === 'undefined' ? undefined : standaloneFileOpenIntent(location.href);
  const standaloneFileMode = ref(initialStandaloneFileIntent !== undefined);
  const standaloneFileLoading = ref(initialStandaloneFileIntent !== undefined);
  const standaloneFileError = ref(false);
  const pendingStandaloneFileIntent = ref<StandaloneFileOpenIntent | undefined>(
    initialStandaloneFileIntent
  );
  let pendingStandaloneFileUrl = typeof location === 'undefined' ? undefined : location.href;
  let openingStandaloneFileIntent = false;
  let disposed = false;

  function receiveStandaloneFileIntent(event: Event): void {
    const url = (event as Event & { readonly detail?: { readonly url?: unknown } }).detail?.url;
    if (typeof url !== 'string') return;
    const intent = standaloneFileOpenIntent(url);
    if (intent === undefined) return;
    event.preventDefault();
    standaloneFileMode.value = true;
    standaloneFileLoading.value = true;
    standaloneFileError.value = false;
    pendingStandaloneFileIntent.value = intent;
    pendingStandaloneFileUrl = url;
  }

  async function openPendingStandaloneFileIntent(): Promise<void> {
    const intent = pendingStandaloneFileIntent.value;
    const intentUrl = pendingStandaloneFileUrl;
    if (
      disposed ||
      intent === undefined ||
      openingStandaloneFileIntent ||
      !input.authenticated() ||
      !input.hasNodes()
    )
      return;
    openingStandaloneFileIntent = true;
    standaloneFileError.value = false;
    let consumedStandaloneFileIntent = false;
    try {
      if (input.nodeId() !== intent.nodeId || input.workspaceId() !== intent.workspaceId) {
        await input.selectWorkspace({ nodeId: intent.nodeId, workspaceId: intent.workspaceId });
        if (disposed || pendingStandaloneFileIntent.value !== intent) return;
        if (input.nodeId() !== intent.nodeId || input.workspaceId() !== intent.workspaceId) {
          pendingStandaloneFileIntent.value = undefined;
          consumedStandaloneFileIntent = true;
          standaloneFileError.value = true;
          return;
        }
      }
      if (!input.filesReady()) {
        if (input.manifestLoading()) return;
        pendingStandaloneFileIntent.value = undefined;
        consumedStandaloneFileIntent = true;
        standaloneFileError.value = true;
        return;
      }
      if (pendingStandaloneFileIntent.value !== intent) return;
      pendingStandaloneFileIntent.value = undefined;
      consumedStandaloneFileIntent = true;
      await input.open(intent);
      if (
        !disposed &&
        pendingStandaloneFileIntent.value === undefined &&
        input.nodeId() === intent.nodeId &&
        input.workspaceId() === intent.workspaceId &&
        intentUrl !== undefined &&
        typeof location !== 'undefined' &&
        typeof history !== 'undefined'
      ) {
        const nextUrl = new URL(intentUrl, location.href);
        if (nextUrl.origin === location.origin && nextUrl.pathname === location.pathname) {
          history.replaceState(history.state, '', nextUrl);
          input.captureRoute();
        }
      }
    } catch {
      if (disposed) return;
      if (pendingStandaloneFileIntent.value === intent) {
        pendingStandaloneFileIntent.value = undefined;
        standaloneFileError.value = true;
      } else if (
        consumedStandaloneFileIntent &&
        pendingStandaloneFileIntent.value === undefined &&
        input.nodeId() === intent.nodeId &&
        input.workspaceId() === intent.workspaceId
      ) {
        standaloneFileError.value = true;
      }
      consumedStandaloneFileIntent = true;
    } finally {
      if (consumedStandaloneFileIntent && pendingStandaloneFileIntent.value === undefined)
        standaloneFileLoading.value = false;
      openingStandaloneFileIntent = false;
      if (
        !disposed &&
        pendingStandaloneFileIntent.value !== undefined &&
        pendingStandaloneFileIntent.value !== intent
      )
        void Promise.resolve().then(openPendingStandaloneFileIntent);
    }
  }

  if (typeof window !== 'undefined') {
    window.addEventListener(STANDALONE_FILE_OPEN_EVENT, receiveStandaloneFileIntent);
  }
  const stopWatching = watch(
    [
      pendingStandaloneFileIntent,
      () => input.authenticated(),
      input.hasNodes,
      input.nodeId,
      input.workspaceId,
      input.filesReady,
      input.manifestLoading
    ],
    () => void openPendingStandaloneFileIntent(),
    { immediate: true, flush: 'post' }
  );

  function dispose(): void {
    disposed = true;
    stopWatching();
    if (typeof window !== 'undefined')
      window.removeEventListener(STANDALONE_FILE_OPEN_EVENT, receiveStandaloneFileIntent);
  }
  if (getCurrentScope() !== undefined) onScopeDispose(dispose);

  return { standaloneFileMode, standaloneFileLoading, standaloneFileError, dispose };
}
