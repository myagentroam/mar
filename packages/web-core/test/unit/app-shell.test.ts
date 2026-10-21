import { createRenderer, createSSRApp, defineComponent, h, ssrContextKey } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ElementPlus from 'element-plus';
import { readFileSync } from 'node:fs';
import AppShell from '../../src/App.vue';
import { i18n, localePreferenceService } from '../../src/service/LocalePreferenceService.js';
import { useDocumentationAvailability } from '../../src/service/DocumentationAvailability.js';

afterEach(() => vi.unstubAllGlobals());

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
    ['', true, '', false]
  ] as const)(
    'applies native context menu policy (search=%s, prevented=%s, pointerType=%s, touchDevice=%s)',
    (search, prevented, pointerType = 'mouse', touchDevice = false) => {
      const documentTarget = Object.assign(new EventTarget(), {
        documentElement: {
          lang: '',
          classList: { toggle: vi.fn(), add: vi.fn(), remove: vi.fn() },
          setAttribute: vi.fn(),
          removeAttribute: vi.fn()
        },
        getElementById: () => null
      });
      vi.stubGlobal('location', { pathname: '/console', search });
      vi.stubGlobal('document', documentTarget);
      vi.stubGlobal('HTMLElement', class {});
      vi.stubGlobal('localStorage', { getItem: () => null });
      vi.stubGlobal('window', { matchMedia: () => ({ matches: touchDevice }) });
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
          home: page,
          workbench: page,
          filePreview: page
        }
      );
      app.use(i18n).use(ElementPlus);
      app.provide(ssrContextKey, {});
      app.mount({});
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

  it('keeps the native context menu on touch devices and suppresses it elsewhere outside editable controls and media', () => {
    const source = readFileSync(new URL('../../src/App.vue', import.meta.url), 'utf8');
    expect(source).toContain("document.addEventListener('contextmenu', preventBrowserContextMenu)");
    expect(source).toContain("pointerType === 'touch'");
    expect(source).toContain("window.matchMedia('(hover: none) and (pointer: coarse)').matches");
    expect(source).toContain("target.matches('input, textarea, select')");
    expect(source).toContain("target.closest('img, video, audio') !== null");
    expect(source).toContain('\'[contenteditable]:not([contenteditable="false"])\'');
    expect(source).toContain('event.preventDefault();');
  });

  it('keeps ordinary standalone files in the Workbench and overlays its bootstrap with loading', () => {
    const appSource = readFileSync(new URL('../../src/App.vue', import.meta.url), 'utf8');
    const workbenchSource = readFileSync(
      new URL('../../src/view/workbench/WorkbenchPage.vue', import.meta.url),
      'utf8'
    );

    expect(appSource).toContain("query.get('markdownPreview') === '1'");
    expect(appSource).toContain("query.get('htmlPreview') === '1'");
    expect(appSource).toContain("query.get('source') === 'hosted'");
    expect(workbenchSource).toContain(
      'page.standaloneFileMode && (page.standaloneFileLoading || page.standaloneFileError)'
    );
    expect(workbenchSource).toContain(':inert="page.standaloneFileMode"');
    expect(workbenchSource).toContain('FilePreviewLoading');
    expect(workbenchSource).toContain(
      "t('generated.standaloneFilePreviewPage.unableToReadTheFileCheckYour')"
    );
    expect(workbenchSource).toContain('z-index: 49;');
  });

  it('keeps the HTML bootstrap visible until the selected async page resolves', () => {
    const source = readFileSync(new URL('../../src/App.vue', import.meta.url), 'utf8');
    expect(source).toContain('<Suspense @resolve="revealApplication">');
    expect(source).toContain("document.getElementById('mar-bootstrap')");
    expect(source).toContain("bootstrap.classList.add('mar-bootstrap--leaving')");
  });

  it.each([true, false])(
    'composes documentation availability without edition checks (%s)',
    async (available) => {
      vi.stubGlobal('location', { pathname: '/', search: '' });
      vi.stubGlobal('document', {
        documentElement: { lang: '', classList: { toggle: vi.fn() } }
      });
      const page = defineComponent({
        setup() {
          const documentationAvailable = useDocumentationAvailability();
          return () => h('div', String(documentationAvailable));
        }
      });
      const app = createSSRApp(AppShell, {
        home: page,
        workbench: page,
        filePreview: page,
        documentationAvailable: available
      });
      app.use(i18n).use(ElementPlus);
      expect(await renderToString(app)).toContain(`>${available}</div>`);
    }
  );

  it.each([
    ['/', '', 'home', false, false],
    ['/index.html', '?standaloneFile=1', 'home', false, false],
    ['/console', '', 'workbench', true, false],
    ['/console', '?standaloneFile=1', 'workbench', true, false],
    ['/console', '?standaloneFile=1&markdownPreview=1', 'preview', true, false],
    ['/console', '?standaloneFile=1&htmlPreview=1', 'preview', true, false],
    ['/console', '?htmlPreview=1', 'workbench', true, false],
    ['/', '', 'workbench', true, true],
    ['/index.html', '?standaloneFile=1', 'workbench', true, true],
    ['/index.html', '?standaloneFile=1&markdownPreview=1', 'preview', true, true],
    ['/index.html', '?standaloneFile=1&htmlPreview=1', 'preview', true, true]
  ] as const)(
    'composes %s%s without initializing unselected pages',
    async (pathname, search, target, consoleUi, rootWorkbench) => {
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
        home: page('home'),
        rootWorkbench,
        workbench: page('workbench'),
        filePreview: page('preview')
      });
      app.use(i18n);
      app.use(ElementPlus);
      const html = await renderToString(app);
      expect(html).toContain(`data-page="${target}"`);
      expect(selected).toEqual([target]);
      expect(toggle).toHaveBeenCalledWith('console-ui', consoleUi);
      if (!consoleUi) expect(getItem).not.toHaveBeenCalled();
    }
  );

  it.each(['zh-CN', 'en-US'] as const)('shares the product locale (%s)', async (locale) => {
    vi.stubGlobal('location', { pathname: '/', search: '' });
    vi.stubGlobal('document', {
      documentElement: { lang: '', classList: { toggle: vi.fn() } }
    });
    localePreferenceService().setLocale(locale);
    const page = defineComponent({
      setup: () => () => h('div', i18n.global.locale.value)
    });
    const app = createSSRApp(AppShell, { home: page, workbench: page, filePreview: page });
    app.use(i18n);
    app.use(ElementPlus);
    expect(await renderToString(app)).toContain(locale);
  });
});
