import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonlSessionStore } from '../../src/session/store/index.js';
import { openAgentSessionCatalog } from '../../src/index.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'mar-input-rollback-'));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const store = await JsonlSessionStore.open(home);
  cleanups.push(() => store.close());
  const session = await store.createSession({ workspace: home });
  const catalog = await openAgentSessionCatalog({ homeDirectory: home });
  cleanups.push(() => catalog.close());
  const append = (turnId: string, type: string, payload: Record<string, unknown>) =>
    store.append(session.id, { turnId, executionId: turnId, type, payload });
  await append('previous', 'turn.user', { prompt: 'Previous', clientMessageId: 'shared-id' });
  await append('current', 'execution.started', {});
  await append('current', 'turn.user', { prompt: 'Initial', clientMessageId: 'initial' });
  await append('current', 'model.context', { role: 'assistant', content: 'Retained work' });
  return { home, store, session, catalog, append };
}

describe('Session input rollback', () => {
  it('scopes input identity to its Turn and deletes only resources beyond the selected receive record', async () => {
    const f = await fixture();
    const [retained] = await f.store.persistInputImages(f.session.id, [
      {
        name: 'keep.png',
        mimeType: 'image/png',
        dataBase64: Buffer.from('keep').toString('base64')
      }
    ]);
    await f.append('current', 'turn.user', {
      prompt: 'Keep pending',
      clientMessageId: 'keep',
      deferred: true,
      images: [retained]
    });
    const prefix = await f.store.read(f.session.id);
    const [removed] = await f.store.persistInputImages(f.session.id, [
      {
        name: 'remove.png',
        mimeType: 'image/png',
        dataBase64: Buffer.from('remove').toString('base64')
      }
    ]);
    await f.append('current', 'turn.user', {
      prompt: 'Remove steer',
      clientMessageId: 'shared-id',
      deferred: true,
      images: [removed]
    });
    await f.append('current', 'model.context', { role: 'assistant', content: 'Removed work' });
    await f.catalog.rollback(f.session.id, {
      beforeInput: { turnId: 'current', clientMessageId: 'shared-id' }
    });
    expect(await f.store.read(f.session.id)).toEqual(prefix);
    expect(await f.catalog.readResource(f.session.id, retained!.resourceId!)).toMatchObject({
      dataBase64: Buffer.from('keep').toString('base64')
    });
    expect(await f.catalog.readResource(f.session.id, removed!.resourceId!)).toBeUndefined();
    expect(await f.store.userTurnCount(f.session.id)).toBe(3);
  });

  it('removes execution-start records when the selected input is the first input of its Turn', async () => {
    const f = await fixture();
    const previous = (await f.store.read(f.session.id)).filter(
      (record) => record.turnId !== 'current'
    );
    await f.catalog.rollback(f.session.id, {
      beforeInput: { turnId: 'current', clientMessageId: 'initial' }
    });
    expect(await f.store.read(f.session.id)).toEqual(previous);
  });

  it('rejects missing, ambiguous, and mixed selectors without changing history', async () => {
    const f = await fixture();
    await f.append('current', 'turn.user', {
      prompt: 'Duplicate identity',
      deferred: true,
      clientMessageId: 'initial'
    });
    const before = await f.store.read(f.session.id);
    for (const input of [
      { beforeInput: { turnId: 'missing', clientMessageId: 'initial' } },
      { beforeInput: { turnId: 'current', clientMessageId: 'missing' } },
      { beforeInput: { turnId: 'current', clientMessageId: 'initial' } },
      { beforeInput: { turnId: 'current', clientMessageId: '' } },
      { boundaryTurnId: null, beforeInput: { turnId: 'current', clientMessageId: 'initial' } },
      { beforeInput: null },
      {}
    ]) {
      await expect(f.catalog.rollback(f.session.id, input as never)).rejects.toMatchObject({
        code: 'MAR_AGENT_ROLLBACK_TARGET_INVALID'
      });
      expect(await f.store.read(f.session.id)).toEqual(before);
    }
  });

  it('refuses input rollback while the Session writer lease remains owned', async () => {
    const f = await fixture();
    const before = await f.store.read(f.session.id);
    const release = await f.store.acquireSessionLease(f.session.id, {});
    try {
      await expect(
        f.catalog.rollback(f.session.id, {
          beforeInput: { turnId: 'current', clientMessageId: 'initial' }
        })
      ).rejects.toMatchObject({ code: 'MAR_AGENT_SESSION_LOCKED' });
      expect(await f.store.read(f.session.id)).toEqual(before);
    } finally {
      await release();
    }
  });
});
