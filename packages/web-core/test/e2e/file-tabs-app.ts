import { h, ref } from 'vue';
import ElementPlus from 'element-plus';
import { createTooltipApp } from './tooltip-app.js';
import Tabs from '../../src/view/workspace/WorkspaceFileTabs.vue';
import Frame from '../../src/view/workspace/WorkspaceFilePageFrame.vue';
import type { WorkspaceFileTab } from '../../src/util/workspace-file-tab.js';
import { i18n, localePreferenceService } from '../../src/service/LocalePreferenceService.js';
import 'element-plus/dist/index.css';
import '../../src/styles.css';

localePreferenceService().setLocale('en-US');
const tabs = ref<WorkspaceFileTab[]>(
  Array.from({ length: 12 }, (_, index) => ({
    id: index + 1,
    identity: String(index),
    kind: 'WORKTREE_TEXT',
    nodeId: 'node',
    workspaceId: 'workspace',
    path: `/workspace/file-${index + 1}.txt`,
    fileName: `Long project file-${index + 1}.txt`,
    repositoryPath: '',
    worktreePath: ''
  }))
);
const active = ref(1);
const loading = ref(true);
createTooltipApp({
  render: () =>
    tabs.value.length
      ? h(
          Tabs,
          {
            tabs: tabs.value,
            activeTabId: active.value,
            onActivate: (id: number) => {
              active.value = id;
            },
            onClose: (id: number) => {
              tabs.value = tabs.value.filter((tab) => tab.id !== id);
            },
            onCloseAll: () => {
              tabs.value = [];
            }
          },
          {
            default: ({ tab, active }: { tab: WorkspaceFileTab; active: boolean }) =>
              h(
                Frame,
                {
                  fileName: tab.fileName,
                  path: tab.path,
                  style: active ? undefined : 'display: none',
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
              )
          }
        )
      : h('p', 'Files closed')
})
  .use(i18n)
  .use(ElementPlus)
  .mount('#app');
