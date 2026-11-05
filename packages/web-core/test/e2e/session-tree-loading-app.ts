import { defineComponent, h, nextTick, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import type {
  NavigationSession,
  NavigationSnapshot
} from '../../src/service/session-navigation-projection.js';
import { consoleKeyboardShortcutService } from '../../src/service/console-keyboard-shortcut-service.js';
import { i18n, localePreferenceService } from '../../src/service/locale-preference-service.js';
import { themePreferenceService } from '../../src/service/theme-preference-service.js';
import WorkspaceSessionTreePopover from '../../src/view/workspace/WorkspaceSessionTreePopover.vue';
import { createTooltipApp } from './tooltip-app.js';
import 'element-plus/theme-chalk/dark/css-vars.css';
import '../../src/styles.css';

type TreeStatus = 'idle' | 'loading' | 'ready' | 'failed';

declare global {
  interface Window {
    sessionTreeLoadingFixture: {
      ready: () => void;
      fail: () => void;
    };
  }
}

const query = new URLSearchParams(location.search);
localePreferenceService().setLocale('en-US');
themePreferenceService().setTheme(query.get('theme') === 'dark' ? 'vscode-dark-2026' : 'daylight');

function makeTree(): NonNullable<NavigationSnapshot['tree']> {
  const now = Date.now();
  const session = (
    id: string,
    parentSessionId: string,
    title: string,
    status: NavigationSession['status'],
    lastActivityAt: number
  ): NavigationSession => ({
    id,
    parentSessionId,
    title,
    runner: 'codex',
    activity: '',
    status,
    lastActivityAt
  });
  const siblings = [
    session('sleeping-newer', 'tree-root', 'Sleeping newer', 'SLEEPING', now - 10_000),
    session('running-older', 'tree-root', 'Running older', 'RUNNING', now - 60_000),
    session('idle-ancestor', 'tree-root', 'Idle ancestor', 'IDLE', now - 120_000),
    ...Array.from({ length: 96 }, (_, index) => {
      const suffix = String(index).padStart(3, '0');
      return session(`idle-${suffix}`, 'tree-root', `Idle ${suffix}`, 'IDLE', 0);
    })
  ];
  const activeChild = session(
    'active-child',
    'idle-ancestor',
    'Active child',
    'RUNNING',
    now - 5_000
  );
  return {
    anchorSessionId: 'tree-root',
    parent: query.has('parent')
      ? session('tree-parent', 'tree-grandparent', 'Parent session', 'IDLE', 0)
      : null,
    // The child may precede its parent in the Node payload; the view must still rebuild the branch.
    nodes: [activeChild, ...siblings],
    truncated: false
  };
}

const FixtureApp = defineComponent({
  setup() {
    const anchor = ref<HTMLButtonElement>();
    const open = ref(true);
    const status = ref<TreeStatus>('loading');
    const tree = shallowRef<NavigationSnapshot['tree']>();
    const retryCount = ref(0);
    const closeRestoredFocus = ref('');
    const ready = () => {
      tree.value = makeTree();
      status.value = 'ready';
    };
    const fail = () => {
      tree.value = undefined;
      status.value = 'failed';
    };
    window.sessionTreeLoadingFixture = { ready, fail };
    onMounted(() => {
      document.addEventListener('keydown', consoleKeyboardShortcutService.handle, {
        capture: true
      });
    });
    onBeforeUnmount(() => {
      document.removeEventListener('keydown', consoleKeyboardShortcutService.handle, {
        capture: true
      });
      delete (window as Partial<Window>).sessionTreeLoadingFixture;
    });

    return () =>
      h(
        'main',
        {
          style: {
            minHeight: '100vh',
            boxSizing: 'border-box',
            padding: '40px 24px',
            color: 'var(--mar-text-primary)',
            background: 'var(--mar-bg-page)'
          }
        },
        [
          h(
            'button',
            {
              ref: anchor,
              type: 'button',
              'data-testid': 'tree-anchor',
              'aria-expanded': String(open.value),
              style: {
                padding: '0.35rem 0.6rem',
                color: 'var(--mar-text-primary)',
                background: 'var(--mar-bg-panel)',
                border: '1px solid var(--mar-border-subtle)',
                borderRadius: 'var(--mar-radius-control)'
              },
              onClick: () => {
                open.value = !open.value;
              }
            },
            'Toggle session tree'
          ),
          h(
            'output',
            { 'data-testid': 'retry-count', style: { display: 'none' } },
            String(retryCount.value)
          ),
          h(
            'output',
            { 'data-testid': 'close-restored-focus', style: { display: 'none' } },
            closeRestoredFocus.value
          ),
          anchor.value && open.value
            ? h(WorkspaceSessionTreePopover, {
                anchor: anchor.value,
                sessionId: 'tree-root',
                title: 'View session tree',
                tree: tree.value,
                status: status.value,
                mainSessionId: 'running-older',
                asideSessionIds: [],
                onClose: (restoreFocus: boolean) => {
                  closeRestoredFocus.value = String(restoreFocus);
                  open.value = false;
                  if (restoreFocus) void nextTick(() => anchor.value?.focus());
                },
                onRetry: () => {
                  retryCount.value += 1;
                  tree.value = undefined;
                  status.value = 'loading';
                }
              })
            : null
        ]
      );
  }
});

createTooltipApp(FixtureApp).use(i18n).mount('#app');
