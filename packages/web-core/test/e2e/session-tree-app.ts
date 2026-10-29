import { h, ref } from 'vue';
import ElementPlus from 'element-plus';
import { createTooltipApp } from './tooltip-app.js';
import { i18n, localePreferenceService } from '../../src/service/locale-preference-service.js';
import { themePreferenceService } from '../../src/service/theme-preference-service.js';
import type { Session } from '../../src/model/workbench.js';
import Header from '../../src/view/conversation/ConversationHeader.vue';
import Tree from '../../src/view/workspace/WorkspaceSessionTreeDialog.vue';
import 'element-plus/dist/index.css';
import 'element-plus/theme-chalk/dark/css-vars.css';
import '../../src/styles.css';

const query = new URLSearchParams(location.search);
localePreferenceService().setLocale(query.get('locale') === 'zh-CN' ? 'zh-CN' : 'en-US');
themePreferenceService().setTheme(query.get('theme') === 'dark' ? 'vscode-dark-2026' : 'daylight');
const open = ref(false);
const selected = ref('');
const session = {
  id: 'child',
  externalSessionId: 'child',
  runner: 'mar-agent',
  sessionGroup: 'CHILD'
} as Session;
const title = 'Review BMP compatibility changes and lifecycle edge cases';
createTooltipApp({
  render: () =>
    h('main', { style: 'padding: 16px' }, [
      h(Header, {
        session,
        runner: 'mar-agent',
        filesReady: false,
        terminalReady: false,
        contentSearchReady: false,
        runnerIcon: () => '',
        sessionTitle: () => title,
        onOpenTree: () => {
          open.value = true;
        }
      }),
      h('output', { 'data-testid': 'selected' }, selected.value),
      open.value
        ? h(Tree, {
            modelValue: true,
            nodeId: 'node',
            workspaceId: 'workspace',
            sessionId: 'child',
            request: async <T>() =>
              ({
                rootSessionId: 'parent',
                truncated: false,
                nodes: [
                  {
                    id: 'parent',
                    parentSessionId: null,
                    title: '图片上传报错: MAR_AGENT_HOST_LIMIT_EXCEEDED',
                    runner: 'mar-agent'
                  },
                  { id: 'child', parentSessionId: 'parent', title, runner: 'mar-agent' },
                  {
                    id: 'grandchild',
                    parentSessionId: 'child',
                    title: 'Verify image decoding and cleanup',
                    runner: 'mar-agent'
                  },
                  {
                    id: 'sibling',
                    parentSessionId: 'parent',
                    title: 'Review upload boundary tests',
                    runner: 'codex'
                  }
                ]
              }) as T,
            onClose: () => {
              open.value = false;
            },
            onOpen: (id: string) => {
              selected.value = id;
              open.value = false;
            }
          })
        : null
    ])
})
  .use(i18n)
  .use(ElementPlus)
  .mount('#app');
