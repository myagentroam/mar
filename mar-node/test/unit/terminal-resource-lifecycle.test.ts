import { describe, expect, it, vi } from 'vitest';
import { setImmediate } from 'node:timers/promises';
import { queryObjects } from 'node:v8';
import { TerminalManager, type TerminalPty, type TerminalPlatform } from '../../src/terminal.js';
import { TerminalPtyPool } from '../../src/terminal-pty-pool.js';
import * as operational from '../../src/operational.js';

class RetainedPty implements TerminalPty {
  readonly data = new Set<(data: string) => void>();
  readonly exits = new Set<(event: { exitCode: number }) => void>();
  readonly write = vi.fn();
  readonly resize = vi.fn();
  readonly kill = vi.fn(() => {
    this.exit(0);
    return true;
  });
  exitOnSubscribe = false;
  throwOnDispose = false;

  onData(listener: (data: string) => void) {
    this.data.add(listener);
    return {
      dispose: () => {
        this.data.delete(listener);
        if (this.throwOnDispose) throw new Error('dispose failed');
      }
    };
  }

  onExit(listener: (event: { exitCode: number }) => void) {
    this.exits.add(listener);
    if (this.exitOnSubscribe) listener({ exitCode: 0 });
    return { dispose: () => this.exits.delete(listener) };
  }

  output(data: string) {
    for (const listener of [...this.data]) listener(data);
  }

  exit(exitCode: number) {
    for (const listener of [...this.exits]) listener({ exitCode });
  }
}

function fixture(platform: TerminalPlatform = 'win32', exitOnSubscribe = false) {
  const pty = new RetainedPty();
  pty.exitOnSubscribe = exitOnSubscribe;
  const manager = new TerminalManager({
    platform,
    profiles: [{ id: 'default', label: 'Fixture', shell: 'fixture', args: [], isDefault: true }],
    ptyFactory: () => pty
  });
  return { pty, manager };
}

describe('terminal resource lifecycle', () => {
  it.each([
    ['idle', false],
    ['idle', true],
    ['capacity', false],
    ['capacity', true]
  ] as const)(
    'handles %s background cleanup failure (logging throws: %s)',
    async (source, loggingThrows) => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      const log = vi.spyOn(operational, 'nodeLog').mockImplementation(() => {
        if (loggingThrows) throw new Error('LOG_STORAGE_FAILED');
      });
      const failure = new Error('native cleanup failed (private fixture context)');
      let failClose!: () => void;
      const closed = new Promise<void>((_resolve, reject) => {
        failClose = () => reject(failure);
      });
      void closed.catch(() => undefined);
      const pty = Object.assign(new RetainedPty(), { closed });
      let created = 0;
      let timestamp = 0;
      const manager = new TerminalManager({
        now: () => timestamp,
        idleTimeoutMs: 1_000,
        maxTerminals: 1,
        maxTerminalsPerWorkspace: 1,
        profiles: [
          { id: 'default', label: 'Fixture', shell: 'fixture', args: [], isDefault: true }
        ],
        ptyFactory: () => (created++ === 0 ? pty : new RetainedPty())
      });
      try {
        const terminal = manager.open();
        if (source === 'idle') {
          timestamp = 1_000;
          await vi.advanceTimersByTimeAsync(1_000);
        } else {
          const replacement = manager.open();
          expect(manager.get(replacement.id).state).toBe('RUNNING');
        }
        failClose();
        // Let Node process the rejection too, not only the cleanup's microtasks.
        await setImmediate();
        expect(log).toHaveBeenCalledExactlyOnceWith('terminal.cleanup.failed', {
          source,
          errorCode: 'TERMINAL_CLEANUP_FAILED',
          ...(source === 'capacity' ? { terminalId: terminal.id } : {})
        });
        expect(manager.get(terminal.id).state).toBe('CLOSED');
        expect(pty.data.size + pty.exits.size).toBe(0);
        const replacement = manager.open();
        expect(manager.get(replacement.id).state).toBe('RUNNING');
        await setImmediate();
        expect(log).toHaveBeenCalledTimes(1);
      } finally {
        failClose();
        await manager.shutdown().catch(() => undefined);
        log.mockRestore();
        vi.useRealTimers();
      }
    }
  );

  it.each(['close', 'shutdown'] as const)(
    'preserves explicit %s cleanup rejection without background logging',
    async (operation) => {
      const log = vi.spyOn(operational, 'nodeLog').mockImplementation(() => undefined);
      const failure = new Error('native cleanup failed');
      let failClose!: () => void;
      const closed = new Promise<void>((_resolve, reject) => {
        failClose = () => reject(failure);
      });
      void closed.catch(() => undefined);
      const pty = Object.assign(new RetainedPty(), { closed });
      const manager = new TerminalManager({
        profiles: [
          { id: 'default', label: 'Fixture', shell: 'fixture', args: [], isDefault: true }
        ],
        ptyFactory: () => pty
      });
      try {
        const terminal = manager.open();
        const result = operation === 'close' ? manager.close(terminal.id) : manager.shutdown();
        const rejection = expect(result).rejects.toBe(failure);
        failClose();
        await rejection;
        expect(log).not.toHaveBeenCalled();
      } finally {
        failClose();
        await manager.shutdown().catch(() => undefined);
        log.mockRestore();
      }
    }
  );

  it.each([false, true])(
    'joins the standby in every concurrent shutdown caller (failed=%s)',
    async (failed) => {
      let release!: () => void;
      const failure = new Error('standby close failed');
      const closed = new Promise<void>((resolve, reject) => {
        release = () => (failed ? reject(failure) : resolve());
      });
      const warmup = vi.spyOn(TerminalPtyPool.prototype, 'warmup').mockResolvedValue();
      const close = vi.spyOn(TerminalPtyPool.prototype, 'close').mockReturnValue(closed);
      const manager = new TerminalManager();
      let settled = 0;
      const observe = (promise: Promise<void>) =>
        promise.then(
          () => {
            settled++;
          },
          (error: unknown) => {
            settled++;
            throw error;
          }
        );
      let results: Promise<PromiseSettledResult<void>[]> | undefined;
      try {
        await manager.warmup();
        results = Promise.allSettled([observe(manager.shutdown()), observe(manager.shutdown())]);
        await setImmediate();
        expect(settled).toBe(0);
        release();
        expect(await results).toEqual(
          Array.from({ length: 2 }, () =>
            failed
              ? { status: 'rejected', reason: failure }
              : { status: 'fulfilled', value: undefined }
          )
        );
      } finally {
        release();
        await results;
        await manager.shutdown().catch(() => undefined);
        warmup.mockRestore();
        close.mockRestore();
      }
    }
  );

  it('still joins the physical host when both kill and fallback fail', async () => {
    let release!: () => void;
    const closed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pty = Object.assign(new RetainedPty(), { closed });
    const failure = new Error('fallback failed');
    pty.kill.mockImplementation(() => {
      throw new Error('kill failed');
    });
    const manager = new TerminalManager({
      ptyFactory: () => pty,
      terminate: async () => {
        throw failure;
      }
    });
    const terminal = manager.open();
    let settled = false;
    const closing = manager.close(terminal.id).catch((error: unknown) => {
      settled = true;
      return error;
    });
    try {
      await setImmediate();
      expect(settled).toBe(false);
      release();
      expect(await closing).toBe(failure);
    } finally {
      release();
      await closing;
      await manager.shutdown();
    }
  });

  it('joins every active close before shutdown reports a sibling failure', async () => {
    let release!: () => void;
    const closed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = Object.assign(new RetainedPty(), { closed });
    const broken = new RetainedPty();
    const failure = new Error('termination failed');
    broken.kill.mockImplementation(() => {
      throw new Error('kill failed');
    });
    let index = 0;
    const manager = new TerminalManager({
      ptyFactory: () => (index++ === 0 ? broken : slow),
      terminate: async () => {
        throw failure;
      }
    });
    manager.open();
    manager.open();
    let settled = false;
    const shuttingDown = manager.shutdown().catch((error: unknown) => {
      settled = true;
      return error;
    });
    try {
      await setImmediate();
      expect(settled).toBe(false);
      release();
      expect(await shuttingDown).toBe(failure);
    } finally {
      release();
      await shuttingDown;
    }
  });

  it.each(['single', 'aggregate', 'cause'] as const)(
    'does not retain native payloads through replayable close errors (%s)',
    async (kind) => {
      class Payload {}
      class FailingPty implements TerminalPty {
        readonly payload = new Payload();
        write() {}
        resize() {}
        onData() {
          return { dispose() {} };
        }
        onExit() {
          return { dispose() {} };
        }
        kill(): never {
          throw new Error('hangup failed');
        }
        failDisposal(): never {
          const error = new Error('native disposal failed');
          throw kind === 'cause' ? new Error('wrapped disposal failure', { cause: error }) : error;
        }
      }
      const managers: TerminalManager[] = [];
      const errors: unknown[] = [];
      for (let index = 0; index < 8; index++) {
        const manager = new TerminalManager({
          profiles: [
            { id: 'fixture', label: 'Fixture', shell: 'fixture', args: [], isDefault: true }
          ],
          ptyFactory: () => new FailingPty(),
          terminate: async (pty) => (pty as FailingPty).failDisposal()
        });
        try {
          const terminal = manager.open();
          if (kind === 'aggregate')
            manager.onSummary(() => {
              throw new Error('summary failed');
            });
          errors.push(await manager.close(terminal.id).catch((error: unknown) => error));
          managers.push(manager);
        } finally {
          await manager.shutdown();
        }
      }
      await setImmediate();
      // Keep errors and closed owners alive, but do not format their lazy stacks before GC.
      const retained = queryObjects(Payload);
      expect(managers).toHaveLength(8);
      expect(errors).toHaveLength(8);
      expect(
        errors.every((error) => error instanceof (kind === 'aggregate' ? AggregateError : Error))
      ).toBe(true);
      expect(retained).toBe(0);
    }
  );

  it('preserves cleanup failures with throwing stack accessors and cyclic causes', async () => {
    const pty = new RetainedPty();
    const failure = new Error('native termination failed');
    failure.cause = failure;
    Object.defineProperty(failure, 'stack', {
      get() {
        throw new Error('stack formatting failed');
      }
    });
    pty.kill.mockImplementation(() => {
      throw failure;
    });
    const manager = new TerminalManager({
      profiles: [{ id: 'fixture', label: 'Fixture', shell: 'fixture', args: [], isDefault: true }],
      ptyFactory: () => pty,
      terminate: async () => {
        throw failure;
      }
    });
    try {
      const terminal = manager.open();
      const rejection: unknown = await manager.close(terminal.id).catch((error: unknown) => error);
      expect(rejection === failure).toBe(true);
      expect(pty.data.size + pty.exits.size).toBe(0);
    } finally {
      await manager.shutdown();
    }
  });

  it.each(['linux', 'darwin', 'win32'] as const)(
    'detaches exited %s PTY callbacks without killing an old process or losing exit facts',
    async (platform) => {
      const { manager, pty } = fixture(platform);
      const frames: unknown[] = [];
      manager.onFrame((frame) => frames.push(frame));
      try {
        const terminal = manager.open();
        pty.output('last output');
        pty.exit(7);
        expect(manager.get(terminal.id)).toMatchObject({ state: 'EXITED', exitCode: 7 });
        expect(manager.list()).toHaveLength(1);
        expect(frames).toContainEqual(
          expect.objectContaining({ type: 'output', data: 'last output' })
        );
        expect(frames).toContainEqual({ type: 'exit', terminalId: terminal.id, exitCode: 7 });
        expect(pty.data.size + pty.exits.size).toBe(0);
        await manager.close(terminal.id);
        expect(pty.kill).not.toHaveBeenCalled();
      } finally {
        await manager.shutdown();
      }
    }
  );

  it('detaches a closed PTY once, including a synchronous native exit during kill', async () => {
    const { manager, pty } = fixture();
    try {
      const terminal = manager.open();
      await Promise.all([manager.close(terminal.id), manager.close(terminal.id)]);
      expect(manager.get(terminal.id).state).toBe('CLOSED');
      expect(pty.kill).toHaveBeenCalledOnce();
      expect(pty.data.size + pty.exits.size).toBe(0);
    } finally {
      await manager.shutdown();
    }
  });

  it('disposes a subscription returned after its synchronous exit callback', async () => {
    const { manager, pty } = fixture('win32', true);
    try {
      const terminal = manager.open();
      expect(manager.get(terminal.id)).toMatchObject({ state: 'EXITED', exitCode: 0 });
      expect(pty.data.size + pty.exits.size).toBe(0);
      expect(pty.kill).not.toHaveBeenCalled();
    } finally {
      await manager.shutdown();
    }
  });

  it('finishes remaining cleanup and reports a failed disposal without hiding exit', async () => {
    const { manager, pty } = fixture();
    pty.throwOnDispose = true;
    const frames: unknown[] = [];
    manager.onFrame((frame) => frames.push(frame));
    try {
      const terminal = manager.open();
      pty.exit(0);
      expect(pty.data.size + pty.exits.size).toBe(0);
      expect(frames).toContainEqual({
        type: 'error',
        terminalId: terminal.id,
        code: 'TERMINAL_CLEANUP_FAILED'
      });
      expect(frames).toContainEqual({ type: 'exit', terminalId: terminal.id, exitCode: 0 });
    } finally {
      await manager.shutdown();
    }
  });

  it.each([false, true])(
    'releases callbacks after failed termination (summary failure: %s)',
    async (summaryFails) => {
      const pty = new RetainedPty();
      pty.kill.mockImplementation(() => {
        throw new Error('native hangup failed');
      });
      const failure = new Error('termination failed');
      const manager = new TerminalManager({
        profiles: [
          { id: 'default', label: 'Fixture', shell: 'fixture', args: [], isDefault: true }
        ],
        ptyFactory: () => pty,
        terminate: async () => {
          throw failure;
        }
      });
      try {
        const terminal = manager.open();
        const summaryFailure = new Error('summary persistence failed');
        if (summaryFails)
          manager.onSummary(() => {
            throw summaryFailure;
          });
        if (summaryFails) {
          await expect(manager.close(terminal.id)).rejects.toMatchObject({
            errors: [summaryFailure, failure]
          });
        } else {
          await expect(manager.close(terminal.id)).rejects.toBe(failure);
        }
        expect(manager.get(terminal.id).state).toBe('CLOSED');
        expect(pty.data.size + pty.exits.size).toBe(0);
      } finally {
        await manager.shutdown();
      }
    }
  );

  it('still terminates and releases callbacks when a close summary observer fails', async () => {
    const { manager, pty } = fixture();
    const failure = new Error('summary persistence failed');
    try {
      const terminal = manager.open();
      manager.onSummary(() => {
        throw failure;
      });
      await expect(manager.close(terminal.id)).rejects.toBe(failure);
      expect(pty.kill).toHaveBeenCalledOnce();
      expect(pty.data.size + pty.exits.size).toBe(0);
    } finally {
      await manager.shutdown();
    }
  });

  it('emits exit even when a natural-exit summary observer fails', async () => {
    const { manager, pty } = fixture();
    const failure = new Error('summary persistence failed');
    const frames: unknown[] = [];
    manager.onFrame((frame) => frames.push(frame));
    try {
      const terminal = manager.open();
      manager.onSummary(() => {
        throw failure;
      });
      expect(() => pty.exit(0)).toThrow(failure);
      expect(pty.data.size + pty.exits.size).toBe(0);
      expect(frames).toContainEqual({ type: 'exit', terminalId: terminal.id, exitCode: 0 });
    } finally {
      await manager.shutdown();
    }
  });

  it('does not let a cleanup-error observer interrupt the remaining disposers', async () => {
    const { manager, pty } = fixture();
    pty.throwOnDispose = true;
    manager.onFrame((frame) => {
      if (frame.type === 'error') throw new Error('error observer failed');
    });
    try {
      const terminal = manager.open();
      expect(() => pty.exit(0)).not.toThrow();
      expect(manager.get(terminal.id).state).toBe('EXITED');
      expect(pty.data.size + pty.exits.size).toBe(0);
    } finally {
      await manager.shutdown();
    }
  });

  it('terminates a pipe even when detaching its backpressure throws', async () => {
    const failure = new Error('pipe resume failed');
    const terminate = vi.fn(async () => undefined);
    const manager = new TerminalManager({
      profiles: [{ id: 'default', label: 'Fixture', shell: 'fixture', args: [], isDefault: true }],
      pipeFactory: () => ({
        kill: () => true,
        write: () => undefined,
        onData: () => undefined,
        onExit: () => undefined,
        pause: () => undefined,
        resume: () => {
          throw failure;
        }
      }),
      terminate
    });
    const summaries: string[] = [];
    manager.onSummary((summary) => summaries.push(summary.state));
    try {
      const terminal = manager.openCommand({}, 'fixture command', true);
      manager.startCommand(terminal.id);
      const attachment = manager.authorizeAttach({ terminalId: terminal.id, readonly: false });
      manager.setOutputBackpressure(terminal.id, new Set([attachment.attachmentId]));
      await expect(manager.close(terminal.id)).rejects.toBe(failure);
      expect(terminate).toHaveBeenCalledOnce();
      expect(summaries).toContain('CLOSED');
    } finally {
      await manager.shutdown();
    }
  });

  it('notifies EXITED even when detaching a naturally exited pipe throws', async () => {
    const failure = new Error('pipe resume failed');
    let exit: ((code: number) => void) | undefined;
    const manager = new TerminalManager({
      profiles: [{ id: 'default', label: 'Fixture', shell: 'fixture', args: [], isDefault: true }],
      pipeFactory: () => ({
        kill: () => true,
        write: () => undefined,
        onData: () => undefined,
        onExit: (listener) => {
          exit = listener;
        },
        pause: () => undefined,
        resume: () => {
          throw failure;
        }
      })
    });
    const summaries: string[] = [];
    manager.onSummary((summary) => summaries.push(summary.state));
    try {
      const terminal = manager.openCommand({}, 'fixture command', true);
      manager.startCommand(terminal.id);
      const attachment = manager.authorizeAttach({ terminalId: terminal.id, readonly: false });
      manager.setOutputBackpressure(terminal.id, new Set([attachment.attachmentId]));
      expect(() => exit!(0)).toThrow(failure);
      expect(summaries).toContain('EXITED');
    } finally {
      await manager.shutdown();
    }
  });

  it('releases an exit subscription before propagating synchronous summary failure', async () => {
    const { manager, pty } = fixture('win32', true);
    const failure = new Error('summary persistence failed');
    manager.onSummary(() => {
      throw failure;
    });
    try {
      expect(() => manager.open()).toThrow(failure);
      expect(pty.data.size + pty.exits.size).toBe(0);
      expect(pty.kill).not.toHaveBeenCalled();
    } finally {
      await manager.shutdown();
    }
  });
});
