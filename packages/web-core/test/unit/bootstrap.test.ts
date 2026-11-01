import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from 'vue';
import { bootstrapConsole } from '../../src/bootstrap.js';
import AppShell from '../../src/App.vue';
import { i18n } from '../../src/service/locale-preference-service.js';
import { tooltipPlugin } from '../../src/directive/tooltip.js';
import {
  createManagementComposition,
  MANAGEMENT_COMPOSITION_KEY
} from '../../src/service/management-composition.js';

vi.mock('vue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue')>()),
  createApp: vi.fn()
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('shared Console bootstrap', () => {
  it('registers when mounted after the load event', async () => {
    const app = { provide: vi.fn(), use: vi.fn(), mount: vi.fn(), onUnmount: vi.fn() };
    vi.mocked(createApp).mockReturnValue(app as never);
    const register = vi.fn().mockResolvedValue({});
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('document', { readyState: 'complete' });
    vi.stubGlobal('navigator', { serviceWorker: { register } });
    const management = createManagementComposition([
      {
        id: 'system',
        order: 0,
        component: {},
        labelKey: 'system',
        visible: () => true,
        props: ({ request }) => ({ request })
      }
    ]);
    bootstrapConsole({ workbench: {}, filePreview: {}, management });
    expect(register).toHaveBeenCalledOnce();
  });

  it('removes the pending load listener on unmount', () => {
    const app = { provide: vi.fn(), use: vi.fn(), mount: vi.fn(), onUnmount: vi.fn() };
    vi.mocked(createApp).mockReturnValue(app as never);
    const window = new EventTarget();
    const register = vi.fn().mockResolvedValue({});
    vi.stubGlobal('window', window);
    vi.stubGlobal('document', { readyState: 'loading' });
    vi.stubGlobal('navigator', { serviceWorker: { register } });
    const management = createManagementComposition([
      {
        id: 'system',
        order: 0,
        component: {},
        labelKey: 'system',
        visible: () => true,
        props: ({ request }) => ({ request })
      }
    ]);
    bootstrapConsole({ workbench: {}, filePreview: {}, management });
    app.onUnmount.mock.calls[0]![0]();
    window.dispatchEvent(new Event('load'));
    expect(register).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'installs the same UI, locale and registry with PWA support=%s',
    async (pwa) => {
      const app = { provide: vi.fn(), use: vi.fn(), mount: vi.fn(), onUnmount: vi.fn() };
      vi.mocked(createApp).mockReturnValue(app as never);
      const window = new EventTarget();
      const register = vi.fn().mockRejectedValue(new Error('fixture service-worker failure'));
      vi.stubGlobal('window', window);
      vi.stubGlobal('document', { readyState: 'loading' });
      vi.stubGlobal('navigator', pwa ? { serviceWorker: { register } } : {});
      const management = createManagementComposition([
        {
          id: 'system',
          order: 0,
          component: {},
          labelKey: 'system',
          visible: () => true,
          props: ({ request }) => ({ request })
        }
      ]);
      const pages = { workbench: {}, filePreview: {} };
      expect(bootstrapConsole({ ...pages, management })).toBe(app);
      expect(createApp).toHaveBeenCalledWith(AppShell, pages);
      expect(app.provide).toHaveBeenCalledWith(MANAGEMENT_COMPOSITION_KEY, management);
      expect(app.use.mock.calls).toEqual([[i18n], [tooltipPlugin]]);
      expect(app.mount).toHaveBeenCalledWith('#app');
      expect(register).not.toHaveBeenCalled();
      window.dispatchEvent(new Event('load'));
      await Promise.resolve();
      if (pwa) expect(register).toHaveBeenCalledWith('/service-worker.js', { scope: '/' });
      else expect(register).not.toHaveBeenCalled();
    }
  );
});
