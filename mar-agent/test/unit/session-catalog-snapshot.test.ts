import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createSessionCatalog } from '../../src/session/catalog.js';
import { JsonlSessionStore } from '../../src/session/store/index.js';

it('reads detached complete metadata once while paged cursors retain revision checks', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mar-catalog-snapshot-'));
  const store = await JsonlSessionStore.open(home);
  const catalog = createSessionCatalog(store, true);
  try {
    const parent = await store.createSession({ title: 'Parent', workspace: home });
    const child = await store.createSession({
      title: 'Child',
      workspace: home,
      source: { type: 'user', parentSessionId: parent.id }
    });
    const firstPage = await catalog.list({ limit: 1 });
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    const pagedRead = vi.spyOn(store, 'list');
    const snapshot = await catalog.listSnapshot();
    expect(pagedRead).not.toHaveBeenCalled();
    expect(snapshot.map((session) => session.id).sort()).toEqual([parent.id, child.id].sort());
    expect(snapshot.find((session) => session.id === child.id)).toMatchObject({
      source: { type: 'user', parentSessionId: parent.id },
      lastActivityAt: child.lastActivityAt
    });
    expect(snapshot[0]).not.toHaveProperty('resume');
    expect(snapshot[0]).not.toHaveProperty('nextSequence');

    const writer = await JsonlSessionStore.open(home);
    try {
      await writer.updateTitle(parent.id, 'Updated');
      await writer.createSession({ title: 'Later', workspace: home });
    } finally {
      await writer.close();
    }
    expect(snapshot).toHaveLength(2);
    expect(snapshot.find((session) => session.id === parent.id)?.title).toBe('Parent');
    await expect(catalog.list({ limit: 1, cursor: firstPage.nextCursor })).rejects.toMatchObject({
      code: 'MAR_AGENT_TOOL_INPUT_INVALID'
    });
    Object.assign(snapshot.find((session) => session.id === child.id)!.source, {
      parentSessionId: 'caller-mutation'
    });
    const refreshed = await catalog.listSnapshot();
    expect(refreshed).toHaveLength(3);
    expect(refreshed.find((session) => session.id === parent.id)?.title).toBe('Updated');
    expect(refreshed.find((session) => session.id === child.id)?.source.parentSessionId).toBe(
      parent.id
    );
    await catalog.close();
    await expect(catalog.listSnapshot()).rejects.toMatchObject({ code: 'MAR_AGENT_DISPOSED' });
    expect(await store.listSnapshot()).toHaveLength(3);
  } finally {
    await catalog.close();
    await store.close();
    await rm(home, { recursive: true, force: true });
  }
});

it('propagates snapshot failures instead of presenting an empty directory', async () => {
  const failure = new Error('Snapshot unavailable');
  const catalog = createSessionCatalog(
    { listSnapshot: vi.fn().mockRejectedValue(failure) } as never,
    true
  );
  try {
    await expect(catalog.listSnapshot()).rejects.toBe(failure);
  } finally {
    await catalog.close();
  }
});
