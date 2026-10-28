import { existsSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({
  write: undefined as undefined | ((path: string) => Promise<void>),
  remove: undefined as undefined | ((path: string) => void)
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    writeFile: async (
      path: string,
      ...args: Parameters<typeof original.writeFile> extends [unknown, ...infer R] ? R : never
    ) => {
      if (io.write) return io.write(path);
      return original.writeFile(path, ...args);
    },
    rm: async (path: string, options: Parameters<typeof original.rm>[1]) => {
      io.remove?.(path);
      return original.rm(path, options);
    }
  };
});

import { BubblewrapSandboxExecutor } from '../../src/sandbox/linux/index.js';

describe('Linux sandbox launch resources', () => {
  it.skipIf(process.platform !== 'linux' || !existsSync('/usr/bin/bwrap'))(
    'waits for every concurrent write before removing its launch directory',
    async () => {
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      let secondStarted = false;
      let removed = false;
      io.write = async (path) => {
        if (path.endsWith('/arguments')) throw new Error('write failed');
        secondStarted = true;
        await pending;
      };
      io.remove = () => {
        removed = true;
      };
      try {
        const operation = new BubblewrapSandboxExecutor({ profile: { policyVersion: 1 } }).spawn({
          command: '/bin/true',
          cwd: '/',
          environment: {},
          detached: true
        });
        const result = operation.catch((error: unknown) => error);
        await vi.waitFor(() => expect(secondStarted).toBe(true));
        await new Promise((resolve) => setImmediate(resolve));
        expect(removed).toBe(false);
        release();
        expect(await result).toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
        expect(removed).toBe(true);
      } finally {
        release();
        io.write = undefined;
        io.remove = undefined;
      }
    }
  );

  it.skipIf(process.platform !== 'linux' || !existsSync('/usr/bin/bwrap'))(
    'settles pending writes and removes the directory when preparation is aborted',
    async () => {
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      let writes = 0;
      let removed = false;
      io.write = async () => {
        writes++;
        await pending;
      };
      io.remove = () => {
        removed = true;
      };
      const controller = new AbortController();
      const reason = new Error('cancelled');
      try {
        const operation = new BubblewrapSandboxExecutor({ profile: { policyVersion: 1 } }).spawn({
          command: '/bin/true',
          cwd: '/',
          environment: {},
          detached: true,
          signal: controller.signal
        });
        const result = operation.catch((error: unknown) => error);
        await vi.waitFor(() => expect(writes).toBe(2));
        controller.abort(reason);
        expect(removed).toBe(false);
        release();
        expect(await result).toBe(reason);
        expect(removed).toBe(true);
      } finally {
        release();
        io.write = undefined;
        io.remove = undefined;
      }
    }
  );
});
