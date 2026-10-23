import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSSRApp, type Component } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { ElMessage } from 'element-plus';

const hooks = vi.hoisted(() => ({
  mounted: [] as (() => void)[],
  unmounted: [] as (() => void)[],
  effects: [] as (() => void)[],
  watchers: [] as { source: unknown; callback: (...args: unknown[]) => void }[]
}));
vi.mock('vue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue')>()),
  onMounted: (callback: () => void) => hooks.mounted.push(callback),
  onBeforeUnmount: (callback: () => void) => hooks.unmounted.push(callback),
  watch: (source: unknown, callback: (...args: unknown[]) => void) =>
    hooks.watchers.push({ source, callback }),
  watchEffect: (callback: () => void) => hooks.effects.push(callback)
}));
vi.mock('element-plus', () => ({ ElMessage: vi.fn() }));
import { installWorkbenchPageLifecycle } from '../../src/service/WorkbenchPageLifecycleService.js';

beforeEach(() => {
  hooks.mounted.length = 0;
  hooks.unmounted.length = 0;
  hooks.effects.length = 0;
  hooks.watchers.length = 0;
});

describe('Shared workbench lifecycle', () => {
  it('keeps service notice icons aligned with the current severity', async () => {
    const values: Record<string, unknown> = {
      notice: { value: 'Operation feedback' },
      noticeType: () => 'error'
    };
    const options = new Proxy(values, {
      get: (target, name: string) => (target[name] ??= () => undefined)
    }) as unknown as Parameters<typeof installWorkbenchPageLifecycle>[0];
    installWorkbenchPageLifecycle(options);
    for (const type of ['error', 'warning', 'success', 'info']) {
      values['noticeType'] = () => type;
      hooks.effects[0]!();
      const message = vi.mocked(ElMessage).mock.lastCall?.[0] as {
        type: string;
        icon: Component;
        message: string;
      };
      expect(message.type).toBe(type);
      expect(message.message).toBe('Operation feedback');
      const html = await renderToString(createSSRApp(message.icon));
      expect(html).toContain(`data-mar-icon="${type}"`);
    }
  });

  it('restores state once and tears down the same page-level resources', () => {
    const calls: string[] = [];
    const document = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
    const window = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
    vi.stubGlobal('document', document);
    vi.stubGlobal('window', window);
    const values: Record<string, unknown> = {};
    const options = new Proxy(values, {
      get: (target, name: string) =>
        (target[name] ??= () => {
          calls.push(name);
        })
    }) as unknown as Parameters<typeof installWorkbenchPageLifecycle>[0];
    try {
      installWorkbenchPageLifecycle(options);
      expect(hooks.mounted).toHaveLength(1);
      expect(hooks.unmounted).toHaveLength(1);
      hooks.mounted[0]!();
      expect(calls).toEqual([
        'restoreWorkbenchState',
        'restoreWorkbenchEventCursors',
        'restoreWorkspaceUploads',
        'startNavigation',
        'refreshAdmin'
      ]);
      expect(document.addEventListener).toHaveBeenCalledWith(
        'visibilitychange',
        options.handleSessionWatchVisibility
      );
      expect(window.addEventListener).not.toHaveBeenCalledWith(
        'keydown',
        options.onGlobalKeydown,
        true
      );
      calls.length = 0;
      hooks.unmounted[0]!();
      expect(calls).toEqual([
        'cancelFileReferenceSearch',
        'disposeNavigation',
        'disposeWorkspaceUploads',
        'disposeWorkbenchNotifications',
        'disposeWebVersionUpdateCheck',
        'stopSelectedSessionWatch',
        'stopWorkspaceWatch',
        'disposeDirectTransport',
        'closeWorkbenchLive',
        'clearNewSessionAttachments',
        'releaseRunImagePreviews'
      ]);
      expect(document.removeEventListener.mock.calls).toEqual(document.addEventListener.mock.calls);
      expect(window.removeEventListener.mock.calls).toEqual([]);
      const selection = hooks.watchers.find((entry) => entry.source === options.selectedSessionId)!;
      calls.length = 0;
      selection.callback('same', 'same');
      expect(calls).toEqual([]);
      selection.callback('next', 'previous');
      expect(calls).toEqual(['stopSelectedSessionWatch']);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
