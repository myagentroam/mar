import { defineAsyncComponent, h, ref } from 'vue';
import { createTooltipApp } from './tooltip-app.js';
import WorkspaceFilesPanel from '../../src/view/workspace/WorkspaceFilesPanel.vue';
import WorkspaceContentSearch from '../../src/view/workspace/WorkspaceContentSearch.vue';
import WorkspaceGitChanges from '../../src/view/workspace/WorkspaceGitChanges.vue';
import WorkspaceGitHistory from '../../src/view/workspace/WorkspaceGitHistory.vue';
import { createWorkspaceFilesController } from '../../src/service/workspace-files-controller.js';
import { createWorkspaceContentSearchService } from '../../src/service/workspace-content-search-service.js';
import { createWorkspaceGitService } from '../../src/service/workspace-git-service.js';
import { createScopedHttpService } from '../../src/service/scoped-http-service.js';
import { i18n, localePreferenceService } from '../../src/service/locale-preference-service.js';
import { themePreferenceService } from '../../src/service/theme-preference-service.js';
import type { WorkspaceFileTreeNode } from '../../src/service/workspace-file-tree-service.js';
import '../../src/styles.css';

const parameters = new URL(location.href).searchParams;
const scrollFeedback = parameters.has('scroll-feedback');
const rowStyles = parameters.has('row-styles');
localePreferenceService().setLocale(parameters.get('locale') === 'zh-CN' ? 'zh-CN' : 'en-US');
themePreferenceService().setTheme(parameters.get('theme') === 'daylight' ? 'daylight' : 'dark');
const target = { nodeId: 'node', workspaceId: 'workspace' };
const noop = () => {};
const http = createScopedHttpService();
const files = createWorkspaceFilesController({
  target: () => target,
  workspaceName: () => 'my-agent-roam',
  list: (_target, path) => http.request(`/api/fixture/files?path=${encodeURIComponent(path)}`),
  preflight: async () => [],
  queue: noop,
  onFailure: noop,
  onWorkspace: noop,
  onDeletedSelection: noop,
  onRevealSelection: async () => {},
  onMutationFailure: noop,
  mutate: async () => undefined,
  revealLocal: async () => {}
});
function treeNode(path: string, kind: 'FILE' | 'DIRECTORY'): WorkspaceFileTreeNode {
  return {
    path,
    name: path.split('/').at(-1)!,
    kind,
    size: null,
    children: [],
    expanded: true,
    loaded: true,
    loading: false,
    nextCursor: null,
    placeholder: false
  };
}
const source = treeNode('src', 'DIRECTORY');
const nested = treeNode('src/nested', 'DIRECTORY');
nested.children = [treeNode('src/nested/existing.ts', 'FILE')];
source.children = [treeNode('src/existing.ts', 'FILE'), nested];
if (rowStyles) {
  nested.expanded = false;
} else {
  nested.failedAppend = true;
  source.failedAppend = false;
}
files.tree.root.value.loaded = true;
files.tree.root.value.children = scrollFeedback
  ? Array.from({ length: 60 }, (_, index) => treeNode(`file-${index}.ts`, 'FILE'))
  : rowStyles
    ? [
        { ...treeNode('scripts', 'DIRECTORY'), expanded: false },
        source,
        treeNode('README.md', 'FILE'),
        treeNode('package.json', 'FILE')
      ]
    : [source];
const watchStatus = ref<'ready' | 'failed'>('ready');
const changesWatchStatus = ref<'ready' | 'loading'>('ready');
const search = createWorkspaceContentSearchService({ http, onFailure: noop });
void search.search({ ...target, query: 'workspace', useRegex: false });
function gitService() {
  return createWorkspaceGitService({
    http,
    target: () => target,
    gitEnabled: () => true,
    historyEnabled: () => true,
    onFailure: noop,
    onWorkspace: noop,
    onBranch: noop
  });
}
const git = gitService();
void git.loadChanges(scrollFeedback);
void git.loadHistory(true, scrollFeedback);
const commitFiles = gitService();
commitFiles.restore({
  changes: {},
  historyRepositoryPath: '',
  selectedHistoryRefs: [],
  historyNextCursor: null,
  historyCommits: [
    {
      hash: 'fixture-commit',
      parents: [],
      subject: 'Update workspace files',
      authorName: 'Developer',
      authorEmail: 'dev@example.test',
      committedAt: 1,
      refs: []
    }
  ]
});
function panel(name: string, content: ReturnType<typeof h>) {
  return h('section', { class: 'inspector-fixture-panel', 'data-testid': name }, [
    h('h2', name),
    content
  ]);
}
const RefreshActionsFixture = defineAsyncComponent(() => import('./refresh-actions-fixture.vue'));
createTooltipApp({
  render: () => {
    if (parameters.has('refresh-controls')) return h(RefreshActionsFixture);
    return h('main', { class: 'inspector-read-fixture' }, [
      panel(
        'Files',
        h(WorkspaceFilesPanel, {
          service: files,
          visible: true,
          mobileViewport: innerWidth < 768,
          watchStatus: watchStatus.value,
          onRefresh: files.requestRefresh,
          onRetryWatch: () => {
            watchStatus.value = 'ready';
          }
        })
      ),
      panel('Search', h(WorkspaceContentSearch, { service: search, enabled: true, ...target })),
      panel(
        'Git Changes',
        h(WorkspaceGitChanges, { service: git, target, watchStatus: changesWatchStatus.value })
      ),
      panel('Git History', h(WorkspaceGitHistory, { service: git })),
      panel('Commit files', h(WorkspaceGitHistory, { service: commitFiles })),
      scrollFeedback
        ? h(
            'button',
            { onClick: () => (changesWatchStatus.value = 'loading') },
            'Load Git Changes Watch'
          )
        : null,
      h(
        'button',
        {
          onClick: () => {
            watchStatus.value = 'failed';
          }
        },
        'Fail Files Watch'
      ),
      h(
        'button',
        {
          onClick: () => {
            files.tree.refreshError.value = { cause: new Error('offline') };
          }
        },
        'Fail Files refresh'
      )
    ]);
  }
})
  .use(i18n)
  .mount('#app');

const style = document.createElement('style');
style.textContent = `
  body { margin: 0; background: var(--mar-bg-app); color: var(--mar-text-primary); }
  .inspector-read-fixture { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; padding: 12px; }
  .inspector-fixture-panel { display: flex; flex-direction: column; height: 280px; min-width: 0; background: var(--mar-bg-panel); border: 1px solid var(--mar-border-default); }
  .inspector-fixture-panel h2 { margin: 0; padding: 8px; font-size: var(--mar-font-size-body); border-bottom: 1px solid var(--mar-border-default); }
  @media(max-width:767px) { .inspector-read-fixture { grid-template-columns: minmax(0, 1fr); } }
`;
document.head.append(style);
