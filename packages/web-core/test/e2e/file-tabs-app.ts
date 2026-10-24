import { h, ref } from 'vue';
import ElementPlus from 'element-plus';
import { createTooltipApp } from './tooltip-app.js';
import Tabs from '../../src/view/workspace/WorkspaceFileTabs.vue';
import Frame from '../../src/view/workspace/WorkspaceFilePageFrame.vue';
import Inspector from '../../src/view/workspace/WorkspaceInspector.vue';
import { consoleKeyboardShortcutService } from '../../src/service/console-keyboard-shortcut-service.js';
import type { WorkspaceFileTab } from '../../src/util/workspace-file-tab.js';
import { i18n, localePreferenceService } from '../../src/service/locale-preference-service.js';
import 'element-plus/dist/index.css';
import '../../src/styles.css';

localePreferenceService().setLocale('en-US');
const query = new URLSearchParams(window.location.search);
const presentation = query.get('presentation') === 'window' ? 'window' : 'overlay';
const previewKind = query.get('kind') as WorkspaceFileTab['kind'] | null;
document.documentElement.dataset.fileTabsBaseHistoryState = JSON.stringify(
  window.history.state ?? null
);
document.documentElement.dataset.fileTabsBaseHistoryLength = String(window.history.length);
document.documentElement.dataset.fileTabsCloseAllowed = 'true';
document.addEventListener('keydown', consoleKeyboardShortcutService.handle, { capture: true });

function createPageHandle() {
  return {
    focus: () => {},
    openFind: () => false,
    selectAll: () => false,
    toggleEdit: () => 'UNAVAILABLE' as const,
    canClose: async () => document.documentElement.dataset.fileTabsCloseAllowed !== 'false'
  };
}

const pageHandles = new Map<number, ReturnType<typeof createPageHandle>>();

function pageHandleFor(id: number): ReturnType<typeof createPageHandle> {
  let handle = pageHandles.get(id);
  if (handle === undefined) {
    handle = createPageHandle();
    pageHandles.set(id, handle);
  }
  return handle;
}

function createTabs(): WorkspaceFileTab[] {
  return Array.from({ length: 12 }, (_, index) => ({
    id: index + 1,
    identity: String(index),
    kind: previewKind ?? 'WORKTREE_TEXT',
    nodeId: 'node',
    workspaceId: 'workspace',
    path: `/workspace/file-${index + 1}.txt`,
    fileName: `Long project file-${index + 1}.txt`,
    repositoryPath: '',
    worktreePath: ''
  }));
}

const tabs = ref<WorkspaceFileTab[]>(createTabs());
const active = ref(1);
const loading = ref(true);
createTooltipApp({
  render: () => {
    if (query.has('diff-navigation'))
      return h(Inspector, {
        nodeId: 'node',
        workspaceId: 'workspace',
        workspaceName: 'project',
        workspaceKind: 'GIT_WORKSPACE',
        csrfToken: 'fixture-csrf',
        renewCsrfToken: async () => 'fixture-csrf',
        enabled: true,
        mobileViewport: window.innerWidth < 768,
        contentSearchEnabled: false,
        codeNavigationEnabled: false,
        codeNavigationPrewarmEnabled: false,
        filesWatchStatus: 'ready',
        changesWatchStatus: 'ready',
        historyCapability: false,
        fileWriteEnabled: false,
        subscriptionSnapshot: {
          nodeId: 'node',
          workspaceId: 'workspace',
          files: { files: { entries: [], nextCursor: null, truncated: false } }
        }
      });
    return h('div', [
      h(
        'button',
        { id: 'file-tabs-background-action', type: 'button' },
        'Workspace background action'
      ),
      tabs.value.length
        ? h(
            Tabs,
            {
              tabs: tabs.value,
              presentation,
              activeTabId: active.value,
              onActivate: (id: number) => {
                active.value = id;
              },
              onClose: (id: number) => {
                tabs.value = tabs.value.filter((tab) => tab.id !== id);
                pageHandles.delete(id);
                if (active.value === id) active.value = tabs.value[0]?.id ?? 0;
              },
              onCloseAll: () => {
                tabs.value = [];
                pageHandles.clear();
              }
            },
            {
              default: ({
                tab,
                active: isActive,
                registerPageHandle
              }: {
                tab: WorkspaceFileTab;
                active: boolean;
                registerPageHandle(handle: unknown): void;
              }) => {
                registerPageHandle(pageHandleFor(tab.id));
                return h(
                  Frame,
                  {
                    fileName: tab.fileName,
                    path: tab.path,
                    style: isActive ? undefined : 'display: none',
                    loading: loading.value
                  },
                  {
                    default: () => h('p', `Content of ${tab.fileName}`),
                    'primary-actions': () =>
                      h(
                        'button',
                        {
                          onClick: () => {
                            loading.value = false;
                          }
                        },
                        'Finish loading'
                      )
                  }
                );
              }
            }
          )
        : h('div', [
            h('p', 'Files closed'),
            h(
              'button',
              {
                id: 'reopen-file-tabs',
                type: 'button',
                onClick: () => {
                  tabs.value = createTabs();
                  active.value = 1;
                  loading.value = true;
                }
              },
              'Reopen file previews'
            )
          ])
    ]);
  }
})
  .use(i18n)
  .use(ElementPlus)
  .mount('#app');
