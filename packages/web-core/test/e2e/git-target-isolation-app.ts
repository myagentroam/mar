import { h, nextTick, ref } from 'vue';
import ElementPlus from 'element-plus';
import { createTooltipApp } from './tooltip-app.js';
import Inspector from '../../src/view/workspace/WorkspaceInspector.vue';
import type { WorkspaceInspectorHandle } from '../../src/service/workbench-surface-state-service.js';
import type { Workspace, WorkspaceTarget } from '../../src/model/workbench.js';
import { createWorkbenchWorkspaceSelectionService } from '../../src/service/workbench-workspace-selection-service.js';
import { createWorkspaceViewCacheService } from '../../src/service/workspace-view-cache-service.js';
import {
  mergeWorkspaceWatchSnapshot,
  type WorkspaceWatchSnapshot
} from '../../src/service/workspace-runtime-state-service.js';
import { i18n, localePreferenceService } from '../../src/service/locale-preference-service.js';
import 'element-plus/dist/index.css';
import '../../src/styles.css';

localePreferenceService().setLocale('en-US');
const targets: readonly WorkspaceTarget[] = await (await fetch('/fixture/targets')).json();
const inspector = ref<WorkspaceInspectorHandle>();
const target = ref<WorkspaceTarget>();
const subscription = ref<WorkspaceWatchSnapshot>();
const cache = createWorkspaceViewCacheService((nodeId, workspaceId) => `${nodeId}:${workspaceId}`);
const workspaces: Workspace[] = targets.map(({ workspaceId }, index) => ({
  id: workspaceId,
  path: `/fixture/${index}`,
  kind: 'GIT_WORKSPACE'
}));
const status = ref('ready');
const noop = () => {};
const selection = createWorkbenchWorkspaceSelectionService({
  workspaceTarget: target,
  selectedSessionId: ref(),
  selectedRunId: ref(),
  workspaces: ref([]),
  sessions: ref([]),
  draftOpen: ref(false),
  profilesLoading: ref(false),
  manifest: ref(),
  manifestLoading: ref(false),
  isCacheActive: cache.isActive,
  hasNode: () => true,
  isHostAvailable: () => true,
  cachedWorkspaces: (nodeId) =>
    workspaces.filter((_workspace, index) => targets[index]!.nodeId === nodeId),
  cacheWorkspaces: noop,
  rememberTarget: noop,
  rememberWorkspace: noop,
  invalidateWorkspace: noop,
  deactivateCache: cache.deactivate,
  clearContent: noop,
  showWorkbench: noop,
  closeSidebar: noop,
  restoreProfiles: noop,
  restoreManifest: () => undefined,
  refreshManifest: async () => {},
  refreshTransport: noop,
  // Session/manifest loading and Watch transport are controlled boundaries. Selection,
  // view caches, Inspector lifecycle, Git service and confirmation UI are real.
  request: async <T>() => ({ workspaces }) as T,
  notice: noop,
  errorMessage: String,
  stopWatch: noop,
  startWatch: async () => {},
  saveCurrent: () => {
    const current = target.value;
    if (current && cache.isActive(current.nodeId, current.workspaceId) && inspector.value) {
      const view = cache.view(current.nodeId, current.workspaceId);
      cache.captureActive({ ...view, inspector: inspector.value.snapshot() }, 2);
    }
  },
  activateCache: cache.activate,
  restoreInspector: (nodeId, workspaceId) => {
    const snapshot = cache.view(nodeId, workspaceId).inspector;
    if (snapshot !== undefined) inspector.value?.restoreWorkspace(nodeId, workspaceId, snapshot);
  },
  refreshInspector: (nodeId, workspaceId) => {
    void nextTick(() => inspector.value?.refreshVisibleSection(nodeId, workspaceId));
  },
  initializePaging: noop,
  tabId: (nodeId, workspaceId) => `${nodeId}:${workspaceId}`,
  viewCache: cache.view,
  resetQueue: noop,
  openSession: async () => {},
  openDraft: noop,
  restoreDraft: noop,
  hasProfiles: () => true,
  loadProfiles: async () => {},
  takeRestoredSelection: () => undefined,
  restoreSession: async () => {}
});

async function publish(index: number, revision: number): Promise<void> {
  const selected = targets[index]!;
  const changes = await (
    await fetch(`/fixture/changes?nodeId=${selected.nodeId}&workspaceId=${selected.workspaceId}`)
  ).json();
  subscription.value = mergeWorkspaceWatchSnapshot(
    undefined,
    selected.nodeId,
    selected.workspaceId,
    { changes },
    { topic: 'changes', revision }
  );
  await nextTick();
  status.value = `watch-${index}-${revision}`;
}

createTooltipApp({
  render: () =>
    h('main', { style: 'height: 800px; display: flex; flex-direction: column' }, [
      h(
        'nav',
        targets.flatMap((entry, index) => [
          h(
            'button',
            {
              onClick: async () => {
                await selection.select(entry, false);
                await nextTick();
                status.value = `selected-${index}`;
              }
            },
            `Select ${index === 0 ? 'A' : 'B'}`
          ),
          h(
            'button',
            { onClick: () => publish(index, index === 0 ? 3 : 1) },
            `Watch ${index === 0 ? 'A:3' : 'B:1'}`
          )
        ])
      ),
      h('button', { onClick: () => publish(0, 99) }, 'Old A Watch'),
      h('button', { onClick: () => publish(1, 0) }, 'Low B Watch'),
      h('output', { 'data-testid': 'status' }, status.value),
      h(Inspector, {
        ref: inspector,
        nodeId: target.value?.nodeId,
        workspaceId: target.value?.workspaceId,
        workspaceName:
          target.value?.nodeId === targets[0]!.nodeId &&
          target.value?.workspaceId === targets[0]!.workspaceId
            ? 'A'
            : 'B',
        workspaceKind: 'GIT_WORKSPACE',
        csrfToken: 'fixture-csrf',
        renewCsrfToken: async () => 'fixture-csrf',
        enabled: true,
        mobileViewport: false,
        contentSearchEnabled: false,
        codeNavigationEnabled: false,
        codeNavigationPrewarmEnabled: false,
        filesWatchStatus: 'idle',
        changesWatchStatus: 'ready',
        historyCapability: false,
        fileWriteEnabled: false,
        subscriptionSnapshot: subscription.value
      })
    ])
})
  .use(i18n)
  .use(ElementPlus)
  .mount('#app');
