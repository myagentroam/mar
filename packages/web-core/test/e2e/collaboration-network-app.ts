import { computed, defineComponent, h, ref } from 'vue';
import type {
  NavigationSession,
  NavigationSnapshot
} from '../../src/service/session-navigation-projection.js';
import { i18n, localePreferenceService } from '../../src/service/locale-preference-service.js';
import { themePreferenceService } from '../../src/service/theme-preference-service.js';
import WorkspaceCollaborationDialog from '../../src/view/workspace/WorkspaceCollaborationDialog.vue';
import WorkspaceSessionTreeButton from '../../src/view/workspace/WorkspaceSessionTreeButton.vue';
import { createTooltipApp } from './tooltip-app.js';
import '../../src/styles.css';

const query = new URLSearchParams(location.search);
localePreferenceService().setLocale('zh-CN');
themePreferenceService().setTheme(query.get('theme') === 'daylight' ? 'daylight' : 'dark');

function session(
  id: string,
  title: string,
  parentSessionId: string | null = null
): NavigationSession {
  return {
    id,
    title,
    parentSessionId,
    runner: 'mar-agent',
    activity: 'IDLE',
    status: 'IDLE',
    lastActivityAt: 0
  };
}

const anchor = session(
  'release-current',
  query.has('longTitles')
    ? '发布协调：同步跨工作区的端到端验证结果和最终确认记录'.repeat(4)
    : '发布协调',
  'release-parent'
);
const parent: NavigationSession = { ...session('release-parent', '发布计划'), runner: 'codex' };
const branches = ['依赖检查', '文档更新', '回归测试', '制品构建', '集成验收'].map((title, i) =>
  session(
    `branch-${i}`,
    i === 2 && query.has('longTitles')
      ? '回归测试：核对跨浏览器发布结果与最终确认记录'.repeat(3)
      : title,
    anchor.id
  )
);
const checks = ['准备', '执行', '复核', '归档'];
const nodes = [
  ...branches,
  ...branches.flatMap((node) =>
    checks.map((title, i) => session(`${node.id}-${i}`, `${node.title} · ${title}`, node.id))
  ),
  session('final-verification', '发布前冒烟', 'branch-2-1')
];
const peers = [
  session('peer-a', '安全审查'),
  session('peer-b', '发布观察'),
  session('peer-c', '依赖维护')
];
const snapshot: NavigationSnapshot = {
  nodeId: 'node',
  workspaceId: 'workspace',
  sessions: [],
  summaries: [],
  missingSessionIds: [],
  tree: { anchorSessionId: anchor.id, parent, nodes, truncated: false },
  collaboration: {
    anchor,
    peers,
    truncated: query.has('truncated'),
    sharing: [
      { ownerSessionId: anchor.id, followerSessionId: 'branch-2' },
      { ownerSessionId: anchor.id, followerSessionId: 'peer-a' },
      { ownerSessionId: 'peer-a', followerSessionId: anchor.id },
      { ownerSessionId: anchor.id, followerSessionId: 'peer-b' },
      { ownerSessionId: 'peer-c', followerSessionId: 'branch-3' },
      { ownerSessionId: 'branch-2', followerSessionId: 'branch-2-0' }
    ]
  }
};

const Fixture = defineComponent({
  setup() {
    const open = ref(false);
    const board = ref<string>();
    const opened = ref<string>();
    const entry = ref(anchor);
    const aside = ref<NavigationSession>();
    const detached = ref(false);
    const status = ref<'loading' | 'ready' | 'failed'>('ready');
    const family = [anchor, parent, ...nodes];
    const sessions = [...family, ...peers];
    const view = computed<NavigationSnapshot>(() => ({
      ...snapshot,
      tree: {
        anchorSessionId: entry.value.id,
        parent: family.find(({ id }) => id === entry.value.parentSessionId) ?? null,
        nodes: family.filter(
          ({ id }) => id !== entry.value.id && id !== entry.value.parentSessionId
        ),
        truncated: false
      },
      collaboration: {
        ...snapshot.collaboration!,
        anchor: entry.value,
        ...(detached.value
          ? {
              peers: peers.filter(({ id }) => id !== 'peer-a'),
              sharing: snapshot.collaboration!.sharing.filter(
                ({ ownerSessionId, followerSessionId }) =>
                  ownerSessionId !== 'peer-a' && followerSessionId !== 'peer-a'
              )
            }
          : {}),
        ...(board.value === undefined
          ? {}
          : {
              board: {
                sessionId: board.value,
                title: sessions.find(({ id }) => id === board.value)!.title,
                revision: 1,
                entries:
                  board.value === 'peer-a'
                    ? [{ id: 'review', content: '核对权限审查的结论。' }]
                    : board.value === anchor.id
                      ? [
                          { id: 'w1', content: '发布前先核对回归结果。' },
                          { id: 'w2', content: '文档与制品使用同一版本。' }
                        ]
                      : [],
                recentChanges: [
                  {
                    revision: 1,
                    actorTitle: '回归测试',
                    at: Date.UTC(2026, 10, 26, 6, 32),
                    summary: 'Added 2 entries'
                  }
                ]
              }
            })
      }
    }));
    window.addEventListener('fixture-board-detached', () => (detached.value = true));
    window.addEventListener('fixture-board-failed', () => (status.value = 'failed'));
    window.addEventListener('fixture-board-recovered', () => (status.value = 'ready'));
    const trigger = (session: NavigationSession) =>
      h(WorkspaceSessionTreeButton, {
        collaboration: true,
        sessionId: session.id,
        open: open.value && entry.value.id === session.id,
        status: 'ready',
        onShow: () => {
          entry.value = session;
          board.value = session.id;
          open.value = true;
        }
      });
    return () =>
      h('main', { style: 'margin: 2rem; max-width: 68rem' }, [
        h(
          'header',
          {
            style:
              'display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--mar-border-subtle)'
          },
          [h('h1', anchor.title), trigger(anchor)]
        ),
        h('p', '请检查依赖、文档与回归测试，准备发布。'),
        opened.value ? h('p', { role: 'status' }, opened.value) : null,
        aside.value
          ? h('aside', { 'aria-label': 'Aside' }, [
              h('h2', aside.value.title),
              trigger(aside.value)
            ])
          : null,
        open.value
          ? h(WorkspaceCollaborationDialog, {
              anchor: entry.value.id,
              title: entry.value.title,
              snapshot: view.value,
              status: status.value,
              canRetry: status.value === 'failed',
              onRetry: () => (status.value = 'loading'),
              onClose: () => {
                open.value = false;
                board.value = undefined;
              },
              onBoard: (id: string | undefined) => (board.value = id),
              onOpen: (id: string, target: 'main' | 'aside') => {
                opened.value = `${target}: ${id}`;
                if (target === 'aside') aside.value = sessions.find((session) => session.id === id);
                open.value = false;
              }
            })
          : null
      ]);
  }
});

createTooltipApp(Fixture).use(i18n).mount('#app');
