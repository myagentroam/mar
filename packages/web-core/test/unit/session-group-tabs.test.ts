import { createSSRApp, h } from 'vue';
import ElementPlus, { ID_INJECTION_KEY, ZINDEX_INJECTION_KEY } from 'element-plus';
import { renderToString } from 'vue/server-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionGroup } from '@myagentroam/protocol';
import SessionGroupTabs from '../../src/view/common/SessionGroupTabs.vue';
import SessionStateBadge from '../../src/view/common/SessionStateBadge.vue';
import InteractiveSessionGroupTabs from '../../src/view/common/SessionGroupTabs.vue?unit-render';
import { i18n, localePreferenceService } from '../../src/service/locale-preference-service.js';
import { mountSessionGroupTestComponent } from './support/session-group-tabs-renderer.js';

const originalLocale = localePreferenceService().locale.value;
const mountedApps: { unmount(): void }[] = [];

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  localePreferenceService().setLocale(originalLocale);
  vi.restoreAllMocks();
});

describe('Session group tabs', () => {
  it('activates a marker without selecting its group', () => {
    const selections: SessionGroup[] = [];
    const markers: SessionGroup[] = [];
    const mounted = mountSessionGroupTestComponent(InteractiveSessionGroupTabs, {
      modelValue: 'MAIN',
      state: { MAIN: { running: 0, unread: false }, CHILD: { running: 1, unread: true } },
      'onUpdate:modelValue': (group: SessionGroup) => selections.push(group),
      onActivateMarker: (group: SessionGroup) => markers.push(group)
    });
    mountedApps.push(mounted.app);
    const badge = mounted.container.findAll((node) =>
      String(node.props.get('class')).includes('session-state-badge')
    )[0];
    const stopPropagation = vi.fn();
    badge?.invoke('onClick', { stopPropagation });
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(markers).toEqual(['CHILD']);
    expect(selections).toEqual([]);
  });

  it.each([
    { running: 3, unread: true, count: '3', label: true },
    { running: 3, unread: false, count: '3', label: false },
    { running: 0, unread: true, count: '', label: true },
    { running: 120, unread: true, count: '99+', label: true },
    { running: 0, unread: false, count: '', label: false }
  ])(
    'renders one state badge for running=$running unread=$unread',
    async ({ running, unread, count, label }) => {
      localePreferenceService().setLocale('en-US');
      const app = createSSRApp({ render: () => h(SessionStateBadge, { running, unread }) });
      app.use(i18n);
      const html = await renderToString(app);
      expect(html.includes('class="session-state-badge"')).toBe(running > 0 || unread);
      expect(html.includes('class="session-state-count"')).toBe(count !== '');
      expect(html.includes('class="session-state-unread mar-unread-label"')).toBe(label);
      if (count) expect(html).toContain(`>${count}</span>`);
      if (label) expect(html).toContain('>Unread</span>');
      if (running > 0 || unread) expect(html).toContain('aria-hidden="true"');
      expect(html).not.toContain('<button');
    }
  );

  it('renders independent running and unread states and caps large running counts', async () => {
    localePreferenceService().setLocale('en-US');
    const app = createSSRApp({
      render: () =>
        h(SessionGroupTabs, {
          modelValue: 'MAIN',
          state: {
            MAIN: { running: 0, unread: true },
            CHILD: { running: 120, unread: true }
          }
        })
    });
    app.use(i18n).use(ElementPlus);
    app.provide(ID_INJECTION_KEY, { prefix: 80, current: 0 });
    app.provide(ZINDEX_INJECTION_KEY, { current: 0 });

    const html = await renderToString(app);

    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-label="Main Sessions, Unread"');
    expect(html).toContain('aria-label="Child Sessions, 120 running sessions, Unread"');
    expect(html).toContain('99+');
    expect(html).not.toContain('aria-label="Main Sessions, 0 running sessions');
    expect(html).toContain('aria-selected="true"');
  });

  it('emits controlled selection for clicks and supports arrow, Home, and End focus navigation', async () => {
    const modelValue = { value: 'MAIN' as SessionGroup };
    const updates: SessionGroup[] = [];
    const mounted = mountSessionGroupTestComponent(InteractiveSessionGroupTabs, {
      get modelValue() {
        return modelValue.value;
      },
      state: {
        MAIN: { running: 0, unread: false },
        CHILD: { running: 0, unread: false }
      },
      'onUpdate:modelValue': (group: SessionGroup) => {
        updates.push(group);
        modelValue.value = group;
      }
    });
    mountedApps.push(mounted.app);

    const tabs = () => mounted.container.findAll((node) => node.props.get('role') === 'tab');
    const [main, child] = tabs();
    expect(main?.props.get('aria-selected')).toBe(true);
    expect(child?.props.get('aria-selected')).toBe(false);

    child?.invoke('onClick');
    expect(updates).toEqual(['CHILD']);

    child?.invoke('onKeydown', {
      key: 'ArrowRight',
      currentTarget: child,
      preventDefault: vi.fn()
    });
    expect(updates).toEqual(['CHILD', 'MAIN']);
    expect(main?.focused).toBe(true);

    main?.invoke('onKeydown', {
      key: 'End',
      currentTarget: main,
      preventDefault: vi.fn()
    });
    expect(updates.at(-1)).toBe('CHILD');
    expect(child?.focused).toBe(true);

    child?.invoke('onKeydown', {
      key: 'Home',
      currentTarget: child,
      preventDefault: vi.fn()
    });
    expect(updates.at(-1)).toBe('MAIN');
    expect(main?.focused).toBe(true);

    main?.invoke('onKeydown', {
      key: 'ArrowLeft',
      currentTarget: main,
      preventDefault: vi.fn()
    });
    expect(updates.at(-1)).toBe('CHILD');
    expect(child?.focused).toBe(true);
  });
});
