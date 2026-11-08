import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSSRApp, h, nextTick, ref, shallowReactive, toRaw } from 'vue';
import { renderToString } from 'vue/server-renderer';
import ElementPlus, { ID_INJECTION_KEY, ZINDEX_INJECTION_KEY } from 'element-plus';
import { i18n, localePreferenceService } from '../../src/service/locale-preference-service.js';
import WorkspaceGitChanges from '../../src/view/workspace/WorkspaceGitChanges.vue?unit-render';
import { renderComponent, textContent, trigger } from './support/component-renderer.js';
import type { WorkspaceWatchTopicStatus } from '../../src/service/workspace-watch-service.js';

vi.mock('../../src/view/workspace/FileTypeIcon.vue?unit-render', () => ({
  default: { render: () => null }
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function gitServiceFixture() {
  return {
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
    changesError: ref(false),
    changesFailureCause: ref<unknown>(new Error('Read failed')),
    changesFetchFailed: ref(false),
    restoringPath: ref(undefined),
    loadChanges: vi.fn(),
    retryChanges: vi.fn()
  };
}

it('appends only at the repository boundary inside the scroll root without a loading delay', async () => {
  const observers: {
    callback: IntersectionObserverCallback;
    options: IntersectionObserverInit | undefined;
    disconnect: ReturnType<typeof vi.fn>;
  }[] = [];
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        observers.push({ callback, options, disconnect: this.disconnect });
      }
      observe = vi.fn();
      disconnect = vi.fn();
    }
  );
  const service = gitServiceFixture();
  const root = service.repositories.value[0]!;
  service.repositories.value = [
    { ...root, changes: root.changes.slice(0, 300) },
    {
      ...root,
      repositoryPath: 'child',
      repositoryName: 'child',
      source: 'SUBMODULE',
      changes: root.changes.slice(300).map((entry) => ({
        ...entry,
        repositoryPath: 'child',
        repositoryName: 'child',
        source: 'SUBMODULE'
      }))
    }
  ];
  const view = renderComponent(WorkspaceGitChanges, {
    service,
    target: { nodeId: 'node', workspaceId: 'workspace' }
  });
  try {
    await nextTick();
    const rows = () => view.findAll('li').filter((node) => node.props.class === 'change-entry');
    const boundary = () =>
      view.findAll('li').find((node) => node.props.class === 'change-append-state');
    expect(rows()).toHaveLength(200);
    expect(boundary()?.parent).toBe(view.findAll('ul')[0]);
    expect(toRaw(observers[0]?.options?.root) === view.findAll('ul')[0]).toBe(true);
    const intersect = (index: number, isIntersecting = true) =>
      observers[index]!.callback(
        [{ isIntersecting } as IntersectionObserverEntry],
        {} as IntersectionObserver
      );
    intersect(0, false);
    expect(rows()).toHaveLength(200);
    intersect(0);
    await nextTick();
    expect(rows()).toHaveLength(400);
    expect(observers[0]?.disconnect).toHaveBeenCalled();
    intersect(0);
    await nextTick();
    expect(rows()).toHaveLength(400);
    service.repositories.value = [...service.repositories.value];
    await nextTick();
    expect(rows()).toHaveLength(200);
    expect(observers[1]?.disconnect).toHaveBeenCalled();
    intersect(1);
    await nextTick();
    expect(rows()).toHaveLength(200);
    intersect(observers.length - 1);
    await nextTick();
    expect(rows()).toHaveLength(400);
    intersect(observers.length - 1);
    await nextTick();
    expect(rows()).toHaveLength(450);
    expect(boundary()).toBeUndefined();
    expect(
      view.findAll('svg').some((node) => node.props['data-mar-icon'] === 'loading-action')
    ).toBe(false);
    service.repositories.value = [...service.repositories.value];
    await nextTick();
    expect(rows()).toHaveLength(200);
  } finally {
    view.unmount();
  }
  expect(observers.every((observer) => observer.disconnect.mock.calls.length > 0)).toBe(true);
});

it.each(['http', 'watch'] as const)(
  'shows %s initial reads in the same content state and refreshes in place',
  async (source) => {
    const service = gitServiceFixture();
    const repositories = service.repositories.value;
    service.repositories.value = [];
    const props = shallowReactive({
      service,
      target: undefined,
      watchStatus: 'ready' as WorkspaceWatchTopicStatus
    });
    if (source === 'http') service.changesRefreshing.value = true;
    else props.watchStatus = 'loading';
    const view = renderComponent(WorkspaceGitChanges, props);
    try {
      await nextTick();
      const statuses = () => view.findAll('div').filter((node) => node.props.role === 'status');
      expect(statuses()).toHaveLength(1);
      expect(statuses()[0]?.props.class).toBe('changes-read-state');
      expect(view.findAll('p').some((node) => node.props.class === 'empty')).toBe(false);
      service.repositories.value = repositories;
      await nextTick();
      expect(statuses()).toHaveLength(0);
      const refresh = view
        .findAll('button')
        .find(
          (node) =>
            node.props['aria-label'] ===
            i18n.global.t('generated.workspaceInspector.refreshGitChanges')
        )!;
      expect(refresh.props.disabled).toBe(true);
      expect(refresh.props['aria-busy']).toBe(true);
      let ancestor = refresh.parent;
      let insideScrollList = false;
      while (ancestor) {
        if (ancestor.props.class === 'change-list') insideScrollList = true;
        ancestor = ancestor.parent;
      }
      expect(insideScrollList).toBe(false);
      expect(
        refresh.children.some((node) => node.props['data-mar-icon'] === 'loading-action')
      ).toBe(true);
      expect(
        view.findAll('svg').filter((node) => node.props['data-mar-icon'] === 'loading-action')
      ).toHaveLength(1);
      service.changesRefreshing.value = false;
      props.watchStatus = 'ready';
      await nextTick();
      expect(statuses()).toHaveLength(0);
      expect(refresh.props.disabled).toBe(false);
      expect(refresh.children.some((node) => node.props['data-mar-icon'] === 'refresh')).toBe(true);
    } finally {
      view.unmount();
    }
  }
);

it.each(['http', 'watch'] as const)(
  'retries a failed %s read in place without duplicating busy indicators',
  async (source) => {
    const service = gitServiceFixture();
    service.changesError.value = source === 'http';
    const retryWatch = vi.fn();
    const props = shallowReactive({
      service,
      target: { nodeId: 'node', workspaceId: 'workspace' },
      watchStatus: (source === 'watch' ? 'failed' : 'ready') as WorkspaceWatchTopicStatus,
      onRetryWatch: retryWatch
    });
    const view = renderComponent(WorkspaceGitChanges, props);
    try {
      await nextTick();
      const retry = view
        .findAll('ElButton')
        .find((node) => textContent(node).includes(i18n.global.t('common.loadFailedRetry')))!;
      expect(retry.parent?.props.class).toBe('changes-read-state');
      await trigger(retry, 'onClick');
      expect(source === 'http' ? service.retryChanges : retryWatch).toHaveBeenCalledTimes(1);
      if (source === 'http') service.changesRefreshing.value = true;
      else props.watchStatus = 'loading';
      await nextTick();
      expect(view.findAll('ElButton').includes(retry)).toBe(true);
      expect(textContent(retry)).toContain(i18n.global.t('common.loadFailedRetry'));
      expect(retry.props['aria-busy']).toBe(true);
      expect(
        view.findAll('svg').filter((node) => node.props['data-mar-icon'] === 'loading-action')
      ).toHaveLength(1);
      await trigger(retry, 'onClick');
      expect(source === 'http' ? service.retryChanges : retryWatch).toHaveBeenCalledTimes(1);
      if (source === 'watch') {
        props.target = { nodeId: 'node', workspaceId: 'other-workspace' };
        await nextTick();
        expect(view.findAll('ElButton').includes(retry)).toBe(false);
      }
      service.changesError.value = false;
      service.changesRefreshing.value = false;
      props.watchStatus = 'ready';
      await nextTick();
      expect(view.findAll('ElButton').includes(retry)).toBe(false);
      service.changesRefreshing.value = true;
      await nextTick();
      expect(
        view.findAll('ElButton').filter((node) => node.parent?.props.class === 'changes-read-state')
      ).toHaveLength(0);
    } finally {
      view.unmount();
    }
  }
);

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
