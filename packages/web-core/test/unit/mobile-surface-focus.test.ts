import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRenderer, h, nextTick, onBeforeUnmount } from 'vue';
import { createMobileSurfaceFocusService } from '../../src/service/mobile-surface-focus-service.js';

const apps: { unmount(): void }[] = [];
afterEach(() => {
  for (const app of apps.splice(0)) app.unmount();
  vi.unstubAllGlobals();
});

function mountSurface() {
  class HostNode {}
  vi.stubGlobal('HTMLElement', HostNode);
  vi.stubGlobal('document', {
    querySelectorAll: () => [],
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  });
  vi.stubGlobal('window', {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  });
  const surfaceFocus = vi.fn();
  const headerFocus = vi.fn();
  const surface = { getClientRects: () => [{}], focus: surfaceFocus } as unknown as HTMLElement;
  const header = { getClientRects: () => [{}], focus: headerFocus } as unknown as HTMLElement;
  let mounted = true;
  const renderer = createRenderer<HostNode, HostNode>({
    patchProp() {},
    insert() {},
    remove() {},
    createElement: () => new HostNode(),
    createText: () => new HostNode(),
    createComment: () => new HostNode(),
    setText() {},
    setElementText() {},
    parentNode: () => null,
    nextSibling: () => null
  });
  const app = renderer.createApp({
    setup() {
      const focus = createMobileSurfaceFocusService({
        isOpen: () => true,
        regions: () => [mounted ? surface : undefined, header]
      });
      onBeforeUnmount(() => {
        mounted = false;
        focus.dispose();
      });
      return () => h('section');
    }
  });
  app.mount(new HostNode());
  apps.push(app);
  return { surfaceFocus, headerFocus };
}

describe('Mobile surface focus lifecycle', () => {
  it('focuses a mounted surface after its DOM has rendered', async () => {
    const { surfaceFocus, headerFocus } = mountSurface();
    await nextTick();
    expect(surfaceFocus).toHaveBeenCalledOnce();
    expect(headerFocus).not.toHaveBeenCalled();
  });

  it('does not steal header focus after the opening surface is unmounted before its focus tick', async () => {
    const { surfaceFocus, headerFocus } = mountSurface();
    apps.pop()!.unmount();
    await nextTick();
    expect(surfaceFocus).not.toHaveBeenCalled();
    expect(headerFocus).not.toHaveBeenCalled();
  });
});
