import type { Pool } from 'mysql2/promise';
import { describe, expect, it, vi } from 'vitest';
import { MarctlUserCredentials } from '../../src/marctl-user-credentials.js';

describe('user-scoped marctl authorization', () => {
  it('preserves channel execution authority without fabricating an owner login Session', async () => {
    let enabled = true;
    const execute = vi.fn(async (_sql: string, _parameters: unknown[]) => [
      enabled ? [{ id: 7, username: 'owner' }] : []
    ]);
    const service = new MarctlUserCredentials({ execute } as unknown as Pool);
    const scope = { nodeId: 'node-one', workspaceId: 'workspace-one' };
    const environment = await service.environment(
      { userId: 7, username: 'owner', sessionHash: 'c'.repeat(43), channel: true },
      'https://server.test',
      scope
    );
    const context = await service.authenticateContext(`Bearer ${environment.MAR_CTL_USER_TOKEN}`);
    expect(context).toMatchObject({ channel: true, scheduled: false, scope, user: { userId: 7 } });
    expect(execute.mock.calls.at(-1)?.[0]).not.toContain('user_sessions');
    const derived = await service.environment(
      {
        ...context!.user,
        ...(context!.channel === undefined ? {} : { channel: context!.channel })
      },
      'https://server.test',
      context!.scope
    );
    expect(await service.authenticateContext(`Bearer ${derived.MAR_CTL_USER_TOKEN}`)).toMatchObject(
      { channel: true, scheduled: false, scope }
    );
    enabled = false;
    expect(await service.authenticate(`Bearer ${environment.MAR_CTL_USER_TOKEN}`)).toBeUndefined();
  });
  it('validates active browser sessions and expires the delegation without exposing its token', async () => {
    let now = 1000;
    let active = true;
    const execute = vi.fn(async (_sql: string, parameters: unknown[]) => [
      active && parameters[0] === 'a'.repeat(43) ? [{ id: 7 }] : []
    ]);
    const service = new MarctlUserCredentials({ execute } as unknown as Pool, () => now);
    const environment = await service.environment(
      { userId: 7, sessionHash: 'a'.repeat(43), username: 'alice' },
      'https://server.test'
    );
    expect(environment).toMatchObject({
      MAR_CTL_CONTEXT_REQUIRED: '1',
      MAR_USERNAME: 'alice',
      MAR_CTL_SERVER_URL: 'https://server.test'
    });
    const token = environment.MAR_CTL_USER_TOKEN!;
    expect(token).toMatch(/^marctl_user_[A-Za-z0-9_-]{43}$/u);
    expect(await service.authenticate(`Bearer ${token}`)).toEqual({
      userId: 7,
      sessionHash: 'a'.repeat(43)
    });
    active = false;
    expect(await service.authenticate(`Bearer ${token}`)).toBeUndefined();
    active = true;
    now += 60 * 60 * 1000;
    expect(await service.authenticate(`Bearer ${token}`)).toBeDefined();
    now = 1000 + 24 * 60 * 60 * 1000 - 1;
    expect(await service.authenticate(`Bearer ${token}`)).toBeDefined();
    now++;
    expect(await service.authenticate(`Bearer ${token}`)).toBeUndefined();
    expect(await service.authenticate('Bearer invalid')).toBeUndefined();
  });

  it('accepts only server-issued scheduled owner contexts and rejects invalid server origins', async () => {
    let enabled = true;
    const execute = vi.fn(async (_sql: string) => [
      enabled ? [{ id: 9, username: 'task-owner' }] : []
    ]);
    const service = new MarctlUserCredentials({ execute } as unknown as Pool);
    expect(await service.environment({ userId: 9 }, undefined)).toEqual({
      MAR_CTL_CONTEXT_REQUIRED: '1',
      MAR_USERNAME: 'task-owner'
    });
    await expect(service.environment({ userId: 9 }, 'http://remote.test')).rejects.toThrow(
      'MARCTL_SERVER_URL_INVALID'
    );
    const environment = await service.environment({ userId: 9 }, 'https://server.test');
    expect(environment.MAR_USERNAME).toBe('task-owner');
    const authenticated = await service.authenticate(`Bearer ${environment.MAR_CTL_USER_TOKEN}`);
    expect(authenticated?.userId).toBe(9);
    expect(authenticated?.sessionHash).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    enabled = false;
    expect(await service.authenticate(`Bearer ${environment.MAR_CTL_USER_TOKEN}`)).toBeUndefined();
    expect(execute.mock.calls.at(-1)?.[0]).toContain('u.enabled=TRUE');
    await expect(service.environment({ userId: 9 }, 'https://server.test')).rejects.toThrow(
      'USER_AUTHORIZATION_REQUIRED'
    );
  });

  it('binds sessions to the source Workspace and preserves scheduled provenance across derived inputs', async () => {
    const execute = vi.fn(async (_sql: string) => [[{ id: 9, username: 'task-owner' }]]);
    const service = new MarctlUserCredentials({ execute } as unknown as Pool);
    const scope = { nodeId: 'node-one', workspaceId: 'workspace-one' };
    const environment = await service.environment({ userId: 9 }, 'https://server.test', scope);
    const context = await service.authenticateContext(`Bearer ${environment.MAR_CTL_USER_TOKEN}`);
    expect(context).toMatchObject({ scheduled: true, scope, user: { userId: 9 } });
    const derived = await service.environment(
      { ...context!.user, scheduled: context!.scheduled },
      'https://server.test',
      context!.scope
    );
    expect(await service.authenticateContext(`Bearer ${derived.MAR_CTL_USER_TOKEN}`)).toMatchObject(
      { scheduled: true, scope }
    );
    expect(execute.mock.calls.at(-1)?.[0]).not.toContain('user_sessions');
    const legacy = await service.environment({ userId: 9 }, 'https://server.test');
    expect(
      await service.authenticateContext(`Bearer ${legacy.MAR_CTL_USER_TOKEN}`)
    ).not.toHaveProperty('scope');
  });

  it('rejects invalid usernames and does not turn a username-only context into a credential', async () => {
    const execute = vi.fn(async () => [[{ username: 'bob' }]]);
    const service = new MarctlUserCredentials({ execute } as unknown as Pool);
    expect(await service.userEnvironment({ userId: 8 })).toEqual({ MAR_USERNAME: 'bob' });
    expect(await service.userEnvironment({ userId: 7, username: 'alice' })).toEqual({
      MAR_USERNAME: 'alice'
    });
    expect(execute).toHaveBeenCalledTimes(1);
    for (const username of ['', 'bad\0name', 'bad\nname', 'x'.repeat(129)])
      await expect(service.userEnvironment({ userId: 7, username })).rejects.toThrow(
        'USER_AUTHORIZATION_REQUIRED'
      );
  });
});
