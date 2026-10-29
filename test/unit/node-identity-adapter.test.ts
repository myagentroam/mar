import { describe, expect, it, vi } from 'vitest';
import { NodeControl } from '../../ee/server/src/node-control.js';

describe('enterprise Node identity persistence boundary', () => {
  it('rejects outstanding requests when an authenticated connection is replaced', () => {
    const rejectNode = vi.fn();
    const activateNodeConnection = vi.fn();
    const receiver = {
      requestBroker: { rejectNode },
      runtimeCredentials: { activateNodeConnection },
      workbenchRelay: { broadcast: vi.fn() }
    };
    const hooks = NodeControl.prototype as unknown as {
      onNodeConnected(nodeId: string, replaced: boolean): void;
    };
    hooks.onNodeConnected.call(receiver, 'node-1', false);
    expect(rejectNode).not.toHaveBeenCalled();
    expect(activateNodeConnection).toHaveBeenCalledExactlyOnceWith('node-1');
    hooks.onNodeConnected.call(receiver, 'node-1', true);
    expect(rejectNode).toHaveBeenCalledWith(
      'node-1',
      expect.objectContaining({ message: 'NODE_CONNECTION_REPLACED' })
    );
    expect(rejectNode).toHaveBeenCalledOnce();
    expect(activateNodeConnection).toHaveBeenNthCalledWith(2, 'node-1');
  });
  it.each(['revokeNode', 'deleteNode'] as const)(
    '%s closes only after a successful commit',
    async (operation) => {
      let complete!: (value: boolean) => void;
      const write = vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            complete = resolve;
          })
      );
      const close = vi.fn();
      const receiver = {
        database: { [operation]: write },
        closeNode: close,
        closeManagedNode: close,
        terminalRelay: { shutdownNode: vi.fn() }
      };
      const result = NodeControl.prototype[operation].call(
        receiver as unknown as NodeControl,
        'node-1',
        1
      );
      expect(close).not.toHaveBeenCalled();
      complete(true);
      await expect(result).resolves.toBe(true);
      expect(close).toHaveBeenCalledTimes(1);
    }
  );

  it.each(['revokeNode', 'deleteNode'] as const)(
    '%s leaves connections unchanged when persistence fails',
    async (operation) => {
      const close = vi.fn();
      const receiver = {
        database: { [operation]: vi.fn().mockRejectedValue(new Error('DATABASE_UNAVAILABLE')) },
        closeNode: close,
        closeManagedNode: close,
        terminalRelay: { shutdownNode: vi.fn() }
      };
      await expect(
        NodeControl.prototype[operation].call(receiver as unknown as NodeControl, 'node-1', 1)
      ).rejects.toThrow('DATABASE_UNAVAILABLE');
      expect(close).not.toHaveBeenCalled();
    }
  );
});
