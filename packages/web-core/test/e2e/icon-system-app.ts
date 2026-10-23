import { createApp, h, ref } from 'vue';
import ElementPlus, { ElDatePicker, ElInputNumber } from 'element-plus';
import 'element-plus/dist/index.css';
import 'element-plus/theme-chalk/dark/css-vars.css';
import '../../src/styles.css';
import MarIcon from '../../src/view/common/MarIcon.vue';
import { iconShapes, type MarIconName } from '../../src/util/icon-shapes.js';
import { marIcon } from '../../src/util/mar-icons.js';
import WorkspaceTree from '../../src/view/workspace/WorkspaceTree.vue';
import WorkspaceSessionList from '../../src/view/workspace/WorkspaceSessionList.vue';
import MailTemplateManagement from '../../src/view/settings/MailTemplateManagement.vue';
import PersonalUsageSettings from '../../src/view/settings/PersonalUsageSettings.vue';
import TerminalDock from '../../src/view/terminal/TerminalDock.vue';
import type { PersonalUsageOverview, UsageTotals } from '@myagentroam/protocol';
import AgentMarkdown from '../../src/view/common/AgentMarkdown.vue';
import { i18n, localePreferenceService } from '../../src/service/LocalePreferenceService.js';
import { themePreferenceService } from '../../src/service/ThemePreferenceService.js';
import type { NodeSummary, Workspace } from '../../src/model/workbench.js';

localePreferenceService().setLocale('en-US');
themePreferenceService().setTheme(
  new URL(location.href).searchParams.get('theme') === 'light' ? 'daylight' : 'vscode-dark-2026'
);
const node: NodeSummary = {
  id: 'host',
  displayName: 'Engineering',
  registeredAddress: 'localhost',
  platform: 'linux',
  architecture: 'x64',
  nodeAppVersion: 'test',
  nodeVersion: 'test',
  connected: true,
  disabled: false,
  manageable: true,
  workspaceCreatable: true,
  capabilities: {}
};
const workspaces: Workspace[] = [
  {
    id: 'project',
    displayName: 'MyAgentRoam',
    path: '/projects/mar',
    kind: 'GIT_WORKSPACE',
    manageable: true
  },
  {
    id: 'other',
    displayName: 'Service',
    path: '/projects/service',
    kind: 'DIRECTORY',
    groupName: 'Company',
    manageable: true
  }
];
const style = document.createElement('style');
style.textContent =
  'body{margin:0;background:var(--mar-bg-app);color:var(--mar-text-primary)}main{padding:24px}.icon-review-columns{display:grid;grid-template-columns:300px 330px minmax(200px,1fr);gap:24px}.icon-review-columns>section{min-width:0;padding:18px;background:var(--mar-bg-panel)}.icon-review-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(100px,1fr));gap:12px;margin-top:24px}.icon-review-cell{display:flex;gap:8px;align-items:center;flex-direction:column;padding:12px;font-size:12px;background:var(--mar-bg-panel)}@media(max-width:767px){main{padding:12px}.icon-review-columns{grid-template-columns:1fr}}';
document.head.append(style);
const app = createApp({
  setup() {
    if (new URL(location.href).searchParams.has('terminal')) {
      return () =>
        h(TerminalDock, {
          errorMessage: String,
          nodeId: 'host',
          workspaceId: 'project',
          csrfToken: 'fixture',
          renewCsrfToken: async () => 'fixture',
          enabled: true,
          capability: {
            available: true,
            reasonCode: null,
            supportsReplay: false,
            supportsConPty: false,
            supportsTakeover: false,
            profiles: [{ id: 'shell', label: 'Shell', isDefault: true }]
          },
          direct: {
            attach: async ({ onAttached }: { onAttached: () => void }) => {
              onAttached();
              return { send() {}, dispose() {} };
            }
          },
          nodeOsRelease: undefined,
          visible: true,
          mobileMode: true,
          active: true
        });
    }
    if (new URL(location.href).searchParams.has('usage')) {
      const totals: UsageTotals = {
        inputTokens: '1',
        outputTokens: '1',
        totalTokens: '2',
        requests: '1',
        cacheReadTokens: null,
        cacheWriteTokens: null,
        completeRequests: '1',
        partialRequests: '0',
        unknownRequests: '0'
      };
      const now = Date.now();
      const overview: PersonalUsageOverview = {
        asOf: now,
        availableFrom: now - 86400000,
        firstRecordedAt: now - 3600000,
        lastReceivedAt: now,
        last24Hours: totals,
        last7Days: totals,
        selected: totals,
        buckets: [{ from: now - 3600000, to: now, ...totals }],
        runners: [],
        models: [],
        coverage: 'observed-only'
      };
      return () =>
        h(PersonalUsageSettings, {
          request: async <T>(path: string) =>
            (path.includes('/overview?') ? overview : { records: [], total: '0', page: 1 }) as T
        });
    }
    const query = ref('');
    const creates = ref(0);
    const searches = ref('');
    const quantity = ref(1);
    return () =>
      h('main', {}, [
        h('h1', {}, 'MAR shared icons — real component fixture'),
        h('div', { class: 'icon-review-columns' }, [
          h('section', { 'data-testid': 'resource-tree' }, [
            h('h2', {}, [h(MarIcon, { name: 'workspace', size: 20 }), ' Workspace']),
            h(WorkspaceTree, {
              nodes: [node],
              expandedNodeIds: ['host'],
              workspaceTarget: { nodeId: 'host', workspaceId: 'project' },
              draggingWorkspace: undefined,
              mobileViewport: innerWidth < 768,
              loading: false,
              nodeLabel: (n: NodeSummary) => n.displayName ?? n.id,
              workspaceLabel: (w: Workspace) => w.displayName ?? w.path,
              workspaces: () => workspaces
            })
          ]),
          h('section', { 'data-testid': 'sessions' }, [
            h(WorkspaceSessionList, {
              sessions: [],
              selectedSessionId: undefined,
              mobileViewport: innerWidth < 768,
              canLoadMore: false,
              loadingMore: false,
              watchStatus: 'ready',
              nodeReady: true,
              loading: false,
              workspaceKind: 'GIT_WORKSPACE',
              workspaceKindLabel: 'Git',
              workspaceBranch: 'develop',
              title: () => '',
              runnerIcon: () => '',
              activity: () => '',
              activityLabel: () => '',
              activityDateTime: () => undefined,
              activityTitle: () => undefined,
              relativeActivity: () => '',
              nodeId: 'host',
              workspaceId: 'project',
              skillSupported: false,
              mcpSupported: false,
              cleanupSessionsSupported: false,
              searchSupported: true,
              searchQuery: query.value,
              searching: new URL(location.href).searchParams.has('busy'),
              refreshing: false,
              workspaceManageable: true,
              request: async <T>() => ({}) as T,
              hasUnread: () => false,
              onCreate: () => creates.value++,
              onSearch: (value: string) => {
                query.value = value;
                searches.value = value;
              },
              onRefresh: () => {
                searches.value = 'refreshed';
              }
            }),
            h('output', { 'data-testid': 'created' }, String(creates.value)),
            h('output', { 'data-testid': 'searched' }, searches.value)
          ]),
          h('section', { 'data-testid': 'management' }, [
            h('h2', {}, 'Management'),
            h(
              ElDatePicker,
              {
                modelValue: new Date(2026, 9, 23),
                placeholder: 'Review date',
                prefixIcon: marIcon('calendar'),
                clearIcon: marIcon('clear-input')
              },
              {
                'prev-month': () => h(MarIcon, { name: 'chevron-left' }),
                'next-month': () => h(MarIcon, { name: 'chevron-right' }),
                'prev-year': () => h(MarIcon, { name: 'chevrons-left' }),
                'next-year': () => h(MarIcon, { name: 'chevrons-right' })
              }
            ),
            h(
              ElInputNumber,
              {
                'data-testid': 'quantity',
                modelValue: quantity.value,
                min: 1,
                max: 5,
                'onUpdate:modelValue': (value: number | undefined) => {
                  quantity.value = value ?? 1;
                }
              },
              {
                'increase-icon': () => h(MarIcon, { name: 'plus' }),
                'decrease-icon': () => h(MarIcon, { name: 'subtract' })
              }
            ),
            h(MailTemplateManagement, {
              writable: true,
              request: async <T>(url: string) => {
                if (new URL(location.href).searchParams.has('failure')) {
                  throw new Error('Template request failed');
                }
                return (
                  url.endsWith('/preview')
                    ? {
                        subject: 'Preview',
                        text: 'Preview message',
                        html: '<p>Preview message</p>'
                      }
                    : [
                        {
                          id: 'one',
                          name: 'Notification',
                          kind: 'NOTIFICATION',
                          locale: 'en-US',
                          subject: 'Notification',
                          body: 'Example',
                          revision: 1,
                          isDefault: true
                        }
                      ]
                ) as T;
              }
            }),
            h(AgentMarkdown, { content: '```ts\nconst shared = true;\n```' })
          ])
        ]),
        h(
          'div',
          { class: 'icon-review-grid' },
          (Object.keys(iconShapes) as MarIconName[]).map((name) =>
            h('div', { class: 'icon-review-cell' }, [
              h(MarIcon, { name, size: 20 }),
              h('span', {}, name)
            ])
          )
        )
      ]);
  }
});
app.use(i18n).use(ElementPlus).mount('#app');
