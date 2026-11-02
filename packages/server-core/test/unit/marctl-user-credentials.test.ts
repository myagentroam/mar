import { createHmac } from 'node:crypto';
import type { Pool } from 'mysql2/promise';
import { describe, expect, it, vi } from 'vitest';
import { MarctlUserCredentials } from '../../src/marctl-user-credentials.js';

describe('user-scoped marctl authorization', () => {
  it('keeps live credentials and delegation valid across a Server restart without renewing expiry', async () => {
    let now = 1000;
    let active = true;
    const pool = {
      execute: vi.fn(async () => [active ? [{ id: 7 }] : []])
    } as unknown as Pool;
    const scope = { nodeId: 'node-one', workspaceId: 'workspace-one' };
    const first = new MarctlUserCredentials(pool, Buffer.alloc(32, 7), () => now);
    const terminal = first.issue({ userId: 7, sessionHash: 'a'.repeat(43) }, scope);
    const parentToken = first.issue({ userId: 7, sessionHash: 'a'.repeat(43) }, scope, {
      type: 'delegation'
    });
    const input = {
      parentToken,
      ...scope,
      userId: 7,
      sessionId: 'child',
      executionId: 'execution-one',
      authorize: vi.fn(async () => true)
    };
    const execution = await first.deriveExecution(input);
    const restarted = new MarctlUserCredentials(pool, Buffer.alloc(32, 7), () => now);
    expect(await restarted.authenticateContext(`Bearer ${terminal}`)).toMatchObject({
      user: { userId: 7 },
      scope,
      source: { type: 'terminal' }
    });
    expect(await restarted.authenticateContext(`Bearer ${execution}`)).toMatchObject({
      source: { type: 'execution', executionId: 'execution-one' }
    });
    now += 60_000;
    const next = await restarted.deriveExecution({ ...input, executionId: 'execution-two' });
    expect(await restarted.authenticateContext(`Bearer ${next}`)).toMatchObject({
      source: { type: 'execution', executionId: 'execution-two' },
      expiresAt: 1000 + 24 * 60 * 60 * 1000
    });
    active = false;
    expect(await restarted.authenticate(`Bearer ${next}`)).toBeUndefined();
    active = true;
    now = 1000 + 24 * 60 * 60 * 1000;
    expect(await restarted.authenticate(`Bearer ${next}`)).toBeUndefined();
    await expect(restarted.deriveExecution(input)).rejects.toThrow(
      'MARCTL_EXECUTION_AUTHORIZATION_INVALID'
    );
  });

  it('derives execution-bound credentials only within the original live user scope', async () => {
    let now = 1000;
    let active = true;
    const execute = vi.fn(async () => [active ? [{ id: 7, username: 'owner' }] : []]);
    const service = new MarctlUserCredentials(
      { execute } as unknown as Pool,
      Buffer.alloc(32, 7),
      () => now
    );
    const scope = { nodeId: 'node-one', workspaceId: 'workspace-one' };
    const authorization = await service.environment(
      { userId: 7, sessionHash: 'a'.repeat(43), username: 'owner' },
      'https://server.test',
      scope,
      { type: 'delegation' }
    );
    const input = {
      parentToken: authorization.MAR_CTL_USER_TOKEN!,
      ...scope,
      userId: 7,
      sessionId: 'child',
      executionId: 'execution-one',
      authorize: vi.fn(async () => true)
    };
    const first = await service.deriveExecution(input);
    const second = await service.deriveExecution({ ...input, executionId: 'execution-two' });
    expect(first).not.toBe(second);
    expect(await service.authenticateContext(`Bearer ${first}`)).toMatchObject({
      scope,
      user: { userId: 7 },
      source: { type: 'execution', sessionId: 'child', executionId: 'execution-one' }
    });
    expect(await service.authenticateContext(`Bearer ${second}`)).toMatchObject({
      source: { type: 'execution', executionId: 'execution-two' }
    });
    for (const invalid of [
      { ...input, nodeId: 'other' },
      { ...input, workspaceId: 'other' },
      { ...input, userId: 8 },
      { ...input, parentToken: first },
      { ...input, authorize: vi.fn(async () => false) }
    ])
      await expect(service.deriveExecution(invalid)).rejects.toThrow(
        'MARCTL_EXECUTION_AUTHORIZATION_INVALID'
      );
    active = false;
    await expect(service.deriveExecution(input)).rejects.toThrow(
      'MARCTL_EXECUTION_AUTHORIZATION_INVALID'
    );
    active = true;
    now += 24 * 60 * 60 * 1000;
    expect(await service.authenticateContext(`Bearer ${first}`)).toBeUndefined();
    await expect(service.deriveExecution(input)).rejects.toThrow(
      'MARCTL_EXECUTION_AUTHORIZATION_INVALID'
    );
  });

  it('rejects tampered, malformed and differently signed credentials before querying authorization', async () => {
    const execute = vi.fn(async () => [[{ id: 7 }]]);
    const pool = { execute } as unknown as Pool;
    const service = new MarctlUserCredentials(pool, Buffer.alloc(32, 7));
    const token = service.issue(
      { userId: 7, sessionHash: 'a'.repeat(43) },
      { nodeId: 'node', workspaceId: 'workspace' },
      { type: 'delegation' }
    );
    const [body, signature] = token.slice('marctl_user_'.length).split('.');
    const claims = JSON.parse(Buffer.from(body!, 'base64url').toString());
    claims.scope.workspaceId = 'other-workspace';
    const tampered = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const otherKey = new MarctlUserCredentials(pool, Buffer.alloc(32, 8));
    expect(await otherKey.authenticate(`Bearer ${token}`)).toBeUndefined();
    const otherPurpose = createHmac('sha256', Buffer.alloc(32, 7))
      .update('mar:model-usage:v1\0')
      .update(body!)
      .digest('base64url');
    for (const invalid of [
      `marctl_user_${tampered}.${signature}`,
      `marctl_user_${body}.${otherPurpose}`,
      `${token.slice(0, -1)}!`,
      `${token}.extra`,
      `marctl_user_${'a'.repeat(43)}`,
      `marctl_user_${'a'.repeat(16_384)}.${signature}`
    ])
      expect(await service.authenticate(`Bearer ${invalid}`)).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
    expect(await service.authenticate(`Bearer ${token}`)).toMatchObject({ userId: 7 });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('distinguishes terminal credentials and rechecks authorization after an asynchronous decision', async () => {
    let now = 1000;
    const execute = vi.fn(async () => [[{ id: 7, username: 'owner' }]]);
    const service = new MarctlUserCredentials(
      { execute } as unknown as Pool,
      Buffer.alloc(32, 7),
      () => now
    );
    const scope = { nodeId: 'node', workspaceId: 'workspace' };
    const terminal = await service.environment(
      { userId: 7, username: 'owner' },
      'https://server.test',
      scope
    );
    expect(
      await service.authenticateContext(`Bearer ${terminal.MAR_CTL_USER_TOKEN}`)
    ).toMatchObject({
      source: { type: 'terminal' }
    });
    const delegation = await service.environment(
      { userId: 7, username: 'owner' },
      'https://server.test',
      scope,
      { type: 'delegation' }
    );
    const input = {
      parentToken: delegation.MAR_CTL_USER_TOKEN!,
      ...scope,
      userId: 7,
      sessionId: 'child',
      executionId: 'execution',
      authorize: async () => {
        now += 24 * 60 * 60 * 1000;
        return true;
      }
    };
    await expect(service.deriveExecution(input)).rejects.toThrow(
      'MARCTL_EXECUTION_AUTHORIZATION_INVALID'
    );
    now = 1000;
    await expect(
      service.deriveExecution({ ...input, parentToken: terminal.MAR_CTL_USER_TOKEN! })
    ).rejects.toThrow('MARCTL_EXECUTION_AUTHORIZATION_INVALID');
  });

  it('preserves channel execution authority without fabricating an owner login Session', async () => {
    let enabled = true;
    const execute = vi.fn(async (_sql: string, _parameters: unknown[]) => [
      enabled ? [{ id: 7, username: 'owner' }] : []
    ]);
    const service = new MarctlUserCredentials({ execute } as unknown as Pool, Buffer.alloc(32, 7));
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
    const service = new MarctlUserCredentials(
      { execute } as unknown as Pool,
      Buffer.alloc(32, 7),
      () => now
    );
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
    expect(token).toMatch(/^marctl_user_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u);
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
    const service = new MarctlUserCredentials({ execute } as unknown as Pool, Buffer.alloc(32, 7));
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
    expect(await service.authenticate(`Bearer ${environment.MAR_CTL_USER_TOKEN}`)).toEqual(
      authenticated
    );
    enabled = false;
    expect(await service.authenticate(`Bearer ${environment.MAR_CTL_USER_TOKEN}`)).toBeUndefined();
    expect(execute.mock.calls.at(-1)?.[0]).toContain('u.enabled=TRUE');
    await expect(service.environment({ userId: 9 }, 'https://server.test')).rejects.toThrow(
      'USER_AUTHORIZATION_REQUIRED'
    );
  });

  it('binds sessions to the source Workspace and preserves scheduled provenance across derived inputs', async () => {
    const execute = vi.fn(async (_sql: string) => [[{ id: 9, username: 'task-owner' }]]);
    const service = new MarctlUserCredentials({ execute } as unknown as Pool, Buffer.alloc(32, 7));
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
    const service = new MarctlUserCredentials({ execute } as unknown as Pool, Buffer.alloc(32, 7));
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
