import { createSSRApp, defineComponent, h, nextTick, ref } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionGroup } from '@myagentroam/protocol';
import SessionGroupTabs from '../../src/view/common/SessionGroupTabs.vue';
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
  it('renders plain categories without running or unread markers', async () => {
    localePreferenceService().setLocale('en-US');
    const app = createSSRApp({ render: () => h(SessionGroupTabs, { modelValue: 'MAIN' }) });
    app.use(i18n);
    const html = await renderToString(app);
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('type="radio"');
    expect(html).toContain('aria-label="Main Sessions"');
    expect(html).toContain('aria-label="Child Sessions"');
    expect(html).not.toContain('Unread');
    expect(html).not.toContain('session-state-badge');
  });

  it('emits one controlled update per changed option and follows external selection', async () => {
    const modelValue = ref<SessionGroup>('MAIN');
    const updates: SessionGroup[] = [];
    const harness = defineComponent({
      setup: () => () =>
        h(InteractiveSessionGroupTabs, {
          modelValue: modelValue.value,
          'onUpdate:modelValue': (group: SessionGroup) => {
            updates.push(group);
            modelValue.value = group;
          }
        })
    });
    const mounted = mountSessionGroupTestComponent(harness, {});
    mountedApps.push(mounted.app);

    const [main, child] = mounted.container.findAll((node) => node.props.get('type') === 'radio');
    expect(main?.props.get('checked')).toBe(true);
    expect(child?.props.get('checked')).toBe(false);

    child?.invoke('onChange');
    await nextTick();
    expect(main?.props.get('checked')).toBe(false);
    expect(child?.props.get('checked')).toBe(true);
    child?.invoke('onChange');
    expect(updates).toEqual(['CHILD']);

    modelValue.value = 'MAIN';
    await nextTick();
    expect(main?.props.get('checked')).toBe(true);
    expect(child?.props.get('checked')).toBe(false);
    expect(updates).toEqual(['CHILD']);
  });
});
