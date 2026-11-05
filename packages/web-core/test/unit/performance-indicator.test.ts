import { afterEach, describe, expect, it, vi } from 'vitest';
import { i18n, localePreferenceService } from '../../src/service/locale-preference-service.js';
import { createWebPerformanceDiagnostics } from '../../src/service/web-performance-diagnostic-service.js';
import WebPerformanceIndicator from '../../src/view/workbench/WebPerformanceIndicator.vue?unit-render';
import { installPerformanceObserver } from './support/performance-observer-fixture.js';
import { renderComponent, textContent } from './support/component-renderer.js';

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
      const view = renderComponent(WebPerformanceIndicator, { diagnostics });
      try {
        const copyLabel = i18n.global.t('performanceDiagnostics.copy');
        const copy = view
          .findAll('ElButton')
          .find((node) => node.props['aria-label'] === copyLabel);
        expect(copy).toBeDefined();
        expect(copy?.props.title).toBeUndefined();
        expect(view.findAll('svg').some((node) => node.props.class === 'mar-icon')).toBe(true);
        expect(view.findAll('svg').some((node) => node.props['data-mar-icon'] === 'info')).toBe(
          true
        );
        expect(textContent(view.root)).toContain('2026-10-17 23:45:46');
        const label = locale === 'en-US' ? 'Long tasks (10s)' : '长任务（10 秒）';
        const term = view.findAll('dt').find((node) => textContent(node) === label);
        expect(term).toBeDefined();
        const siblings = term!.parent!.children;
        const value = siblings[siblings.indexOf(term!) + 1];
        expect(value?.type).toBe('dd');
        expect(textContent(value!).trim()).toBe(expected);
        if (state === 'unavailable') expect(textContent(value!)).not.toContain('ms');
      } finally {
        view.unmount();
      }
    } finally {
      diagnostics.dispose();
    }
  });
});
