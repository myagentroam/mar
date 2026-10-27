import { fork } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { withSessionReadDrain } from '../../src/session/store/jsonl/read-pins.js';
import { JsonlSessionStore } from '../../src/session/store/jsonl/jsonl-store.js';

function gatePath(root: string): string {
  return join(dirname(root), '.read-pins', `${basename(root)}.lock`);
}

describe('Session generation read pins', () => {
  it('reports the public missing-session error without creating a session directory', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-missing-pin-'));
    const store = await JsonlSessionStore.open(home);
    const id = '11111111-1111-4111-8111-111111111111';
    const root = join(home, '.mar/agent/sessions', id);
    try {
      await expect(store.read(id)).rejects.toMatchObject({ code: 'MAR_AGENT_SESSION_NOT_FOUND' });
      await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await store.close();
      await rm(home, { recursive: true, force: true });
    }
  });
  it('clear waits for a cross-process old-generation reader before retiring its data', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-clear-pin-'));
    const store = await JsonlSessionStore.open(home);
    const session = await store.createSession({ workspace: '/workspace' });
    const root = join(home, '.mar/agent/sessions', session.id);
    const generation = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const directory = join(root, 'v2', generation);
    await mkdir(directory);
    await writeFile(join(directory, 'events-000001.jsonl'), 'old history');
    const child = fork(
      fileURLToPath(new URL('../support/read-pin-child.ts', import.meta.url)),
      [root, generation],
      {
        execArgv: ['--import', 'tsx'],
        stdio: ['ignore', 'ignore', 'pipe', 'ipc']
      }
    );
    try {
      expect(await new Promise((resolve) => child.once('message', resolve))).toBe('selected');
      const clearing = store.clearSession(session.id);
      await vi.waitFor(async () => expect((await stat(gatePath(root))).isFile()).toBe(true));
      const reading = new Promise((resolve) => child.once('message', resolve));
      child.send('continue');
      expect(await reading).toBe('old history');
      await clearing;
      await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      child.kill();
      await store.close();
      await rm(home, { recursive: true, force: true });
    }
  });
  it('tree deletion waits for a cross-process reader that selected the active generation', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-delete-pin-'));
    const store = await JsonlSessionStore.open(home);
    const session = await store.createSession({ workspace: '/workspace' });
    const root = join(home, '.mar/agent/sessions', session.id);
    const index = JSON.parse(await readFile(join(home, '.mar/agent/sessions/index.json'), 'utf8'));
    const generation = index.sessions[0].storage.generation;
    const child = fork(
      fileURLToPath(new URL('../support/read-pin-child.ts', import.meta.url)),
      [root, generation],
      {
        execArgv: ['--import', 'tsx'],
        stdio: ['ignore', 'ignore', 'pipe', 'ipc']
      }
    );
    try {
      expect(await new Promise((resolve) => child.once('message', resolve))).toBe('selected');
      const deleting = store.delete(session.id);
      await vi.waitFor(async () => expect((await stat(gatePath(root))).isFile()).toBe(true));
      const reading = new Promise((resolve) => child.once('message', resolve));
      child.send('continue');
      expect(await reading).toContain('session.created');
      await expect(deleting).resolves.toEqual({ deleted: true });
      await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      child.kill();
      await store.close();
      await rm(home, { recursive: true, force: true });
    }
  });
  it('drains a separate process that already selected the old path before retirement', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-read-pin-'));
    const root = join(home, 'session');
    await mkdir(join(root, 'v2', 'old'), { recursive: true });
    const old = join(root, 'v2', 'old', 'events-000001.jsonl');
    await writeFile(old, 'old history');
    const child = fork(
      fileURLToPath(new URL('../support/read-pin-child.ts', import.meta.url)),
      [root],
      {
        execArgv: ['--import', 'tsx'],
        stdio: ['ignore', 'ignore', 'pipe', 'ipc']
      }
    );
    try {
      const selected = await new Promise<unknown>((resolve, reject) => {
        child.once('message', resolve);
        child.once('error', reject);
        child.once('exit', (code) => reject(new Error(`reader exited before selecting: ${code}`)));
      });
      expect(selected).toBe('selected');
      let retired = false;
      const retirement = withSessionReadDrain(root, async () => {
        await rename(join(root, 'v2', 'old'), join(root, 'v2', 'retired'));
        retired = true;
      });
      await vi.waitFor(async () => {
        expect((await stat(gatePath(root))).isFile()).toBe(true);
      });
      expect(retired).toBe(false);
      expect(await readFile(old, 'utf8')).toBe('old history');
      const reading = new Promise<unknown>((resolve) => child.once('message', resolve));
      child.send('continue');
      expect(await reading).toBe('old history');
      await retirement;
      expect(retired).toBe(true);
    } finally {
      child.kill();
      await rm(home, { recursive: true, force: true });
    }
  });
  it('holds the gate after deleting the session root and does not recreate it for a new reader', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-delete-pin-'));
    const root = join(home, 'session');
    await mkdir(root);
    let releaseDrain!: () => void;
    let removed!: () => void;
    const removal = new Promise<void>((resolve) => {
      removed = resolve;
    });
    const latch = new Promise<void>((resolve) => {
      releaseDrain = resolve;
    });
    const drain = withSessionReadDrain(root, async () => {
      await rm(root, { recursive: true });
      removed();
      await latch;
    });
    await removal;
    const child = fork(
      fileURLToPath(new URL('../support/read-pin-missing-child.ts', import.meta.url)),
      [root],
      {
        execArgv: ['--import', 'tsx'],
        stdio: ['ignore', 'ignore', 'pipe', 'ipc']
      }
    );
    try {
      expect(await new Promise((resolve) => child.once('message', resolve))).toBe('starting');
      const result = new Promise((resolve) => child.once('message', resolve));
      await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await stat(gatePath(root))).isFile()).toBe(true);
      releaseDrain();
      await drain;
      expect(await result).toBe('MAR_AGENT_SESSION_NOT_FOUND');
      await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      releaseDrain();
      await drain;
      child.kill();
      await rm(home, { recursive: true, force: true });
    }
  });
});
