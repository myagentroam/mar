import { createTooltipApp as createApp } from './tooltip-app.js';
import type { createHostedConversationWorkspaceService } from '../../src/service/hosted-conversation-workspace-service.js';
import { computed, h, ref, resolveDirective, withDirectives } from 'vue';
import ElementPlus, { ElDialog, ElTable, ElTableColumn } from 'element-plus';
import { tableTooltipOptions } from '../../src/util/tooltip.js';
import SharedTooltipFixture from './shared-tooltip-fixture.vue';
import 'element-plus/dist/index.css';
import 'element-plus/theme-chalk/dark/css-vars.css';
import '../../src/styles.css';
import ComposerToolbar from '../../src/view/composer/ComposerToolbar.vue';
import HostedConversationComposer from '../../src/view/conversation/HostedConversationComposer.vue';
import ThemeSettings from '../../src/view/settings/ThemeSettings.vue';
import WebPerformanceIndicator from '../../src/view/workbench/WebPerformanceIndicator.vue';
import ConversationScroll from '../../src/view/conversation/ConversationScroll.vue';
import LoadingFeedbackFixture from './loading-feedback-fixture.vue';
import UtilityInteractionFixture from './utility-interaction-fixture.vue';
import ListHierarchyFixture from './list-hierarchy-fixture.vue';
import SessionPerformanceInfo from '../../src/view/conversation/SessionPerformanceInfo.vue';
import { createWorkbenchContextCommandService } from '../../src/service/workbench-context-command-service.js';
import type { RunnerCommand, Session } from '../../src/model/workbench.js';
import NodeDetailsDialogs from '../../src/view/settings/NodeDetailsDialogs.vue';
import { createWebPerformanceDiagnostics } from '../../src/service/web-performance-diagnostic-service.js';
import WorkbenchNotificationCenter from '../../src/view/workbench/WorkbenchNotificationCenter.vue';
import MailTemplateManagement from '../../src/view/settings/MailTemplateManagement.vue';
import { createWorkbenchNotificationService } from '../../src/service/workbench-notification-service.js';
import { i18n, localePreferenceService } from '../../src/service/locale-preference-service.js';
import { themePreferenceService } from '../../src/service/theme-preference-service.js';

const mobile = new URLSearchParams(location.search).has('mobile');
const mobileNotificationsOpen = ref(false);
const mobileNotificationPanelTarget = ref<HTMLElement>();
localePreferenceService().setLocale(
  new URLSearchParams(location.search).get('locale') === 'zh-CN' ? 'zh-CN' : 'en-US'
);
themePreferenceService().setTheme(
  new URL(location.href).searchParams.get('theme') === 'daylight' ? 'daylight' : 'vscode-dark-2026'
);
let notificationRemoved = false;
const service = createWorkbenchNotificationService(ref('fixture'), {
  request: async <T>(path: string, init?: RequestInit) => {
    if (path === '/api/notifications/notice' && init?.method === 'DELETE') {
      notificationRemoved = true;
    }
    if (notificationRemoved) return { notifications: [] } as T;
    return {
      notifications: [
        {
          id: 'notice',
          kind: 'agent',
          title: new URLSearchParams(location.search).has('long-notification')
            ? 'MyAgentRoam: 检查通知布局与完整内容 Review notification layout and complete content'
            : 'Review ready',
          message: new URLSearchParams(location.search).has('long-notification')
            ? `Run completed. Open the related session to review all results.\n完整通知内容不应被截断。${'LongUnbrokenDetail'.repeat(20)}\nEnd of notification.`
            : 'A complete notification message',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          expiresAt: Date.now() + 60000,
          read: false,
          target: {
            targetType: 'WORKSPACE_SESSION',
            nodeId: 'node',
            workspaceId: 'workspace',
            sessionId: 'session'
          }
        }
      ]
    } as T;
  }
});
const compactCount = ref(0);
const canCompact = ref(true);
const hintDialogOpen = ref(false);
const following = ref(true);
const performanceVisible = ref(true);
const diagnostics = createWebPerformanceDiagnostics();
const hostedSnapshot = ref({
  conversation: {
    id: 'conversation',
    nodeId: 'node',
    sessionId: 'session',
    modelId: 'one',
    templateName: 'Template'
  },
  run: null,
  models: [
    { id: 'one', name: 'Model One' },
    { id: 'two', name: 'Model Two' }
  ]
});
const hostedWorkspace = {
  snapshot: hostedSnapshot,
  messageSubmitting: ref(false),
  messageSubmissionContext: ref(undefined),
  turns: ref([]),
  watchReady: ref(true),
  watchFailureCode: ref(undefined),
  updateConfiguration: async ({ modelId }: { modelId: string }) => {
    hostedSnapshot.value.conversation.modelId = modelId;
  }
} as unknown as ReturnType<typeof createHostedConversationWorkspaceService>;
const modelOptions = new URLSearchParams(location.search).has('model-options');
const modelEffortSelection = ref('model:one');
const selectedModel = ref('one');
const selectedEffort = ref('medium');
const toolbar = {
  draftSessionOpen: false,
  runner: 'mar-agent' as const,
  runnerOptions: [],
  runnerLoading: false,
  runnerLabel: 'MAR Agent',
  modelEffortSelection: undefined,
  modelEffortLabel: 'Model',
  selectedModel: '',
  selectedEffort: '',
  models: modelOptions
    ? [
        { id: 'one', label: 'Model One' },
        { id: 'two', label: 'Model Two' }
      ]
    : [],
  efforts: modelOptions ? ['medium', 'high'] : [],
  hideModelSelection: !modelOptions,
  access: 'auto',
  accessLabel: 'Auto',
  accessOptions: [],
  hideAccessSelection: true,
  configurationDisabled: false,
  accessDisabled: false,
  fastEnabled: false,
  contextUsage: { percentage: 42 },
  contextUsageLabel: '42% used; 42000 of 100000 tokens',
  mobileViewport: mobile,
  activeRun: undefined,
  canInterrupt: new URLSearchParams(location.search).has('interrupt'),
  interruptVisible: new URLSearchParams(location.search).has('interrupt'),
  inputHasContent: !new URLSearchParams(location.search).has('empty-input'),
  hasSelectedCommand: false,
  loading: false,
  attachmentsPending: false,
  effortLabel: String
};
const contextCommands = createWorkbenchContextCommandService({
  workspaceTarget: ref({ nodeId: 'node', workspaceId: 'workspace' }),
  selectedSession: computed(() => ({ id: 'session' }) as Session),
  compactCommand: computed(() => ({ id: 'compact' }) as RunnerCommand),
  canCompact: computed(() => canCompact.value),
  contextUsageLabel: computed(() => toolbar.contextUsageLabel),
  notice: () => {},
  request: async <T>() => ({}) as T,
  execute: async () => {
    compactCount.value++;
  },
  errorMessage: String,
  beginSubmission: () => () => true
});
const sessionPerformanceFixture = {
  setup: () => () =>
    h('main', { style: 'display: flex; flex-direction: column; height: 100dvh' }, [
      h(
        ConversationScroll,
        {
          hasOlder: false,
          loadingInitial: false,
          initialLoadFailed: false,
          loadingOlder: false,
          hasTurns: true,
          following: following.value,
          onLatest: () => (following.value = true)
        },
        {
          default: () => [
            h('div', { style: 'height: 900px' }, 'Reviewing Git diff output'),
            h('div', { 'data-testid': 'last-row', style: 'text-align: right' }, '4 files')
          ],
          status: () =>
            h(SessionPerformanceInfo, {
              performance: performanceVisible.value
                ? { runId: 'run', latencyMs: 420, tokensPerSecond: 42 }
                : undefined
            })
        }
      ),
      h(
        'button',
        { 'data-testid': 'leave-latest', onClick: () => (following.value = false) },
        'Read older messages'
      ),
      h(
        'button',
        { 'data-testid': 'hide-performance', onClick: () => (performanceVisible.value = false) },
        'Hide performance'
      )
    ])
};
const emptyConversationFixture = {
  setup() {
    const hasTurns = ref(false);
    const mode = new URLSearchParams(location.search).get('empty-conversation');
    return () =>
      h('main', { style: 'display: flex; flex-direction: column; height: 100dvh' }, [
        h('header', [
          h('button', { onClick: () => (hasTurns.value = true) }, 'Show first message')
        ]),
        h(
          ConversationScroll,
          {
            emptyPrompt: mode === 'workspace' ? 'workspace' : 'hosted',
            hasOlder: false,
            loadingInitial: false,
            initialLoadFailed: false,
            loadingOlder: false,
            hasTurns: hasTurns.value,
            following: true
          },
          { default: () => (hasTurns.value ? h('p', 'First message') : null) }
        ),
        h(HostedConversationComposer, {
          workspace: hostedWorkspace,
          connected: true,
          mobileViewport: mobile,
          readonly: false,
          readonlyReason: ''
        })
      ]);
  }
};
const app = createApp({
  setup: () => () =>
    h('main', { style: 'padding: 16px' }, [
      new URLSearchParams(location.search).has('menus') ? h(ThemeSettings) : null,
      new URLSearchParams(location.search).has('performance')
        ? h('section', { style: 'position: relative; width: 48px; height: 80px' }, [
            h(WebPerformanceIndicator, { diagnostics })
          ])
        : null,
      new URLSearchParams(location.search).has('hosted')
        ? h(HostedConversationComposer, {
            workspace: hostedWorkspace,
            mobileViewport: mobile,
            readonly: false,
            readonlyReason: ''
          })
        : null,
      h(WorkbenchNotificationCenter, {
        service,
        uploads: [],
        statusLabel: String,
        mobileMode: mobile,
        mobileOpen: mobileNotificationsOpen.value,
        mobilePresented: mobileNotificationsOpen.value,
        mobilePanelTarget: mobileNotificationPanelTarget.value,
        'onUpdate:mobileOpen': (open: boolean) => {
          mobileNotificationsOpen.value = open;
          if (open) void service.load();
        }
      }),
      mobile
        ? h('div', {
            ref: mobileNotificationPanelTarget,
            class: 'notification-fixture-drawer',
            hidden: !mobileNotificationsOpen.value,
            style:
              'position:fixed;z-index:40;top:60px;right:8px;bottom:8px;width:calc(100vw - 16px);max-width:390px;overflow-y:auto'
          })
        : null,
      h('section', { class: 'composer', style: 'margin-top: 32px' }, [
        h(ComposerToolbar, {
          ...toolbar,
          ...(modelOptions
            ? {
                modelEffortSelection: modelEffortSelection.value,
                selectedModel: selectedModel.value,
                selectedEffort: selectedEffort.value,
                onUpdateModelEffort: (value: string) => {
                  modelEffortSelection.value = value;
                  if (value.startsWith('model:')) selectedModel.value = value.slice(6);
                  else selectedEffort.value = value.slice(7);
                }
              }
            : {}),
          canCompactContext: canCompact.value,
          onCompact: () =>
            new URLSearchParams(location.search).has('context-confirm')
              ? contextCommands.compactCurrentContext()
              : compactCount.value++
        })
      ]),
      h('output', { 'data-testid': 'compact-count' }, compactCount.value),
      h('button', { onClick: () => (hintDialogOpen.value = true) }, 'Open hint dialog'),
      hintDialogOpen.value
        ? h(
            ElDialog,
            {
              modelValue: true,
              title: 'Hint dialog',
              'onUpdate:modelValue': (value: boolean) => (hintDialogOpen.value = value)
            },
            () =>
              withDirectives(h('button', {}, 'Dialog action'), [
                [resolveDirective('tooltip')!, 'Dialog action details']
              ])
          )
        : null,
      h(
        'button',
        {
          onClick: () => {
            canCompact.value = !canCompact.value;
          }
        },
        'Toggle availability'
      ),
      h(
        ElTable,
        {
          data: [{ name: 'A complete long table cell description that must remain readable' }],
          tooltipOptions: tableTooltipOptions,
          style: 'width: 180px'
        },
        () => h(ElTableColumn, { prop: 'name', showOverflowTooltip: true })
      ),
      h(MailTemplateManagement, {
        writable: true,
        request: async <T>(url: string) =>
          (url.endsWith('/preview')
            ? { subject: 'Preview', text: 'Preview message', html: '<p>Preview message</p>' }
            : ['One', 'Two'].map((name, index) => ({
                id: String(index),
                name,
                kind: 'NOTIFICATION',
                locale: 'en-US',
                subject: name,
                body: name,
                revision: 1,
                isDefault: true
              }))) as T
      })
    ])
});
const resourceDetailsFixture = {
  setup() {
    const open = ref(true);
    const waiting = ref(false);
    const refreshed = ref(0);
    return () =>
      h('main', [
        h('output', { 'data-testid': 'capability-refresh-count' }, String(refreshed.value)),
        h(NodeDetailsDialogs, {
          nodeOpen: open.value,
          workspaceOpen: false,
          usageOpen: false,
          node: { id: 'node', label: 'Fixture Node', connected: true, manageable: true },
          nodeRefreshable: true,
          usageDisabledReason: () => '',
          request: async () => ({ secrets: [] }),
          upgrade: {
            label: 'Upgrade',
            canUpgrade: !waiting.value,
            waitingForRuns: waiting.value,
            canCancelUpgrade: true
          },
          onUpgrade: () => {
            waiting.value = true;
          },
          onCancelUpgrade: () => {
            waiting.value = false;
          },
          onRefreshNode: () => {
            refreshed.value++;
          },
          'onUpdate:nodeOpen': (value: boolean) => {
            open.value = value;
          }
        })
      ]);
  }
};
(new URLSearchParams(location.search).has('empty-conversation')
  ? createApp(emptyConversationFixture)
  : new URLSearchParams(location.search).has('list-hierarchy')
    ? createApp(ListHierarchyFixture)
    : new URLSearchParams(location.search).has('utility-interaction')
      ? createApp(UtilityInteractionFixture)
      : new URLSearchParams(location.search).has('resource-details')
        ? createApp(resourceDetailsFixture)
        : new URLSearchParams(location.search).has('shared-tooltip')
          ? createApp(SharedTooltipFixture)
          : new URLSearchParams(location.search).has('loading-feedback')
            ? createApp(LoadingFeedbackFixture)
            : new URLSearchParams(location.search).has('session-performance')
              ? createApp(sessionPerformanceFixture)
              : app
)
  .use(i18n)
  .use(ElementPlus)
  .mount('#app');
