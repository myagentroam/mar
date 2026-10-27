import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { JsonlSessionStore } from '../../src/session/store/index.js';

const gate = vi.hoisted(() => ({
  active: false,
  entered: undefined as (() => void) | undefined,
  release: undefined as Promise<void> | undefined
}));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const value = await actual.readFile(...args);
      if (gate.active && String(args[0]).endsWith('/sessions/index.json')) {
        gate.active = false;
        gate.entered?.();
        await gate.release;
      }
      return value;
    }
  };
});

const roots: string[] = [];
afterEach(async () => {
  gate.active = false;
  gate.entered = undefined;
  gate.release = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

it('does not let an older in-flight index refresh erase a newly published child Session', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mar-agent-index-race-'));
  roots.push(home);
  const store = await JsonlSessionStore.open(home);
  const parent = await store.createSession({ workspace: home });
  let release!: () => void;
  let entered!: () => void;
  const reading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  gate.release = new Promise<void>((resolve) => {
    release = resolve;
  });
  gate.entered = entered;
  gate.active = true;
  const refreshing = store.getSession(parent.id);
  await reading;
  const creating = store.createSession({
    workspace: home,
    source: {
      type: 'subagent',
      parentSessionId: parent.id,
      rootSessionId: parent.id,
      parentOperationId: 'real-operation',
      ownerInstanceId: 'real-instance',
      extensionId: 'real-extension',
      description: 'child',
      role: 'general-purpose'
    }
  });
  try {
    // Before coordination, creation commits while the old read is held. After
    // coordination, it waits behind that read. Both interleavings must be correct.
    await Promise.race([creating, new Promise<void>((resolve) => setTimeout(resolve, 100))]);
  } finally {
    release();
  }
  const [, child] = await Promise.all([refreshing, creating]);
  await expect(
    store.append(child.id, {
      type: 'turn.user',
      payload: { prompt: 'child input' }
    })
  ).resolves.toHaveProperty('sequence', 2);
  expect((await store.getSession(child.id)).source).toHaveProperty(
    'parentOperationId',
    'real-operation'
  );
  expect(await store.listSubagentChildren(parent.id)).toHaveLength(1);
});
