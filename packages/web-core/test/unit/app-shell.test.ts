import { createRenderer, createSSRApp, defineComponent, h, ssrContextKey } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ElementPlus, { ZINDEX_INJECTION_KEY } from 'element-plus';
import AppShell from '../../src/App.vue';
import { i18n, localePreferenceService } from '../../src/service/LocalePreferenceService.js';
import { useDocumentationAvailability } from '../../src/service/DocumentationAvailability.js';
import { TOOLTIP_SERVICE_KEY, TooltipService } from '../../src/service/TooltipService.js';

afterEach(() => vi.unstubAllGlobals());

function registerTooltipSSRFixture(app: ReturnType<typeof createSSRApp>): void {
  app.provide(TOOLTIP_SERVICE_KEY, new TooltipService(document));
  app.provide(ZINDEX_INJECTION_KEY, { current: 0 });
  app.directive('tooltip', { getSSRProps: () => ({}) });
}

describe('shared product application shell', () => {
  it.each([
    ['?standaloneFile=1&markdownPreview=1', false],
    ['?standaloneFile=1&htmlPreview=1', false],
    ['?standaloneFile=1&source=hosted&markdownPreview=1', false],
    ['?standaloneFile=1&source=hosted&htmlPreview=1', false],
    ['?standaloneFile=1', true],
    ['?standaloneFile=1&source=hosted', true],
    ['?markdownPreview=1', true],
    ['?htmlPreview=1', true],
    ['', true],
    ['', false, 'mouse', true],
    ['', false, 'touch', true],
    ['', false, '', true],
    ['', false, 'touch', false],
    ['', true, '', false],
    ['?node=node-1&workspace=workspace-1', true, 'mouse', false, '/'],
    ['?next=https%3A%2F%2Fexample.com', true, 'mouse', false, '/index.html']
  ] as const)(
    'applies native context menu policy (search=%s, prevented=%s, pointerType=%s, touchDevice=%s)',
    (
      search,
      prevented,
      pointerType = 'mouse',
      touchDevice = false,
      pathname: string = '/console'
    ) => {
      const documentTarget = Object.assign(new EventTarget(), {
        documentElement: {
          lang: '',
          classList: { toggle: vi.fn(), add: vi.fn(), remove: vi.fn() },
          setAttribute: vi.fn(),
          removeAttribute: vi.fn()
        },
        getElementById: () => null
      });
      vi.stubGlobal('location', { pathname, search, hash: '#context' });
      vi.stubGlobal('document', documentTarget);
      vi.stubGlobal('HTMLElement', class {});
      vi.stubGlobal('localStorage', { getItem: () => null });
      const replaceState = vi.fn();
      const historyState = { existing: 'fixture' };
      vi.stubGlobal('window', {
        matchMedia: () => ({ matches: touchDevice }),
        history: { state: historyState, replaceState }
      });
      const renderer = createRenderer<object, object>({
        patchProp() {},
        insert() {},
        remove() {},
        createElement: () => ({}),
        createText: () => ({}),
        createComment: () => ({}),
        setText() {},
        setElementText() {},
        parentNode: () => null,
        nextSibling: () => null
      });
      const page = defineComponent({ setup: () => () => h('p', 'File content') });
      // Exercise lifecycle listeners without rendering the SSR-compiled template.
      const app = renderer.createApp(
        { ...AppShell, render: () => null },
        {
          workbench: page,
          filePreview: page
        }
      );
      app.use(i18n).use(ElementPlus);
      app.provide(ssrContextKey, {});
      app.mount({});
      if (pathname === '/' || pathname === '/index.html')
        expect(replaceState).toHaveBeenCalledWith(historyState, '', `/console${search}#context`);
      else expect(replaceState).not.toHaveBeenCalled();
      try {
        const event = Object.assign(new Event('contextmenu', { cancelable: true }), {
          pointerType
        });
        documentTarget.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(prevented);
      } finally {
        app.unmount();
      }
      const event = new Event('contextmenu', { cancelable: true });
      documentTarget.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
  );

  it.each([true, false])(
    'composes documentation availability without edition checks (%s)',
    async (available) => {
      vi.stubGlobal('location', { pathname: '/', search: '' });
      vi.stubGlobal('document', {
        documentElement: {
          lang: '',
          classList: { toggle: vi.fn(), add: vi.fn(), remove: vi.fn() },
          setAttribute: vi.fn(),
          removeAttribute: vi.fn()
        }
      });
      const page = defineComponent({
        setup() {
          const documentationAvailable = useDocumentationAvailability();
          return () => h('div', String(documentationAvailable));
        }
      });
      const app = createSSRApp(AppShell, {
        workbench: page,
        filePreview: page,
        documentationAvailable: available
      });
      app.use(i18n).use(ElementPlus);
      registerTooltipSSRFixture(app);
      expect(await renderToString(app)).toContain(`>${available}</div>`);
    }
  );

  it.each([
    ['/', '', 'workbench'],
    ['/index.html', '?standaloneFile=1', 'workbench'],
    ['/console', '', 'workbench'],
    ['/console', '?standaloneFile=1', 'workbench'],
    ['/console', '?standaloneFile=1&markdownPreview=1', 'preview'],
    ['/console', '?standaloneFile=1&htmlPreview=1', 'preview'],
    ['/console', '?htmlPreview=1', 'workbench'],
    ['/index.html', '?standaloneFile=1&markdownPreview=1', 'preview'],
    ['/index.html', '?standaloneFile=1&htmlPreview=1', 'preview']
  ] as const)(
    'composes %s%s without initializing unselected pages',
    async (pathname, search, target) => {
      const toggle = vi.fn();
      const getItem = vi.fn(() => null);
      vi.stubGlobal('location', { pathname, search });
      vi.stubGlobal('localStorage', { getItem });
      vi.stubGlobal('document', {
        documentElement: {
          lang: '',
          classList: { toggle, add: vi.fn(), remove: vi.fn() },
          setAttribute: vi.fn(),
          removeAttribute: vi.fn()
        }
      });
      const selected: string[] = [];
      const page = (name: string) =>
        defineComponent({
          setup() {
            selected.push(name);
            return () => h('div', { 'data-page': name });
          }
        });
      const app = createSSRApp(AppShell, {
        workbench: page('workbench'),
        filePreview: page('preview')
      });
      app.use(i18n);
      app.use(ElementPlus);
      registerTooltipSSRFixture(app);
      const html = await renderToString(app);
      expect(html).toContain(`data-page="${target}"`);
      expect(selected).toEqual([target]);
      expect(toggle).toHaveBeenCalledWith('console-ui', true);
    }
  );

  it.each(['zh-CN', 'en-US'] as const)('shares the product locale (%s)', async (locale) => {
    vi.stubGlobal('location', { pathname: '/', search: '' });
    vi.stubGlobal('document', {
      documentElement: {
        lang: '',
        classList: { toggle: vi.fn(), add: vi.fn(), remove: vi.fn() },
        setAttribute: vi.fn(),
        removeAttribute: vi.fn()
      }
    });
    localePreferenceService().setLocale(locale);
    const page = defineComponent({
      setup: () => () => h('div', i18n.global.locale.value)
    });
    const app = createSSRApp(AppShell, { workbench: page, filePreview: page });
    app.use(i18n);
    app.use(ElementPlus);
    registerTooltipSSRFixture(app);
    expect(await renderToString(app)).toContain(locale);
  });
});
