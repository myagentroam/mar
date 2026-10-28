import {
  createRenderer,
  h,
  nextTick,
  shallowRef,
  ssrContextKey,
  type Component,
  type SetupContext,
  type VNode
} from 'vue';
import { expect, it, vi } from 'vitest';
import ConversationScroll from '../../src/view/conversation/ConversationScroll.vue';
import { i18n } from '../../src/service/locale-preference-service.js';

it.each(['initial', 'older'] as const)(
  'retains and guards manual %s history actions until settlement',
  async (kind) => {
    const renderer = createRenderer<object, object>({
      patchProp() {},
      insert() {},
      remove() {},
      setText() {},
      setElementText() {},
      createElement: () => ({}),
      createText: () => ({}),
      createComment: () => ({}),
      parentNode: () => null,
      nextSibling: () => null
    });
    const props = shallowRef({
      hasOlder: true,
      hasTurns: kind === 'older',
      following: false,
      loadingInitial: false,
      initialLoadFailed: kind === 'initial',
      loadingOlder: false,
      olderError: 'History unavailable'
    });
    const loadingKey = kind === 'initial' ? 'loadingInitial' : 'loadingOlder';
    const pendingKey = kind === 'initial' ? 'reloading' : 'olderAction';
    let state: Record<string, unknown>;
    const request = vi.fn(() => {
      props.value = {
        ...props.value,
        [loadingKey]: true,
        initialLoadFailed: false,
        olderError: ''
      };
    });
    const component = { ...ConversationScroll, render: () => null } as Component;
    const app = renderer.createApp({
      render: () =>
        h(component, {
          ...props.value,
          onReload: request,
          onLoadOlder: request,
          onVnodeMounted: (vnode: VNode) => {
            state = (vnode.component as unknown as { setupState: Record<string, unknown> })
              .setupState;
          }
        })
    });
    app.use(i18n);
    app.provide(ssrContextKey, { modules: new Set<string>() });
    vi.stubGlobal('window', {
      matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} })
    });
    vi.stubGlobal('HTMLElement', class {});
    app.component('ElButton', {
      setup:
        (_: unknown, { slots }: SetupContext) =>
        () =>
          h('button', slots.default?.())
    });
    app.component('ElIcon', {
      setup:
        (_: unknown, { slots }: SetupContext) =>
        () =>
          h('span', slots.default?.())
    });
    app.mount({});
    try {
      const activate = state![kind === 'initial' ? 'reload' : 'loadOlder'] as () => Promise<void>;
      await activate();
      expect(state![pendingKey]).toBeTruthy();
      if (kind === 'older') expect(state![pendingKey]).toBe('retry');
      await activate();
      expect(request).toHaveBeenCalledTimes(1);
      props.value = {
        ...props.value,
        [loadingKey]: false,
        initialLoadFailed: kind === 'initial',
        olderError: 'Retry failed'
      };
      await nextTick();
      expect(state![pendingKey]).toBeFalsy();
      await activate();
      expect(request).toHaveBeenCalledTimes(2);
      props.value = { ...props.value, [loadingKey]: false };
      await nextTick();
      expect(state![pendingKey]).toBeFalsy();
      // If the parent rejects a request without starting loading, the control remains usable.
      request.mockImplementation(() => {});
      await activate();
      expect(state![pendingKey]).toBeFalsy();
      if (kind === 'older') {
        const button = { getAttribute: () => 'load' };
        state!['element'] = { querySelector: () => button };
        vi.stubGlobal('document', { activeElement: button });
        props.value = { ...props.value, loadingOlder: true };
        await nextTick();
        expect(state!['olderAction']).toBe('load');
        props.value = { ...props.value, loadingOlder: false };
        await nextTick();
        vi.stubGlobal('document', { activeElement: null });
        props.value = { ...props.value, loadingOlder: true };
        await nextTick();
        expect(state!['olderAction']).toBeUndefined();
      }
    } finally {
      app.unmount();
      vi.unstubAllGlobals();
    }
  }
);
