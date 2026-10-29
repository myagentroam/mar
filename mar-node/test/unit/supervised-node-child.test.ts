import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), terminate: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('../../src/process-tree.js', () => ({ terminateProcessTree: mocks.terminate }));
import { runSupervisedNodeChild } from '../../src/service/supervised-node-child.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

function fixture() {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    connected: boolean;
    send: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    kill: ReturnType<typeof vi.fn>;
    unref: ReturnType<typeof vi.fn>;
  };
  child.pid = 1234;
  child.connected = true;
  child.send = vi.fn();
  child.disconnect = vi.fn(() => {
    child.connected = false;
  });
  child.kill = vi.fn();
  child.unref = vi.fn();
  mocks.spawn.mockReturnValue(child);
  mocks.terminate.mockResolvedValue(undefined);
  vi.spyOn(process, 'kill').mockReturnValue(true);
  return child;
}

describe('Supervisor child exit deadline', () => {
  it.each(['resolve', 'reject', 'timeout'] as const)(
    'requires process-tree reclamation after root exit (%s)',
    async (outcome) => {
      vi.useFakeTimers();
      const child = fixture();
      let resolveReap!: () => void;
      let rejectReap!: (error: Error) => void;
      mocks.terminate.mockReturnValue(
        new Promise<void>((resolve, reject) => {
          resolveReap = resolve;
          rejectReap = reject;
        })
      );
      let settled = false;
      const result = runSupervisedNodeChild(
        '/old/main.js',
        '/config',
        async () => true,
        () => undefined
      ).then((value) => {
        settled = true;
        return value;
      });
      child.emit('message', { type: 'node-upgrade-hello', channelId: 'channel' });
      child.emit('message', {
        type: 'node-upgrade-handoff',
        channelId: 'channel',
        id: 'id',
        attemptId: 'a',
        targetVersion: '1.2.3',
        credential: 'private'
      });
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(25_000);
      child.emit('exit', null);
      await Promise.resolve();
      expect(settled).toBe(false);
      if (outcome === 'resolve') resolveReap();
      else if (outcome === 'reject') rejectReap(new Error('reclaim failed'));
      else await vi.advanceTimersByTimeAsync(10_000);
      expect(await result).toMatchObject(
        outcome === 'resolve' ? { forced: true } : { reclaimFailed: true }
      );
    }
  );
  it('accepts one handoff, reclaims a stuck child, and waits for exit rather than stream close', async () => {
    vi.useFakeTimers();
    const child = fixture();
    const accepted = vi.fn();
    const result = runSupervisedNodeChild('/old/main.js', '/config', async () => true, accepted);
    child.emit('message', { type: 'node-upgrade-hello', channelId: 'channel' });
    const request = {
      type: 'node-upgrade-handoff',
      channelId: 'channel',
      id: 'id',
      attemptId: 'a',
      targetVersion: '1.2.3',
      credential: 'private'
    };
    child.emit('message', request);
    await Promise.resolve();
    child.emit('message', request);
    expect(accepted).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(25_000);
    expect(mocks.terminate).toHaveBeenCalledOnce();
    child.emit('exit', null);
    expect(await result).toMatchObject({ forced: true, handoff: { attemptId: 'a' } });
  });

  it('does not treat a failed reclamation as an exited child', async () => {
    vi.useFakeTimers();
    const child = fixture();
    mocks.terminate.mockRejectedValue(new Error('failed'));
    const result = runSupervisedNodeChild(
      '/old/main.js',
      '/config',
      async () => true,
      () => undefined
    );
    child.emit('message', { type: 'node-upgrade-hello', channelId: 'channel' });
    child.emit('message', {
      type: 'node-upgrade-handoff',
      channelId: 'channel',
      id: 'id',
      attemptId: 'a',
      targetVersion: '1.2.3',
      credential: 'private'
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(35_000);
    expect(await result).toMatchObject({ reclaimFailed: true, forced: true });
    expect(child.unref).toHaveBeenCalledOnce();
  });
});
