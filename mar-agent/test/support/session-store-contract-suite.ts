import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { SessionStore } from '../../src/session/store/contracts.js';
import { prepareContractGcDraft } from '../support/session-store-contract-gc.js';

/** A fresh logical storage domain whose independent handles share durable state. */
export interface SessionStoreContractFixture {
  readonly workspace: string;
  open(): Promise<SessionStore>;
  dispose(): Promise<void>;
}

export function sessionStoreContract(
  name: string,
  createFixture: () => Promise<SessionStoreContractFixture>
): void {
  describe(`${name} SessionStore contract`, () => {
    let fixture: SessionStoreContractFixture;
    let handles: SessionStore[];
    const open = async () => {
      const store = await fixture.open();
      handles.push(store);
      return store;
    };
    beforeEach(async () => {
      fixture = await createFixture();
      handles = [];
    });
    afterEach(async () => {
      try {
        for (const store of handles.reverse()) await store.close();
      } finally {
        await fixture.dispose();
      }
    });

    it('preserves identities, order, page boundaries and committed history on reopen', async () => {
      let store = await open();
      const session = await store.createSession({ workspace: fixture.workspace, title: 'History' });
      const first = await store.append(session.id, {
        type: 'turn.user',
        payload: { prompt: 'one' },
        turnId: 't1'
      });
      const second = await store.append(session.id, {
        type: 'turn.user',
        payload: { prompt: 'two' },
        turnId: 't2'
      });
      expect(second.sequence).toBe(first.sequence + 1);
      expect(second.recordId).not.toBe(first.recordId);
      const tail = await store.readPage(session.id, { limit: 1 });
      expect(tail.records).toEqual([second]);
      expect(tail.previousBeforeSequence).toBe(second.sequence);
      const prior = await store.readPage(session.id, {
        limit: 1,
        beforeSequence: tail.previousBeforeSequence
      });
      expect(prior.records).toEqual([first]);
      expect((await store.list()).sessions).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: session.id, title: 'History' })])
      );
      await store.close();
      store = await open();
      expect((await store.read(session.id)).slice(-2)).toEqual([first, second]);
      expect(await store.userTurnCount(session.id)).toBe(2);
    });

    it('shares the writer domain without closing another handle or retained owner', async () => {
      const first = await open();
      const second = await open();
      const session = await first.createSession({ workspace: fixture.workspace });
      const owner = {};
      const release = await first.acquireSessionLease(session.id, owner);
      const retained = await first.retainSessionLease(session.id, owner);
      try {
        await expect(second.acquireSessionLease(session.id, {})).rejects.toMatchObject({
          code: 'MAR_AGENT_SESSION_LOCKED'
        });
        await release();
        expect(first.hasRetainedSessionLease(session.id, owner)).toBe(true);
        await expect(second.acquireSessionLease(session.id, {})).rejects.toMatchObject({
          code: 'MAR_AGENT_SESSION_LOCKED'
        });
        const joined = await second.acquireSessionLease(session.id, owner);
        const writer = await second.acquireSessionWriteLease(session.id, owner);
        await writer();
        await joined();
        await retained();
        await first.close();
        const independent = await second.acquireSessionLease(session.id, {});
        await independent();
        await second.append(session.id, { type: 'test.committed', payload: { ok: true } });
        expect((await second.read(session.id)).at(-1)?.type).toBe('test.committed');
      } finally {
        await release();
        await retained();
      }
    });

    it('enforces code-state and extension checkpoint compare-and-set', async () => {
      const store = await open();
      const session = await store.createSession({ workspace: fixture.workspace });
      const base = await store.readCodeModeState(session.id);
      const input = { executionId: 'e1', turnId: 't1', expectedState: base };
      await store.commitCodeModeState(
        session.id,
        [{ operation: 'set', key: 'count', value: 1 }],
        input
      );
      await expect(
        store.commitCodeModeState(session.id, [{ operation: 'set', key: 'count', value: 2 }], input)
      ).rejects.toMatchObject({ code: 'MAR_AGENT_CODE_STATE_CONFLICT' });
      expect(await store.readCodeModeState(session.id)).toEqual([{ key: 'count', value: 1 }]);
      const owner = {};
      const release = await store.acquireSessionLease(session.id, owner);
      try {
        const options = { owner, signal: new AbortController().signal };
        expect(
          await store.writeExtensionCheckpoint(
            session.id,
            'extension',
            'key',
            { ok: true },
            0,
            options
          )
        ).toMatchObject({ revision: 1, value: { ok: true } });
        await expect(
          store.writeExtensionCheckpoint(session.id, 'extension', 'key', false, 0, options)
        ).rejects.toMatchObject({ code: 'MAR_AGENT_EXTENSION_DATA_CONFLICT' });
        expect(await store.readExtensionCheckpoint(session.id, 'extension', 'key')).toMatchObject({
          revision: 1,
          value: { ok: true }
        });
      } finally {
        await release();
      }
    });

    it('retains image resources by logical identity after commit and reopening', async () => {
      let store = await open();
      const session = await store.createSession({ workspace: fixture.workspace });
      const image = { mimeType: 'image/png', dataBase64: 'aW1hZ2U=' };
      const resource = await store.persistResource(session.id, image);
      const published = await store.setResourceUrl(session.id, resource.resourceId, {
        url: 'https://images.example.test/image.png',
        urlExpiresAt: 2000000000000
      });
      expect(published).toMatchObject({
        resourceId: resource.resourceId,
        url: 'https://images.example.test/image.png'
      });
      const [metadata] = await store.persistInputImages(session.id, [
        { ...image, name: 'input.png' }
      ]);
      const record = await store.append(session.id, {
        type: 'turn.user',
        payload: { prompt: 'inspect', images: [metadata] },
        turnId: 't1'
      });
      expect(metadata?.resourceId).toBeDefined();
      await store.close();
      store = await open();
      expect(await store.readResource(session.id, metadata!.resourceId!)).toEqual(image);
      expect(await store.readInputImages(session.id, [metadata])).toMatchObject([
        { resourceId: metadata!.resourceId, mimeType: image.mimeType }
      ]);
      expect(
        await store.readInputImage(session.id, { sequence: record.sequence, imageIndex: 0 })
      ).toMatchObject(image);
      const other = await store.createSession({ workspace: fixture.workspace });
      expect(await store.readResource(other.id, metadata!.resourceId!)).toBeUndefined();
    });

    it('preserves retained turns across fork and rollback, then clears and deletes', async () => {
      const store = await open();
      const session = await store.createSession({
        workspace: fixture.workspace,
        title: 'Original'
      });
      await store.append(session.id, {
        type: 'turn.user',
        payload: { prompt: 'one' },
        executionId: 'e1',
        turnId: 't1'
      });
      await store.append(session.id, {
        type: 'turn.user',
        payload: { prompt: 'two' },
        executionId: 'e2',
        turnId: 't2'
      });
      const fork = await store.forkSession(session.id, { boundaryTurnId: 't1', title: 'Fork' });
      expect(
        (await store.read(fork.id))
          .filter((record) => record.type === 'turn.user')
          .map((record) => record.turnId)
      ).toEqual(['t1']);
      await store.rollbackSession(session.id, { boundaryTurnId: 't1' });
      expect(
        (await store.read(session.id))
          .filter((record) => record.type === 'turn.user')
          .map((record) => record.turnId)
      ).toEqual(['t1']);
      await store.clearSession(session.id);
      expect((await store.read(session.id)).some((record) => record.type === 'turn.user')).toBe(
        false
      );
      expect(await store.getSession(session.id)).toMatchObject({
        id: session.id,
        title: 'Original'
      });
      expect(await store.delete(session.id)).toEqual({ deleted: true });
      expect((await store.list()).sessions.some((item) => item.id === session.id)).toBe(false);
    });

    it('commits compact checkpoints and restores their context after reopen', async () => {
      let store = await open();
      const session = await store.createSession({ workspace: fixture.workspace });
      await store.append(session.id, {
        type: 'turn.user',
        payload: { prompt: 'hello' },
        turnId: 't1'
      });
      const checkpoint = await store.compact(session.id, { summary: 'retained', turnId: 't1' });
      await store.close();
      store = await open();
      expect((await store.readExecutionState(session.id)).contextRecords).toContainEqual(
        expect.objectContaining({ recordId: checkpoint.recordId, type: 'compact.completed' })
      );
    });

    it('commits GC against the durable boundary and rejects stale plans without publishing', async () => {
      const store = await open();
      const session = await store.createSession({ workspace: fixture.workspace });
      const draft = await prepareContractGcDraft(store, session.id);
      const planned = (await store.readExecutionState(session.id)).contextRecords;
      const committed = await store.commitContextGc(session.id, draft, planned);
      expect(committed.type).toBe('context.gc.completed');
      expect(
        (await store.read(session.id)).some((record) => record.recordId === committed.recordId)
      ).toBe(true);
      const before = await store.read(session.id);
      await expect(store.commitContextGc(session.id, draft, planned)).rejects.toMatchObject({
        code: 'MAR_AGENT_SESSION_CORRUPT'
      });
      expect(await store.read(session.id)).toEqual(before);
    });

    it('holds maintenance until the matching durable clear has completed', async () => {
      const store = await open();
      const other = await open();
      const session = await store.createSession({ workspace: fixture.workspace });
      await store.append(session.id, {
        type: 'turn.user',
        payload: { prompt: 'one' },
        turnId: 't1'
      });
      const maintenance = await store.acquireSessionMaintenance(session.id, 'clear');
      try {
        expect(maintenance.sessionIds).toContain(session.id);
        await expect(other.acquireSessionLease(session.id, {})).rejects.toMatchObject({
          code: 'MAR_AGENT_SESSION_LOCKED'
        });
        await store.clearSession(session.id, maintenance);
        expect((await store.read(session.id)).some((record) => record.type === 'turn.user')).toBe(
          false
        );
      } finally {
        await maintenance.release();
      }
      const release = await other.acquireSessionLease(session.id, {});
      await release();
    });

    it('freezes a Session tree during delete maintenance', async () => {
      const store = await open();
      const root = await store.createSession({ workspace: fixture.workspace, title: 'Root' });
      const source = {
        type: 'subagent' as const,
        parentSessionId: root.id,
        rootSessionId: root.id,
        parentExecutionId: 'parent-execution',
        role: 'explore' as const,
        description: 'Child'
      };
      const child = await store.createSession({ workspace: fixture.workspace, source });
      expect((await store.listSubagentChildren(root.id)).map((item) => item.id)).toContain(
        child.id
      );
      expect(await store.sessionTree(root.id)).toEqual(expect.arrayContaining([root.id, child.id]));
      const maintenance = await store.acquireSessionMaintenance(root.id, 'delete');
      try {
        expect(maintenance.sessionIds).toEqual(expect.arrayContaining([root.id, child.id]));
        await expect(
          store.createSession({ workspace: fixture.workspace, source })
        ).rejects.toMatchObject({ code: 'MAR_AGENT_SESSION_LOCKED' });
        expect(await store.delete(root.id, maintenance)).toEqual({ deleted: true });
      } finally {
        await maintenance.release();
      }
      expect(await store.listSubagentChildren(root.id)).toEqual([]);
    });

    it('preserves title, world state and execution metadata in the same domain', async () => {
      let store = await open();
      const session = await store.createSession({ workspace: fixture.workspace, title: 'Before' });
      expect(await store.updateTitle(session.id, 'After', { expectedTitle: 'Before' })).toBe(true);
      expect(await store.updateTitle(session.id, 'Ignored', { expectedTitle: 'Before' })).toBe(
        false
      );
      await store.writeContextualWorldState(session.id, { location: 'workspace' });
      await store.append(session.id, {
        type: 'turn.user',
        payload: { prompt: 'first message' },
        turnId: 't1'
      });
      await store.append(session.id, {
        type: 'execution.header',
        payload: { modelId: 'coding', modelName: 'Coding', mode: 'run' },
        executionId: 'e1',
        turnId: 't1'
      });
      await store.close();
      store = await open();
      expect(await store.getSession(session.id)).toMatchObject({ title: 'After' });
      expect(await store.readContextualWorldState(session.id)).toEqual({ location: 'workspace' });
      expect(await store.firstUserMessagePreview(session.id)).toBe('first message');
      expect(await store.executionConfiguration(session.id)).toMatchObject({ modelId: 'coding' });
    });

    it('commits and isolates tool-result resources with paginated reads', async () => {
      const store = await open();
      const session = await store.createSession({ workspace: fixture.workspace });
      const text = 'a'.repeat(1023) + '你好\n'.repeat(800);
      const diff = await store.writeToolResultResource(session.id, text);
      await store.append(session.id, {
        type: 'tool.completed',
        payload: {
          toolName: 'apply_patch',
          callId: randomUUID(),
          resultExtensions: [
            {
              type: 'file_changes',
              version: 1,
              entries: [
                {
                  changeId: randomUUID(),
                  path: 'file',
                  change: 'added',
                  additions: 1,
                  deletions: 0,
                  diff
                }
              ]
            }
          ]
        }
      });
      let content = '';
      let cursor: string | undefined;
      do {
        const page = await store.readToolResultResource(session.id, {
          resourceRef: diff.resourceRef,
          maxBytes: 1024,
          ...(cursor ? { cursor } : {})
        });
        content += page.content;
        cursor = page.nextCursor;
      } while (cursor);
      expect(content).toBe(text);
      const other = await store.createSession({ workspace: fixture.workspace });
      await expect(
        store.readToolResultResource(other.id, { resourceRef: diff.resourceRef })
      ).rejects.toMatchObject({ code: 'MAR_AGENT_TOOL_RESOURCE_NOT_FOUND' });
    });
  });
}
