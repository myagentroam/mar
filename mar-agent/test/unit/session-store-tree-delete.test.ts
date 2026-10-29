import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';

const fault = vi.hoisted(() => ({
  stageCountdown: -1,
  indexPath: '',
  failIndex: false,
  cleanupPath: '',
  failCleanup: false,
  syncRoot: '',
  failSync: false,
  indexRenamed: false,
  failRestore: false,
  failDecisionRead: false,
  publishLockPath: '',
  publishGate: undefined as { entered: () => void; resume: Promise<void> } | undefined,
  error: new Error('injected deletion failure')
}));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return {
    ...fs,
    readFile: async (...args: Parameters<typeof fs.readFile>) => {
      if (args[0] === fault.indexPath && fault.failDecisionRead && !fault.failIndex)
        throw Object.assign(new Error('secondary index read failed'), { code: 'EIO' });
      return fs.readFile(...args);
    },
    rename: async (...args: Parameters<typeof fs.rename>) => {
      if (
        String(args[0]).includes('.delete-') &&
        String(args[0]).includes('.trash/') &&
        fault.failRestore
      )
        throw new Error('secondary restore failure');
      if (String(args[1]).includes('.delete-') && String(args[1]).includes('.trash/')) {
        if (fault.stageCountdown === 0) {
          fault.stageCountdown = -1;
          throw fault.error;
        }
        if (fault.stageCountdown > 0) fault.stageCountdown--;
      }
      if (args[1] === fault.indexPath && fault.failIndex) {
        fault.failIndex = false;
        throw fault.error;
      }
      await fs.rename(...args);
      if (args[1] === fault.indexPath) fault.indexRenamed = true;
    },
    rm: async (...args: Parameters<typeof fs.rm>) => {
      if (args[0] === fault.cleanupPath && fault.failCleanup) throw fault.error;
      return fs.rm(...args);
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      if (args[0] === fault.publishLockPath && args[1] === 'wx' && fault.publishGate) {
        const gate = fault.publishGate;
        fault.publishGate = undefined;
        gate.entered();
        await gate.resume;
      }
      const handle = await fs.open(...args);
      if (args[0] === fault.syncRoot && fault.failSync && fault.indexRenamed)
        vi.spyOn(handle, 'sync').mockImplementation(async () => {
          throw fault.error;
        });
      return handle;
    }
  };
});

import { JsonlSessionStore } from '../../src/session/store/jsonl/jsonl-store.js';
import { syncJsonlDirectory } from '../../src/session/store/jsonl/fs-durability.js';
import { acquireFileLock } from '../../src/storage/file-lock.js';
import {
  beginTreeDeleteTransaction,
  finishTreeDelete,
  stageTreeDelete
} from '../../src/session/store/jsonl/transaction-recovery.js';
import { randomUUID } from 'node:crypto';

const homes: string[] = [];
afterEach(async () => {
  fault.stageCountdown = -1;
  fault.indexPath = '';
  fault.failIndex = false;
  fault.cleanupPath = '';
  fault.failCleanup = false;
  fault.syncRoot = '';
  fault.failSync = false;
  fault.indexRenamed = false;
  fault.failRestore = false;
  fault.failDecisionRead = false;
  fault.publishLockPath = '';
  fault.publishGate = undefined;
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'mar-tree-delete-'));
  homes.push(home);
  const store = await JsonlSessionStore.open(home);
  const root = await store.createSession({ workspace: home });
  const child = await store.createSession({
    workspace: home,
    source: {
      type: 'subagent',
      parentSessionId: root.id,
      rootSessionId: root.id,
      parentExecutionId: 'execution',
      role: 'explore',
      description: 'child'
    }
  });
  const other = await store.createSession({ workspace: home });
  await store.append(root.id, {
    type: 'turn.user',
    turnId: 'root-turn',
    payload: { prompt: 'root' }
  });
  await store.append(child.id, {
    type: 'turn.user',
    turnId: 'child-turn',
    payload: { prompt: 'child' }
  });
  return { home, store, root, child, other, sessions: join(home, '.mar/agent/sessions') };
}

async function deleteMembers(
  store: JsonlSessionStore,
  rootId: string,
  memberIds: readonly string[]
) {
  const holding = await store.acquireSessionMaintenance(rootId, 'delete', undefined, memberIds);
  try {
    return await store.delete(rootId, holding);
  } finally {
    await holding.release();
  }
}

it('admits only the explicit set rather than expanding a stored relation', async () => {
  const { store, root, child, other } = await fixture();
  const holding = await store.acquireSessionMaintenance(root.id, 'delete', undefined, [
    root.id,
    other.id
  ]);
  try {
    expect(new Set(holding.sessionIds)).toEqual(new Set([root.id, other.id]));
    await store.delete(root.id, holding);
    await expect(store.getSession(child.id)).resolves.toMatchObject({ id: child.id });
    await expect(store.getSession(other.id)).rejects.toMatchObject({
      code: 'MAR_AGENT_SESSION_NOT_FOUND'
    });
  } finally {
    await holding.release();
    await store.close();
  }
});

it('blocks cross-process child publication throughout tree maintenance', async () => {
  const { home, store, root, child, other } = await fixture();
  const holding = await store.acquireSessionMaintenance(root.id, 'delete', undefined, [
    root.id,
    child.id
  ]);
  const helper = fileURLToPath(new URL('../support/create-subagent-child.ts', import.meta.url));
  const create = (parent: string, rootId: string) => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', helper, home, parent, rootId], {
      timeout: 10000,
      encoding: 'utf8'
    });
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  };
  try {
    expect(create(root.id, root.id)).toEqual({ code: 'MAR_AGENT_SESSION_LOCKED' });
    expect(create(child.id, root.id)).toEqual({ code: 'MAR_AGENT_SESSION_LOCKED' });
    expect(create(other.id, other.id)).toEqual({ id: expect.any(String) });
    expect(await store.delete(root.id, holding)).toEqual({ deleted: true });
  } finally {
    await holding.release();
    await store.close();
  }
});

it('allows cross-process child publication while the parent has an ordinary writer', async () => {
  const { home, store, root } = await fixture();
  const release = await store.acquireSessionLease(root.id, {});
  try {
    const helper = fileURLToPath(new URL('../support/create-subagent-child.ts', import.meta.url));
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', helper, home, root.id, root.id],
      { timeout: 10000, encoding: 'utf8' }
    );
    expect(result.status, result.stderr).toBe(0);
    const published = JSON.parse(result.stdout);
    expect(published).toEqual({ id: expect.any(String) });
    expect((await store.getSession(published.id)).source).toMatchObject({
      parentSessionId: root.id
    });
  } finally {
    await release();
    await store.close();
  }
});

it('waits for a short competing publication instead of rejecting a concurrent child', async () => {
  const { home, store, root, sessions } = await fixture();
  const directory = join(sessions, '.publication-locks');
  await mkdir(directory, { recursive: true });
  const release = await acquireFileLock(join(directory, root.id));
  let released = false;
  const helper = fileURLToPath(new URL('../support/create-subagent-child.ts', import.meta.url));
  const child = spawn(process.execPath, ['--import', 'tsx', helper, home, root.id, root.id], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    output += chunk;
  });
  const completed = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(child.exitCode).toBeNull();
    await release();
    released = true;
    expect(await completed).toBe(0);
    expect(JSON.parse(output)).toEqual({ id: expect.any(String) });
  } finally {
    if (!released) await release();
    await store.close();
  }
});

it('excludes another process deleting the parent during child publication', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mar-delete-publication-'));
  homes.push(home);
  const store = await JsonlSessionStore.open(home);
  const parent = await store.createSession({ workspace: home });
  const sessions = join(home, '.mar', 'agent', 'sessions');
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  fault.publishLockPath = join(sessions, 'index.lock');
  fault.publishGate = { entered: entered.resolve, resume: resume.promise };
  const creation = store.createSession({
    workspace: home,
    source: {
      type: 'subagent',
      parentSessionId: parent.id,
      rootSessionId: parent.id,
      parentExecutionId: 'execution',
      role: 'explore',
      description: 'in flight'
    }
  });
  // Attach immediately so a rejected creation cannot become an unhandled rejection.
  const outcome = creation.then(
    (value) => ({ value }),
    (error: unknown) => ({ error })
  );
  try {
    await entered.promise;
    const pending = (await readdir(sessions)).filter(
      (name) => /^[0-9a-f-]{36}$/iu.test(name) && name !== parent.id
    );
    expect(pending).toHaveLength(1);
    expect(await readFile(join(sessions, pending[0]!, 'publication-pending'), 'utf8')).toBe('1');
    const helper = fileURLToPath(new URL('../support/delete-parent-child.ts', import.meta.url));
    const child = spawnSync(process.execPath, ['--import', 'tsx', helper, home, parent.id], {
      encoding: 'utf8',
      timeout: 10000
    });
    expect(child.error).toBeUndefined();
    expect(child.status).not.toBe(0);
    expect(child.stderr).toContain('MAR_AGENT_SESSION_LOCKED');
    resume.resolve();
    expect(await outcome).toMatchObject({ value: { id: pending[0] } });
    expect(await deleteMembers(store, parent.id, [parent.id, pending[0]!])).toEqual({
      deleted: true
    });
    const index = JSON.parse(await readFile(join(sessions, 'index.json'), 'utf8'));
    expect(index.sessions).toEqual([]);
    await expect(stat(join(sessions, pending[0]!))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    resume.resolve();
    await outcome;
    await store.close();
  }
});

it('rejects publication if its parent disappears from the index after the initial check', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mar-deleted-parent-publication-'));
  homes.push(home);
  const store = await JsonlSessionStore.open(home);
  const parent = await store.createSession({ workspace: home });
  const sessions = join(home, '.mar', 'agent', 'sessions');
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  fault.publishLockPath = join(sessions, 'index.lock');
  fault.publishGate = { entered: entered.resolve, resume: resume.promise };
  const creation = store.createSession({
    workspace: home,
    source: {
      type: 'subagent',
      parentSessionId: parent.id,
      rootSessionId: parent.id,
      parentExecutionId: 'execution',
      role: 'explore',
      description: 'in flight'
    }
  });
  const outcome = creation.then(
    (value) => ({ value }),
    (error: unknown) => ({ error })
  );
  try {
    await entered.promise;
    const pending = (await readdir(sessions)).filter(
      (name) => /^[0-9a-f-]{36}$/iu.test(name) && name !== parent.id
    );
    expect(pending).toHaveLength(1);
    const path = join(sessions, 'index.json');
    const index = JSON.parse(await readFile(path, 'utf8'));
    index.sessions = index.sessions.filter((entry: { id: string }) => entry.id !== parent.id);
    await writeFile(path, JSON.stringify(index), { flush: true });
    resume.resolve();
    expect(await outcome).toMatchObject({ error: { code: 'MAR_AGENT_SESSION_NOT_FOUND' } });
    expect(JSON.parse(await readFile(path, 'utf8')).sessions).toEqual([]);
    await expect(stat(join(sessions, pending[0]!))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    resume.resolve();
    await outcome;
    await store.close();
  }
});

it('rejects publication if the parent acquires a pending-delete marker after its initial check', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mar-pending-publication-'));
  homes.push(home);
  const store = await JsonlSessionStore.open(home);
  const parent = await store.createSession({ workspace: home });
  const sessions = join(home, '.mar', 'agent', 'sessions');
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  fault.publishLockPath = join(sessions, 'index.lock');
  fault.publishGate = { entered: entered.resolve, resume: resume.promise };
  const creation = store.createSession({
    workspace: home,
    source: {
      type: 'subagent',
      parentSessionId: parent.id,
      rootSessionId: parent.id,
      parentExecutionId: 'execution',
      role: 'explore',
      description: 'in flight'
    }
  });
  const outcome = creation.then(
    (value) => ({ value }),
    (error: unknown) => ({ error })
  );
  try {
    await entered.promise;
    const pending = (await readdir(sessions)).filter(
      (name) => /^[0-9a-f-]{36}$/iu.test(name) && name !== parent.id
    );
    expect(pending).toHaveLength(1);
    const index = JSON.parse(await readFile(join(sessions, 'index.json'), 'utf8'));
    const meta = index.sessions.find((entry: { id: string }) => entry.id === parent.id);
    await beginTreeDeleteTransaction(
      sessions,
      {
        version: 1,
        kind: 'delete',
        id: randomUUID(),
        members: [
          {
            id: parent.id,
            existed: true,
            identity: {
              createdAt: meta.createdAt,
              workspace: meta.workspace,
              source: meta.source,
              storage: meta.storage,
              nextSequence: meta.nextSequence
            }
          }
        ]
      },
      syncJsonlDirectory
    );
    resume.resolve();
    expect(await outcome).toMatchObject({ error: { code: 'MAR_AGENT_SESSION_LOCKED' } });
    await expect(stat(join(sessions, pending[0]!))).rejects.toMatchObject({ code: 'ENOENT' });
    const release = await store.acquireSessionLease(parent.id);
    await release();
    expect((await store.getSession(parent.id)).id).toBe(parent.id);
    expect((await store.list()).sessions.map((entry) => entry.id)).toEqual([parent.id]);
  } finally {
    resume.resolve();
    await outcome;
    await store.close();
  }
});

it('deletes the whole tree while preserving unrelated Sessions', async () => {
  const { store, root, child, other, sessions } = await fixture();
  try {
    expect(await deleteMembers(store, root.id, [root.id, child.id])).toEqual({ deleted: true });
    await expect(stat(join(sessions, root.id))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(sessions, child.id))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await store.read(other.id))[0]?.type).toBe('session.created');
  } finally {
    await store.close();
  }
});

it('restores all tree history if a later content rename fails before index commit', async () => {
  const { store, root, child, other, sessions } = await fixture();
  try {
    const before = await Promise.all([store.read(root.id), store.read(child.id)]);
    fault.stageCountdown = 1;
    await expect(deleteMembers(store, root.id, [root.id, child.id])).rejects.toBe(fault.error);
    expect(await store.read(root.id)).toEqual(before[0]);
    expect(await store.read(child.id)).toEqual(before[1]);
    expect((await store.read(other.id))[0]?.type).toBe('session.created');
    const disk = JSON.parse(await readFile(join(sessions, 'index.json'), 'utf8'));
    expect(disk.sessions.map((entry: { id: string }) => entry.id)).toEqual(
      expect.arrayContaining([root.id, child.id, other.id])
    );
  } finally {
    await store.close();
  }
});

it('restores the tree when index replacement fails before commit', async () => {
  const { store, root, child, sessions } = await fixture();
  try {
    const before = await Promise.all([store.read(root.id), store.read(child.id)]);
    fault.indexPath = join(sessions, 'index.json');
    fault.failIndex = true;
    await expect(deleteMembers(store, root.id, [root.id, child.id])).rejects.toBe(fault.error);
    expect(await store.read(root.id)).toEqual(before[0]);
    expect(await store.read(child.id)).toEqual(before[1]);
  } finally {
    await store.close();
  }
});

it('preserves the first staging error and blocks reads if restoring the tree also fails', async () => {
  const { home, store, root, child, sessions } = await fixture();
  const before = await Promise.all([store.read(root.id), store.read(child.id)]);
  fault.stageCountdown = 1;
  fault.failRestore = true;
  await expect(deleteMembers(store, root.id, [root.id, child.id])).rejects.toBe(fault.error);
  await expect(store.read(root.id)).rejects.toMatchObject({ code: 'MAR_AGENT_SESSION_CORRUPT' });
  await expect(store.getSession(root.id)).rejects.toMatchObject({
    code: 'MAR_AGENT_SESSION_CORRUPT'
  });
  await store.close();
  fault.failRestore = false;
  const reopened = await JsonlSessionStore.open(home);
  try {
    const release = await reopened.acquireSessionLease(child.id);
    await release();
    expect(await reopened.read(root.id)).toEqual(before[0]);
    expect(await reopened.read(child.id)).toEqual(before[1]);
    expect(await readFile(join(sessions, 'index.json'), 'utf8')).toContain(root.id);
  } finally {
    await reopened.close();
  }
});

it('blocks an existing owner writer after an uncertain tree delete', async () => {
  const { home, store, root, child } = await fixture();
  const owner = {};
  const releaseWriter = await store.acquireSessionLease(root.id, owner);
  const maintenance = await store.acquireSessionMaintenance(root.id, 'delete', owner, [
    root.id,
    child.id
  ]);
  fault.stageCountdown = 1;
  fault.failRestore = true;
  await expect(store.delete(root.id, maintenance)).rejects.toBe(fault.error);
  await maintenance.release();
  await expect(store.append(root.id, { type: 'test.record', payload: {} })).rejects.toBe(
    fault.error
  );
  await releaseWriter();
  await store.close();
  fault.failRestore = false;
  const reopened = await JsonlSessionStore.open(home);
  const release = await reopened.acquireSessionLease(root.id);
  await release();
  expect((await reopened.read(root.id))[0]?.type).toBe('session.created');
  await reopened.close();
});

it.each([false, true])(
  'recovers partially published markers after an unmarked member writes (other marker: %s)',
  async (includeSibling) => {
    const { home, sessions, store, root, child } = await fixture();
    const sibling = includeSibling
      ? await store.createSession({
          workspace: home,
          source: {
            type: 'subagent',
            parentSessionId: root.id,
            rootSessionId: root.id,
            parentExecutionId: 'another',
            role: 'explore',
            description: 'sibling'
          }
        })
      : undefined;
    await store.close();
    const disk = JSON.parse(await readFile(join(sessions, 'index.json'), 'utf8'));
    const ids = [root.id, ...(sibling ? [sibling.id] : []), child.id];
    const members = ids.map((id) => {
      const meta = disk.sessions.find((entry: { id: string }) => entry.id === id);
      return {
        id,
        existed: true,
        identity: {
          createdAt: meta.createdAt,
          workspace: meta.workspace,
          source: meta.source,
          storage: meta.storage,
          storageTransactionId: meta.storageTransactionId,
          nextSequence: meta.nextSequence
        }
      };
    });
    const markerDir = join(sessions, '.delete-pending');
    await mkdir(markerDir, { recursive: true });
    await writeFile(
      join(markerDir, root.id),
      JSON.stringify({ version: 1, kind: 'delete', phase: 'preparing', id: randomUUID(), members }),
      { flush: true }
    );
    if (sibling) await writeFile(join(markerDir, sibling.id), root.id, { flush: true });
    await syncJsonlDirectory(markerDir);
    const reopened = await JsonlSessionStore.open(home);
    try {
      const record = await reopened.append(child.id, {
        type: 'turn.user',
        turnId: 'after-partial',
        payload: { prompt: 'preserved' }
      });
      const release = await reopened.acquireSessionLease(root.id);
      await release();
      expect((await reopened.read(child.id)).at(-1)?.recordId).toBe(record.recordId);
      expect((await reopened.getSession(root.id)).id).toBe(root.id);
      await expect(stat(join(markerDir, root.id))).rejects.toMatchObject({ code: 'ENOENT' });
      if (sibling)
        await expect(stat(join(markerDir, sibling.id))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await reopened.close();
    }
  }
);

it.skipIf(process.platform === 'win32')(
  'recovers an interrupted marker publication after another process writes the unmarked child',
  async () => {
    const { home, store, root, child, sessions } = await fixture();
    await store.close();
    const helper = fileURLToPath(new URL('../support/tree-delete-crash-child.ts', import.meta.url));
    const killed = spawnSync(
      process.execPath,
      ['--import', 'tsx', helper, sessions, root.id, child.id, 'preparing', join(home, 'ready')],
      { timeout: 10000, encoding: 'utf8' }
    );
    expect(killed.signal).toBe('SIGKILL');
    expect(
      JSON.parse(await readFile(join(sessions, '.delete-pending', root.id), 'utf8')).phase
    ).toBe('preparing');
    const reopened = await JsonlSessionStore.open(home);
    try {
      const record = await reopened.append(child.id, {
        type: 'turn.user',
        turnId: 'after-crash',
        payload: { prompt: 'preserved' }
      });
      const release = await reopened.acquireSessionLease(root.id);
      await release();
      expect((await reopened.read(child.id)).at(-1)?.recordId).toBe(record.recordId);
      expect((await reopened.getSession(root.id)).id).toBe(root.id);
    } finally {
      await reopened.close();
    }
  }
);

it('durably publishes every member marker before the ready journal', async () => {
  const { store, root, child, sessions } = await fixture();
  await store.close();
  const index = JSON.parse(await readFile(join(sessions, 'index.json'), 'utf8'));
  const members = [root.id, child.id].map((id) => {
    const meta = index.sessions.find((entry: { id: string }) => entry.id === id);
    return {
      id,
      existed: true,
      identity: {
        createdAt: meta.createdAt,
        workspace: meta.workspace,
        source: meta.source,
        storage: meta.storage,
        storageTransactionId: meta.storageTransactionId,
        nextSequence: meta.nextSequence
      }
    };
  });
  const markerDir = join(sessions, '.delete-pending');
  const snapshots: Array<{ phase: string; child: boolean }> = [];
  await beginTreeDeleteTransaction(
    sessions,
    { version: 1, kind: 'delete', id: randomUUID(), members },
    async (path) => {
      await syncJsonlDirectory(path);
      if (path === markerDir) {
        const journal = JSON.parse(await readFile(join(markerDir, root.id), 'utf8'));
        const childExists = await stat(join(markerDir, child.id)).then(
          () => true,
          () => false
        );
        snapshots.push({ phase: journal.phase, child: childExists });
      }
    }
  );
  expect(snapshots).toEqual([
    { phase: 'preparing', child: false },
    { phase: 'preparing', child: true },
    { phase: 'ready', child: true }
  ]);
});

it('recovers interrupted marker cleanup after a restored child has accepted another write', async () => {
  const { home, store, root, child, sessions } = await fixture();
  await store.close();
  const disk = JSON.parse(await readFile(join(sessions, 'index.json'), 'utf8'));
  const members = [root.id, child.id].map((id) => {
    const meta = disk.sessions.find((entry: { id: string }) => entry.id === id);
    return {
      id,
      existed: true,
      identity: {
        createdAt: meta.createdAt,
        workspace: meta.workspace,
        source: meta.source,
        storage: meta.storage,
        storageTransactionId: meta.storageTransactionId,
        nextSequence: meta.nextSequence
      }
    };
  });
  const transaction = { version: 1 as const, kind: 'delete' as const, id: randomUUID(), members };
  const markerDir = join(sessions, '.delete-pending');
  await beginTreeDeleteTransaction(sessions, transaction, syncJsonlDirectory);
  await stageTreeDelete(sessions, transaction, syncJsonlDirectory);
  await expect(
    finishTreeDelete(sessions, transaction, false, async (path) => {
      await syncJsonlDirectory(path);
      if (
        path === markerDir &&
        !(await stat(join(markerDir, child.id)).then(
          () => true,
          () => false
        ))
      )
        throw fault.error;
    })
  ).rejects.toBe(fault.error);
  expect(JSON.parse(await readFile(join(markerDir, root.id), 'utf8')).phase).toBe('restored');
  const reopened = await JsonlSessionStore.open(home);
  try {
    const record = await reopened.append(child.id, {
      type: 'turn.user',
      turnId: 'after-restoration',
      payload: { prompt: 'preserved' }
    });
    const release = await reopened.acquireSessionLease(root.id);
    await release();
    expect((await reopened.read(child.id)).at(-1)?.recordId).toBe(record.recordId);
    expect((await reopened.getSession(root.id)).id).toBe(root.id);
    await expect(stat(join(markerDir, root.id))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await reopened.close();
  }
});

it('keeps all members blocked when restored-phase durability is unknown', async () => {
  const { home, store, root, child, sessions } = await fixture();
  const before = await Promise.all([store.read(root.id), store.read(child.id)]);
  await store.close();
  const disk = JSON.parse(await readFile(join(sessions, 'index.json'), 'utf8'));
  const members = [root.id, child.id].map((id) => {
    const meta = disk.sessions.find((entry: { id: string }) => entry.id === id);
    return {
      id,
      existed: true,
      identity: {
        createdAt: meta.createdAt,
        workspace: meta.workspace,
        source: meta.source,
        storage: meta.storage,
        storageTransactionId: meta.storageTransactionId,
        nextSequence: meta.nextSequence
      }
    };
  });
  const transaction = { version: 1 as const, kind: 'delete' as const, id: randomUUID(), members };
  const markerDir = join(sessions, '.delete-pending');
  await beginTreeDeleteTransaction(sessions, transaction, syncJsonlDirectory);
  await stageTreeDelete(sessions, transaction, syncJsonlDirectory);
  await expect(
    finishTreeDelete(sessions, transaction, false, async (path) => {
      if (path === markerDir) throw fault.error;
      await syncJsonlDirectory(path);
    })
  ).rejects.toBe(fault.error);
  expect(JSON.parse(await readFile(join(markerDir, root.id), 'utf8')).phase).toBe('restored');
  expect(await readFile(join(markerDir, child.id), 'utf8')).toBe(root.id);
  const reopened = await JsonlSessionStore.open(home);
  try {
    const release = await reopened.acquireSessionLease(root.id);
    await release();
    expect(await reopened.read(root.id)).toEqual(before[0]);
    expect(await reopened.read(child.id)).toEqual(before[1]);
  } finally {
    await reopened.close();
  }
});

it.each(['member-conflict', 'ready-sync'] as const)(
  'recovers marker publication failure without discarding evidence (%s)',
  async (mode) => {
    const { home, store, root, child, sessions } = await fixture();
    const before = await Promise.all([store.read(root.id), store.read(child.id)]);
    await store.close();
    const index = JSON.parse(await readFile(join(sessions, 'index.json'), 'utf8'));
    const members = [root.id, child.id].map((id) => {
      const meta = index.sessions.find((entry: { id: string }) => entry.id === id);
      return {
        id,
        existed: true,
        identity: {
          createdAt: meta.createdAt,
          workspace: meta.workspace,
          source: meta.source,
          storage: meta.storage,
          storageTransactionId: meta.storageTransactionId,
          nextSequence: meta.nextSequence
        }
      };
    });
    const markerDir = join(sessions, '.delete-pending');
    await mkdir(markerDir, { recursive: true });
    const foreign = randomUUID();
    if (mode === 'member-conflict')
      await writeFile(join(markerDir, child.id), foreign, { flush: true });
    let syncs = 0;
    await expect(
      beginTreeDeleteTransaction(
        sessions,
        { version: 1, kind: 'delete', id: randomUUID(), members },
        async (path) => {
          if (path === markerDir && ++syncs === 3 && mode === 'ready-sync') throw fault.error;
          await syncJsonlDirectory(path);
        }
      )
    ).rejects.toMatchObject(
      mode === 'ready-sync'
        ? { message: fault.error.message }
        : { code: 'MAR_AGENT_SESSION_CORRUPT' }
    );
    const journal = JSON.parse(await readFile(join(markerDir, root.id), 'utf8'));
    expect(journal.phase).toBe(mode === 'ready-sync' ? 'ready' : 'preparing');
    const reopened = await JsonlSessionStore.open(home);
    try {
      const release = await reopened.acquireSessionLease(root.id);
      await release();
      expect(await reopened.read(root.id)).toEqual(before[0]);
      if (mode === 'member-conflict') {
        expect(await readFile(join(markerDir, child.id), 'utf8')).toBe(foreign);
        await rm(join(markerDir, child.id));
      }
      expect(await reopened.read(child.id)).toEqual(before[1]);
    } finally {
      await reopened.close();
    }
  }
);

it('retains staged data when the index decision cannot be read after a failed replacement', async () => {
  const { home, store, root, child, sessions } = await fixture();
  const before = await Promise.all([store.read(root.id), store.read(child.id)]);
  fault.indexPath = join(sessions, 'index.json');
  fault.failIndex = true;
  fault.failDecisionRead = true;
  await expect(deleteMembers(store, root.id, [root.id, child.id])).rejects.toBe(fault.error);
  await expect(store.read(root.id)).rejects.toMatchObject({ code: 'MAR_AGENT_SESSION_CORRUPT' });
  fault.failDecisionRead = false;
  await store.close();
  const reopened = await JsonlSessionStore.open(home);
  try {
    const release = await reopened.acquireSessionLease(root.id);
    await release();
    expect(await reopened.read(root.id)).toEqual(before[0]);
    expect(await reopened.read(child.id)).toEqual(before[1]);
  } finally {
    await reopened.close();
  }
});

it('keeps committed deletion blocked and completes cleanup on explicit reopen after cleanup failure', async () => {
  const { home, store, root, child, other, sessions } = await fixture();
  fault.cleanupPath = join(sessions, child.id);
  fault.failCleanup = true;
  await expect(deleteMembers(store, root.id, [root.id, child.id])).rejects.toBe(fault.error);
  await expect(store.read(child.id)).rejects.toMatchObject({ code: 'MAR_AGENT_SESSION_CORRUPT' });
  await store.close();
  fault.failCleanup = false;
  const reopened = await JsonlSessionStore.open(home);
  try {
    await expect(reopened.acquireSessionLease(child.id)).rejects.toMatchObject({
      code: 'MAR_AGENT_SESSION_NOT_FOUND'
    });
    await expect(stat(join(sessions, root.id))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(sessions, child.id))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await reopened.read(other.id))[0]?.type).toBe('session.created');
  } finally {
    await reopened.close();
  }
});

it.each(['member', 'journal'] as const)(
  'keeps the stable journal discoverable after %s marker cleanup fails',
  async (kind) => {
    const { home, store, root, child, sessions } = await fixture();
    const anchor = join(sessions, '.delete-pending', root.id);
    fault.cleanupPath = kind === 'member' ? join(sessions, '.delete-pending', child.id) : anchor;
    fault.failCleanup = true;
    await expect(deleteMembers(store, root.id, [root.id, child.id])).rejects.toBe(fault.error);
    expect(await readFile(anchor, 'utf8')).toContain('"kind":"delete"');
    await store.close();
    fault.failCleanup = false;
    const reopened = await JsonlSessionStore.open(home);
    try {
      await expect(reopened.acquireSessionLease(root.id)).rejects.toMatchObject({
        code: 'MAR_AGENT_SESSION_NOT_FOUND'
      });
      await expect(stat(anchor)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(join(sessions, child.id))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await reopened.close();
    }
  }
);

it.skipIf(process.platform === 'win32')(
  'preserves unknown index durability and recovers without resurrecting a committed tree',
  async () => {
    const { home, store, root, child, other, sessions } = await fixture();
    fault.indexPath = join(sessions, 'index.json');
    fault.syncRoot = sessions;
    fault.failSync = true;
    await expect(deleteMembers(store, root.id, [root.id, child.id])).rejects.toBe(fault.error);
    await expect(store.read(root.id)).rejects.toMatchObject({ code: 'MAR_AGENT_SESSION_CORRUPT' });
    await store.close();
    fault.failSync = false;
    const reopened = await JsonlSessionStore.open(home);
    try {
      await expect(reopened.acquireSessionLease(root.id)).rejects.toMatchObject({
        code: 'MAR_AGENT_SESSION_NOT_FOUND'
      });
      await expect(stat(join(sessions, child.id))).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await reopened.read(other.id))[0]?.type).toBe('session.created');
    } finally {
      await reopened.close();
    }
  }
);

it.skipIf(process.platform === 'win32')(
  'recovers a staged tree before admitting another child',
  async () => {
    const { home, sessions, store, root, child } = await fixture();
    const before = await store.read(root.id);
    await store.close();
    const helper = fileURLToPath(new URL('../support/tree-delete-crash-child.ts', import.meta.url));
    const run = spawnSync(
      process.execPath,
      ['--import', 'tsx', helper, sessions, root.id, child.id, 'staged', join(home, 'child-ready')],
      { timeout: 10000, encoding: 'utf8' }
    );
    expect(run.stderr).toBe('');
    expect(run.signal).toBe('SIGKILL');
    const reopened = await JsonlSessionStore.open(home);
    const newChild = await reopened.createSession({
      workspace: home,
      source: {
        type: 'subagent',
        parentSessionId: root.id,
        rootSessionId: root.id,
        parentExecutionId: 'new-parent',
        role: 'explore',
        description: 'new child'
      }
    });
    expect(await reopened.read(root.id)).toEqual(before);
    expect(await reopened.sessionTree(root.id)).toContain(newChild.id);
    await reopened.close();
  }
);

it.skipIf(process.platform === 'win32').each(['staged', 'committed'] as const)(
  'recovers a separate process killed after the %s deletion boundary',
  async (mode) => {
    const { home, store, root, child, other, sessions } = await fixture();
    const before = await Promise.all([store.read(root.id), store.read(child.id)]);
    await store.close();
    const marker = join(home, 'child-ready');
    const script = fileURLToPath(new URL('../support/tree-delete-crash-child.ts', import.meta.url));
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', script, sessions, root.id, child.id, mode, marker],
      {
        encoding: 'utf8',
        timeout: 10000
      }
    );
    expect(result.error).toBeUndefined();
    expect(result.signal).toBe('SIGKILL');
    expect(await readFile(marker, 'utf8')).toBe('ready');
    const reopened = await JsonlSessionStore.open(home);
    try {
      await expect(reopened.read(root.id)).rejects.toMatchObject({
        code: 'MAR_AGENT_SESSION_CORRUPT'
      });
      if (mode === 'staged') {
        const release = await reopened.acquireSessionLease(root.id);
        await release();
        expect(await reopened.read(root.id)).toEqual(before[0]);
        expect(await reopened.read(child.id)).toEqual(before[1]);
      } else {
        await expect(reopened.acquireSessionLease(root.id)).rejects.toMatchObject({
          code: 'MAR_AGENT_SESSION_NOT_FOUND'
        });
        await expect(stat(join(sessions, root.id))).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(stat(join(sessions, child.id))).rejects.toMatchObject({ code: 'ENOENT' });
      }
      expect((await reopened.read(other.id))[0]?.type).toBe('session.created');
    } finally {
      await reopened.close();
    }
  }
);

it.skipIf(process.platform === 'win32')(
  'refuses recovery when an indexed member identity conflicts with the journal',
  async () => {
    const { home, store, root, child, sessions } = await fixture();
    const before = await Promise.all([store.read(root.id), store.read(child.id)]);
    await store.close();
    const marker = join(home, 'child-ready');
    const script = fileURLToPath(new URL('../support/tree-delete-crash-child.ts', import.meta.url));
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', script, sessions, root.id, child.id, 'staged', marker],
      {
        encoding: 'utf8',
        timeout: 10000
      }
    );
    expect(result.signal).toBe('SIGKILL');
    const path = join(sessions, 'index.json');
    const original = await readFile(path, 'utf8');
    const index = JSON.parse(original);
    index.sessions.find((entry: { id: string }) => entry.id === child.id).createdAt = 'different';
    await writeFile(path, JSON.stringify(index));
    let reopened = await JsonlSessionStore.open(home);
    await expect(reopened.acquireSessionLease(root.id)).rejects.toMatchObject({
      code: 'MAR_AGENT_SESSION_CORRUPT'
    });
    await expect(reopened.read(child.id)).rejects.toMatchObject({
      code: 'MAR_AGENT_SESSION_CORRUPT'
    });
    expect(await readFile(join(sessions, '.delete-pending', root.id), 'utf8')).toContain(
      '"kind":"delete"'
    );
    await reopened.close();
    await writeFile(path, original);
    reopened = await JsonlSessionStore.open(home);
    try {
      const release = await reopened.acquireSessionLease(root.id);
      await release();
      expect(await reopened.read(root.id)).toEqual(before[0]);
      expect(await reopened.read(child.id)).toEqual(before[1]);
    } finally {
      await reopened.close();
    }
  }
);
