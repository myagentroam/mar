import { createSSRApp, h, type Component } from 'vue';
import { renderToString } from 'vue/server-renderer';
import ElementPlus, { ID_INJECTION_KEY, ZINDEX_INJECTION_KEY } from 'element-plus';
import { afterEach, describe, expect, it, vi } from 'vitest';
import LoadingPanel from '../../src/view/common/LoadingPanel.vue';
import BusyIndicator from '../../src/view/common/BusyIndicator.vue';
import ManagementPagination from '../../src/view/settings/ManagementPagination.vue';
import McpCenterPanel from '../../src/view/skill/McpCenterPanel.vue?unit-render';
import SkillCenterPage from '../../src/view/skill/SkillCenterPage.vue?unit-render';
import { i18n } from '../../src/service/locale-preference-service.js';
import { showMessage } from '../../src/service/message-feedback-service.js';
import { flushComponent, renderComponent, textContent } from './support/component-renderer.js';

vi.mock('../../src/service/message-feedback-service.js', () => ({ showMessage: vi.fn() }));

const originalLocale = i18n.global.locale.value;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.mocked(showMessage).mockClear();
  i18n.global.locale.value = originalLocale;
});

async function render(
  component: Component,
  props: Record<string, unknown>,
  content?: string
): Promise<string> {
  const app = createSSRApp({
    render: () => h(component, props, content ? () => h('input', { value: content }) : undefined)
  });
  app.use(ElementPlus);
  app.directive('tooltip', { getSSRProps: () => ({}) });
  app.provide(ID_INJECTION_KEY, { prefix: 700, current: 0 });
  app.provide(ZINDEX_INJECTION_KEY, { current: 0 });
  return renderToString(app);
}

describe('shared loading presentation', () => {
  it.each(['page', 'region'] as const)(
    'preserves content, caller attributes and busy semantics for %s',
    async (variant) => {
      for (const loading of [true, false]) {
        const html = await render(
          LoadingPanel,
          { variant, loading, 'aria-label': 'Retained content' },
          'Draft value'
        );
        expect(html).toContain('value="Draft value"');
        expect(html).toContain('aria-label="Retained content"');
        expect(html).toContain(`aria-busy="${loading}"`);
        expect(html.includes('element-loading-custom-class="mar-page-loading"')).toBe(
          variant === 'page'
        );
      }
    }
  );

  it('keeps the shared ring decorative rather than creating an interactive or duplicate status', async () => {
    const html = await render(BusyIndicator, {});
    expect(html).toContain('class="busy-indicator"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toMatch(/\b(?:tabindex|role)=/u);
  });

  it('uses one accessible ring without a manual action for automatic management append', async () => {
    const html = await render(ManagementPagination, {
      total: 60,
      page: 1,
      mobile: true,
      mobileVisibleCount: 20,
      loading: true,
      loadingMore: true,
      hasMore: true
    });
    expect(html.match(/class="[^"]*\bbusy-indicator\b[^"]*"/gu)).toHaveLength(1);
    expect(html).toContain('role="status"');
    expect(html).not.toContain('<button');
    expect(html).not.toMatch(/\bis-loading\b/u);
  });

  it('disables desktop page controls without incremental feedback during a page request', async () => {
    const html = await render(ManagementPagination, {
      total: 60,
      page: 1,
      mobile: false,
      mobileVisibleCount: 20,
      loading: true,
      hasMore: true
    });
    expect(html).not.toContain('busy-indicator');
    expect(html).toContain('el-pagination');
    const controls = html.match(/<button\b[^>]*>/gu) ?? [];
    expect(controls).toHaveLength(2);
    for (const control of controls) expect(control).toMatch(/\sdisabled(?:[=>\s])/u);
  });

  it('does not duplicate mobile refresh feedback or expose a manual append action', async () => {
    const html = await render(ManagementPagination, {
      total: 60,
      page: 1,
      mobile: true,
      mobileVisibleCount: 20,
      loading: true,
      loadingMore: false,
      hasMore: true
    });
    expect(html).not.toContain('<button');
    expect(html).not.toContain('busy-indicator');
    expect(html).not.toMatch(/\bis-loading\b/u);
  });

  it('keeps only the retry ring while retrying a mobile append', async () => {
    i18n.global.locale.value = 'en-US';
    const props = {
      total: 60,
      page: 1,
      mobile: true,
      mobileVisibleCount: 20,
      hasMore: true,
      failed: true,
      incrementalFailed: true,
      error: new Error('List request failed')
    };
    const failed = await render(ManagementPagination, props);
    expect(failed).toContain('Failed to load. Retry');
    expect(failed).not.toContain('busy-indicator');
    const retrying = await render(ManagementPagination, {
      ...props,
      loading: true,
      loadingMore: true
    });
    expect(retrying.match(/class="[^"]*\bbusy-indicator\b[^"]*"/gu)).toHaveLength(1);
    expect(retrying).toContain('aria-label="Loading"');
    expect(retrying).toContain('aria-busy="true"');
    expect(retrying).not.toContain('Failed to load. Retry');
  });

  it.each([true, false])(
    'does not show append retry for a non-append failure on mobile=%s',
    async (mobile) => {
      i18n.global.locale.value = 'en-US';
      const html = await render(ManagementPagination, {
        page: 1,
        mobile,
        mobileVisibleCount: 0,
        hasMore: false,
        failed: true,
        error: new Error('List request failed')
      });
      expect(html).not.toContain('Failed to load. Retry');
    }
  );

  it('does not show append retry on desktop even if an append failure remains', async () => {
    const html = await render(ManagementPagination, {
      page: 1,
      mobile: false,
      mobileVisibleCount: 20,
      hasMore: true,
      failed: true,
      incrementalFailed: true
    });
    expect(html).not.toContain('Failed to load. Retry');
  });

  it.each(['success', 'failure'] as const)(
    'shows indeterminate MCP installation feedback after the delay and clears it on %s',
    async (outcome) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      vi.stubGlobal('window', {
        matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
        addEventListener() {},
        removeEventListener() {},
        setTimeout: globalThis.setTimeout,
        clearTimeout: globalThis.clearTimeout
      });
      i18n.global.locale.value = 'en-US';

      const entry = {
        id: 'entry-1',
        sourceId: 'source-1',
        scope: 'PERSONAL',
        serverName: 'fixture-mcp',
        displayName: 'Fixture MCP',
        description: 'MCP installation fixture',
        version: '1.0.0',
        featured: false,
        tags: [],
        runtime: { transport: 'STDIO' as const }
      };
      const installation = {
        catalogEntryId: entry.id,
        serverName: entry.serverName,
        displayName: entry.displayName,
        version: entry.version,
        origin: 'NODE' as const,
        enabled: true,
        status: 'CURRENT' as const,
        installedAt: 1
      };
      let resolveInstall!: (value: {
        targetKind: 'NODE';
        installations: (typeof installation)[];
      }) => void;
      let rejectInstall!: (reason: Error) => void;
      const pendingInstall = new Promise<{
        targetKind: 'NODE';
        installations: (typeof installation)[];
      }>((resolve, reject) => {
        resolveInstall = resolve;
        rejectInstall = reject;
      });
      const request = vi.fn(async <T>(path: string, init?: RequestInit): Promise<T> => {
        if (path.startsWith('/api/mcp-catalog'))
          return { entries: [entry], page: 1, pageSize: 20, total: 1, hasMore: false } as T;
        if (path === '/api/resources')
          return {
            nodes: [
              { id: 'node-1', displayName: 'Fixture Node', connected: true, disabled: false }
            ],
            workspaces: []
          } as T;
        if (path === '/api/nodes/node-1/mcps' && init?.method === 'POST')
          return (await pendingInstall) as T;
        if (path === '/api/nodes/node-1/mcps')
          return { targetKind: 'NODE', installations: [] } as T;
        throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${path}`);
      });
      const view = renderComponent(McpCenterPanel, {
        request,
        nodes: [
          {
            id: 'node-1',
            displayName: 'Fixture Node',
            registeredAddress: 'fixture-node',
            connected: true,
            disabled: false,
            nodeAppVersion: '0.10.1'
          }
        ]
      });

      try {
        await flushComponent();
        expect(textContent(view.root)).toContain('Fixture MCP');
        const installButton = view
          .findAll('ElButton')
          .find((button) => textContent(button).trim() === 'Install')!;
        const click = installButton.props['onClick'];
        expect(click).toBeTypeOf('function');
        const installOperation = (click as () => Promise<void>)();
        await flushComponent();
        expect(request).toHaveBeenCalledWith(
          '/api/nodes/node-1/mcps',
          expect.objectContaining({ method: 'POST' })
        );
        expect(view.findAll('div').some((element) => element.props['role'] === 'progressbar')).toBe(
          false
        );
        await vi.advanceTimersByTimeAsync(799);
        await flushComponent();
        expect(view.findAll('div').some((element) => element.props['role'] === 'progressbar')).toBe(
          false
        );
        await vi.advanceTimersByTimeAsync(1);
        await flushComponent();
        const progress = view
          .findAll('div')
          .find((element) => element.props['role'] === 'progressbar');
        expect(progress).toBeDefined();
        expect(progress?.props['aria-label']).toBeTruthy();
        expect(progress?.props).not.toHaveProperty('aria-valuenow');
        expect(progress?.props).not.toHaveProperty('aria-valuemin');
        expect(progress?.props).not.toHaveProperty('aria-valuemax');
        expect(textContent(progress!)).not.toMatch(/\d+(?:\.\d+)?%/u);
        expect(view.findAll('ElProgress')).toHaveLength(0);

        if (outcome === 'success')
          resolveInstall({ targetKind: 'NODE', installations: [installation] });
        else rejectInstall(new Error('MCP_PROTOCOL_VALIDATION_FAILED'));
        await installOperation;
        await flushComponent();
        if (outcome === 'failure')
          expect(showMessage).toHaveBeenCalledWith(expect.any(String), 'error', expect.any(Error));
        expect(view.findAll('div').some((element) => element.props['role'] === 'progressbar')).toBe(
          false
        );
      } finally {
        view.unmount();
      }
    }
  );

  it.each(['success', 'failure'] as const)(
    'shows indeterminate Skill installation feedback after the delay and clears it on %s',
    async (outcome) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      vi.stubGlobal('window', {
        matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
        addEventListener() {},
        removeEventListener() {},
        setTimeout: globalThis.setTimeout,
        clearTimeout: globalThis.clearTimeout
      });
      i18n.global.locale.value = 'en-US';

      const favorite = {
        id: 'favorite-1',
        sourceId: 'source-1',
        scope: 'PERSONAL',
        normalizedName: 'fixture-skill',
        featured: false,
        tags: [],
        description: 'Skill installation fixture',
        repositoryIdentity: 'https://example.invalid/skills',
        skillPath: 'skills/fixture-skill',
        commitSha: 'a'.repeat(40),
        currentVersionId: 'version-1',
        tlsVerified: true,
        updatedAt: 1,
        manageable: true
      };
      let resolveJob!: (value: { status: 'SUCCEEDED' | 'FAILED'; errorCode?: string }) => void;
      const pendingJob = new Promise<{ status: 'SUCCEEDED' | 'FAILED'; errorCode?: string }>(
        (resolve) => {
          resolveJob = resolve;
        }
      );
      const request = vi.fn(async <T>(path: string, init?: RequestInit): Promise<T> => {
        if (path === '/api/skill-favorites?page=1&limit=20')
          return { favorites: [favorite], page: 1, pageSize: 20, total: 1, hasMore: false } as T;
        if (path === '/api/resources')
          return {
            nodes: [
              { id: 'node-1', displayName: 'Fixture Node', connected: true, disabled: false }
            ],
            workspaces: []
          } as T;
        if (path === '/api/nodes/node-1/skills' && init?.method === 'POST')
          return { installJobId: 'install-1' } as T;
        if (path === '/api/skill-install-jobs/install-1') return (await pendingJob) as T;
        if (path === '/api/nodes/node-1/skills')
          return { targetKind: 'NODE', compatibilityMode: 'SYMLINK', skills: [] } as T;
        throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${path}`);
      });
      const view = renderComponent(SkillCenterPage, {
        request,
        nodes: [
          {
            id: 'node-1',
            displayName: 'Fixture Node',
            registeredAddress: 'fixture-node',
            connected: true,
            disabled: false,
            nodeAppVersion: '0.10.1'
          }
        ]
      });

      try {
        await flushComponent();
        expect(textContent(view.root)).toContain('fixture-skill');
        const installButton = view
          .findAll('ElButton')
          .find((button) => textContent(button).trim() === 'Install')!;
        const click = installButton.props['onClick'];
        expect(click).toBeTypeOf('function');
        const installOperation = (click as () => Promise<void>)();
        await flushComponent();
        expect(request).toHaveBeenCalledWith(
          '/api/nodes/node-1/skills',
          expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({ favoriteId: 'favorite-1' })
          })
        );
        expect(request).toHaveBeenCalledWith('/api/skill-install-jobs/install-1');
        await vi.advanceTimersByTimeAsync(799);
        await flushComponent();
        expect(view.findAll('div').some((element) => element.props['role'] === 'progressbar')).toBe(
          false
        );
        await vi.advanceTimersByTimeAsync(1);
        await flushComponent();
        const progress = view
          .findAll('div')
          .find((element) => element.props['role'] === 'progressbar');
        expect(progress).toBeDefined();
        expect(progress?.props['aria-label']).toBeTruthy();
        expect(progress?.props).not.toHaveProperty('aria-valuenow');
        expect(progress?.props).not.toHaveProperty('aria-valuemin');
        expect(progress?.props).not.toHaveProperty('aria-valuemax');
        expect(textContent(progress!)).not.toMatch(/\d+(?:\.\d+)?%/u);
        expect(view.findAll('ElProgress')).toHaveLength(0);

        resolveJob(
          outcome === 'success'
            ? { status: 'SUCCEEDED' }
            : { status: 'FAILED', errorCode: 'SKILL_CONTENT_INVALID' }
        );
        await installOperation;
        await flushComponent();
        expect(view.findAll('div').some((element) => element.props['role'] === 'progressbar')).toBe(
          false
        );
      } finally {
        view.unmount();
      }
    }
  );
});
