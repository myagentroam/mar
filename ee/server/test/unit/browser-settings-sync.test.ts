import { randomUUID } from 'node:crypto';
import type { BrowserControlRequest, BrowserSettingsSnapshot } from '@myagentroam/protocol';
import { expect, it, vi } from 'vitest';
import { BrowserWorkbenchService } from '../../src/service/browser-workbench-service.js';

it('reads the latest account settings at open or attach, and omits them for older Nodes', async () => {
  type Options = ConstructorParameters<typeof BrowserWorkbenchService>[0];
  const browserId = randomUUID();
  const scope = { nodeId: 'node', workspaceId: 'workspace' };
  const owner = { userId: 17, sessionHash: 'session-hash' };
  const identity = { ...owner, workbenchConnectionId: randomUUID() };
  const generation = 'generation';
  const defaults = { revision: 0, cacheCleanupDays: 30 };
  const updated = { revision: 1, cacheCleanupDays: 7 };
  let account: BrowserSettingsSnapshot | undefined = defaults;
  const settings = vi.fn<Options['settings']>(() => account && Promise.resolve(account));
  const request = vi.fn<Options['request']>(async (_node, operation) =>
    operation === 'resource' ? { browserId } : {}
  );
  const send = vi.fn(async () => {});
  const service = new BrowserWorkbenchService({
    workbench: {
      ownsActiveConnection: () => true,
      sendDirectConnection: send
    } as unknown as Options['workbench'],
    direct: {} as Options['direct'],
    request,
    authorize: () => true,
    capability: () => ({ apiVersion: 1, ice: false, nodeGeneration: generation }),
    settings,
    failed: vi.fn()
  });
  async function message(input: BrowserControlRequest['request']) {
    const requestId = randomUUID();
    await service.message(identity, { type: 'browser.request', requestId, request: input });
    expect(send).toHaveBeenLastCalledWith(
      identity.workbenchConnectionId,
      expect.objectContaining({ type: 'browser.response', requestId, result: expect.anything() })
    );
  }

  try {
    const open = { action: 'open', preserveLogin: true } as const;
    await message({ ...scope, action: 'resource', command: open });
    expect(settings).toHaveBeenLastCalledWith(scope.nodeId, generation, owner.userId);
    expect(request).toHaveBeenLastCalledWith(
      scope.nodeId,
      'resource',
      generation,
      { workspaceId: scope.workspaceId, command: open, settings: defaults },
      owner
    );

    account = updated;
    await message({ ...scope, action: 'resource', command: { action: 'lookup' } });
    expect(settings).toHaveBeenCalledTimes(1);
    expect(request.mock.lastCall?.[3]).not.toHaveProperty('settings');

    await message({ ...scope, action: 'resource', command: open });
    expect(request.mock.lastCall?.[3]).toHaveProperty('settings', updated);

    await message({ ...scope, action: 'attach', browserId });
    expect(settings).toHaveBeenLastCalledWith(scope.nodeId, generation, owner.userId);
    expect(request).toHaveBeenLastCalledWith(
      scope.nodeId,
      'attachment',
      generation,
      expect.objectContaining({
        action: 'prepare',
        grant: expect.objectContaining({ browserId, userId: owner.userId }),
        settings: updated
      }),
      owner
    );

    account = undefined;
    await message({ ...scope, action: 'resource', command: open });
    expect(request.mock.lastCall?.[3]).not.toHaveProperty('settings');
    await message({ ...scope, action: 'attach', browserId });
    expect(request.mock.lastCall?.[3]).not.toHaveProperty('settings');
  } finally {
    service.close();
  }
});
