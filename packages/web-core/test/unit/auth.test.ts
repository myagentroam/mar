import { afterEach, describe, expect, it, vi } from 'vitest';
import { authFixture } from './support/auth-fixture.js';
import { ApiError } from '../../src/util/api-error.js';

afterEach(() => vi.unstubAllGlobals());
describe('shared browser authentication lifecycle', () => {
  it('logs in with the selected locale, retains CSRF only in tab storage and restores the host', async () => {
    const f = authFixture('en-US');
    f.request.mockResolvedValue({
      authenticated: true,
      mustChangePassword: false,
      csrfToken: 'csrf',
      locale: 'zh-CN'
    });
    await f.service.login({ username: 'admin', password: 'fixture-secret' });
    expect(JSON.parse(f.request.mock.calls[0]![1].body)).toEqual({
      username: 'admin',
      password: 'fixture-secret',
      locale: 'en-US'
    });
    expect(f.state.admin.value.authenticated).toBe(true);
    expect(f.storage.get('mar.user.csrf-token')).toBe('csrf');
    expect(JSON.stringify([...f.storage])).not.toContain('fixture-secret');
    expect(f.i18n.global.locale.value).toBe('en-US');
    expect(f.request.mock.calls[1]).toEqual([
      '/api/auth/preferences/locale',
      { method: 'PUT', body: JSON.stringify({ locale: 'en-US' }) }
    ]);
    expect(f.restore).toHaveBeenCalledOnce();
    expect(f.loading.value).toBe(false);
  });

  it('holds the password gate and validates both new password fields before writing', async () => {
    const f = authFixture();
    f.request.mockResolvedValue({
      authenticated: true,
      mustChangePassword: true,
      csrfToken: 'csrf'
    });
    await f.service.login({ username: 'admin', password: 'initial-password' });
    expect(f.restore).not.toHaveBeenCalled();
    f.request.mockClear();
    await f.service.changePassword({
      currentPassword: 'initial-password',
      password: 'short',
      confirmation: 'short'
    });
    expect(f.state.passwordValidationError.value).toContain('8');
    await f.service.changePassword({
      currentPassword: 'initial-password',
      password: 'long-password',
      confirmation: 'different'
    });
    expect(f.state.passwordValidationError.value).toBe(
      f.i18n.global.t('generated.adminAuthService.theNewPasswordsDoNotMatch')
    );
    expect(f.request).not.toHaveBeenCalled();
    f.request
      .mockResolvedValueOnce({
        authenticated: true,
        mustChangePassword: false,
        csrfToken: 'new-csrf'
      })
      .mockResolvedValueOnce({ sessions: [] });
    f.state.newPassword.value = 'long-password';
    await f.service.changePassword({
      currentPassword: 'initial-password',
      password: 'long-password',
      confirmation: 'long-password'
    });
    expect(f.state.newPassword.value).toBe('');
    expect(f.state.csrfToken.value).toBe('new-csrf');
    expect(f.restore).toHaveBeenCalledOnce();
    expect(f.request.mock.calls[1]![0]).toBe('/api/auth/sessions');
  });

  it('reveals authenticated state before host recovery and does not discard it on a Node failure', async () => {
    const f = authFixture();
    f.storage.set('mar.user.csrf-token', 'csrf');
    f.request.mockResolvedValue({ authenticated: true, mustChangePassword: false });
    f.restore.mockImplementation(async () => {
      expect(f.state.loaded.value).toBe(true);
      throw new Error('NODE_REQUEST_TIMEOUT');
    });
    await f.service.refresh();
    expect(f.state.admin.value.authenticated).toBe(true);
    expect(f.notice).toHaveBeenCalledWith(
      f.i18n.global.t('generated.adminAuthService.workbenchRecoveryFailed', {
        value0: 'NODE_REQUEST_TIMEOUT'
      })
    );
    expect(f.renew).not.toHaveBeenCalled();
  });

  it('renews missing CSRF during restore and ignores identity arriving after sign-out', async () => {
    const f = authFixture();
    f.request.mockResolvedValueOnce({ authenticated: true, mustChangePassword: false });
    await f.service.refresh();
    expect(f.renew).toHaveBeenCalledOnce();
    let complete!: (value: unknown) => void;
    f.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        })
    );
    const pending = f.service.refresh();
    f.service.returnToLogin();
    complete({ authenticated: true, mustChangePassword: false });
    await pending;
    expect(f.state.admin.value.authenticated).toBe(false);
    expect(f.state.sessions.value).toEqual([]);
    expect(f.storage.size).toBe(0);
  });

  it.each(['zh-CN', 'en-US'] as const)(
    'preserves the current page and identity when an authentication check fails (%s)',
    async (locale) => {
      const f = authFixture(locale);
      const identity = { authenticated: true, mustChangePassword: false, username: 'admin' };
      f.state.admin.value = identity;
      f.state.loaded.value = true;
      f.state.csrfToken.value = 'saved-csrf';
      f.storage.set('mar.user.csrf-token', 'saved-csrf');
      for (const error of [
        new TypeError('Failed to fetch'),
        new ApiError('REQUEST_FAILED_503', 'Server unavailable')
      ]) {
        f.request.mockRejectedValueOnce(error);
        await f.service.refresh();
        expect(f.state.admin.value).toEqual(identity);
        expect(f.state.loaded.value).toBe(true);
        expect(f.state.csrfToken.value).toBe('saved-csrf');
        expect(f.storage.get('mar.user.csrf-token')).toBe('saved-csrf');
        expect(f.signedOut).not.toHaveBeenCalled();
        expect(f.restore).not.toHaveBeenCalled();
        expect(f.notice).toHaveBeenLastCalledWith(
          locale === 'zh-CN'
            ? `无法确认登录状态，请刷新重试：${error.message}`
            : `Unable to verify sign-in status. Refresh to retry: ${error.message}`
        );
      }
    }
  );

  it('does not reveal login or discard tab CSRF when the initial check fails', async () => {
    const f = authFixture();
    f.storage.set('mar.user.csrf-token', 'saved-csrf');
    f.request.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await f.service.refresh();
    expect(f.state.loaded.value).toBe(false);
    expect(f.storage.get('mar.user.csrf-token')).toBe('saved-csrf');
    expect(f.signedOut).not.toHaveBeenCalled();
    expect(f.restore).not.toHaveBeenCalled();
    f.request.mockResolvedValueOnce({ authenticated: true, mustChangePassword: false });
    await f.service.refresh();
    expect(f.state.loaded.value).toBe(true);
    expect(f.state.admin.value.authenticated).toBe(true);
    expect(f.restore).toHaveBeenCalledOnce();
  });

  it('preserves identity and CSRF when authentication recovery renewal fails', async () => {
    const f = authFixture();
    const identity = { authenticated: true, mustChangePassword: false, username: 'admin' };
    f.state.admin.value = identity;
    f.state.loaded.value = true;
    f.state.csrfToken.value = 'current-csrf';
    f.request.mockResolvedValue({
      authenticated: true,
      mustChangePassword: false,
      username: 'other'
    });
    f.renew.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await f.service.refresh();
    expect(f.state.admin.value).toEqual(identity);
    expect(f.state.csrfToken.value).toBe('current-csrf');
    expect(f.state.loaded.value).toBe(true);
    expect(f.signedOut).not.toHaveBeenCalled();
    expect(f.restore).not.toHaveBeenCalled();
    expect(f.notice).toHaveBeenCalledWith('无法确认登录状态，请刷新重试：Failed to fetch');
  });

  it.each(['response', 'error'] as const)(
    'still clears tab identity when recovery explicitly confirms sign-out (%s)',
    async (result) => {
      const f = authFixture();
      f.state.admin.value = { authenticated: true, mustChangePassword: false };
      f.state.csrfToken.value = 'old-csrf';
      f.storage.set('mar.user.csrf-token', 'old-csrf');
      if (result === 'response')
        f.request.mockResolvedValueOnce({ authenticated: false, mustChangePassword: false });
      else f.request.mockRejectedValueOnce(new ApiError('UNAUTHENTICATED', 'Sign-in required'));
      await f.service.refresh();
      expect(f.state.admin.value.authenticated).toBe(false);
      expect(f.state.loaded.value).toBe(true);
      expect(f.state.csrfToken.value).toBe('');
      expect(f.storage.size).toBe(0);
      expect(f.signedOut).toHaveBeenCalledOnce();
      expect(f.notice).not.toHaveBeenCalled();
    }
  );

  it('revokes another session and refreshes the list, then clears tab identity when revoking this session', async () => {
    const f = authFixture();
    f.state.admin.value = { authenticated: true, mustChangePassword: false };
    const session = {
      id: 'session/one',
      current: false,
      createdAt: 1,
      expiresAt: 2,
      ipAddress: '127.0.0.1',
      userAgent: 'fixture'
    };
    f.request.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ sessions: [] });
    await f.service.logoutSession(session);
    expect(f.request.mock.calls[0]![0]).toBe('/api/auth/sessions/session%2Fone');
    expect(f.signedOut).not.toHaveBeenCalled();
    f.request.mockResolvedValueOnce(undefined);
    await f.service.logoutSession({ ...session, current: true });
    expect(f.signedOut).toHaveBeenCalledOnce();
    expect(f.state.admin.value.authenticated).toBe(false);
  });

  it.each(['en-US', 'zh-CN'] as const)(
    'keeps failed logout authenticated and displays a localized failure (%s)',
    async (locale) => {
      const f = authFixture(locale);
      f.state.admin.value = { authenticated: true, mustChangePassword: false };
      f.request.mockRejectedValueOnce(new Error('NETWORK_FAILED'));
      await f.service.logout();
      expect(f.state.admin.value.authenticated).toBe(true);
      expect(f.signedOut).not.toHaveBeenCalled();
      expect(f.notice.mock.calls.at(-1)![0]).toContain('NETWORK_FAILED');
      expect(f.loading.value).toBe(false);
      f.request.mockResolvedValueOnce(undefined);
      await f.service.logout();
      expect(f.state.admin.value.authenticated).toBe(false);
    }
  );
});
