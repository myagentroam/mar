import { defineComponent, h, nextTick, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import { createTooltipApp } from './tooltip-app.js';
import { uploadLimitMessage } from './support/localized-fixture-data.js';
import { consoleKeyboardShortcutService } from '../../src/service/console-keyboard-shortcut-service.js';
import {
  i18n,
  localePreferenceService,
  translate
} from '../../src/service/locale-preference-service.js';
import { themePreferenceService } from '../../src/service/theme-preference-service.js';
import { MarMessageBox } from '../../src/service/message-box-service.js';
import type { Session } from '../../src/model/workbench.js';
import type {
  NavigationSession,
  NavigationSnapshot
} from '../../src/service/session-navigation-projection.js';
import Header from '../../src/view/conversation/ConversationHeader.vue';
import TreeButton from '../../src/view/workspace/WorkspaceSessionTreeButton.vue';
import TreePopover from '../../src/view/workspace/WorkspaceSessionTreePopover.vue';
import '../../src/styles.css';

const query = new URLSearchParams(location.search);
const rootOnly = query.get('rootOnly') === '1';
const sleepingOnly = query.has('sleeping-only');
localePreferenceService().setLocale(query.get('locale') === 'zh-CN' ? 'zh-CN' : 'en-US');
themePreferenceService().setTheme(query.get('theme') === 'dark' ? 'vscode-dark-2026' : 'daylight');
const session = {
  id: query.has('long-id') ? 'session-'.repeat(40) : rootOnly ? 'parent' : 'child',
  externalSessionId: rootOnly ? 'parent' : 'child',
  runner: 'mar-agent',
  sessionGroup: rootOnly ? 'MAIN' : 'CHILD'
} as Session;
const title =
  query.get('title') ??
  (query.has('long-title')
    ? 'Review BMP compatibility changes and lifecycle edge cases '.repeat(8).trim()
    : 'Review BMP compatibility changes and lifecycle edge cases');
const makeNode = (
  id: string,
  parentSessionId: string | null,
  nodeTitle: string,
  status: NavigationSession['status'] = 'IDLE',
  lastActivityAt = 0
): NavigationSession => ({
  id,
  parentSessionId,
  title: nodeTitle,
  status,
  lastActivityAt,
  runner: 'mar-agent',
  activity: ''
});
function makeTree(): NonNullable<NavigationSnapshot['tree']> {
  const now = Date.now();
  const anchor = session.id;
  const parent =
    rootOnly || query.has('mixed') || query.has('long')
      ? null
      : makeNode('parent', null, uploadLimitMessage, 'IDLE', now - 12 * 60_000);
  const nodes = rootOnly
    ? []
    : query.has('long')
      ? Array.from({ length: 100 }, (_, index) =>
          makeNode(`node-${index}`, index === 0 ? anchor : `node-${index - 1}`, `Node ${index}`)
        )
      : query.has('mixed')
        ? [
            makeNode('running', anchor, 'Running branch', 'RUNNING'),
            makeNode('sleeping', anchor, 'Sleeping branch', 'SLEEPING'),
            makeNode('idle-branch', anchor, 'Idle branch'),
            makeNode('grandchild', 'idle-branch', 'Active descendant', 'RUNNING'),
            makeNode('idle', anchor, 'Idle leaf'),
            makeNode('idle-two', anchor, 'Idle leaf two')
          ]
        : [
            makeNode(
              'grandchild',
              anchor,
              'Verify image decoding and cleanup',
              query.has('activity') ? 'SLEEPING' : 'IDLE',
              now - 5 * 60_000
            ),
            makeNode(
              'great-grandchild',
              'grandchild',
              'Review child compatibility',
              query.has('activity') ? (sleepingOnly ? 'SLEEPING' : 'RUNNING') : 'IDLE',
              now - 20_000
            ),
            makeNode(
              'another-child',
              anchor,
              'Review upload boundary tests and verify image compatibility. '.repeat(6).trim(),
              'IDLE',
              now - 2 * 3_600_000
            )
          ];
  return { anchorSessionId: anchor, parent, nodes, truncated: false };
}

createTooltipApp(
  defineComponent({
    setup() {
      const anchor = shallowRef<HTMLElement>();
      const open = ref(false);
      const status = ref<'idle' | 'loading' | 'ready' | 'failed'>('idle');
      const tree = shallowRef<NavigationSnapshot['tree']>();
      const requests = ref(0);
      const selected = ref('');
      const target = ref('');
      function ready() {
        tree.value = makeTree();
        status.value = 'ready';
      }
      function fail() {
        tree.value = undefined;
        status.value = 'failed';
      }
      function read() {
        requests.value++;
        tree.value = undefined;
        status.value = 'loading';
        if (query.has('pending') || (query.has('delayed') && requests.value === 1)) return;
        if (query.has('failure') && requests.value === 1) fail();
        else ready();
      }
      function show(_id: string, element: HTMLElement) {
        if (open.value) {
          open.value = false;
          return;
        }
        anchor.value = element;
        open.value = true;
        if (status.value === 'idle') read();
      }
      onMounted(() =>
        document.addEventListener('keydown', consoleKeyboardShortcutService.handle, {
          capture: true
        })
      );
      onBeforeUnmount(() =>
        document.removeEventListener('keydown', consoleKeyboardShortcutService.handle, {
          capture: true
        })
      );
      return () =>
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
                h(TreeButton, {
                  sessionId: session.id,
                  open: open.value,
                  status: status.value === 'idle' ? 'ready' : status.value,
                  summary: query.has('activity')
                    ? {
                        anchorSessionId: session.id,
                        descendantCount: 3,
                        activeCount: 2,
                        runningCount: sleepingOnly ? 0 : 1,
                        sleepingCount: sleepingOnly ? 2 : 1,
                        hasActiveDescendants: true
                      }
                    : undefined,
                  onShow: show
                })
            }
          ),
          anchor.value
            ? h(TreePopover, {
                visible: open.value,
                anchor: anchor.value,
                placement: 'bottom-end',
                sessionId: session.id,
                title: translate('sessionGroups.tree'),
                tree: tree.value,
                status: status.value,
                mainSessionId: 'grandchild',
                asideSessionIds: [],
                onAfterLeave: () => {
                  if (!open.value) anchor.value = undefined;
                },
                onClose: (restoreFocus: boolean) => {
                  open.value = false;
                  if (restoreFocus) void nextTick(() => anchor.value?.focus());
                },
                onOpen: (id: string, pane: 'aside' | 'main') => {
                  selected.value = id;
                  target.value = pane;
                  open.value = false;
                },
                onRetry: read
              })
            : null,
          h('output', { 'data-testid': 'selected' }, selected.value),
          h('output', { 'data-testid': 'target' }, target.value),
          h('output', { 'data-testid': 'requests' }, requests.value),
          query.has('confirmation')
            ? h(
                'button',
                {
                  'data-testid': 'show-confirmation',
                  onClick: () => {
                    void MarMessageBox.confirm('Fixture confirmation', 'Confirmation').catch(
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
                  { 'data-testid': 'resolve-snapshot', onClick: ready },
                  'Resolve snapshot'
                ),
                h('button', { 'data-testid': 'reject-snapshot', onClick: fail }, 'Reject snapshot')
              ])
            : null
        ]);
    }
  })
)
  .use(i18n)
  .mount('#app');
