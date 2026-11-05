import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSSRApp, h, nextTick, ref } from 'vue';
import { renderToString } from 'vue/server-renderer';
import ElementPlus, { ID_INJECTION_KEY, ZINDEX_INJECTION_KEY } from 'element-plus';
import { i18n, localePreferenceService } from '../../src/service/locale-preference-service.js';
import WorkspaceGitChanges from '../../src/view/workspace/WorkspaceGitChanges.vue?unit-render';
import { renderComponent } from './support/component-renderer.js';

vi.mock('../../src/view/workspace/FileTypeIcon.vue?unit-render', () => ({
  default: { render: () => null }
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('automatically appends Git changes after the loading delay and disconnects the observer', async () => {
  vi.useFakeTimers();
  let intersect: IntersectionObserverCallback | undefined;
  const disconnect = vi.fn();
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: IntersectionObserverCallback) {
        intersect = callback;
      }
      observe = vi.fn();
      disconnect = disconnect;
    }
  );
  const service = {
    repositories: ref([
      {
        repositoryPath: '',
        repositoryName: 'root',
        source: 'ROOT',
        current: true,
        branch: 'main',
        locked: false,
        prunable: false,
        changes: Array.from({ length: 450 }, (_, index) => ({
          repositoryPath: '',
          repositoryName: 'root',
          source: 'ROOT',
          path: `file-${index}.ts`,
          state: 'UNSTAGED',
          change: 'MODIFIED',
          diffAvailable: true
        }))
      }
    ]),
    worktrees: ref([]),
    worktreesTruncated: ref(false),
    discoveryErrors: ref([]),
    changesRefreshing: ref(false),
    changesError: ref(undefined),
    changesFetchFailed: ref(false),
    restoringPath: ref(undefined),
    loadChanges: vi.fn()
  };
  const view = renderComponent(WorkspaceGitChanges, {
    service,
    target: { nodeId: 'node', workspaceId: 'workspace' }
  });
  try {
    await nextTick();
    const rows = () => view.findAll('li').filter((node) => node.props.class === 'change-entry');
    const boundary = () =>
      view.findAll('div').find((node) => node.props.class === 'change-append-state');
    expect(rows()).toHaveLength(200);
    const initialBoundary = boundary();
    expect(initialBoundary).toBeDefined();
    expect(intersect).toBeDefined();
    intersect!([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    await nextTick();
    expect(rows()).toHaveLength(200);
    expect(boundary()).toBe(initialBoundary);
    expect(view.findAll('span').some((node) => node.props.role === 'status')).toBe(true);
    await vi.advanceTimersByTimeAsync(99);
    expect(rows()).toHaveLength(200);
    await vi.advanceTimersByTimeAsync(1);
    await nextTick();
    expect(rows()).toHaveLength(400);
    expect(disconnect).toHaveBeenCalled();
  } finally {
    view.unmount();
  }
});

describe.each(['zh-CN', 'en-US'] as const)('Git changes in %s', (locale) => {
  it('renders Git worktree status in the selected locale', async () => {
    localePreferenceService().setLocale(locale);
    const service = {
      repositories: ref([
        {
          repositoryPath: '',
          repositoryName: 'project',
          source: 'ROOT',
          current: true,
          branch: 'main',
          locked: false,
          prunable: false,
          changes: Array.from({ length: 450 }, (_, index) => ({
            repositoryPath: '',
            repositoryName: 'project',
            source: 'ROOT',
            path: `src/file-${index}.ts`,
            state: 'UNSTAGED',
            change: 'MODIFIED',
            diffAvailable: true
          }))
        },
        {
          repositoryPath: 'limited',
          repositoryName: 'limited',
          source: 'SUBMODULE',
          current: false,
          branch: 'main',
          locked: false,
          prunable: false,
          changesTruncated: true,
          changes: []
        }
      ]),
      worktrees: ref([
        {
          directoryName: 'linked',
          branch: 'feature/test',
          head: 'a'.repeat(40),
          current: false,
          status: 'CLEAN',
          locked: false,
          prunable: false
        }
      ]),
      worktreesTruncated: ref(false),
      discoveryErrors: ref([]),
      changesRefreshing: ref(false),
      changesError: ref(undefined),
      changesFetchFailed: ref(false),
      restoringPath: ref(undefined),
      loadChanges: vi.fn(async () => undefined)
    };
    const app = createSSRApp({
      render: () => h(WorkspaceGitChanges, { service: service as never, target: undefined })
    });
    app.directive('tooltip', {});
    app.use(i18n);
    app.use(ElementPlus);
    app.provide(ID_INJECTION_KEY, { prefix: 400, current: 0 });
    app.provide(ZINDEX_INJECTION_KEY, { current: 0 });
    const html = await renderToString(app);
    expect(html).toContain('linked');
    expect(html).toContain('feature/test');
    expect(html).toContain(i18n.global.t('gitWorktrees.title'));
    expect(html).toContain(i18n.global.t('gitWorktrees.clean'));
    expect(html.match(/class="change-entry"/gu)).toHaveLength(200);
    expect(html).toContain('class="change-append-state"');
    expect(html).not.toContain(i18n.global.t('generated.workspaceInspector.loadMore'));
    expect(html).toContain(i18n.global.t('gitWorktrees.changesTruncated'));
    expect(html).not.toContain(i18n.global.t('generated.workspaceInspector.noUncommittedChanges'));
  });
});
