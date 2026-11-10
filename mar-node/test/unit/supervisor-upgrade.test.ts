import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  terminate: vi.fn(),
  child: vi.fn(),
  readFile: vi.fn(),
  access: vi.fn(),
  mkdir: vi.fn(),
  rm: vi.fn(),
  writeFile: vi.fn(),
  rename: vi.fn(),
  log: vi.fn(),
  finish: vi.fn(),
  update: vi.fn(),
  stop: vi.fn()
}));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('../../src/process-tree.js', () => ({ terminateProcessTree: mocks.terminate }));
vi.mock('../../src/service/supervised-node-child.js', () => ({
  runSupervisedNodeChild: mocks.child
}));
vi.mock('../../src/service/node-upgrade-reporter.js', () => ({
  NodeUpgradeReporter: class {
    update = mocks.update;
    finish = mocks.finish;
    stop = mocks.stop;
  }
}));
vi.mock('node:fs/promises', () => ({
  readFile: mocks.readFile,
  access: mocks.access,
  mkdir: mocks.mkdir,
  rm: mocks.rm,
  writeFile: mocks.writeFile,
  rename: mocks.rename
}));
vi.mock('../../src/config.js', () => ({
  loadNodeConfig: async () => ({ nodeId: 'node-1', serverUrl: 'http://localhost' }),
  nodeDatabasePath: () => '/test/node.sqlite'
}));
vi.mock('../../src/service/node-upgrade-coordinator.js', () => ({
  nodeUpgradeRequestPath: () => '/test/upgrade-request.json'
}));
vi.mock('../../src/operational.js', () => ({
  nodeLog: mocks.log,
  platformCliInvocation: (_command: string, args: string[]) => ({ command: 'npm', args })
}));
import { superviseNode } from '../../src/supervisor.js';

describe('Supervisor upgrade recovery', () => {
  afterEach(() => vi.useRealTimers());
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.readFile.mockImplementation(async (path: string) => {
      if (path.endsWith('upgrade-request.json'))
        return JSON.stringify({ schemaVersion: 1, targetVersion: '1.2.3' });
      throw new Error('missing active entrypoint');
    });
    mocks.access.mockResolvedValue(undefined);
    mocks.mkdir.mockResolvedValue(undefined);
    mocks.writeFile.mockResolvedValue(undefined);
    mocks.rename.mockResolvedValue(undefined);
    mocks.terminate.mockResolvedValue(undefined);
    mocks.finish.mockResolvedValue(undefined);
    mocks.rm.mockImplementation(async (path: string) => {
      if (path.endsWith('upgrade-request.json')) throw new Error('request is locked');
    });
    mocks.spawn.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & { kill: () => void };
      child.kill = () => undefined;
      process.nextTick(() => child.emit('exit', 0));
      return child;
    });
    mocks.child
      .mockResolvedValueOnce({ code: 75, signalled: false })
      .mockResolvedValueOnce({ code: 0, signalled: false });
  });

  it.each([
    ['disconnect', false, 1],
    ['message', false, 0],
    ['message', true, 1]
  ] as const)('retains %s shutdown status when forced=%s', async (event, forced, expected) => {
    vi.stubEnv('MAR_QUICK_START_OWNER', '1');
    const oldExitCode = process.exitCode;
    try {
      mocks.child.mockReset();
      mocks.child.mockImplementation(async () => {
        if (event === 'disconnect') process.emit('disconnect');
        else process.emit('message', { type: 'node-quick-start-stop' }, undefined);
        return { code: 0, signalled: true, forced };
      });
      await superviseNode('/test/config.json', '/server/main.js');
      expect(process.exitCode).toBe(expected);
    } finally {
      process.exitCode = oldExitCode;
      vi.unstubAllEnvs();
    }
  });

  it('keeps the bundled entrypoint and never installs an upgrade for Quick Start', async () => {
    vi.stubEnv('MAR_QUICK_START_OWNER', '1');
    const oldExitCode = process.exitCode;
    try {
      mocks.child.mockReset();
      mocks.child.mockImplementationOnce(async (entry, _config, accept) => {
        expect(entry).toBe('/server/node/main.js');
        expect(
          await accept({
            attemptId: '11111111-1111-4111-8111-111111111111',
            targetVersion: '1.2.3',
            credential: 'x'.repeat(43)
          })
        ).toBe(false);
        return { code: 75, signalled: false };
      });
      await superviseNode('/test/config.json', '/server/node/main.js');
      expect(process.exitCode).toBe(1);
      expect(mocks.readFile).not.toHaveBeenCalled();
      expect(mocks.spawn).not.toHaveBeenCalled();
      expect(mocks.writeFile).not.toHaveBeenCalled();
    } finally {
      process.exitCode = oldExitCode;
      vi.unstubAllEnvs();
    }
  });

  it.each(['resolve', 'reject', 'timeout'] as const)(
    'does not replace an installer before its process tree is reclaimed (%s)',
    async (outcome) => {
      vi.useFakeTimers();
      mocks.rm.mockResolvedValue(undefined);
      if (outcome !== 'resolve') {
        mocks.writeFile.mockRejectedValue(new Error('disk full'));
        mocks.rm.mockImplementation(async (path: string) => {
          if (path.endsWith('upgrade-request.json')) throw new Error('request is locked');
        });
      }
      let resolveReap!: () => void;
      let rejectReap!: (error: Error) => void;
      mocks.terminate.mockReturnValue(
        new Promise<void>((resolve, reject) => {
          resolveReap = resolve;
          rejectReap = reject;
        })
      );
      const child = new EventEmitter() as EventEmitter & { kill: () => void; unref: () => void };
      child.kill = vi.fn();
      child.unref = vi.fn();
      mocks.spawn.mockReturnValue(child);
      let settled = false;
      const running = superviseNode('/test/config.json', '/old/main.js').then(() => {
        settled = true;
      });
      for (let i = 0; i < 20 && mocks.spawn.mock.calls.length === 0; i++) await Promise.resolve();
      expect(mocks.spawn).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      expect(mocks.terminate).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      child.emit('exit', null);
      await Promise.resolve();
      expect(settled).toBe(false);
      if (outcome === 'resolve') resolveReap();
      else if (outcome === 'reject') rejectReap(new Error('reclaim failed'));
      else await vi.advanceTimersByTimeAsync(10_000);
      // A successfully reclaimed timed-out installer follows the existing failure recovery;
      // failed/unconfirmed reclamation must not start a replacement child.
      if (outcome === 'resolve') await vi.advanceTimersByTimeAsync(1_000);
      await running;
      expect(mocks.spawn).toHaveBeenCalledOnce();
      expect(mocks.child).toHaveBeenCalledTimes(outcome === 'resolve' ? 2 : 1);
    }
  );

  it.each([false, true])(
    'starts the switched entrypoint when request cleanup fails (result write fails: %s)',
    async (resultWriteFails) => {
      if (resultWriteFails)
        mocks.rename.mockImplementation(async (_from: string, to: string) => {
          if (to.endsWith('upgrade-result.json')) throw new Error('result is locked');
        });
      await superviseNode('/test/config.json', '/old/main.js');
      expect(mocks.spawn).toHaveBeenCalledTimes(3);
      expect(mocks.child.mock.calls[1]?.[0]).toBe(
        '/test/node-versions/1.2.3/node_modules/@myagentroam/node/dist/main.js'
      );
      expect(mocks.log).toHaveBeenCalledWith(
        'node.supervisor.upgrade-request-cleanup-failed',
        expect.any(Object)
      );
      expect(
        mocks.writeFile.mock.calls.some(([, value]) => String(value).includes('"state":"FAILED"'))
      ).toBe(false);
      expect(
        mocks.log.mock.calls.some(
          ([event]) => event === 'node.supervisor.upgrade-result-write-failed'
        )
      ).toBe(resultWriteFails);
    }
  );

  it.each([
    { resultWriteFails: true, cleanupFails: false },
    { resultWriteFails: false, cleanupFails: true },
    { resultWriteFails: true, cleanupFails: true }
  ])(
    'restarts the old entrypoint after an install failure despite $resultWriteFails result write / $cleanupFails cleanup failures',
    async ({ resultWriteFails, cleanupFails }) => {
      const attemptId = '11111111-1111-4111-8111-111111111111';
      const handoff = { attemptId, targetVersion: '1.2.3', credential: 'x'.repeat(43) };
      mocks.readFile.mockImplementation(async (path: string) => {
        if (path.endsWith('upgrade-request.json'))
          return JSON.stringify({ schemaVersion: 1, ...handoff });
        throw new Error('missing active entrypoint');
      });
      mocks.child.mockReset();
      mocks.child
        .mockImplementationOnce(async (_entry, _config, accept, accepted) => {
          expect(await accept(handoff)).toBe(true);
          accepted(handoff);
          return { code: 75, signalled: false, handoff };
        })
        .mockResolvedValueOnce({ code: 0, signalled: false });
      mocks.spawn.mockImplementation(() => {
        const child = new EventEmitter();
        process.nextTick(() => child.emit('exit', 1));
        return child;
      });
      if (resultWriteFails) mocks.writeFile.mockRejectedValue(new Error('disk full'));
      if (!cleanupFails) mocks.rm.mockResolvedValue(undefined);

      await superviseNode('/test/config.json', '/old/main.js');

      expect(mocks.spawn).toHaveBeenCalledOnce();
      expect(mocks.child).toHaveBeenCalledTimes(2);
      expect(mocks.child.mock.calls[1]?.[0]).toBe('/old/main.js');
      expect(mocks.finish).toHaveBeenCalledWith(
        expect.objectContaining({
          attemptId,
          result: 'FAILED',
          operationEnded: true,
          failure: expect.objectContaining({ code: 'NODE_UPGRADE_INSTALL_FAILED' })
        })
      );
      expect(mocks.rename).not.toHaveBeenCalledWith(
        expect.any(String),
        '/test/node-active-entrypoint'
      );
      expect(
        mocks.log.mock.calls.some(
          ([event]) => event === 'node.supervisor.upgrade-result-write-failed'
        )
      ).toBe(resultWriteFails);
      expect(
        mocks.log.mock.calls.some(
          ([event]) => event === 'node.supervisor.upgrade-request-cleanup-failed'
        )
      ).toBe(cleanupFails);
    }
  );

  it('records a successful forced old-node reclamation', async () => {
    mocks.child.mockReset();
    mocks.child
      .mockResolvedValueOnce({ code: 75, signalled: false, forced: true })
      .mockResolvedValueOnce({ code: 0, signalled: false });
    await superviseNode('/test/config.json', '/old/main.js');
    expect(mocks.log).toHaveBeenCalledWith('node.supervisor.upgrade-old-node-reclaimed', {
      code: 'NODE_UPGRADE_EXIT_TIMEOUT_RECLAIMED'
    });
  });

  it('keeps the switched attempt on later children after a first startup failure', async () => {
    const attemptId = '11111111-1111-4111-8111-111111111111';
    const handoff = { attemptId, targetVersion: '1.2.3', credential: 'x'.repeat(43) };
    mocks.rm.mockResolvedValue(undefined);
    mocks.readFile.mockImplementation(async (path: string) => {
      if (path.endsWith('upgrade-request.json'))
        return JSON.stringify({ schemaVersion: 1, ...handoff });
      throw new Error('missing active entrypoint');
    });
    mocks.child.mockReset();
    mocks.child
      .mockImplementationOnce(async (_entry, _config, accept, accepted) => {
        expect(await accept(handoff)).toBe(true);
        accepted(handoff);
        return { code: 75, signalled: false, handoff };
      })
      .mockResolvedValueOnce({ code: 1, signalled: false })
      .mockResolvedValueOnce({ code: 0, signalled: false });
    vi.useFakeTimers();
    const running = superviseNode('/test/config.json', '/old/main.js');
    await vi.advanceTimersByTimeAsync(1_000);
    await running;
    expect(mocks.finish).toHaveBeenCalledWith(
      expect.objectContaining({ attemptId, result: 'FAILED' })
    );
    expect(mocks.child.mock.calls[1]?.[4]).toBe(attemptId);
    expect(mocks.child.mock.calls[2]?.[4]).toBe(attemptId);
  });
});
