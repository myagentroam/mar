import { mkdtemp, readFile, rm, writeFile, open, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ExtensionStore } from '../../src/agent-core/extensions/store.js';
import { ExtensionResourceScope } from '../../src/agent-core/extensions/resources.js';
import type { CoreJsonValue } from '../../src/agent-core/extensions/data.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'mar-extension-store-'));
  directories.push(directory);
  const scope = new ExtensionResourceScope();
  scope.activate();
  const store = new ExtensionStore(directory).bind((operation) => scope.run(operation));
  return { directory, scope, store };
}

describe('Installation durable store', () => {
  it('waits for a foreign process holding the physical writer lock', async () => {
    const { directory, scope, store } = await fixture();
    const lockPath = join(directory, 'core-store.lock');
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import {open, rm} from 'node:fs/promises';
      const path = process.argv[1];
      const lock = await open(path, 'wx', 0o600);
      await lock.writeFile(JSON.stringify({pid: process.pid}));
      process.stdin.once('data', async () => { await lock.close(); await rm(path); process.exit(0); });
      process.stdout.write('ready');
    `,
        lockPath
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const exited = once(child, 'exit');
    try {
      await once(child.stdout, 'data');
      let committed = false;
      const pending = store.set({ key: 'after-lock', value: true }).then((value) => {
        committed = true;
        return value;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(committed).toBe(false);
      child.stdin.end('release');
      expect(await pending).toEqual({ revision: 1, value: true });
      expect((await exited)[0]).toBe(0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
      await scope.dispose();
    }
  });
  it('persists independent namespaces and commits multiple keys atomically with real CAS', async () => {
    const { directory, scope, store } = await fixture();
    expect(await store.get({ key: 'first' })).toEqual({ revision: 0 });
    expect(
      await store.commit({
        expectedRevision: 0,
        writes: [
          { key: 'first', value: { count: 1 } },
          { key: 'second', value: 'two' }
        ]
      })
    ).toEqual({ revision: 1 });
    const reopened = new ExtensionStore(directory).bind((operation) => scope.run(operation));
    expect(await reopened.keys()).toEqual({ revision: 1, keys: ['first', 'second'] });
    expect(await reopened.get({ key: 'second' })).toEqual({ revision: 1, value: 'two' });
    const outcomes = await Promise.allSettled([
      store.set({ key: 'cas', value: 1, expectedRevision: 1 }),
      reopened.set({ key: 'cas', value: 2, expectedRevision: 1 })
    ]);
    expect(outcomes.filter((value) => value.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((value) => value.status === 'rejected')).toHaveLength(1);
    expect(
      (outcomes.find((value) => value.status === 'rejected') as PromiseRejectedResult).reason.code
    ).toBe('MAR_AGENT_EXTENSION_STORE_CONFLICT');
    expect(await store.delete({ key: 'first', expectedRevision: 2 })).toEqual({ revision: 3 });
    expect(await reopened.get({ key: 'first' })).toEqual({ revision: 3 });
    expect(await readdir(directory)).toEqual(['core-store.json']);
    const other = await fixture();
    expect(await other.store.keys()).toEqual({ revision: 0, keys: [] });
    await scope.dispose();
    await other.scope.dispose();
  });

  it('preserves old data after serialization failure, conflict, and corruption detection', async () => {
    const { directory, scope, store } = await fixture();
    await store.set({ key: 'preserved', value: 'old' });
    const before = await readFile(join(directory, 'core-store.json'), 'utf8');
    await expect(
      store.commit({
        writes: [
          { key: 'first', value: true },
          { key: 'invalid', value: Number.NaN }
        ]
      })
    ).rejects.toThrow(/DATA_INVALID/);
    await expect(
      store.set({ key: 'preserved', value: 'new', expectedRevision: 0 })
    ).rejects.toThrow(/STORE_CONFLICT/);
    expect(await readFile(join(directory, 'core-store.json'), 'utf8')).toBe(before);
    await writeFile(join(directory, 'core-store.json'), 'corrupt-private-data');
    await expect(store.get({ key: 'preserved' })).rejects.toThrow(/STORE_CORRUPT/);
    await expect(store.set({ key: 'new', value: true })).rejects.toThrow(/STORE_CORRUPT/);
    expect(await readFile(join(directory, 'core-store.json'), 'utf8')).toBe('corrupt-private-data');
    await scope.dispose();
  });

  it('cancels lock admission on owner retirement and prevents late writes', async () => {
    const { directory, scope, store } = await fixture();
    const lock = await open(join(directory, 'core-store.lock'), 'wx', 0o600);
    await lock.writeFile(JSON.stringify({ pid: process.pid }));
    const pending = store.set({ key: 'late', value: true });
    const rejected = expect(pending).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await scope.dispose();
    await rejected;
    await lock.close();
    await rm(join(directory, 'core-store.lock'));
    expect(await readdir(directory)).toEqual([]);
    await expect(store.set({ key: 'after-retire', value: true })).rejects.toThrow(/RETIRED/);
  });

  it('accepts ordinary JSON keys without prototype pollution or mutable read aliases', async () => {
    const { scope, store } = await fixture();
    await store.set({ key: '__proto__', value: { marker: 'ordinary-key' } });
    expect(await store.get({ key: '__proto__' })).toEqual({
      revision: 1,
      value: { marker: 'ordinary-key' }
    });
    await expect(
      store.set({ key: 'special-data', value: JSON.parse('{"__proto__": null}') })
    ).resolves.toMatchObject({ value: { ['__proto__']: null } });
    await expect(
      store.set({ key: 'invalid-special', value: Object.fromEntries([['__proto__', Number.NaN]]) })
    ).rejects.toThrow(/DATA_INVALID/);
    const value: CoreJsonValue = { nested: { count: 1 } };
    await store.set({ key: 'copy', value });
    (value as { nested: { count: number } }).nested.count = 7;
    const first = await store.get({ key: 'copy' });
    (first.value as { nested: { count: number } }).nested.count = 9;
    expect((await store.get({ key: 'copy' })).value).toEqual({ nested: { count: 1 } });
    expect(({} as { marker?: string }).marker).toBeUndefined();
    await scope.dispose();
  });
});
