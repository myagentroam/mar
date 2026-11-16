import { afterEach, describe, expect, it, vi } from 'vitest';
import { authFixture } from './support/auth-fixture.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

afterEach(() => vi.unstubAllGlobals());

describe('authentication account lifecycle', () => {
  it.each([17, 29])(
    'confirms the account on password change without resetting an unchanged user %s',
    async (userId) => {
      const f = authFixture();
      f.state.admin.value = { authenticated: true, userId: 17, mustChangePassword: false };
      f.request.mockResolvedValue({
        authenticated: true,
        userId,
        mustChangePassword: false,
        csrfToken: 'changed-csrf',
        sessions: []
      });
      const events: string[] = [];
      f.signedOut.mockImplementation(() => events.push('end'));
      f.accountChanged.mockImplementation((id) => events.push(`bind:${id}`));
      const changed = await f.service.changePassword({
        currentPassword: 'fixture-current-password',
        password: 'new-password-long-enough',
        confirmation: 'new-password-long-enough'
      });
      expect(changed).toBe(true);
      expect(events).toEqual(userId === 17 ? [] : ['end', 'bind:29']);
      expect(f.state.admin.value.userId).toBe(userId);
      expect(f.state.csrfToken.value).toBe('changed-csrf');
    }
  );

  it('rejects a successful password response that has no account identity', async () => {
    const f = authFixture();
    f.state.admin.value = { authenticated: true, userId: 17, mustChangePassword: false };
    f.request.mockResolvedValue({
      authenticated: true,
      mustChangePassword: false,
      csrfToken: 'unbound'
    });
    expect(
      await f.service.changePassword({
        currentPassword: 'fixture-current-password',
        password: 'new-password-long-enough',
        confirmation: 'new-password-long-enough'
      })
    ).toBe(false);
    expect(f.state.admin.value.userId).toBe(17);
    expect(f.accountChanged).not.toHaveBeenCalled();
    expect(f.state.csrfToken.value).not.toBe('unbound');
  });

  it('always ends the old account even when the browser refuses token removal', () => {
    const f = authFixture();
    f.state.admin.value = { authenticated: true, userId: 17, mustChangePassword: false };
    vi.spyOn(window.sessionStorage, 'removeItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    expect(() => f.service.returnToLogin()).not.toThrow();
    expect(f.signedOut).toHaveBeenCalledOnce();
    expect(f.state.admin.value.authenticated).toBe(false);
  });

  it('ends the previous account before notifying and publishing a confirmed switch', async () => {
    const f = authFixture();
    f.state.admin.value = { authenticated: true, userId: 17, mustChangePassword: false };
    f.storage.set('mar.user.csrf-token', 'tab-csrf');
    const events: string[] = [];
    f.signedOut.mockImplementation(() => events.push('signed-out'));
    f.accountChanged.mockImplementation((userId) => {
      events.push(`account-changed:${userId}:published=${f.state.admin.value.authenticated}`);
    });
    f.request.mockResolvedValueOnce({
      authenticated: true,
      userId: 29,
      mustChangePassword: false
    });

    await f.service.refresh();

    expect(events).toEqual(['signed-out', 'account-changed:29:published=false']);
    expect(f.state.admin.value).toMatchObject({ authenticated: true, userId: 29 });
  });

  it('keeps the workbench identity key stable across same-user refreshes', async () => {
    const f = authFixture();
    f.state.admin.value = { authenticated: true, userId: 17, mustChangePassword: false };
    f.storage.set('mar.user.csrf-token', 'tab-csrf');
    f.request
      .mockResolvedValueOnce({ authenticated: true, userId: 17, mustChangePassword: false })
      .mockResolvedValueOnce({ authenticated: true, userId: 17, mustChangePassword: false });

    await f.service.refresh();
    const accountKey = f.service.view.accountKey;
    await f.service.refresh();

    expect(f.service.view.accountKey).toBe(accountKey);
    expect(f.state.admin.value.userId).toBe(17);
    expect(f.signedOut).not.toHaveBeenCalled();
  });

  it('resets the prior account after a fresh login succeeds', async () => {
    const f = authFixture();
    f.request
      .mockResolvedValueOnce({
        authenticated: true,
        userId: 17,
        mustChangePassword: false,
        csrfToken: 'alice-csrf'
      })
      .mockResolvedValueOnce({
        authenticated: true,
        userId: 29,
        mustChangePassword: false,
        csrfToken: 'bob-csrf'
      });
    await f.service.login({ username: 'alice', password: 'fixture-password' });
    const previousAccountKey = f.service.view.accountKey;
    const events: string[] = [];
    f.signedOut.mockImplementation(() => events.push('signed-out'));
    f.accountChanged.mockImplementation((userId) => {
      events.push(`account-changed:${userId}:published=${f.state.admin.value.authenticated}`);
    });

    await f.service.login({ username: 'bob', password: 'fixture-password' });

    expect(events).toEqual(['signed-out', 'account-changed:29:published=false']);
    expect(f.service.view.accountKey).not.toBe(previousAccountKey);
    expect(f.state.admin.value).toMatchObject({ authenticated: true, userId: 29 });
  });

  it('does not revive the old account when CSRF renewal fails after a confirmed switch', async () => {
    const f = authFixture();
    f.state.admin.value = { authenticated: true, userId: 17, mustChangePassword: false };
    f.state.csrfToken.value = 'alice-csrf';
    const renewalError = new Error('CSRF_RENEWAL_FAILED');
    f.request.mockResolvedValueOnce({
      authenticated: true,
      userId: 29,
      mustChangePassword: false
    });
    f.renew.mockRejectedValueOnce(renewalError);

    await f.service.refresh();

    expect(f.state.admin.value.authenticated).toBe(false);
    expect(f.state.admin.value.userId).toBeUndefined();
    expect(f.state.csrfToken.value).toBe('');
    expect(f.signedOut).toHaveBeenCalledOnce();
    expect(f.accountChanged).not.toHaveBeenCalled();
    expect(f.restore).not.toHaveBeenCalled();
  });

  it('ignores a stale refresh response after a newer account has been confirmed', async () => {
    const f = authFixture();
    const staleResponse = deferred<unknown>();
    f.request.mockReturnValueOnce(staleResponse.promise).mockResolvedValueOnce({
      authenticated: true,
      userId: 29,
      mustChangePassword: false
    });
    const staleRefresh = f.service.refresh();
    await f.service.refresh();
    staleResponse.resolve({ authenticated: true, userId: 17, mustChangePassword: false });
    await staleRefresh;

    expect(f.state.admin.value).toMatchObject({ authenticated: true, userId: 29 });
    expect(f.accountChanged).toHaveBeenCalledOnce();
    expect(f.accountChanged).toHaveBeenCalledWith(29);
    expect(f.restore).toHaveBeenCalledOnce();
  });

  it.each(['login', 'refresh'] as const)(
    'does not publish a successful %s response without a user ID',
    async (operation) => {
      const f = authFixture();
      f.request.mockResolvedValueOnce({
        authenticated: true,
        mustChangePassword: false,
        ...(operation === 'login' ? { csrfToken: 'csrf-without-identity' } : {})
      });

      if (operation === 'login')
        await f.service.login({ username: 'alice', password: 'fixture-password' });
      else await f.service.refresh();

      expect(f.state.admin.value.authenticated).toBe(false);
      expect(f.state.admin.value.userId).toBeUndefined();
      expect(f.accountChanged).not.toHaveBeenCalled();
      expect(f.restore).not.toHaveBeenCalled();
      expect(f.notice).toHaveBeenCalledOnce();
    }
  );
});
