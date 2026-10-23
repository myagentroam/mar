import { createTooltipApp as createApp } from './tooltip-app.js';
import type { createHostedConversationWorkspaceService } from '../../src/service/HostedConversationWorkspaceService.js';
import { h, ref, resolveDirective, withDirectives } from 'vue';
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
import SessionPerformanceInfo from '../../src/view/conversation/SessionPerformanceInfo.vue';
import { createWebPerformanceDiagnostics } from '../../src/service/WebPerformanceDiagnosticService.js';
import WorkbenchNotificationCenter from '../../src/view/workbench/WorkbenchNotificationCenter.vue';
import MailTemplateManagement from '../../src/view/settings/MailTemplateManagement.vue';
import { createWorkbenchNotificationService } from '../../src/service/WorkbenchNotificationService.js';
import { i18n, localePreferenceService } from '../../src/service/LocalePreferenceService.js';
import { themePreferenceService } from '../../src/service/ThemePreferenceService.js';

const mobile = new URLSearchParams(location.search).has('mobile');
localePreferenceService().setLocale('en-US');
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
  models: [],
  efforts: [],
  hideModelSelection: true,
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
  canInterrupt: false,
  interruptVisible: false,
  inputHasContent: true,
  hasSelectedCommand: false,
  loading: false,
  attachmentsPending: false,
  effortLabel: String
};
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
        mobileMode: mobile
      }),
      h('section', { class: 'composer', style: 'margin-top: 32px' }, [
        h(ComposerToolbar, {
          ...toolbar,
          canCompactContext: canCompact.value,
          onCompact: () => compactCount.value++
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
(new URLSearchParams(location.search).has('shared-tooltip')
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
