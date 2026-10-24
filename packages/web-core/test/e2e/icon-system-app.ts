import { createTooltipApp as createApp } from './tooltip-app.js';
import { h, ref } from 'vue';
import ElementPlus, { ElButton, ElDatePicker, ElInputNumber } from 'element-plus';
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
import ConversationTimeline from '../../src/view/conversation/ConversationTimeline.vue';
import ConversationWorkProcess from '../../src/view/conversation/ConversationWorkProcess.vue';
import QuickOpenDialog from '../../src/view/workspace/QuickOpenDialog.vue';
import WorkbenchNavigation from '../../src/view/workbench/WorkbenchNavigation.vue';
import ComposerToolbar from '../../src/view/composer/ComposerToolbar.vue';
import { createWorkbenchNotificationService } from '../../src/service/WorkbenchNotificationService.js';
import { createWebPerformanceDiagnostics } from '../../src/service/WebPerformanceDiagnosticService.js';
import type { PersonalUsageOverview, UsageTotals } from '@myagentroam/protocol';
import type { Session } from '../../src/model/workbench.js';
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
    if (new URL(location.href).searchParams.has('process-icons')) {
      return () =>
        h(
          'main',
          {},
          [false, true].map((active) =>
            h(
              ConversationWorkProcess,
              {
                block: {
                  id: `process-${active}`,
                  groupId: `process-${active}`,
                  entries: [],
                  partial: false,
                  sealed: !active,
                  active,
                  status: active ? 'executing' : 'completed',
                  startedAt: 1792771200000,
                  durationMs: active ? undefined : 360000
                },
                synchronized: true,
                now: 1792771634000
              },
              () => h('p', {}, 'Process details')
            )
          )
        );
    }
    if (new URL(location.href).searchParams.has('composer-icons')) {
      const sends = ref(0);
      const stops = ref(0);
      const pending = ref(false);
      return () =>
        h('main', {}, [
          h(ConversationTimeline, {
            turns: [
              {
                id: 'turn',
                sessionId: 'session',
                runId: 'run',
                status: 'SUCCEEDED',
                items: [
                  {
                    id: 'reply',
                    kind: 'assistant_message',
                    status: 'COMPLETED',
                    createdAt: 1792771200000,
                    payload: { text: 'Mobile icon scale review.' }
                  }
                ]
              }
            ],
            workspaceRoot: undefined,
            loading: false,
            initializing: false,
            initialRenderVersion: 0,
            imageAttachments: () => [],
            userInputQuestions: () => [],
            userInputAnswer: () => '',
            userInputSubmitted: () => false,
            planContinuation: undefined,
            nodeReady: true,
            synchronized: true,
            rewindEnabled: false,
            rollbackEnabled: false
          }),
          h(
            'form',
            {
              onSubmit: (event: Event) => {
                event.preventDefault();
                sends.value++;
                pending.value = true;
              }
            },
            [
              h(ComposerToolbar, {
                draftSessionOpen: false,
                runner: 'MAR_AGENT',
                runnerOptions: [],
                runnerLoading: false,
                runnerLabel: 'MAR Agent',
                modelEffortSelection: 'model:test',
                modelEffortLabel: 'Test model',
                selectedModel: 'test',
                selectedEffort: 'high',
                models: [{ id: 'test', label: 'Test model', supportedEfforts: ['high'] }],
                efforts: ['high'],
                access: 'auto',
                accessLabel: 'Auto',
                accessOptions: [{ id: 'auto', label: 'Auto' }],
                configurationDisabled: false,
                accessDisabled: false,
                fastEnabled: false,
                contextUsage: { percentage: 18.4 },
                contextUsageLabel: 'Context usage',
                canCompactContext: true,
                mobileViewport: innerWidth < 768,
                activeRun: undefined,
                canInterrupt: !new URL(location.href).searchParams.has('empty-draft'),
                interruptVisible: true,
                inputHasContent: !new URL(location.href).searchParams.has('empty-draft'),
                hasSelectedCommand: false,
                loading: false,
                submitting: pending.value,
                attachmentsPending: false,
                effortLabel: (effort: string) => effort,
                onStop: () => stops.value++
              })
            ]
          ),
          h(ElButton, { icon: marIcon('edit'), size: 'small' }, () => 'Edit'),
          h('span', { 'data-testid': 'status-icon', style: { fontSize: '11px' } }, [
            h(MarIcon, { name: 'clock' })
          ]),
          h('button', { type: 'button', 'aria-label': 'Explicit icon size' }, [
            h(MarIcon, { name: 'help', size: 24 })
          ]),
          h('output', { 'data-testid': 'sends' }, String(sends.value)),
          h('output', { 'data-testid': 'stops' }, String(stops.value))
        ]);
    }
    if (new URL(location.href).searchParams.has('navigation')) {
      const mobile = new URL(location.href).searchParams.has('mobile');
      const count = Number(new URL(location.href).searchParams.get('count') ?? 6);
      const now = Date.now();
      const service = createWorkbenchNotificationService(ref('fixture'), {
        request: async <T>() =>
          ({
            notifications: [],
            recentRuns: Array.from({ length: count }, (_, i) => ({
              nodeId: 'host',
              runId: `run-${i}`,
              workspaceId: 'project',
              sessionId: `session-${i}`,
              sessionTitle: `Session ${i}`,
              runner: 'MAR_AGENT',
              status: 'RUNNING',
              createdAt: now,
              startedAt: now,
              completedAt: null,
              sortAt: now,
              updatedAt: now,
              version: 1
            }))
          }) as T
      });
      void service.load();
      const diagnostics = createWebPerformanceDiagnostics();
      return () =>
        h(WorkbenchNavigation, {
          webVersion: 'test',
          view: 'conversations',
          navigationItems: [
            { id: 'nodes', label: 'Work' },
            { id: 'conversations', label: 'Conversations' },
            { id: 'management', label: 'Management' },
            { id: 'settings', label: 'Settings' }
          ],
          settingsSection: 'account',
          settingsItems: [],
          managementSection: 'overview',
          managementItems: [],
          sidebarCollapsed: true,
          mobileSidebarOpen: true,
          sidebarContentVisible: false,
          nodes: [],
          expandedNodeIds: [],
          workspaceTarget: undefined,
          draggingWorkspace: undefined,
          loading: false,
          nodeLabel: () => '',
          workspaceLabel: () => '',
          workspaces: () => [],
          mobileViewport: mobile,
          notificationService: service,
          performanceDiagnostics: diagnostics,
          uploads: [],
          uploadStatusLabel: () => ''
        });
    }
    if (new URL(location.href).searchParams.has('disclosure')) {
      return () =>
        h(ConversationTimeline, {
          turns: [
            {
              id: 'turn',
              sessionId: 'session',
              runId: 'run',
              status: 'SUCCEEDED',
              items: [1, 2].map((id) => ({
                id: String(id),
                kind: 'command_execution',
                status: 'COMPLETED',
                payload: { command: `echo ${id}`, output: `Result ${id}` }
              }))
            }
          ],
          workspaceRoot: undefined,
          loading: false,
          initializing: false,
          initialRenderVersion: 0,
          imageAttachments: () => [],
          userInputQuestions: () => [],
          userInputAnswer: () => '',
          userInputSubmitted: () => false,
          planContinuation: undefined,
          nodeReady: true,
          synchronized: true,
          rewindEnabled: false,
          rollbackEnabled: false
        });
    }
    if (new URL(location.href).searchParams.has('quick-open')) {
      return () =>
        h(QuickOpenDialog, {
          open: true,
          nodeId: 'host',
          workspaceId: 'project',
          filesReady: true,
          symbolsReady: true,
          nodes: [node],
          sessions: [],
          workspaceTabs: [],
          sessionTitle: (session: Session) => session.id,
          openSession: async () => {},
          openWorkspace: async () => true
        });
    }
    if (new URL(location.href).searchParams.has('terminal')) {
      const multipleProfiles = new URL(location.href).searchParams.has('multipleProfiles');
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
            profiles: [
              { id: 'shell', label: 'Shell', isDefault: true },
              ...(multipleProfiles
                ? [{ id: 'other-shell', label: 'Other shell', isDefault: false }]
                : [])
            ]
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
      const usageDetails = new URL(location.href).searchParams.has('touch-details');
      const totals: UsageTotals = {
        inputTokens: usageDetails ? '1234567' : '1',
        outputTokens: usageDetails ? '23456' : '1',
        totalTokens: usageDetails ? '1258023' : '2',
        requests: '1',
        cacheReadTokens: usageDetails ? '345678' : null,
        cacheWriteTokens: usageDetails ? '2345' : null,
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
