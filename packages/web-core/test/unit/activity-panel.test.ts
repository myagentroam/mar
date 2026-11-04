import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref, shallowReactive } from 'vue';
import ActivityPanel from '../../src/view/workbench/WorkbenchActivityPanel.vue?unit-render';
import { createWorkbenchNotificationService } from '../../src/service/workbench-notification-service.js';
import { i18n } from '../../src/service/locale-preference-service.js';
import { renderComponent, textContent } from './support/component-renderer.js';

const originalLocale = i18n.global.locale.value;
afterEach(() => {
  vi.useRealTimers();
  i18n.global.locale.value = originalLocale;
});

describe('Activity panel lifecycle', () => {
  it.each(['recent-sessions', 'notifications'] as const)(
    'keeps both panel identities and unloads inactive content, starting on %s',
    async (page) => {
      vi.useFakeTimers();
      i18n.global.locale.value = 'en-US';
      const service = createWorkbenchNotificationService(ref('activity-fixture'));
      const baselineTimers = vi.getTimerCount();
      const props = shallowReactive({
        service,
        uploads: [],
        statusLabel: () => '',
        page: page as 'recent-sessions' | 'notifications',
        sessionGroup: 'MAIN' as const,
        mobileMode: false,
        'onUpdate:page': (value: 'recent-sessions' | 'notifications') => (props.page = value)
      });
      const view = renderComponent(ActivityPanel, props);
      try {
        await nextTick();
        const tabs = view
          .findAll('button')
          .filter((node) => node.props['role'] === 'tab' && node.props['aria-controls']);
        const panels = () =>
          [...view.findAll('div'), ...view.findAll('section')].filter(
            (node) => node.props['role'] === 'tabpanel'
          );
        expect(tabs).toHaveLength(2);
        expect(panels()).toHaveLength(2);
        const identities = tabs.map((tab) => [tab.props['id'], tab.props['aria-controls']]);
        for (const active of ['recent-sessions', 'notifications', 'recent-sessions'] as const) {
          (tabs[active === 'recent-sessions' ? 0 : 1]!.props['onClick'] as () => void)();
          await nextTick();
          expect(tabs.map((tab) => [tab.props['id'], tab.props['aria-controls']])).toEqual(
            identities
          );
          for (const tab of tabs) {
            const matching = panels().filter(
              (panel) => panel.props['id'] === tab.props['aria-controls']
            );
            expect(matching).toHaveLength(1);
            expect(matching[0]!.props['aria-labelledby']).toBe(tab.props['id']);
            const content = textContent(matching[0]!);
            if (tab.props['aria-selected']) expect(content).not.toBe('');
            else expect(content).toBe('');
          }
          // Switching content must not create a second elapsed-time timer.
          expect(vi.getTimerCount()).toBe(baselineTimers + 1);
        }
      } finally {
        // Closing the owner unmounts this panel and releases its elapsed clock.
        view.unmount();
        expect(vi.getTimerCount()).toBe(baselineTimers);
        service.dispose();
      }
    }
  );
});
