import { h, nextTick, ref, watch } from 'vue';
import ElementPlus from 'element-plus';
import { createTooltipApp } from './tooltip-app.js';
import WorkspaceGitChanges from '../../src/view/workspace/WorkspaceGitChanges.vue';
import WorkspaceGitHistory from '../../src/view/workspace/WorkspaceGitHistory.vue';
import { createWorkspaceGitService } from '../../src/service/workspace-git-service.js';
import { createScopedHttpService } from '../../src/service/scoped-http-service.js';
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
const target = ref<WorkspaceTarget>();
const subscription = ref<WorkspaceWatchSnapshot>();
const cache = createWorkspaceViewCacheService((nodeId, workspaceId) => `${nodeId}:${workspaceId}`);
const workspaces: Workspace[] = targets.map(({ workspaceId }, index) => ({
  id: workspaceId,
  path: `/fixture/${index}`,
  kind: 'GIT_WORKSPACE'
}));
const git = createWorkspaceGitService({
  http: createScopedHttpService({
    csrfToken: () => 'fixture-csrf',
    renewCsrfToken: async () => 'fixture-csrf'
  }),
  target: () => target.value,
  gitEnabled: () => true,
  historyEnabled: () => true,
  onFailure: () => {},
  onWorkspace: () => {},
  onBranch: () => {}
});
watch(target, () => git.reset(), { flush: 'sync' });
watch(
  subscription,
  (snapshot) => {
    if (
      snapshot !== undefined &&
      snapshot.nodeId === target.value?.nodeId &&
      snapshot.workspaceId === target.value?.workspaceId &&
      snapshot.changes !== undefined
    )
      git.applyWatch(snapshot.changes, snapshot.changesWatchRevision);
  },
  { flush: 'sync' }
);
const status = ref('ready');
const activeTool = ref<'files' | 'changes' | 'history'>('files');
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
  // Session/manifest loading and Watch transport are controlled boundaries.
  // Selection, view caches, Git service and confirmation UI are real.
  request: async <T>() => ({ workspaces }) as T,
  notice: noop,
  errorMessage: String,
  stopWatch: noop,
  startWatch: async () => {},
  saveCurrent: () => {
    const current = target.value;
    if (current && cache.isActive(current.nodeId, current.workspaceId))
      cache.captureActive(
        { ...cache.view(current.nodeId, current.workspaceId), git: git.snapshot() },
        2
      );
  },
  activateCache: cache.activate,
  restoreWorkspaceView: (nodeId, workspaceId) => {
    const snapshot = cache.view(nodeId, workspaceId).git;
    if (snapshot !== undefined) git.restore(snapshot);
  },
  refreshVisibleTool: () => {
    void git.loadChanges();
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
      h(
        'div',
        { role: 'tablist' },
        (['files', 'changes', 'history'] as const).map((tool) =>
          h(
            'button',
            {
              role: 'tab',
              'aria-selected': activeTool.value === tool,
              onClick: () => {
                if (activeTool.value === 'history' && tool !== 'history')
                  git.cancelHistoryPending();
                activeTool.value = tool;
                if (tool === 'changes') void git.loadChanges(true);
                if (tool === 'history') void git.openHistory();
              }
            },
            tool === 'changes' ? 'Git Changes' : tool === 'history' ? 'Git History' : 'Files'
          )
        )
      ),
      activeTool.value === 'changes' &&
        h(WorkspaceGitChanges, { service: git, target: target.value }),
      activeTool.value === 'history' && h(WorkspaceGitHistory, { service: git })
    ])
})
  .use(i18n)
  .use(ElementPlus)
  .mount('#app');
