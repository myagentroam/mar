import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

const faults = vi.hoisted(() => ({
  spawn: undefined as undefined | (() => unknown),
  close: false,
  remove: false,
  write: false,
  mkdir: false,
  open: 0,
  opens: 0,
  closes: 0
}));

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: () => faults.spawn?.()
}));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return {
    ...fs,
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      faults.opens++;
      if (faults.open === faults.opens) throw new Error('secret /private');
      return fs.openSync(...args);
    },
    closeSync: (fd: number) => {
      faults.closes++;
      fs.closeSync(fd);
      if (faults.close) throw new Error('secret /private');
    }
  };
});
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return {
    ...fs,
    mkdtemp: async (...args: Parameters<typeof fs.mkdtemp>) => {
      if (faults.mkdir) throw new Error('secret /private');
      return fs.mkdtemp(...args);
    },
    writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
      if (faults.write) throw new Error('secret /private');
      return fs.writeFile(...args);
    },
    rm: async (...args: Parameters<typeof fs.rm>) => {
      await fs.rm(...args);
      if (faults.remove) throw new Error('secret /private');
    }
  };
});

import { launchBubblewrap } from '../../src/sandbox/linux/bubblewrap-launch.js';

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killedWith: NodeJS.Signals | undefined;
  unref() {
    return this;
  }
  kill(signal: NodeJS.Signals) {
    this.killedWith = signal;
    queueMicrotask(() => {
      this.signalCode = signal;
      this.emit('exit', null, signal);
      this.emit('close', null, signal);
    });
    return true;
  }
}

const spec = {
  executable: '/usr/bin/bwrap',
  arguments: [],
  command: ['/bin/true'],
  seccomp: Buffer.alloc(8),
  detached: true
};
afterEach(() => {
  faults.spawn = undefined;
  faults.close = false;
  faults.remove = false;
  faults.write = false;
  faults.mkdir = false;
  faults.open = 0;
  faults.opens = 0;
  faults.closes = 0;
});

describe('Bubblewrap launch failure ownership', () => {
  it('kills and observes an aborted child before rejecting with the original reason', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled');
    const child = new FakeChild();
    let exited = false;
    child.once('exit', () => {
      exited = true;
    });
    faults.spawn = () => {
      process.nextTick(() => {
        child.emit('spawn');
        controller.abort(reason);
      });
      return child;
    };
    await expect(launchBubblewrap({ ...spec, signal: controller.signal })).rejects.toBe(reason);
    expect(child.killedWith).toBe('SIGKILL');
    expect(exited).toBe(true);
  });

  it('preserves a sanitized spawn error while reporting cleanup failure', async () => {
    const child = new FakeChild();
    faults.close = true;
    faults.spawn = () => {
      process.nextTick(() => {
        child.emit('error', new Error('secret /private'));
        child.emit('close');
      });
      return child;
    };
    const error = await launchBubblewrap(spec).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: 'SANDBOX_UNAVAILABLE', details: { cleanup: ['close'] } });
    expect(faults.closes).toBe(2);
    expect(JSON.stringify(error)).not.toContain('secret');
    expect(JSON.stringify(error)).not.toContain('/private');
  });

  it('sanitizes a synchronous spawn exception and closes both descriptors', async () => {
    faults.spawn = () => {
      throw new Error('secret /private/path');
    };
    const error = await launchBubblewrap(spec).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
    expect(JSON.stringify(error)).not.toContain('secret');
    expect(faults.closes).toBe(2);
  });

  it('does not hand off a child if closing parent descriptors fails', async () => {
    const child = new FakeChild();
    faults.close = true;
    faults.spawn = () => {
      process.nextTick(() => child.emit('spawn'));
      return child;
    };
    await expect(launchBubblewrap(spec)).rejects.toMatchObject({
      code: 'SANDBOX_UNAVAILABLE',
      details: { cleanup: ['close'] }
    });
    expect(child.killedWith).toBe('SIGKILL');
    expect(child.signalCode).toBe('SIGKILL');
  });

  it('reports unconfirmed descendants without signaling the host group for non-detached launches', async () => {
    const child = new FakeChild();
    faults.close = true;
    faults.spawn = () => {
      process.nextTick(() => child.emit('spawn'));
      return child;
    };
    await expect(launchBubblewrap({ ...spec, detached: false })).rejects.toMatchObject({
      code: 'SANDBOX_UNAVAILABLE',
      details: { cleanup: ['close', 'terminate'] }
    });
    expect(child.killedWith).toBe('SIGKILL');
  });

  it('retains the primary error if signaling the detached group fails', async () => {
    const child = Object.assign(new FakeChild(), { pid: 999999 });
    const groupKill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('secret /private'), { code: 'EPERM' });
    });
    faults.close = true;
    faults.spawn = () => {
      process.nextTick(() => child.emit('spawn'));
      return child;
    };
    try {
      const error = await launchBubblewrap(spec).catch((value: unknown) => value);
      expect(error).toMatchObject({
        code: 'SANDBOX_UNAVAILABLE',
        details: { cleanup: ['close', 'terminate'] }
      });
      expect(JSON.stringify(error)).not.toContain('secret');
      expect(child.killedWith).toBe('SIGKILL');
    } finally {
      groupKill.mockRestore();
    }
  });

  it('handles abort before the spawn event without leaving the child running', async () => {
    const controller = new AbortController();
    const child = new FakeChild();
    const reason = new Error('cancel');
    faults.spawn = () => {
      process.nextTick(() => controller.abort(reason));
      return child;
    };
    await expect(launchBubblewrap({ ...spec, signal: controller.signal })).rejects.toBe(reason);
    expect(child.killedWith).toBe('SIGKILL');
    expect(child.signalCode).toBe('SIGKILL');
  });

  it('rejects a child that exits before spawn handoff', async () => {
    const child = new FakeChild();
    faults.spawn = () => {
      process.nextTick(() => {
        child.exitCode = 1;
        child.emit('exit', 1);
      });
      return child;
    };
    await expect(launchBubblewrap(spec)).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
    expect(child.killedWith).toBeUndefined();
  });

  it('keeps a configuration failure primary when removal also fails', async () => {
    faults.write = true;
    faults.remove = true;
    const error = await launchBubblewrap(spec).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: 'SANDBOX_UNAVAILABLE', details: { cleanup: ['remove'] } });
    expect(JSON.stringify(error)).not.toContain('secret');
    expect(JSON.stringify(error)).not.toContain('/private');
  });

  it.each(['throw', 'false'] as const)(
    'bounds failed child termination when kill returns %s',
    async (kind) => {
      const child = new FakeChild();
      child.kill = () => {
        if (kind === 'throw') throw new Error('secret /private');
        return false;
      };
      faults.close = true;
      faults.spawn = () => {
        process.nextTick(() => child.emit('spawn'));
        return child;
      };
      const error = await launchBubblewrap(spec).catch((value: unknown) => value);
      expect(error).toMatchObject({
        code: 'SANDBOX_UNAVAILABLE',
        details: { cleanup: ['close', 'terminate', 'exit_timeout'] }
      });
      expect(JSON.stringify(error)).not.toContain('secret');
      expect(child.listenerCount('exit')).toBe(0);
      expect(child.listenerCount('close')).toBe(0);
    }
  );

  it('classifies directory creation failure as unavailable without leaking the OS error', async () => {
    faults.mkdir = true;
    const error = await launchBubblewrap(spec).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
    expect(JSON.stringify(error)).not.toContain('secret');
  });

  it('closes the first descriptor if opening the second fails', async () => {
    faults.open = 2;
    await expect(launchBubblewrap(spec)).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
    expect(faults.closes).toBe(1);
    expect(faults.spawn).toBeUndefined();
  });
});
