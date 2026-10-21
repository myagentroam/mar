import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from 'vue';
import ElementPlus from 'element-plus';
import { bootstrapConsole } from '../../src/bootstrap.js';
import AppShell from '../../src/App.vue';
import { i18n } from '../../src/service/LocalePreferenceService.js';
import {
  createManagementComposition,
  MANAGEMENT_COMPOSITION_KEY
} from '../../src/service/ManagementComposition.js';

vi.mock('vue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue')>()),
  createApp: vi.fn()
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('shared Console bootstrap', () => {
  it.each([false, true])(
    'installs the same UI, locale and registry with PWA support=%s',
    async (pwa) => {
      const app = { provide: vi.fn(), use: vi.fn(), mount: vi.fn() };
      vi.mocked(createApp).mockReturnValue(app as never);
      const window = new EventTarget();
      const register = vi.fn().mockRejectedValue(new Error('fixture service-worker failure'));
      vi.stubGlobal('window', window);
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
      const pages = { home: {}, workbench: {}, filePreview: {} };
      expect(bootstrapConsole({ ...pages, management })).toBe(app);
      expect(createApp).toHaveBeenCalledWith(AppShell, pages);
      expect(app.provide).toHaveBeenCalledWith(MANAGEMENT_COMPOSITION_KEY, management);
      expect(app.use.mock.calls).toEqual([[i18n], [ElementPlus]]);
      expect(app.mount).toHaveBeenCalledWith('#app');
      expect(register).not.toHaveBeenCalled();
      window.dispatchEvent(new Event('load'));
      await Promise.resolve();
      if (pwa) expect(register).toHaveBeenCalledWith('/service-worker.js', { scope: '/' });
      else expect(register).not.toHaveBeenCalled();
    }
  );
});
