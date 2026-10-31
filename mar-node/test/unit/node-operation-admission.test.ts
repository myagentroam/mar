import { describe, expect, it, vi } from 'vitest';
import { NodeOperationAdmission } from '../../src/application/node-operation-admission.js';

describe('Node operation admission', () => {
  it('joins accepted operations on shutdown', async () => {
    const gate = Promise.withResolvers<unknown>();
    const restart = { blocksOperation: vi.fn(() => false) };
    const git = { execute: vi.fn(() => gate.promise) };
    const owner = new NodeOperationAdmission(
      () => false,
      () => true,
      () => 'node',
      restart as never,
      { blocks: () => false } as never,
      git as never,
      {} as never
    );
    const result = owner.execute('session.message', { sessionId: 'session' });
    let drained = false;
    const drain = owner.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    gate.resolve('ok');
    await expect(result).resolves.toBe('ok');
    await drain;
  });

  it('does not admit operations blocked by restart or shutdown', async () => {
    const restart = { blocksOperation: vi.fn(() => true) };
    const git = { execute: vi.fn() };
    let stopped = false;
    const owner = new NodeOperationAdmission(
      () => stopped,
      () => true,
      () => undefined,
      restart as never,
      { blocks: () => false } as never,
      git as never,
      {} as never
    );
    await expect(owner.execute('session.message', {})).rejects.toThrow('SESSION_RESTART_PENDING');
    stopped = true;
    await expect(owner.execute('session.message', {})).rejects.toThrow('NODE_STOPPED');
    expect(git.execute).not.toHaveBeenCalled();
    await owner.drain();
  });
});
