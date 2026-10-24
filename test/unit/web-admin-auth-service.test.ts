import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAdminAuthService } from '../../ee/web/src/service/admin-auth-service.js';
import { localePreferenceService } from '../../ee/web/src/service/locale-preference-service.js';

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => localePreferenceService().setLocale('zh-CN'));

describe('Initial Web authentication recovery', () => {
  it('Successful authentication opens the gate and failed Node restoration does not reset login', async () => {
    const storage = new Map<string, string>([['mar.user.csrf-token', 'csrf']]);
    vi.stubGlobal('window', {
      sessionStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        removeItem: (key: string) => storage.delete(key),
        setItem: (key: string, value: string) => storage.set(key, value)
      }
    });
    const admin = { value: { authenticated: false, mustChangePassword: false } };
    const loaded = { value: false };
    let loadedDuringRestore = false;
    const notice = vi.fn();
    const service = createAdminAuthService({
      admin: admin as never,
      loaded: loaded as never,
      sessions: { value: [] } as never,
      password: { value: '' } as never,
      passwordError: { value: '' } as never,
      csrfToken: { value: '' } as never,
      loading: { value: false } as never,
      request: vi.fn().mockResolvedValue({ authenticated: true, mustChangePassword: false }),
      renewCsrfToken: vi.fn(),
      invalidateRequests: vi.fn(),
      onAuthenticated: async () => {
        loadedDuringRestore = loaded.value;
        throw new Error('NODE_REQUEST_TIMEOUT');
      },
      onSignedOut: vi.fn(),
      notice,
      errorMessage: (error) => (error instanceof Error ? error.message : 'UNKNOWN')
    });

    await service.refresh();

    expect(loadedDuringRestore).toBe(true);
    expect(admin.value.authenticated).toBe(true);
    expect(notice).toHaveBeenCalledWith(
      '工作台恢复失败：NODE_REQUEST_TIMEOUT',
      'error',
      expect.objectContaining({ message: 'NODE_REQUEST_TIMEOUT' })
    );
  });

  it('Identity recovery preserves the browser language and synchronizes it to the account', async () => {
    const storage = new Map<string, string>([['mar.user.csrf-token', 'csrf']]);
    vi.stubGlobal('window', {
      sessionStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        removeItem: (key: string) => storage.delete(key),
        setItem: (key: string, value: string) => storage.set(key, value)
      }
    });
    localePreferenceService().setLocale('en-US');
    let failToSave = false;
    let waitForSave = false;
    let finishSave: (() => void) | undefined;
    const request = vi.fn(async (path: string) => {
      if (path === '/api/auth/me')
        return { authenticated: true, mustChangePassword: false, locale: 'zh-CN' };
      if (failToSave) throw new Error('NETWORK_ERROR');
      if (waitForSave) await new Promise<void>((resolve) => (finishSave = resolve));
      return undefined;
    });
    const notice = vi.fn();
    const loaded = { value: false };
    const onAuthenticated = vi.fn();
    const service = createAdminAuthService({
      admin: { value: { authenticated: false, mustChangePassword: false } } as never,
      loaded: loaded as never,
      sessions: { value: [] } as never,
      password: { value: '' } as never,
      passwordError: { value: '' } as never,
      csrfToken: { value: '' } as never,
      loading: { value: false } as never,
      request: request as never,
      renewCsrfToken: vi.fn(),
      invalidateRequests: vi.fn(),
      onAuthenticated,
      onSignedOut: vi.fn(),
      notice,
      errorMessage: () => 'ERROR'
    });

    await service.refresh();
    expect(localePreferenceService().locale.value).toBe('en-US');
    expect(request).toHaveBeenCalledWith('/api/auth/preferences/locale', {
      method: 'PUT',
      body: JSON.stringify({ locale: 'en-US' })
    });
    expect(notice).not.toHaveBeenCalled();

    failToSave = true;
    await service.refresh();
    expect(localePreferenceService().locale.value).toBe('en-US');
    expect(loaded.value).toBe(true);
    expect(onAuthenticated).toHaveBeenCalledTimes(2);
    expect(notice).toHaveBeenCalledWith(
      'Unable to save the language preference. Try again.',
      'error'
    );

    failToSave = false;
    waitForSave = true;
    const pendingRefresh = service.refresh();
    await vi.waitFor(() => expect(finishSave).toBeDefined());
    localePreferenceService().setLocale('zh-CN');
    waitForSave = false;
    finishSave?.();
    await pendingRefresh;
    expect(request).toHaveBeenLastCalledWith('/api/auth/preferences/locale', {
      method: 'PUT',
      body: JSON.stringify({ locale: 'zh-CN' })
    });
  });
});
