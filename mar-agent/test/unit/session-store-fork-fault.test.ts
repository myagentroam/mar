import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const fault = vi.hoisted(() => ({
  source: '',
  index: '',
  mode: '' as
    | ''
    | 'readback'
    | 'readback-missing'
    | 'release'
    | 'source-release'
    | 'marker'
    | 'marker-stale-index'
    | 'index-readback',
  triggered: false,
  secondaryTriggered: false,
  first: new Error('fork segment failure'),
  second: new Error('fork secondary failure')
}));

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return {
    ...fs,
    rmdir: async (...args: Parameters<typeof fs.rmdir>) => {
      await fs.rmdir(...args);
      const path = String(args[0]);
      if (
        basename(path) === 'lock' &&
        ((fault.mode === 'release' && dirname(path) !== fault.source) ||
          (fault.mode === 'source-release' && dirname(path) === fault.source))
      ) {
        fault.secondaryTriggered = true;
        throw fault.second;
      }
    },
    readFile: async (...args: Parameters<typeof fs.readFile>) => {
      if (fault.mode === 'marker-stale-index' && fault.triggered && args[0] === fault.index) {
        fault.secondaryTriggered = true;
        const index = JSON.parse(await fs.readFile(fault.index, 'utf8'));
        index.sessions = index.sessions.filter(
          (item: { title: string }) => item.title !== 'Branch'
        );
        return JSON.stringify(index);
      }
      if (
        (fault.mode === 'readback' ||
          fault.mode === 'readback-missing' ||
          fault.mode === 'index-readback') &&
        fault.triggered &&
        args[0] === fault.index
      ) {
        fault.secondaryTriggered = true;
        if (fault.mode === 'readback-missing')
          throw Object.assign(new Error('Index unavailable'), { code: 'ENOENT' });
        throw fault.second;
      }
      return fs.readFile(...args);
    },
    rename: async (...args: Parameters<typeof fs.rename>) => {
      if (fault.mode === 'index-readback' && !fault.triggered && args[1] === fault.index) {
        fault.triggered = true;
        throw fault.first;
      }
      return fs.rename(...args);
    },
    rm: async (...args: Parameters<typeof fs.rm>) => {
      if (
        (fault.mode === 'marker' || fault.mode === 'marker-stale-index') &&
        basename(String(args[0])) === 'publication-pending'
      ) {
        fault.triggered = true;
        throw fault.second;
      }
      return fs.rm(...args);
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      const path = String(args[0]);
      const segment =
        path.endsWith('.fork-tmp') &&
        (fault.mode === 'readback' ||
          fault.mode === 'readback-missing' ||
          fault.mode === 'release' ||
          fault.mode === 'source-release');
      if (!segment) return handle;
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'sync' && segment)
            return async () => {
              fault.triggered = true;
              throw fault.first;
            };
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
      });
    }
  };
});

import { JsonlSessionStore } from '../../src/session/store/jsonl/jsonl-store.js';

const homes: string[] = [];
afterEach(async () => {
  fault.mode = '';
  fault.triggered = false;
  fault.secondaryTriggered = false;
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

it.each(['readback', 'readback-missing', 'release', 'source-release'] as const)(
  'retains the first fork failure when %s also fails',
  async (mode) => {
    const home = await mkdtemp(join(tmpdir(), 'mar-fork-double-fault-'));
    homes.push(home);
    const store = await JsonlSessionStore.open(home);
    const source = await store.createSession({ title: 'Source', workspace: home });
    const root = join(home, '.mar', 'agent', 'sessions');
    fault.source = join(root, source.id);
    fault.index = join(root, 'index.json');
    fault.mode = mode;
    try {
      await expect(
        store.forkSession(source.id, { boundaryTurnId: null, title: 'Branch' })
      ).rejects.toBe(fault.first);
      expect(fault.triggered).toBe(true);
      expect(fault.secondaryTriggered).toBe(true);
      if (mode === 'readback' || mode === 'readback-missing') {
        const directories = (await readdir(root)).filter((name) => /^[0-9a-f-]{36}$/u.test(name));
        expect(directories).toHaveLength(2);
      }
    } finally {
      fault.mode = '';
      await store.close();
    }
  }
);

it('preserves a published fork when marker cleanup fails', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mar-fork-marker-fault-'));
  homes.push(home);
  const store = await JsonlSessionStore.open(home);
  const source = await store.createSession({ title: 'Source', workspace: home });
  fault.mode = 'marker';
  try {
    await expect(
      store.forkSession(source.id, { boundaryTurnId: null, title: 'Branch' })
    ).rejects.toBe(fault.second);
    expect(fault.triggered).toBe(true);
    const branches = (await store.list()).sessions.filter((item) => item.title === 'Branch');
    expect(branches).toHaveLength(1);
    expect(await readdir(join(home, '.mar', 'agent', 'sessions'))).toContain(branches[0]!.id);
  } finally {
    fault.mode = '';
    await store.close();
  }
});

it('retains a confirmed fork when cleanup fails and a later index read omits it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mar-fork-confirmed-'));
  homes.push(home);
  const store = await JsonlSessionStore.open(home);
  const source = await store.createSession({ title: 'Source', workspace: home });
  const root = join(home, '.mar', 'agent', 'sessions');
  fault.index = join(root, 'index.json');
  fault.mode = 'marker-stale-index';
  try {
    await expect(
      store.forkSession(source.id, { boundaryTurnId: null, title: 'Branch' })
    ).rejects.toBe(fault.second);
    expect(fault.triggered).toBe(true);
    expect(fault.secondaryTriggered).toBe(false);
    fault.mode = '';
    const index = JSON.parse(await readFile(fault.index, 'utf8'));
    const branch = index.sessions.find((item: { title: string }) => item.title === 'Branch');
    expect(branch).toBeDefined();
    expect(await readdir(root)).toContain(branch.id);
  } finally {
    fault.mode = '';
    await store.close();
  }
});

it('does not publish an uncertain fork through a later index flush', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mar-fork-unknown-index-'));
  homes.push(home);
  const store = await JsonlSessionStore.open(home);
  const source = await store.createSession({ title: 'Source', workspace: home });
  fault.index = join(home, '.mar', 'agent', 'sessions', 'index.json');
  fault.mode = 'index-readback';
  try {
    await expect(
      store.forkSession(source.id, { boundaryTurnId: null, title: 'Branch' })
    ).rejects.toBe(fault.first);
    expect(fault.triggered).toBe(true);
    fault.mode = '';
    await store.createSession({ workspace: home, title: 'Other' });
    const index = JSON.parse(await readFile(fault.index, 'utf8'));
    expect(index.sessions.map((item: { title: string }) => item.title)).not.toContain('Branch');
  } finally {
    fault.mode = '';
    await store.close();
  }
});
