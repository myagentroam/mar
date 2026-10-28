import { describe, expect, it, vi } from 'vitest';
import { NodeConnector } from '../../src/connector.js';
import { NodeDatabase } from '../../src/database.js';

describe('Node shutdown failures', () => {
  it('reports database close failure when earlier resources drain successfully', async () => {
    const database = new NodeDatabase(':memory:', 'shutdown-database');
    const connector = new NodeConnector({ database, reconnect: false });
    const error = new Error('database close failed');
    const close = vi.spyOn(database, 'close').mockImplementation(() => {
      throw error;
    });
    try {
      await expect(connector.stop()).rejects.toBe(error);
      expect(close).toHaveBeenCalledOnce();
    } finally {
      close.mockRestore();
      database.close();
    }
  });

  it.each(['hosting', 'runner'] as const)(
    'preserves the %s drain error while still attempting database close',
    async (owner) => {
      const database = new NodeDatabase(':memory:', `shutdown-${owner}`);
      const connector = new NodeConnector({ database, reconnect: false });
      const internals = connector as unknown as {
        conversationHosting: { dispose(): Promise<void> };
        runners: { stop(): Promise<void> };
      };
      const primary = new Error(`${owner} drain failed`);
      const closeError = new Error('database close failed');
      const drain =
        owner === 'hosting'
          ? vi.spyOn(internals.conversationHosting, 'dispose')
          : vi.spyOn(internals.runners, 'stop');
      drain.mockRejectedValue(primary);
      const close = vi.spyOn(database, 'close').mockImplementation(() => {
        throw closeError;
      });
      try {
        await expect(connector.stop()).rejects.toBe(primary);
        expect(drain).toHaveBeenCalledOnce();
        expect(close).toHaveBeenCalledOnce();
      } finally {
        close.mockRestore();
        database.close();
        drain.mockRestore();
      }
    }
  );
});
