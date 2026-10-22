import { createSSRApp, defineComponent, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { ElButton, ElIcon } from 'element-plus';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { i18n, localePreferenceService } from '../../src/service/LocalePreferenceService.js';
import { createWebPerformanceDiagnostics } from '../../src/service/WebPerformanceDiagnosticService.js';
import WebPerformanceIndicator from '../../src/view/workbench/WebPerformanceIndicator.vue';
import { installPerformanceObserver } from './support/performance-observer-fixture.js';

const originalLocale = localePreferenceService().locale.value;
afterEach(() => {
  localePreferenceService().setLocale(originalLocale);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Long Task diagnostic indicator', () => {
  it.each([
    ['en-US', 'unavailable', 'Unavailable'],
    ['en-US', 'empty', '0 0 ms'],
    ['en-US', 'samples', '2 120 ms'],
    ['zh-CN', 'unavailable', '不可用'],
    ['zh-CN', 'empty', '0 次 0 ms'],
    ['zh-CN', 'samples', '2 次 120 ms']
  ] as const)('renders %s Long Task collection as %s', async (locale, state, expected) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 17, 23, 45, 46));
    vi.stubGlobal('document', {
      hidden: false,
      documentElement: { lang: originalLocale },
      getElementsByTagName: () => [],
      querySelectorAll: () => []
    });
    installPerformanceObserver();
    if (state === 'unavailable') vi.stubGlobal('PerformanceObserver', undefined);
    const diagnostics = createWebPerformanceDiagnostics();
    try {
      diagnostics.start();
      diagnostics.observeFrame({ bytes: 1, durationMs: 0, message: {} });
      diagnostics.setConnectionState('connected');
      if (state === 'samples')
        diagnostics.updateBrowserMetrics({
          domNodes: 0,
          messageCards: 0,
          eventLoopDelayMs: 0,
          longTasks: { count: 2, totalDurationMs: 120 }
        });
      localePreferenceService().setLocale(locale);
      const app = createSSRApp({ render: () => h(WebPerformanceIndicator, { diagnostics }) });
      app.use(i18n);
      app.component('ElButton', ElButton);
      app.component('ElIcon', ElIcon);
      // Render the reference and content; placement and hover are unchanged.
      app.component(
        'ElPopover',
        defineComponent({
          setup(_props, { slots }) {
            return () => h('div', [slots.reference?.(), slots.default?.()]);
          }
        })
      );
      const html = await renderToString(app);
      expect(html).toContain('class="mar-icon"');
      expect(html).toContain('cx="12" cy="7.8" r="1"');
      expect(html).toContain('2026-10-17 23:45:46');
      const label = locale === 'en-US' ? 'Long tasks (10s)' : '长任务（10 秒）';
      const value = html
        .slice(html.indexOf(label) + label.length)
        .split('</dd>')[0]
        ?.split('>')
        .at(-1);
      expect(value?.trim()).toBe(expected);
      if (state === 'unavailable') expect(value).not.toContain('ms');
    } finally {
      diagnostics.dispose();
    }
  });
});
