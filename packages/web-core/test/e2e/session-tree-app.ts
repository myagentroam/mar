import { h, ref } from 'vue';
import { createTooltipApp } from './tooltip-app.js';
import { i18n, localePreferenceService } from '../../src/service/locale-preference-service.js';
import { themePreferenceService } from '../../src/service/theme-preference-service.js';
import { ElMessageBox } from '../../src/service/message-box-service.js';
import type { Session } from '../../src/model/workbench.js';
import Header from '../../src/view/conversation/ConversationHeader.vue';
import Tree from '../../src/view/workspace/WorkspaceSessionTreeButton.vue';
import 'element-plus/theme-chalk/dark/css-vars.css';
import '../../src/styles.css';

const query = new URLSearchParams(location.search);
const rootOnly = query.get('rootOnly') === '1';
localePreferenceService().setLocale(query.get('locale') === 'zh-CN' ? 'zh-CN' : 'en-US');
themePreferenceService().setTheme(query.get('theme') === 'dark' ? 'vscode-dark-2026' : 'daylight');
const requests = ref(0);
const aborts = ref(0);
const selected = ref('');
let settleSnapshot: ((fail: boolean) => void) | undefined;
const session = {
  id: query.has('long-id') ? 'session-'.repeat(40) : rootOnly ? 'parent' : 'child',
  externalSessionId: rootOnly ? 'parent' : 'child',
  runner: 'mar-agent',
  sessionGroup: rootOnly ? 'MAIN' : 'CHILD'
} as Session;
const title = 'Review BMP compatibility changes and lifecycle edge cases';
createTooltipApp({
  render: () =>
    h('main', { style: 'padding: 16px' }, [
      h(
        Header,
        {
          session,
          runner: 'mar-agent',
          filesReady: false,
          terminalReady: false,
          contentSearchReady: false,
          runnerIcon: () => '',
          sessionTitle: () => title
        },
        {
          tree: () =>
            h(Tree, {
              nodeId: 'node',
              workspaceId: 'workspace',
              sessionId: session.id,
              request: async <T>(_path: string, init?: RequestInit) => {
                requests.value++;
                if (query.has('delayed') && requests.value === 1) {
                  await new Promise<void>((resolve, reject) => {
                    settleSnapshot = (fail) =>
                      fail ? reject(new Error('tree unavailable')) : resolve();
                    init?.signal?.addEventListener('abort', () => aborts.value++, { once: true });
                  });
                }
                if (query.has('pending')) {
                  await new Promise<void>((_resolve, reject) => {
                    init?.signal?.addEventListener('abort', () => {
                      aborts.value++;
                      reject(new Error('aborted'));
                    });
                  });
                }
                if (query.has('failure') && requests.value === 1)
                  throw new Error('tree unavailable');
                return {
                  rootSessionId: 'parent',
                  truncated: false,
                  nodes: query.has('long')
                    ? Array.from({ length: 100 }, (_, index) => ({
                        id: index === 0 ? 'parent' : `node-${index}`,
                        parentSessionId:
                          index === 0 ? null : index === 1 ? 'parent' : `node-${index - 1}`,
                        title: `Node ${index}`,
                        runner: 'mar-agent',
                        status: 'IDLE'
                      }))
                    : query.has('mixed')
                      ? [
                          {
                            id: 'parent',
                            parentSessionId: null,
                            title: 'Root',
                            runner: 'mar-agent',
                            status: 'IDLE'
                          },
                          {
                            id: 'idle-branch',
                            parentSessionId: 'parent',
                            title: 'Idle branch',
                            runner: 'mar-agent',
                            status: 'IDLE'
                          },
                          {
                            id: 'running',
                            parentSessionId: 'parent',
                            title: 'Running branch',
                            runner: 'mar-agent',
                            status: 'RUNNING'
                          },
                          {
                            id: 'sleeping',
                            parentSessionId: 'parent',
                            title: 'Sleeping branch',
                            runner: 'mar-agent',
                            status: 'SLEEPING'
                          },
                          {
                            id: 'idle',
                            parentSessionId: 'parent',
                            title: 'Idle leaf',
                            runner: 'mar-agent',
                            status: 'IDLE'
                          },
                          {
                            id: 'idle-two',
                            parentSessionId: 'parent',
                            title: 'Idle leaf two',
                            runner: 'mar-agent',
                            status: 'IDLE'
                          },
                          {
                            id: 'grandchild',
                            parentSessionId: 'idle-branch',
                            title: 'Active descendant',
                            runner: 'mar-agent',
                            status: 'RUNNING'
                          }
                        ]
                      : [
                          {
                            id: 'parent',
                            status: 'IDLE',
                            parentSessionId: null,
                            title: rootOnly
                              ? 'forge#maintainer'
                              : '图片上传报错: MAR_AGENT_HOST_LIMIT_EXCEEDED',
                            runner: 'mar-agent'
                          },
                          {
                            id: 'child',
                            parentSessionId: 'parent',
                            title,
                            runner: 'mar-agent',
                            status: query.has('activity') ? 'RUNNING' : 'IDLE'
                          },
                          {
                            id: 'grandchild',
                            status: query.has('activity') ? 'SLEEPING' : 'IDLE',
                            parentSessionId: 'child',
                            title: 'Verify image decoding and cleanup',
                            runner: 'mar-agent'
                          },
                          {
                            id: 'sibling',
                            status: 'IDLE',
                            parentSessionId: 'parent',
                            title: 'Review upload boundary tests and verify image compatibility. '
                              .repeat(6)
                              .trim(),
                            runner: 'codex'
                          }
                        ]
                          .filter((node) => !rootOnly || node.id === 'parent')
                          .map((node, index) => ({
                            ...node,
                            lastActivityAt:
                              Date.now() - [12 * 60_000, 20_000, 5 * 60_000, 2 * 3_600_000][index]!
                          }))
                } as T;
              },
              onOpen: (id: string) => {
                selected.value = id;
              }
            })
        }
      ),
      h('output', { 'data-testid': 'selected' }, selected.value),
      h('output', { 'data-testid': 'requests' }, requests.value),
      h('output', { 'data-testid': 'aborts' }, aborts.value),
      query.has('confirmation')
        ? h(
            'button',
            {
              'data-testid': 'show-confirmation',
              onClick: () => {
                void ElMessageBox.confirm('Fixture confirmation', 'Confirmation').catch(
                  () => undefined
                );
              }
            },
            'Show confirmation'
          )
        : null,
      query.has('delayed')
        ? h('div', [
            h(
              'button',
              { 'data-testid': 'resolve-snapshot', onClick: () => settleSnapshot?.(false) },
              'Resolve snapshot'
            ),
            h(
              'button',
              { 'data-testid': 'reject-snapshot', onClick: () => settleSnapshot?.(true) },
              'Reject snapshot'
            )
          ])
        : null
    ])
})
  .use(i18n)
  .mount('#app');
