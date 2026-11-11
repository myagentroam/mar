import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fault = vi.hoisted(() => ({
  directory: '',
  renameCountdown: -1,
  syncCountdown: -1,
  doublePath: '',
  releasePath: '',
  pendingPath: '',
  closeCalls: 0,
  releaseCalls: 0,
  syncFails: true,
  syncError: new Error('first sync failure'),
  closeError: new Error('later close failure')
}));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return {
    ...fs,
    rmdir: async (...args: Parameters<typeof fs.rmdir>) => {
      await fs.rmdir(...args);
      if (args[0] === fault.releasePath) {
        fault.releaseCalls++;
        throw fault.closeError;
      }
    },
    rm: async (...args: Parameters<typeof fs.rm>) => {
      if (args[0] === fault.pendingPath) {
        fault.pendingPath = '';
        throw Object.assign(new Error('pending cleanup failed'), { code: 'EIO' });
      }
      return fs.rm(...args);
    },
    rename: async (...args: Parameters<typeof fs.rename>) => {
      if (args[1] === join(fault.directory, 'index.json') && fault.renameCountdown >= 0) {
        if (fault.renameCountdown-- === 0)
          throw Object.assign(new Error('index rename fault'), { code: 'ENOSPC' });
      }
      return fs.rename(...args);
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      if (args[0] === fault.doublePath) {
        const syncFails = args[0] === fault.doublePath && fault.syncFails;
        return new Proxy(handle, {
          get(target, property) {
            if (property === 'sync' && syncFails)
              return async () => {
                throw fault.syncError;
              };
            if (property === 'close')
              return async () => {
                fault.closeCalls++;
                await target.close();
                throw fault.closeError;
              };
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          }
        });
      }
      if (args[0] !== fault.directory || fault.syncCountdown < 0) return handle;
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'sync')
            return async () => {
              if (fault.syncCountdown-- === 0)
                throw Object.assign(new Error('index directory sync fault'), { code: 'EIO' });
              await target.sync();
            };
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
      });
    }
  };
});

import { JsonlSessionStore } from '../../src/session/store/jsonl/jsonl-store.js';
import { beginSessionStorageTransaction } from '../../src/session/store/jsonl/transaction-recovery.js';
import { prepareJsonlV2Generation } from '../../src/session/store/jsonl/jsonl-migration.js';
import { syncJsonlDirectory } from '../../src/session/store/jsonl/fs-durability.js';
const homes: string[] = [];
afterEach(async () => {
  fault.directory = '';
  fault.renameCountdown = -1;
  fault.syncCountdown = -1;
  fault.doublePath = '';
  fault.releasePath = '';
  fault.pendingPath = '';
  fault.closeCalls = 0;
  fault.releaseCalls = 0;
  fault.syncFails = true;
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function legacyStore() {
  const home = await mkdtemp(join(tmpdir(), 'mar-v2-fault-'));
  homes.push(home);
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const directory = join(home, '.mar/agent/sessions');
  const source = join(directory, id);
  await mkdir(source, { recursive: true });
  const created = {
    schemaVersion: 1,
    recordId: '11111111-1111-4111-8111-111111111111',
    sequence: 1,
    timestamp: '2026-10-27T00:00:00.000Z',
    sessionId: id,
    type: 'session.created',
    payload: {}
  };
  const line = JSON.stringify(created) + '\n';
  await writeFile(join(source, 'events-000001.jsonl'), line);
  await writeFile(
    join(directory, 'index.json'),
    JSON.stringify({
      version: 1,
      revision: 1,
      sessions: [
        {
          id,
          title: 'old',
          workspace: '/workspace',
          source: { type: 'user' },
          createdAt: created.timestamp,
          lastActivityAt: created.timestamp,
          nextSequence: 2,
          segments: [
            { number: 1, firstSequence: 1, lastSequence: 1, bytes: Buffer.byteLength(line) }
          ]
        }
      ]
    })
  );
  fault.directory = directory;
  return { home, id, source, directory, store: await JsonlSessionStore.open(home) };
}

describe('JSONL v2 commit failure boundaries', () => {
  it('returns a durably committed image turn when its pending marker cleanup fails', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-pending-commit-'));
    homes.push(home);
    const store = await JsonlSessionStore.open(home);
    const session = await store.createSession({ workspace: home });
    const images = await store.persistInputImages(session.id, [
      {
        name: 'one.png',
        mimeType: 'image/png',
        dataBase64: Buffer.from('image').toString('base64')
      }
    ]);
    const index = JSON.parse(await readFile(join(home, '.mar/agent/sessions/index.json'), 'utf8'));
    const active = join(
      home,
      '.mar/agent/sessions',
      session.id,
      'v2',
      index.sessions[0].storage.generation
    );
    const marker = join(active, 'resources', `.${images[0]!.resourceId}.pending`);
    fault.pendingPath = marker;
    const record = await store.append(session.id, {
      type: 'turn.user',
      turnId: 'turn',
      payload: { prompt: 'image', images }
    });
    expect(record.sequence).toBe(2);
    expect((await store.read(session.id)).filter((item) => item.turnId === 'turn')).toEqual([
      record
    ]);
    expect((await stat(marker)).isFile()).toBe(true);
    await store.close();
    const reopened = await JsonlSessionStore.open(home);
    const release = await reopened.acquireSessionLease(session.id);
    await release();
    expect((await reopened.read(session.id)).filter((item) => item.turnId === 'turn')).toEqual([
      record
    ]);
    await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await reopened.readInputImages(session.id, images)).toHaveLength(1);
    await reopened.close();
  });
  it.each(['records', 'resources', 'sidecar'] as const)(
    'rejects a future %s in an uncommitted v1 clear target before deleting it',
    async (kind) => {
      const { source, id, store } = await legacyStore();
      const transactionId = '99999999-9999-4999-8999-999999999999';
      const generation = '88888888-8888-4888-8888-888888888888';
      const target = join(source, 'v2', generation);
      await mkdir(join(target, 'resources'), { recursive: true });
      const path =
        kind === 'records'
          ? join(target, 'events-000001.jsonl')
          : kind === 'sidecar'
            ? join(target, 'context-world-state.json')
            : join(target, 'resources', `${'a'.repeat(64)}.json`);
      const value =
        kind === 'records'
          ? '{"schemaVersion":3}\n'
          : kind === 'sidecar'
            ? '{"version":2}'
            : '{"resourceInputVersion":2}';
      await writeFile(path, value);
      const journal = join(source, 'storage-transaction.json');
      const body = JSON.stringify({
        version: 1,
        id: transactionId,
        kind: 'clear',
        originalSegments: ['events-000001.jsonl'],
        stagedSegments: [],
        sidecarBackup: `context-world-state.json.2.${transactionId}.clear-backup`,
        targetGeneration: generation
      });
      await writeFile(journal, body);
      const original = await readFile(join(source, 'events-000001.jsonl'), 'utf8');
      await expect(store.acquireSessionLease(id)).rejects.toMatchObject({
        code: 'MAR_AGENT_SESSION_VERSION_UNSUPPORTED'
      });
      expect(await readFile(journal, 'utf8')).toBe(body);
      expect(await readFile(path, 'utf8')).toBe(value);
      expect(await readFile(join(source, 'events-000001.jsonl'), 'utf8')).toBe(original);
      await store.close();
    }
  );

  it('rejects future pending image metadata before orphan recovery removes any resource', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-v2-pending-future-'));
    homes.push(home);
    let store = await JsonlSessionStore.open(home);
    const session = await store.createSession({ workspace: home });
    const image = await store.persistResource(session.id, {
      mimeType: 'image/png',
      dataBase64: 'AAAB'
    });
    await store.close();
    const base = join(home, '.mar/agent/sessions');
    const index = JSON.parse(await readFile(join(base, 'index.json'), 'utf8'));
    const resources = join(
      base,
      session.id,
      'v2',
      index.sessions[0].storage.generation,
      'resources'
    );
    const metadata = join(resources, `${image.resourceId}.json`);
    const pending = join(resources, `.${image.resourceId}.pending`);
    const bytes = await readFile(join(resources, `${image.resourceId}.bin`));
    await writeFile(metadata, '{"resourceInputVersion":2}');
    store = await JsonlSessionStore.open(home);
    await expect(store.acquireSessionLease(session.id)).rejects.toMatchObject({
      code: 'MAR_AGENT_SESSION_VERSION_UNSUPPORTED'
    });
    expect(await readFile(metadata, 'utf8')).toBe('{"resourceInputVersion":2}');
    expect(await readFile(pending, 'utf8')).toBe('');
    expect(await readFile(join(resources, `${image.resourceId}.bin`))).toEqual(bytes);
    await store.close();
  });
  it('preserves a migration file sync failure when its close also fails', async () => {
    const { source, id, store } = await legacyStore();
    await writeFile(join(source, 'context-world-state.json'), '{"version":1}');
    const destination = join(source, 'candidate');
    fault.doublePath = join(destination, 'context-world-state.json');
    await expect(
      prepareJsonlV2Generation({ source, destination, sessionId: id, nextSequence: 2 })
    ).rejects.toBe(fault.syncError);
    expect(fault.closeCalls).toBe(1);
    expect(await readFile(join(source, 'context-world-state.json'), 'utf8')).toBe('{"version":1}');
    await store.close();
  });
  it.skipIf(process.platform === 'win32')(
    'preserves a directory sync failure when its close also fails',
    async () => {
      const home = await mkdtemp(join(tmpdir(), 'mar-v2-directory-fault-'));
      homes.push(home);
      fault.doublePath = home;
      await expect(syncJsonlDirectory(home)).rejects.toBe(fault.syncError);
      expect(fault.closeCalls).toBe(1);
    }
  );
  it('still reports a close-only failure after a successful migration file sync', async () => {
    const { source, id, store } = await legacyStore();
    await writeFile(join(source, 'context-world-state.json'), '{"version":1}');
    const destination = join(source, 'candidate');
    fault.doublePath = join(destination, 'context-world-state.json');
    fault.syncFails = false;
    await expect(
      prepareJsonlV2Generation({ source, destination, sessionId: id, nextSequence: 2 })
    ).rejects.toBe(fault.closeError);
    expect(fault.closeCalls).toBe(1);
    await store.close();
  });
  it.skipIf(process.platform === 'win32')(
    'still reports a close-only failure after a successful directory sync',
    async () => {
      const home = await mkdtemp(join(tmpdir(), 'mar-v2-directory-close-'));
      homes.push(home);
      fault.doublePath = home;
      fault.syncFails = false;
      await expect(syncJsonlDirectory(home)).rejects.toBe(fault.closeError);
      expect(fault.closeCalls).toBe(1);
    }
  );
  it('preserves a recovery failure when releasing the Session lock also fails', async () => {
    const { id, source, store } = await legacyStore();
    const journal = join(source, 'storage-transaction.json');
    await writeFile(journal, '{');
    fault.releasePath = join(source, 'lock');
    await expect(store.acquireSessionLease(id)).rejects.toMatchObject({
      code: 'MAR_AGENT_SESSION_CORRUPT'
    });
    expect(fault.releaseCalls).toBe(1);
    expect(await readFile(journal, 'utf8')).toBe('{');
    fault.releasePath = '';
    await store.close();
  });
  it('preserves an index flush failure when releasing the Session lock also fails', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-v2-release-flush-'));
    homes.push(home);
    const store = await JsonlSessionStore.open(home);
    const session = await store.createSession({ workspace: home });
    await store.append(session.id, { type: 'turn.user', payload: { prompt: 'hello' } });
    const directory = join(home, '.mar/agent/sessions');
    const indexPath = join(directory, 'index.json');
    const index = JSON.parse(await readFile(indexPath, 'utf8'));
    delete index.sessions[0].resume.firstUserMessageIndexed;
    delete index.sessions[0].resume.firstUserMessagePreview;
    await writeFile(indexPath, JSON.stringify(index));
    await store.getSession(session.id);
    fault.releasePath = join(directory, session.id, 'lock');
    const release = await store.acquireSessionLease(session.id);
    await store.firstUserMessagePreview(session.id);
    fault.directory = directory;
    fault.renameCountdown = 0;
    await expect(release()).rejects.toMatchObject({
      code: 'ENOSPC',
      message: 'index rename fault'
    });
    expect(fault.releaseCalls).toBe(1);
    fault.releasePath = '';
    await store.close();
  });
  it('keeps all pending input images across an unrelated append until their turn commits', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-v2-pending-images-'));
    homes.push(home);
    const store = await JsonlSessionStore.open(home);
    const session = await store.createSession({ workspace: home });
    const images = await store.persistInputImages(session.id, [
      { name: 'first.png', mimeType: 'image/png', dataBase64: 'AAAB' },
      { name: 'second.png', mimeType: 'image/png', dataBase64: 'AAAC' }
    ]);
    await store.append(session.id, { type: 'test.unrelated', payload: {} });
    await store.append(session.id, {
      type: 'turn.user',
      turnId: 'turn',
      payload: { prompt: 'images', images }
    });
    for (const image of images)
      await expect(store.readResource(session.id, image.resourceId)).resolves.toMatchObject({
        mimeType: 'image/png'
      });
    await store.close();
  });
  it('rejects a future v2 backup before journal recovery can replace the active segment', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-v2-future-backup-'));
    homes.push(home);
    let store = await JsonlSessionStore.open(home);
    const session = await store.createSession({ workspace: home });
    await store.close();
    const base = join(home, '.mar/agent/sessions');
    const index = JSON.parse(await readFile(join(base, 'index.json'), 'utf8'));
    const active = join(base, session.id, 'v2', index.sessions[0].storage.generation);
    const canonical = join(active, 'events-000001.jsonl');
    const original = await readFile(canonical, 'utf8');
    const transactionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const backup = `${canonical}.${transactionId}.clear-backup`;
    const future = JSON.stringify({ ...JSON.parse(original), schemaVersion: 3 }) + '\n';
    await writeFile(backup, future);
    await beginSessionStorageTransaction(active, {
      version: 1,
      id: transactionId,
      kind: 'clear',
      originalSegments: ['events-000001.jsonl'],
      stagedSegments: [],
      sidecarBackup: `context-world-state.json.2.${transactionId}.clear-backup`
    });
    store = await JsonlSessionStore.open(home);
    await expect(store.acquireSessionLease(session.id)).rejects.toMatchObject({
      code: 'MAR_AGENT_SESSION_VERSION_UNSUPPORTED'
    });
    expect(await readFile(canonical, 'utf8')).toBe(original);
    expect(await readFile(backup, 'utf8')).toBe(future);
    expect(await readFile(join(active, 'storage-transaction.json'), 'utf8')).toContain(
      transactionId
    );
    await store.close();
  });
  it('leaves a future retired generation and its journal untouched before recovery', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-v2-future-retired-'));
    homes.push(home);
    let store = await JsonlSessionStore.open(home);
    const session = await store.createSession({ workspace: home });
    await store.close();
    const base = join(home, '.mar/agent/sessions');
    const index = JSON.parse(await readFile(join(base, 'index.json'), 'utf8'));
    const root = join(base, session.id);
    const active = join(root, 'v2', index.sessions[0].storage.generation);
    const transactionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const retiredId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const trash = join(root, 'v2', `.${retiredId}.${transactionId}.retired-trash`);
    await mkdir(trash, { recursive: true });
    const evidence = JSON.stringify({ schemaVersion: 3 }) + '\n';
    await writeFile(join(trash, 'events-000001.jsonl'), evidence);
    await beginSessionStorageTransaction(active, {
      version: 1,
      id: transactionId,
      kind: 'clear',
      originalSegments: [],
      stagedSegments: [],
      sidecarBackup: `context-world-state.json.2.${transactionId}.clear-backup`,
      retiredPaths: [`v2/${retiredId}`]
    });
    store = await JsonlSessionStore.open(home);
    await expect(store.acquireSessionLease(session.id)).rejects.toMatchObject({
      code: 'MAR_AGENT_SESSION_VERSION_UNSUPPORTED'
    });
    expect(await readFile(join(trash, 'events-000001.jsonl'), 'utf8')).toBe(evidence);
    expect(await readFile(join(active, 'storage-transaction.json'), 'utf8')).toContain(
      transactionId
    );
    await store.close();
  });
  it('rejects a future version in a journal backup before restoring or replacing any v1 history', async () => {
    const { id, source, directory, store } = await legacyStore();
    const transactionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const canonical = join(source, 'events-000001.jsonl');
    const backup = `${canonical}.${transactionId}.clear-backup`;
    const original = await readFile(canonical, 'utf8');
    const future = original.replace('"schemaVersion":1', '"schemaVersion":2');
    await writeFile(backup, future);
    await beginSessionStorageTransaction(source, {
      version: 1,
      id: transactionId,
      kind: 'clear',
      originalSegments: ['events-000001.jsonl'],
      stagedSegments: [],
      sidecarBackup: `context-world-state.json.2.${transactionId}.clear-backup`
    });
    const index = await readFile(join(directory, 'index.json'), 'utf8');
    const journal = await readFile(join(source, 'storage-transaction.json'), 'utf8');
    await expect(store.acquireSessionLease(id)).rejects.toMatchObject({
      code: 'MAR_AGENT_SESSION_VERSION_UNSUPPORTED'
    });
    expect(await readFile(canonical, 'utf8')).toBe(original);
    expect(await readFile(backup, 'utf8')).toBe(future);
    expect(await readFile(join(source, 'storage-transaction.json'), 'utf8')).toBe(journal);
    expect(await readFile(join(directory, 'index.json'), 'utf8')).toBe(index);
    await store.close();
  });
  it('restores the v1 source when direct clear cannot commit its index selection', async () => {
    const { id, source, directory, store } = await legacyStore();
    const original = await readFile(join(source, 'events-000001.jsonl'), 'utf8');
    fault.renameCountdown = 1;
    await expect(store.clearSession(id)).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(
      JSON.parse(await readFile(join(directory, 'index.json'), 'utf8')).sessions[0].storage.encoding
    ).toBe(1);
    expect(await readFile(join(source, 'events-000001.jsonl'), 'utf8')).toBe(original);
    expect((await store.read(id)).map((record) => record.type)).toEqual(['session.created']);
    await expect(readFile(join(source, 'storage-transaction.json'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
    await store.close();
  });
  it('recovers an unsynced direct v1 clear from its original journal after reopen', async () => {
    const { home, id, source, directory, store } = await legacyStore();
    fault.syncCountdown = 1;
    await expect(store.clearSession(id)).rejects.toMatchObject({ code: 'EIO' });
    const selected = JSON.parse(await readFile(join(directory, 'index.json'), 'utf8')).sessions[0]
      .storage;
    expect(selected.encoding).toBe(2);
    expect(await readdir(join(source, 'v2'))).toContain(selected.generation);
    expect(await readFile(join(source, 'storage-transaction.json'), 'utf8')).toContain(
      'targetGeneration'
    );
    await expect(store.read(id)).rejects.toMatchObject({ code: 'MAR_AGENT_SESSION_CORRUPT' });
    await store.close();
    const reopened = await JsonlSessionStore.open(home);
    await expect(reopened.read(id)).rejects.toMatchObject({ code: 'MAR_AGENT_SESSION_CORRUPT' });
    const release = await reopened.acquireSessionLease(id);
    await release();
    expect((await reopened.read(id)).map((record) => record.type)).toEqual(['session.created']);
    await expect(readFile(join(source, 'events-000001.jsonl'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
    await reopened.close();
  });
  it('keeps the journal and retired history when clear becomes visible but is not synced', async () => {
    const { home, id, source, directory, store } = await legacyStore();
    await store.append(id, { type: 'turn.user', payload: { prompt: 'private history' } });
    const index = JSON.parse(await readFile(join(directory, 'index.json'), 'utf8'));
    const active = join(source, 'v2', index.sessions[0].storage.generation);
    fault.syncCountdown = 0;
    await expect(store.clearSession(id)).rejects.toMatchObject({ code: 'EIO' });
    expect(await readFile(join(active, 'storage-transaction.json'), 'utf8')).toContain(
      'retiredPaths'
    );
    await expect(store.read(id)).rejects.toMatchObject({ code: 'MAR_AGENT_SESSION_CORRUPT' });
    await store.close();
    const reopened = await JsonlSessionStore.open(home);
    await expect(reopened.read(id)).rejects.toMatchObject({ code: 'MAR_AGENT_SESSION_CORRUPT' });
    const release = await reopened.acquireSessionLease(id);
    await release();
    expect((await reopened.read(id)).map((record) => record.type)).toEqual(['session.created']);
    await expect(readFile(join(source, 'events-000001.jsonl'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
    await reopened.close();
  });
  it('leaves a known precommit failure read-only and retries only after reopening', async () => {
    const { home, id, source, directory, store } = await legacyStore();
    const original = await readFile(join(source, 'events-000001.jsonl'), 'utf8');
    fault.renameCountdown = 1;
    await expect(
      store.append(id, { type: 'turn.user', payload: { prompt: 'hello' } })
    ).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(
      JSON.parse(await readFile(join(directory, 'index.json'), 'utf8')).sessions[0].storage.encoding
    ).toBe(1);
    expect(await readFile(join(source, 'events-000001.jsonl'), 'utf8')).toBe(original);
    expect(await readdir(join(source, 'v2'))).toEqual([]);
    expect(await store.read(id)).toHaveLength(1);
    await expect(store.append(id, { type: 'turn.user', payload: {} })).rejects.toMatchObject({
      code: 'ENOSPC'
    });
    await store.close();
    let reopened = await JsonlSessionStore.open(home);
    // The root fence is already committed, so the next rename is the Session selection.
    fault.renameCountdown = 0;
    await expect(reopened.append(id, { type: 'turn.user', payload: {} })).rejects.toMatchObject({
      code: 'ENOSPC'
    });
    expect(await readdir(join(source, 'v2'))).toEqual([]);
    await reopened.close();
    reopened = await JsonlSessionStore.open(home);
    await reopened.append(id, { type: 'turn.user', payload: { prompt: 'hello' } });
    expect(await readdir(join(source, 'v2'))).toHaveLength(1);
    expect((await reopened.read(id)).map((record) => record.sequence)).toEqual([1, 2]);
    await reopened.close();
  });

  it('keeps a visible but unsynced migration selection unavailable until reopen', async () => {
    const { home, id, source, directory, store } = await legacyStore();
    fault.syncCountdown = 1;
    await expect(store.append(id, { type: 'turn.user', payload: {} })).rejects.toMatchObject({
      code: 'EIO'
    });
    const selected = JSON.parse(await readFile(join(directory, 'index.json'), 'utf8')).sessions[0]
      .storage;
    expect(selected.encoding).toBe(2);
    expect(await readdir(join(source, 'v2'))).toContain(selected.generation);
    expect(await readFile(join(source, 'events-000001.jsonl'), 'utf8')).toContain('schemaVersion');
    expect(await readdir(join(source, 'v2'))).toHaveLength(1);
    await expect(store.read(id)).rejects.toMatchObject({ code: 'EIO' });
    await store.close();
    const reopened = await JsonlSessionStore.open(home);
    await reopened.append(id, { type: 'turn.user', payload: {} });
    expect((await reopened.read(id)).map((record) => record.sequence)).toEqual([1, 2]);
    await reopened.close();
  });
});
