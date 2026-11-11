import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({
  gate: undefined as
    | {
        operation: 'rename' | 'unlink' | 'rmdir';
        path: string;
        entered: PromiseWithResolvers<void>;
        resume: PromiseWithResolvers<void>;
      }
    | undefined,
  renameError: undefined as Error | undefined,
  cleanupError: undefined as Error | undefined
}));

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  const pause = async (operation: 'rename' | 'unlink' | 'rmdir', path: unknown) => {
    if (io.gate?.operation !== operation || io.gate.path !== path) return;
    const gate = io.gate;
    io.gate = undefined;
    gate.entered.resolve();
    await gate.resume.promise;
  };
  return {
    ...fs,
    rename: async (...args: Parameters<typeof fs.rename>) => {
      await pause('rename', args[1]);
      if (io.renameError) throw io.renameError;
      return fs.rename(...args);
    },
    unlink: async (...args: Parameters<typeof fs.unlink>) => {
      await pause('unlink', args[0]);
      return fs.unlink(...args);
    },
    rmdir: async (...args: Parameters<typeof fs.rmdir>) => {
      await pause('rmdir', args[0]);
      if (io.cleanupError) throw io.cleanupError;
      return fs.rmdir(...args);
    },
    rm: async (...args: Parameters<typeof fs.rm>) => {
      if (io.cleanupError && String(args[0]).includes('.pending-')) throw io.cleanupError;
      return fs.rm(...args);
    }
  };
});

import { acquireFileLock } from '../../src/storage/file-lock.js';

const directories: string[] = [];
afterEach(async () => {
  io.renameError = undefined;
  io.cleanupError = undefined;
  io.gate = undefined;
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function fixture(owner?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'mar-file-lock-'));
  directories.push(directory);
  const path = join(directory, 'lock');
  if (owner !== undefined) {
    await mkdir(path);
    if (owner) await writeFile(join(path, 'abandoned-owner'), owner);
  }
  return { directory, path };
}

it('publishes complete ownership, excludes another writer, and releases idempotently', async () => {
  const { directory, path } = await fixture();
  const release = await acquireFileLock(path);
  try {
    const owners = await readdir(path);
    expect(owners).toHaveLength(1);
    expect(JSON.parse(await readFile(join(path, owners[0]!), 'utf8'))).toMatchObject({
      pid: process.pid,
      createdAt: expect.any(String)
    });
    await expect(
      acquireFileLock(path, 'Writer is busy.', 0, { code: 'TEST_LOCKED' })
    ).rejects.toMatchObject({
      code: 'TEST_LOCKED',
      publicMessage: 'Writer is busy.'
    });
  } finally {
    await release();
  }
  await release();
  expect(await readdir(directory)).toEqual([]);
});

it.each(['', JSON.stringify({ pid: 2147483647 })])(
  'recovers an interrupted owner cleanup without any reclamation marker: %j',
  async (owner) => {
    const { directory, path } = await fixture(owner);
    await writeFile(`${path}.reclaim`, '');
    const release = await acquireFileLock(path, undefined, 0);
    await release();
    expect(await readdir(directory)).toEqual(['lock.reclaim']);
  }
);

it.each([
  'invalid',
  JSON.stringify({ pid: 0 }),
  JSON.stringify({ pid: process.pid, createdAt: '2000-01-01' })
])('does not take a lock whose owner is unknown or still alive: %s', async (owner) => {
  const { path } = await fixture(owner);
  await expect(acquireFileLock(path, undefined, 0)).rejects.toMatchObject({
    code: 'MAR_AGENT_SESSION_LOCKED'
  });
  expect(await readFile(join(path, 'abandoned-owner'), 'utf8')).toBe(owner);
});

it.each(['unlink', 'rmdir'] as const)(
  'does not delete a new owner when a stale cleanup resumes before %s',
  async (operation) => {
    const { path } = await fixture(JSON.stringify({ pid: 2147483647 }));
    const gate = {
      operation,
      path: operation === 'unlink' ? join(path, 'abandoned-owner') : path,
      entered: Promise.withResolvers<void>(),
      resume: Promise.withResolvers<void>()
    };
    io.gate = gate;
    const stale = acquireFileLock(path, undefined, 0).then(
      async (release) => {
        await release();
        return undefined;
      },
      (error: unknown) => error
    );
    let release: (() => Promise<void>) | undefined;
    try {
      await gate.entered.promise;
      release = await acquireFileLock(path, undefined, 0);
      const owners = await readdir(path);
      gate.resume.resolve();
      expect(await stale).toMatchObject({ code: 'MAR_AGENT_SESSION_LOCKED' });
      expect(await readdir(path)).toEqual(owners);
      expect(JSON.parse(await readFile(join(path, owners[0]!), 'utf8')).pid).toBe(process.pid);
    } finally {
      gate.resume.resolve();
      await stale;
      await release?.();
    }
  }
);

it('does not remove a new lock when the previous owner finishes releasing', async () => {
  const { path } = await fixture();
  const release = await acquireFileLock(path);
  const gate = {
    operation: 'rmdir' as const,
    path,
    entered: Promise.withResolvers<void>(),
    resume: Promise.withResolvers<void>()
  };
  io.gate = gate;
  const releasing = release();
  let releaseNext: (() => Promise<void>) | undefined;
  try {
    await gate.entered.promise;
    releaseNext = await acquireFileLock(path, undefined, 0);
    const owners = await readdir(path);
    gate.resume.resolve();
    await releasing;
    expect(await readdir(path)).toEqual(owners);
  } finally {
    gate.resume.resolve();
    await releasing;
    await releaseNext?.();
  }
});

it.each([false, true])(
  'preserves an abort after publication (cleanup failure: %s)',
  async (cleanupFails) => {
    const { directory, path } = await fixture();
    const controller = new AbortController();
    const reason = new Error('cancelled');
    const gate = {
      operation: 'rename' as const,
      path,
      entered: Promise.withResolvers<void>(),
      resume: Promise.withResolvers<void>()
    };
    io.gate = gate;
    const pending = acquireFileLock(path, undefined, 0, { signal: controller.signal });
    const rejected = expect(pending).rejects.toBe(reason);
    try {
      await gate.entered.promise;
      await expect(readdir(path)).rejects.toMatchObject({ code: 'ENOENT' });
      if (cleanupFails)
        io.cleanupError = Object.assign(new Error('release cleanup failed'), { code: 'EIO' });
      controller.abort(reason);
    } finally {
      gate.resume.resolve();
    }
    await rejected;
    if (cleanupFails) {
      expect(await readdir(path)).toEqual([]);
      io.cleanupError = undefined;
      const release = await acquireFileLock(path);
      await release();
    }
    expect(await readdir(directory)).toEqual([]);
  }
);

it('surfaces publication I/O failures and removes its private pending directory', async () => {
  const { directory, path } = await fixture();
  io.renameError = Object.assign(new Error('disk failed'), { code: 'EIO' });
  await expect(acquireFileLock(path)).rejects.toBe(io.renameError);
  expect(await readdir(directory)).toEqual([]);
});

it('preserves the acquisition error when private pending cleanup also fails', async () => {
  const { path } = await fixture();
  const failure = Object.assign(new Error('publication failed'), { code: 'EIO' });
  io.renameError = failure;
  io.cleanupError = Object.assign(new Error('pending cleanup failed'), { code: 'ENOSPC' });
  await expect(acquireFileLock(path)).rejects.toBe(failure);
  await expect(readdir(path)).rejects.toMatchObject({ code: 'ENOENT' });
  io.renameError = undefined;
  io.cleanupError = undefined;
  const release = await acquireFileLock(path);
  await release();
});
