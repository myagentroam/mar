import { afterEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { authFixture } from './support/auth-fixture.js';
import { createWorkbenchHttpService } from '../../src/service/WorkbenchHttpService.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

afterEach(() => vi.unstubAllGlobals());

describe('authentication generation boundaries', () => {
  it('ignores a late authentication failure after a newer refresh succeeds', async () => {
    const f = authFixture();
    f.storage.set('mar.user.csrf-token', 'csrf');
    let reject!: (error: unknown) => void;
    f.request.mockReturnValueOnce(new Promise((_, fail) => (reject = fail)));
    const oldRefresh = f.service.refresh();
    f.request.mockResolvedValueOnce({ authenticated: true, mustChangePassword: false });
    await f.service.refresh();
    reject(new TypeError('Failed to fetch'));
    await oldRefresh;
    expect(f.state.admin.value.authenticated).toBe(true);
    expect(f.state.loaded.value).toBe(true);
    expect(f.signedOut).not.toHaveBeenCalled();
    expect(f.notice).not.toHaveBeenCalled();
  });

  it('does not restore the workbench after signing out during CSRF renewal', async () => {
    const f = authFixture();
    const renewal = deferred<string>();
    f.request.mockResolvedValue({ authenticated: true, mustChangePassword: false });
    f.renew.mockReturnValueOnce(renewal.promise);
    const refresh = f.service.refresh();
    await vi.waitFor(() => expect(f.renew).toHaveBeenCalledOnce());
    f.service.returnToLogin();
    renewal.resolve('old-csrf');
    await refresh;
    expect(f.restore).not.toHaveBeenCalled();
    expect(f.state.admin.value.authenticated).toBe(false);
  });

  it.each(['login', 'password'] as const)(
    'discards a late %s response after authentication is revoked',
    async (operation) => {
      const f = authFixture();
      const response = deferred<unknown>();
      f.request.mockReturnValueOnce(response.promise);
      const pending =
        operation === 'login'
          ? f.service.login({ username: 'admin', password: 'fixture-password' })
          : f.service.changePassword({
              currentPassword: 'fixture-password',
              password: 'updated-password',
              confirmation: 'updated-password'
            });
      f.service.returnToLogin();
      response.resolve({
        authenticated: true,
        mustChangePassword: false,
        csrfToken: 'revoked-csrf'
      });
      await pending;
      expect(f.restore).not.toHaveBeenCalled();
      expect(f.state.admin.value.authenticated).toBe(false);
      expect(f.state.csrfToken.value).toBe('');
      expect(f.storage.size).toBe(0);
    }
  );

  it('does not repopulate the session list after signing out', async () => {
    const f = authFixture();
    const response = deferred<unknown>();
    f.state.admin.value = { authenticated: true, mustChangePassword: false };
    f.request.mockReturnValueOnce(response.promise);
    const pending = f.service.refreshSessions();
    f.service.returnToLogin();
    response.resolve({ sessions: [{ id: 'old-session' }] });
    await pending;
    expect(f.state.sessions.value).toEqual([]);
  });

  it('drops an invalidated renewal without replacing a newer CSRF token', async () => {
    const response = deferred<Response>();
    const csrfToken = ref('');
    const setItem = vi.fn();
    vi.stubGlobal('window', { sessionStorage: { setItem } });
    const fetchMock = vi.fn<typeof fetch>().mockReturnValueOnce(response.promise);
    vi.stubGlobal('fetch', fetchMock);
    const http = createWorkbenchHttpService({
      csrfToken,
      csrfStorageKey: 'csrf',
      onUnauthenticated: vi.fn()
    });
    const renewal = http.renewCsrfToken();
    const rejected = expect(renewal).rejects.toMatchObject({ name: 'AbortError' });
    http.invalidateAuthentication();
    csrfToken.value = 'new-session-csrf';
    response.resolve(Response.json({ csrfToken: 'old-session-csrf' }));
    await rejected;
    expect(csrfToken.value).toBe('new-session-csrf');
    expect(setItem).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(Response.json({ csrfToken: 'current-csrf' }));
    await expect(http.renewCsrfToken()).resolves.toBe('current-csrf');
  });

  it('ignores an unauthenticated response from a previous identity', async () => {
    const response = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockReturnValueOnce(response.promise));
    const onUnauthenticated = vi.fn();
    const http = createWorkbenchHttpService({
      csrfToken: ref(''),
      csrfStorageKey: 'csrf',
      onUnauthenticated
    });
    const request = http.request('/api/auth/me');
    const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' });
    http.invalidateAuthentication();
    response.resolve(Response.json({ error: 'UNAUTHENTICATED' }, { status: 401 }));
    await rejected;
    expect(onUnauthenticated).not.toHaveBeenCalled();
  });
});
