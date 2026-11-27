import type { ExtensionRequestContext } from '@myagentroam/agent/extensions';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeDatabase } from '../../src/database.js';
import { NodeOrchestration } from '../../src/orchestration/node-orchestration.js';
import { WhiteboardService } from '../../src/orchestration/whiteboard/whiteboard-service.js';
import { WhiteboardStore } from '../../src/orchestration/whiteboard/whiteboard-store.js';

const OWNER = 'whiteboard-owner';
const ACTOR = 'whiteboard-editor';
const databases: NodeDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function fixture() {
  const database = new NodeDatabase(':memory:', 'whiteboard-test');
  databases.push(database);
  return { database, store: new WhiteboardStore(database.raw) };
}

function update(
  store: WhiteboardStore,
  ops: Parameters<WhiteboardStore['update']>[2]['ops'],
  actorSessionId = ACTOR
) {
  return store.update(OWNER, actorSessionId, { expectedBoardId: OWNER, ops });
}

interface TestRun {
  readonly id: string;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly initiatedByUserId?: number;
}

function addRun(
  runs: Map<string, TestRun>,
  id: string,
  sessionId: string,
  workspaceId = 'workspace',
  initiatedByUserId: number | undefined = 7
) {
  runs.set(id, { id, sessionId, workspaceId, initiatedByUserId });
}

function serviceFixture() {
  const database = new NodeDatabase(':memory:', 'whiteboard-service-test');
  databases.push(database);
  const store = new WhiteboardStore(database.raw);
  const runs = new Map<string, TestRun>();
  const service = new WhiteboardService({
    store: () => store,
    activeRun: (runId) => runs.get(runId),
    activeOwnerRunId: (id) => [...runs.values()].find(({ sessionId }) => sessionId === id)?.id,
    boardInWorkspace: (id, workspace) =>
      (id === 'archived' && workspace === 'workspace') ||
      [...runs.values()].some(
        ({ sessionId, workspaceId }) => sessionId === id && workspaceId === workspace
      ),
    canRecover: (_run, ownerSessionId) => ownerSessionId === 'owner-A'
  });
  return { store, runs, service };
}

function followedBoard(service: WhiteboardService, runId: string) {
  return service.capture(runId, []).views.find(({ role }) => role === 'followed')?.snapshot;
}

function contextBoard(
  items: readonly { id: string; content: string }[] | undefined,
  role: 'own' | 'followed'
) {
  const item = items?.find(
    ({ id }) => id === (role === 'own' ? 'mar.node.whiteboard.own' : 'mar.node.whiteboard')
  );
  return (
    item &&
    (JSON.parse(item.content.slice(item.content.indexOf('\n') + 1)) as Record<string, unknown>)
  );
}

describe('WhiteboardStore', () => {
  it('reads an unmaterialized empty board and commits one versioned batch with one change record', () => {
    const { database, store } = fixture();

    expect(store.read(OWNER)).toEqual({
      boardId: OWNER,
      boardRevision: 0,
      entries: [],
      recentChanges: []
    });
    expect(
      database.raw.prepare('SELECT 1 FROM whiteboards WHERE owner_session_id=?').get(OWNER)
    ).toBeUndefined();

    expect(
      update(store, [
        { op: 'add', content: 'first' },
        { op: 'add', content: 'second' }
      ])
    ).toMatchObject({
      boardId: OWNER,
      boardRevision: 1,
      added: [
        { id: 'w1', revision: 1 },
        { id: 'w2', revision: 1 }
      ]
    });
    expect(store.read(OWNER)).toMatchObject({
      boardRevision: 1,
      entries: [
        { id: 'w1', revision: 1, content: 'first' },
        { id: 'w2', revision: 1, content: 'second' }
      ],
      recentChanges: [{ boardRevision: 1, actorSessionId: ACTOR }]
    });
  });

  it('applies ordered edits against prior operations while advancing the board revision once', () => {
    const { store } = fixture();
    update(store, [
      { op: 'add', content: 'first' },
      { op: 'add', content: 'second' }
    ]);

    expect(
      update(store, [
        { op: 'update', id: 'w1', expectedRevision: 1, content: 'intermediate' },
        { op: 'update', id: 'w1', expectedRevision: 2, content: 'final' },
        { op: 'del', id: 'w2', expectedRevision: 1 },
        { op: 'add', content: 'third' }
      ])
    ).toMatchObject({
      boardRevision: 2,
      added: [{ id: 'w3', revision: 1 }],
      entryChanges: { entries: ['final', 'third'], removedCount: 1 }
    });
    expect(store.read(OWNER)).toMatchObject({
      boardRevision: 2,
      entries: [
        { id: 'w1', revision: 3, content: 'final' },
        { id: 'w3', revision: 1, content: 'third' }
      ],
      recentChanges: [{ boardRevision: 2 }, { boardRevision: 1 }]
    });

    expect(
      update(store, [
        { op: 'clear', expectedBoardRevision: 2 },
        { op: 'add', content: 'replacement after clear' }
      ])
    ).toMatchObject({
      boardRevision: 3,
      added: [{ id: 'w4', revision: 1 }],
      entryChanges: { entries: ['replacement after clear'], removedCount: 2 }
    });
    expect(store.read(OWNER)).toMatchObject({
      boardRevision: 3,
      entries: [{ id: 'w4', revision: 1, content: 'replacement after clear' }],
      recentChanges: [{ boardRevision: 3 }, { boardRevision: 2 }, { boardRevision: 1 }]
    });
  });

  it('rolls back every operation, revision, log entry, and allocated ID when a later operation conflicts', () => {
    const { store } = fixture();
    update(store, [{ op: 'add', content: 'keep' }]);
    const before = store.read(OWNER);

    expect(() =>
      update(store, [
        { op: 'clear', expectedBoardRevision: 1 },
        { op: 'add', content: 'temporary' },
        { op: 'update', id: 'missing', expectedRevision: 1, content: 'unreachable' }
      ])
    ).toThrowError(
      expect.objectContaining({
        code: 'WHITEBOARD_CONFLICT',
        details: { opIndex: 2, id: 'missing', revision: null }
      })
    );
    expect(store.read(OWNER)).toEqual(before);

    expect(update(store, [{ op: 'add', content: 'after rollback' }])).toMatchObject({
      boardRevision: 2,
      added: [{ id: 'w2', revision: 1 }]
    });
  });

  it('rejects stale board, entry, and selected-board versions without writing', () => {
    const { store } = fixture();
    update(store, [{ op: 'add', content: 'current' }]);
    const before = store.read(OWNER);

    expect(() =>
      store.update(OWNER, ACTOR, {
        expectedBoardId: 'another-board',
        ops: [{ op: 'add', content: 'wrong board' }]
      })
    ).toThrowError(expect.objectContaining({ code: 'WHITEBOARD_CONFLICT' }));
    expect(() =>
      update(store, [{ op: 'update', id: 'w1', expectedRevision: 0, content: 'stale' }])
    ).toThrowError(
      expect.objectContaining({
        code: 'WHITEBOARD_CONFLICT',
        details: { opIndex: 0, id: 'w1', revision: 1 }
      })
    );
    expect(() => update(store, [{ op: 'clear', expectedBoardRevision: 0 }])).toThrowError(
      expect.objectContaining({
        code: 'WHITEBOARD_CONFLICT',
        details: { opIndex: 0, boardRevision: 1 }
      })
    );
    expect(store.read(OWNER)).toEqual(before);
  });

  it('does not version or log no-op edits', () => {
    const { store } = fixture();
    update(store, [{ op: 'add', content: 'unchanged' }]);

    expect(
      update(store, [{ op: 'update', id: 'w1', expectedRevision: 1, content: 'unchanged' }])
    ).toMatchObject({ boardRevision: 1, entryChanges: { entries: [], removedCount: 0 } });
    expect(store.read(OWNER)).toMatchObject({
      boardRevision: 1,
      entries: [{ id: 'w1', revision: 1, content: 'unchanged' }],
      recentChanges: [{ boardRevision: 1 }]
    });
  });

  it('enforces entry-count and UTF-8 byte limits atomically, while accepting the exact board-byte limit', () => {
    const { store } = fixture();

    update(
      store,
      Array.from({ length: 32 }, (_, index) => ({ op: 'add' as const, content: `item ${index}` }))
    );
    const full = store.read(OWNER);
    expect(() => update(store, [{ op: 'add', content: '33rd' }])).toThrowError(
      expect.objectContaining({ code: 'WHITEBOARD_LIMIT', details: { limit: 'entries' } })
    );
    expect(store.read(OWNER)).toEqual(full);

    const { store: byteLimitedStore } = fixture();
    expect(() => update(byteLimitedStore, [{ op: 'add', content: 'é'.repeat(513) }])).toThrowError(
      expect.objectContaining({ code: 'WHITEBOARD_LIMIT', details: { limit: 'entryBytes' } })
    );
    expect(byteLimitedStore.read(OWNER)).toMatchObject({
      boardRevision: 0,
      entries: [],
      recentChanges: []
    });

    const { store: exactLimitStore } = fixture();
    const exactBoard = Array.from({ length: 8 }, () => ({
      op: 'add' as const,
      content: 'x'.repeat(1024)
    }));
    const exactResult = update(exactLimitStore, exactBoard);
    expect(exactResult.boardRevision).toBe(1);
    expect(exactResult.added.map(({ id }) => id)).toEqual([
      'w1',
      'w2',
      'w3',
      'w4',
      'w5',
      'w6',
      'w7',
      'w8'
    ]);
    expect(exactLimitStore.read(OWNER).entries).toHaveLength(8);
    const atLimit = exactLimitStore.read(OWNER);
    expect(() => update(exactLimitStore, [{ op: 'add', content: 'x' }])).toThrowError(
      expect.objectContaining({ code: 'WHITEBOARD_LIMIT', details: { limit: 'boardBytes' } })
    );
    expect(exactLimitStore.read(OWNER)).toEqual(atLimit);
  });

  it('retains only the ten newest committed change records', () => {
    const { store } = fixture();

    for (let index = 0; index < 11; index++)
      update(store, [{ op: 'add', content: `item ${index}` }], `editor-${index}`);

    const board = store.read(OWNER);
    expect(board.boardRevision).toBe(11);
    expect(board.entries).toContainEqual({ id: 'w11', revision: 1, content: 'item 10' });
    expect(board.recentChanges).toHaveLength(10);
    expect(
      board.recentChanges.map(({ boardRevision, actorSessionId }) => [
        boardRevision,
        actorSessionId
      ])
    ).toEqual(Array.from({ length: 10 }, (_, index) => [11 - index, `editor-${10 - index}`]));
  });
});

describe('WhiteboardService', () => {
  it('projects only active, same-user sharing without removing boards on detach', () => {
    const { service, runs } = serviceFixture();
    addRun(runs, 'root-run', 'archived');
    addRun(runs, 'peer-run', 'peer');
    addRun(runs, 'other-run', 'other', 'workspace', 8);
    service.join('peer-run', 'archived');
    service.update('peer-run', {
      expectedBoardId: 'archived',
      ops: [{ op: 'add', content: 'Decision' }]
    });
    expect(service.relationships('workspace', 7)).toEqual([
      { ownerSessionId: 'archived', followerSessionId: 'peer' }
    ]);
    expect(service.relationships('workspace', 8)).toEqual([]);
    expect(service.relationships('elsewhere', 7)).toEqual([]);
    runs.delete('root-run');
    service.release('root-run', 'workspace');
    expect(service.relationships('workspace', 7)).toEqual([]);
    expect(service.readPersisted('workspace', 'archived')?.entries[0]?.content).toBe('Decision');
    expect(service.readPersisted('elsewhere', 'archived')).toBeUndefined();
  });

  it('keeps the own board through inheritance and replaces only the followed board', () => {
    const { service, runs } = serviceFixture();
    for (const id of ['A', 'B', 'C', 'D']) addRun(runs, id, id);
    service.inherit('B', 'A');
    service.inherit('C', 'B');
    const edit = (runId: string, expectedBoardId: string, content: string) =>
      service.update(runId, { expectedBoardId, ops: [{ op: 'add', content }] });
    edit('B', 'B', 'B keeps its own board');
    edit('C', 'A', 'C follows the same board as B');
    expect(service.read('B').entries).toMatchObject([{ content: 'B keeps its own board' }]);

    expect(service.join('B', 'D')).toEqual({ boardAgentId: 'D', changed: true });
    edit('B', 'D', 'B now follows D');
    expect(service.join('B', 'B')).toEqual({ boardAgentId: 'B', changed: false });
    expect(followedBoard(service, 'B')?.boardId).toBe('D');
    expect(service.leave('B')).toEqual({ boardAgentId: 'D', changed: true });
    expect(service.leave('B')).toEqual({ changed: false });
    expect(followedBoard(service, 'B')).toBeUndefined();
    expect(() => edit('B', 'D', 'B stopped following D')).toThrowError(
      expect.objectContaining({ code: 'WHITEBOARD_CONFLICT' })
    );
    edit('B', 'B', 'B still writes to its own board');
    edit('C', 'A', 'C still follows A');
    expect(() => edit('B', 'A', 'B has stopped following A')).toThrowError(
      expect.objectContaining({ code: 'WHITEBOARD_CONFLICT' })
    );
    expect(service.read('B', 'A').entries).toHaveLength(2);
  });

  it('inherits a detached follow until the source explicitly leaves', () => {
    const { service, runs } = serviceFixture();
    addRun(runs, 'run-A1', 'A');
    addRun(runs, 'run-B', 'B');
    service.inherit('run-B', 'run-A1');
    runs.delete('run-A1');
    service.release('run-A1', 'workspace');
    expect(service.isDetached('run-B')).toBe(true);

    addRun(runs, 'run-A2', 'A');
    addRun(runs, 'run-C', 'C');
    service.inherit('run-C', 'run-B');
    expect(followedBoard(service, 'run-C')).toBeUndefined();
    expect(service.isDetached('run-C')).toBe(true);

    const candidate = service.capture('run-B', ['run-A2']);
    expect(service.leave('run-B')).toEqual({ boardAgentId: 'A', changed: true });
    expect(service.isDetached('run-B')).toBe(false);
    expect(candidate.accept()).toBe(false);
    expect(service.capture('run-B', ['run-A2']).views.map(({ role }) => role)).toEqual(['own']);
    expect(service.isDetached('run-C')).toBe(true);
    addRun(runs, 'run-D', 'D');
    service.inherit('run-D', 'run-B');
    expect(followedBoard(service, 'run-D')?.boardId).toBe('B');
    expect(service.capture('run-C', ['run-A2']).accept()).toBe(true);
    expect(followedBoard(service, 'run-C')?.boardId).toBe('A');
  });

  it('reads another board without joining, even when its owner is idle', () => {
    const { service, store, runs } = serviceFixture();
    addRun(runs, 'A', 'owner-A');
    addRun(runs, 'outside', 'outside', 'other-workspace');
    store.update('archived', 'archived', {
      expectedBoardId: 'archived',
      ops: [{ op: 'add', content: 'previous decision' }]
    });
    expect(service.read('A', 'archived')).toMatchObject({
      boardAgentId: 'archived',
      entries: [{ content: 'previous decision' }],
      recentChanges: [{ actorAgentId: 'archived' }]
    });
    expect(service.read('A')).toMatchObject({ boardAgentId: 'owner-A', entries: [] });
    expect(() => service.read('A', 'outside')).toThrowError(
      expect.objectContaining({ code: 'WHITEBOARD_UNAVAILABLE' })
    );
    expect(() => service.join('A', 'archived')).toThrowError(
      expect.objectContaining({ code: 'WHITEBOARD_UNAVAILABLE' })
    );
  });

  it('lets a root join another board without moving or detaching its existing peers', () => {
    const { service, runs } = serviceFixture();
    addRun(runs, 'A', 'owner-A');
    addRun(runs, 'B', 'owner-B');
    addRun(runs, 'peer', 'peer');
    addRun(runs, 'new-peer', 'new-peer');
    addRun(runs, 'outside', 'outside', 'other-workspace');
    addRun(runs, 'another-user', 'another-user', 'workspace', 8);
    service.inherit('peer', 'A');
    const wake = vi.fn();
    const rootWake = vi.fn();
    const stop = service.subscribe('peer', wake);
    expect(service.join('A', 'owner-B')).toEqual({ boardAgentId: 'owner-B', changed: true });
    expect(service.join('A', 'owner-B')).toEqual({ boardAgentId: 'owner-B', changed: false });
    expect(wake).not.toHaveBeenCalled();
    expect(service.read('A').boardAgentId).toBe('owner-A');
    expect(followedBoard(service, 'A')?.boardId).toBe('owner-B');
    expect(followedBoard(service, 'peer')?.boardId).toBe('owner-A');
    const stopRoot = service.subscribe('A', rootWake);
    expect(service.join('new-peer', 'owner-A').changed).toBe(true);
    service.update('new-peer', {
      expectedBoardId: 'owner-A',
      ops: [{ op: 'add', content: 'old group still works' }]
    });
    expect(wake).toHaveBeenCalledOnce();
    expect(rootWake).toHaveBeenCalledOnce();
    service.update('B', {
      expectedBoardId: 'owner-B',
      ops: [{ op: 'add', content: 'a change on the board A follows' }]
    });
    expect(rootWake).toHaveBeenCalledTimes(2);
    expect(wake).toHaveBeenCalledOnce();
    stopRoot();
    stop();
    for (const target of ['outside', 'another-user']) {
      expect(() => service.join('A', target)).toThrowError(
        expect.objectContaining({ code: 'WHITEBOARD_UNAVAILABLE' })
      );
    }
    expect(followedBoard(service, 'A')?.boardId).toBe('owner-B');
    runs.delete('A');
    service.release('A', 'workspace');
    expect(service.isDetached('peer')).toBe(true);
    expect(service.isDetached('new-peer')).toBe(true);
    expect(service.read('B').boardAgentId).toBe('owner-B');
  });

  it('shares the owner board transitively only across compatible active Runs', () => {
    const { service, runs } = serviceFixture();
    addRun(runs, 'run-A1', 'owner-A');
    addRun(runs, 'run-B1', 'agent-B');
    addRun(runs, 'run-C1', 'agent-C');
    addRun(runs, 'run-outsider', 'outsider', 'other-workspace');
    addRun(runs, 'run-other-user', 'other-user', 'workspace', 8);

    service.inherit('run-B1', 'run-A1');
    service.inherit('run-C1', 'run-B1');
    service.inherit('run-outsider', 'run-A1');
    service.inherit('run-other-user', 'run-A1');
    service.update('run-B1', {
      expectedBoardId: 'owner-A',
      ops: [{ op: 'add', content: 'shared decision' }]
    });

    for (const runId of ['run-B1', 'run-C1'])
      expect(followedBoard(service, runId)).toMatchObject({
        boardId: 'owner-A',
        entries: [{ id: 'w1', content: 'shared decision' }]
      });
    expect(service.read('run-outsider')).toMatchObject({
      boardAgentId: 'outsider',
      entries: []
    });
    expect(service.read('run-other-user')).toMatchObject({
      boardAgentId: 'other-user',
      entries: []
    });
  });

  it('releases an intermediate binding without detaching descendants from the active root Run', () => {
    const { service, runs } = serviceFixture();
    addRun(runs, 'run-A1', 'owner-A');
    addRun(runs, 'run-B1', 'agent-B');
    addRun(runs, 'run-C1', 'agent-C');
    service.inherit('run-B1', 'run-A1');
    service.inherit('run-C1', 'run-B1');
    service.update('run-A1', {
      expectedBoardId: 'owner-A',
      ops: [{ op: 'add', content: 'still shared through the root' }]
    });

    service.release('run-B1', 'workspace');

    expect(followedBoard(service, 'run-C1')).toMatchObject({
      boardId: 'owner-A',
      entries: [{ content: 'still shared through the root' }]
    });
    expect(followedBoard(service, 'run-B1')).toBeUndefined();
    expect(service.read('run-B1')).toMatchObject({ boardAgentId: 'agent-B', entries: [] });
  });

  it('detaches old sharing when the root ends and reconnects only the addressed Run to a later same-board Run', () => {
    const { service, runs } = serviceFixture();
    addRun(runs, 'run-A1', 'owner-A');
    addRun(runs, 'run-B1', 'agent-B');
    addRun(runs, 'run-C1', 'agent-C');
    service.inherit('run-B1', 'run-A1');
    service.inherit('run-C1', 'run-B1');
    service.update('run-A1', {
      expectedBoardId: 'owner-A',
      ops: [{ op: 'add', content: 'stale until a new message reconnects B' }]
    });

    runs.delete('run-A1');
    service.release('run-A1', 'workspace');
    expect(service.read('run-B1')).toMatchObject({ boardAgentId: 'agent-B' });
    const editDetached = (runId: string) =>
      service.update(runId, {
        expectedBoardId: 'owner-A',
        ops: [{ op: 'add', content: 'must not be written while detached' }]
      });
    expect(() => editDetached('run-B1')).toThrowError(
      expect.objectContaining({
        code: 'WHITEBOARD_DETACHED',
        publicMessage: expect.stringContaining(
          'Ask the owner to send you a new agent_send message from a run using this board, or join using the owner’s Agent ID when they have an active run.'
        ),
        details: { recoveryAgentId: 'owner-A' }
      })
    );

    addRun(runs, 'run-A2', 'owner-A');
    const reconnect = service.capture('run-B1', ['run-A2']);
    service.update('run-A2', {
      expectedBoardId: 'owner-A',
      ops: [
        { op: 'clear', expectedBoardRevision: 1 },
        { op: 'add', content: 'current state after reconnect' }
      ]
    });
    expect(reconnect.accept()).toBe(true);
    expect(service.pending('run-B1', [])).toBe(true);
    expect(followedBoard(service, 'run-B1')).toMatchObject({
      boardId: 'owner-A',
      entries: [{ content: 'current state after reconnect' }]
    });
    expect(() => editDetached('run-C1')).toThrowError(
      expect.objectContaining({ code: 'WHITEBOARD_DETACHED' })
    );
  });

  it('notifies each authorized peer once per committed batch, excluding the writer and other boards', () => {
    const { service, runs } = serviceFixture();
    addRun(runs, 'run-A1', 'owner-A');
    addRun(runs, 'run-B1', 'agent-B');
    addRun(runs, 'run-C1', 'agent-C');
    addRun(runs, 'run-D1', 'agent-D');
    service.inherit('run-B1', 'run-A1');
    service.inherit('run-C1', 'run-B1');

    const ownerWake = vi.fn();
    const writerWake = vi.fn();
    const peerWake = vi.fn();
    const otherBoardWake = vi.fn();
    service.subscribe('run-A1', ownerWake);
    service.subscribe('run-B1', writerWake);
    const unsubscribePeer = service.subscribe('run-C1', peerWake);
    service.subscribe('run-D1', otherBoardWake);

    service.update('run-B1', {
      expectedBoardId: 'owner-A',
      ops: [
        { op: 'add', content: 'first batch edit' },
        { op: 'add', content: 'second batch edit' }
      ]
    });
    expect(ownerWake).toHaveBeenCalledTimes(1);
    expect(peerWake).toHaveBeenCalledTimes(1);
    expect(writerWake).not.toHaveBeenCalled();
    expect(otherBoardWake).not.toHaveBeenCalled();

    service.update('run-B1', {
      expectedBoardId: 'owner-A',
      ops: [{ op: 'update', id: 'w1', expectedRevision: 1, content: 'first batch edit' }]
    });
    expect(ownerWake).toHaveBeenCalledTimes(1);
    expect(peerWake).toHaveBeenCalledTimes(1);

    unsubscribePeer();
    service.subscribe('run-A1', () => {
      throw new Error('subscriber failure');
    });
    expect(() =>
      service.update('run-B1', {
        expectedBoardId: 'owner-A',
        ops: [{ op: 'add', content: 'committed despite subscriber failure' }]
      })
    ).not.toThrow();
    expect(ownerWake).toHaveBeenCalledTimes(2);
    expect(peerWake).toHaveBeenCalledTimes(1);
    expect(service.read('run-A1').entries).toContainEqual(
      expect.objectContaining({ content: 'committed despite subscriber failure' })
    );

    const revokedWake = vi.fn();
    service.subscribe('run-C1', revokedWake);
    addRun(runs, 'run-C1', 'agent-C', 'workspace', 8);
    service.update('run-A1', {
      expectedBoardId: 'owner-A',
      ops: [{ op: 'add', content: 'visible only to still-authorized subscribers' }]
    });
    expect(ownerWake).toHaveBeenCalledTimes(2);
    expect(writerWake).toHaveBeenCalledTimes(1);
    expect(peerWake).toHaveBeenCalledTimes(1);
    expect(revokedWake).not.toHaveBeenCalled();

    runs.delete('run-A1');
    service.release('run-A1', 'workspace');
    addRun(runs, 'run-A2', 'owner-A');
    service.update('run-A2', {
      expectedBoardId: 'owner-A',
      ops: [{ op: 'add', content: 'same board in a new task network' }]
    });
    expect(writerWake).toHaveBeenCalledTimes(1);
    expect(service.pending('run-B1', [])).toBe(false);
  });
});

function acknowledgeContext(proposal: ExtensionRequestContext) {
  proposal.acknowledge?.(new Set(proposal.items?.map(({ id }) => id)));
}

describe('NodeOrchestration whiteboard context', () => {
  it('acknowledges the captured revisions independently when one board changes again', async () => {
    const { service, runs } = serviceFixture();
    addRun(runs, 'A', 'owner-A');
    addRun(runs, 'B', 'owner-B');
    addRun(runs, 'peer', 'peer');
    service.inherit('peer', 'A');
    service.join('A', 'owner-B');
    const context = new NodeOrchestration(service).context(() => 'A', { collect: () => [] });
    const signal = new AbortController().signal;
    const request = () => context.requestContext!({ clientMessageIds: [], signal });
    const edit = (actor: string, board: string, content: string) =>
      service.update(actor, { expectedBoardId: board, ops: [{ op: 'add', content }] });

    acknowledgeContext(await request());
    edit('peer', 'owner-A', 'own revision one');
    edit('B', 'owner-B', 'followed revision one');
    const captured = await request();
    captured.acknowledge?.(new Set(['mar.node.whiteboard']));
    expect(context.wake?.pending()).toBe(true);
    edit('peer', 'owner-A', 'own revision two');
    acknowledgeContext(captured);
    expect(context.wake?.pending()).toBe(true);

    const next = await request();
    expect(contextBoard(next.items, 'own')).toMatchObject({ boardRevision: 2 });
    expect(next.items?.find(({ id }) => id === 'mar.node.whiteboard')).toEqual(
      captured.items?.find(({ id }) => id === 'mar.node.whiteboard')
    );
    acknowledgeContext(next);
    expect(context.wake?.pending()).toBe(false);
  });

  it('wakes only for new peer edits after joining another board', async () => {
    const { service, runs } = serviceFixture();
    addRun(runs, 'A', 'owner-A');
    addRun(runs, 'B', 'owner-B');
    const context = new NodeOrchestration(service).context(() => 'A', { collect: () => [] });
    const signal = new AbortController().signal;
    const request = () => context.requestContext!({ clientMessageIds: [], signal });
    const edit = (content: string) =>
      service.update('B', { expectedBoardId: 'owner-B', ops: [{ op: 'add', content }] });

    acknowledgeContext(await request());
    edit('already on the board');
    expect(service.join('A', 'owner-B').changed).toBe(true);
    expect(context.wake?.pending()).toBe(false);
    const candidate = await request();
    expect(contextBoard(candidate.items, 'followed')).toMatchObject({
      entries: [{ content: 'already on the board' }]
    });

    const wake = vi.fn();
    const unsubscribe = context.wake?.subscribe(wake);
    try {
      edit('written after joining');
      expect(wake).toHaveBeenCalledOnce();
      acknowledgeContext(candidate);
      expect(service.join('A', 'owner-B').changed).toBe(false);
      expect(context.wake?.pending()).toBe(true);
      acknowledgeContext(await request());
      expect(context.wake?.pending()).toBe(false);
    } finally {
      unsubscribe?.();
    }
  });

  it('does not wake for edits before inheriting a board, even before the first snapshot is delivered', () => {
    const { service, runs } = serviceFixture();
    addRun(runs, 'A', 'owner-A');
    addRun(runs, 'B', 'owner-B');
    addRun(runs, 'C', 'owner-C');
    service.inherit('B', 'A');
    const edit = (content: string) =>
      service.update('A', { expectedBoardId: 'owner-A', ops: [{ op: 'add', content }] });

    edit('before C inherits from B');
    service.inherit('C', 'B');
    const context = new NodeOrchestration(service).context(() => 'C', { collect: () => [] });
    expect(context.wake?.pending()).toBe(false);
    edit('after C inherits from B');
    expect(context.wake?.pending()).toBe(true);
  });

  it('starts a new snapshot without a change summary after leaving and rejoining the same live board', async () => {
    const { service, runs } = serviceFixture();
    addRun(runs, 'A', 'owner-A');
    addRun(runs, 'B', 'owner-B');
    service.inherit('B', 'A');
    const context = new NodeOrchestration(service).context(() => 'B', { collect: () => [] });
    const request = () =>
      context.requestContext!({ clientMessageIds: [], signal: new AbortController().signal });
    acknowledgeContext(await request());
    service.leave('B');
    service.update('A', {
      expectedBoardId: 'owner-A',
      ops: [{ op: 'add', content: 'edit while not following' }]
    });
    service.join('B', 'owner-A');
    const rejoined = await request();
    expect(contextBoard(rejoined.items, 'followed')).toMatchObject({
      entries: [{ content: 'edit while not following' }]
    });
    expect(contextBoard(rejoined.items, 'followed')).not.toHaveProperty('lastChange');
    acknowledgeContext(rejoined);
    service.update('A', {
      expectedBoardId: 'owner-A',
      ops: [{ op: 'add', content: 'edit after the new snapshot' }]
    });
    expect(contextBoard((await request()).items, 'followed')).toMatchObject({
      lastChange: { actorAgentId: 'owner-A', summary: 'add: 1' }
    });
  });

  it('rejects a captured view if a leave and rejoin replaced the same follow', () => {
    const { service, runs } = serviceFixture();
    addRun(runs, 'A', 'owner-A');
    addRun(runs, 'B', 'owner-B');
    service.inherit('B', 'A');
    const candidate = service.capture('B', []);

    service.leave('B');
    service.update('A', {
      expectedBoardId: 'owner-A',
      ops: [{ op: 'add', content: 'added before joining again' }]
    });
    service.join('B', 'owner-A');

    expect(candidate.accept()).toBe(false);
    const rebuilt = service.capture('B', []);
    expect(rebuilt.views[1]?.snapshot.entries).toEqual([
      { id: 'w1', revision: 1, content: 'added before joining again' }
    ]);
    expect(rebuilt.accept()).toBe(true);
  });

  it('captures the current Run snapshot with its board owner and without change logs', async () => {
    const { service, runs } = serviceFixture();
    addRun(runs, 'run-A1', 'owner-A');
    addRun(runs, 'run-B1', 'agent-B');
    addRun(runs, 'run-C1', 'agent-C');
    service.inherit('run-B1', 'run-A1');
    service.update('run-A1', {
      expectedBoardId: 'owner-A',
      ops: [{ op: 'add', content: 'shared snapshot' }]
    });
    service.update('run-C1', {
      expectedBoardId: 'agent-C',
      ops: [{ op: 'add', content: 'independent snapshot' }]
    });
    const orchestration = new NodeOrchestration(service);
    let runId = 'run-B1';
    const currentRun = vi.fn(() => runId);
    const context = orchestration.context(currentRun, { collect: () => [] });
    const signal = new AbortController().signal;

    const shared = await context.requestContext!({ clientMessageIds: [], signal });
    expect(currentRun).toHaveBeenCalled();
    expect(shared.items).toHaveLength(2);
    expect(contextBoard(shared.items, 'own')).toMatchObject({
      boardAgentId: 'agent-B',
      entries: []
    });
    const sharedSnapshot = contextBoard(shared.items, 'followed');
    expect(sharedSnapshot).toEqual({
      boardAgentId: 'owner-A',
      boardRevision: 1,
      entries: [{ id: 'w1', revision: 1, content: 'shared snapshot' }]
    });
    expect(sharedSnapshot).not.toHaveProperty('recentChanges');

    acknowledgeContext(shared);
    service.update('run-A1', {
      expectedBoardId: 'owner-A',
      ops: [{ op: 'add', content: 'an intervening edit' }]
    });
    service.update('run-B1', {
      expectedBoardId: 'owner-A',
      ops: [{ op: 'update', id: 'w1', expectedRevision: 1, content: 'shared revision' }]
    });
    const updated = await context.requestContext!({ clientMessageIds: [], signal });
    expect(contextBoard(updated.items, 'followed')).toEqual({
      boardAgentId: 'owner-A',
      boardRevision: 3,
      entries: [
        { id: 'w1', revision: 2, content: 'shared revision' },
        { id: 'w2', revision: 1, content: 'an intervening edit' }
      ],
      lastChange: { actorAgentId: 'agent-B', summary: 'update: 1' }
    });
    acknowledgeContext(updated);
    expect((await context.requestContext!({ clientMessageIds: [], signal })).items).toEqual(
      updated.items
    );

    runId = 'run-C1';
    const independent = await context.requestContext!({ clientMessageIds: [], signal });
    expect(independent.items).toHaveLength(1);
    const independentSnapshot = contextBoard(independent.items, 'own');
    expect(independentSnapshot).toMatchObject({
      boardAgentId: 'agent-C',
      entries: [{ content: 'independent snapshot' }]
    });
  });

  it('reconnects a detached Run only when its adopted client message ID reaches the request boundary', async () => {
    const { service, runs } = serviceFixture();
    addRun(runs, 'run-A1', 'owner-A');
    addRun(runs, 'run-B1', 'agent-B');
    service.inherit('run-B1', 'run-A1');
    service.update('run-A1', {
      expectedBoardId: 'owner-A',
      ops: [{ op: 'add', content: 'initial state' }]
    });
    const orchestration = new NodeOrchestration(service);
    const context = orchestration.context(() => 'run-B1', { collect: () => [] });
    const signal = new AbortController().signal;
    acknowledgeContext(await context.requestContext!({ clientMessageIds: [], signal }));
    runs.delete('run-A1');
    service.release('run-A1', 'workspace');
    addRun(runs, 'run-A2', 'owner-A');
    service.update('run-A2', {
      expectedBoardId: 'owner-A',
      ops: [
        { op: 'clear', expectedBoardRevision: 1 },
        { op: 'add', content: 'state at reconnection' }
      ]
    });
    orchestration.prepareInput(
      'run-B1',
      'adopted-message',
      { runId: 'run-A2', hasMessage: true },
      false
    );

    const unrelated = await context.requestContext!({
      clientMessageIds: ['unrelated-message'],
      signal
    });
    expect(contextBoard(unrelated.items, 'followed')).toBeUndefined();
    expect(contextBoard(unrelated.items, 'own')).toMatchObject({ boardAgentId: 'agent-B' });

    const adopted = await context.requestContext!({
      clientMessageIds: ['adopted-message'],
      signal
    });
    expect(service.isDetached('run-B1')).toBe(true);
    const rebuiltWithoutMessage = await context.requestContext!({ clientMessageIds: [], signal });
    expect(contextBoard(rebuiltWithoutMessage.items, 'followed')).toBeUndefined();
    expect(rebuiltWithoutMessage.accept?.(() => false)).toBe(true);
    expect(service.isDetached('run-B1')).toBe(true);
    expect(adopted.accept?.(() => false)).toBe(false);
    expect(service.isDetached('run-B1')).toBe(true);
    expect(adopted.accept?.((id) => id === 'adopted-message')).toBe(true);
    expect(service.isDetached('run-B1')).toBe(false);
    expect(adopted.items).toHaveLength(2);
    const snapshot = contextBoard(adopted.items, 'followed');
    expect(snapshot).toMatchObject({
      boardAgentId: 'owner-A',
      entries: [{ content: 'state at reconnection' }]
    });
    expect(snapshot).not.toHaveProperty('recentChanges');
    expect(snapshot).not.toHaveProperty('lastChange');

    // The model request may retain the reconnection message but filter the followed snapshot.
    adopted.acknowledge?.(new Set(['mar.node.whiteboard.own']));
    expect(context.wake?.pending()).toBe(false);
    service.update('run-A2', {
      expectedBoardId: 'owner-A',
      ops: [{ op: 'add', content: 'new edit after reconnecting' }]
    });
    expect(context.wake?.pending()).toBe(true);
  });

  it('keeps wake pending until the explicit empty board state is acknowledged', async () => {
    const { service, runs } = serviceFixture();
    addRun(runs, 'run-A1', 'owner-A');
    addRun(runs, 'run-B1', 'agent-B');
    service.inherit('run-B1', 'run-A1');
    const orchestration = new NodeOrchestration(service);
    const context = orchestration.context(() => 'run-B1', { collect: () => [] });
    const signal = new AbortController().signal;
    const request = () => context.requestContext!({ clientMessageIds: [], signal });

    expect(context.wake?.pending()).toBe(false);
    service.update('run-A1', {
      expectedBoardId: 'owner-A',
      ops: [{ op: 'add', content: 'external change' }]
    });
    expect(context.wake?.pending()).toBe(true);
    const first = await request();
    expect(first.items).toHaveLength(2);
    expect(context.wake?.pending()).toBe(true);
    const repeated = await request();
    expect(repeated.items).toEqual(first.items);
    acknowledgeContext(repeated);
    expect(context.wake?.pending()).toBe(false);

    service.update('run-A1', {
      expectedBoardId: 'owner-A',
      ops: [{ op: 'clear', expectedBoardRevision: 1 }]
    });
    expect(context.wake?.pending()).toBe(true);
    const cleared = await request();
    expect(contextBoard(cleared.items, 'followed')).toEqual({
      boardAgentId: 'owner-A',
      boardRevision: 2,
      entries: [],
      lastChange: { actorAgentId: 'owner-A', summary: 'clear: 1' }
    });
    expect(cleared.acknowledge).toBeTypeOf('function');
    expect(context.wake?.pending()).toBe(true);
    acknowledgeContext(cleared);
    expect(context.wake?.pending()).toBe(false);
  });

  it('never reconnects from an ended sender, rejected delivery, or message without text', async () => {
    const { service, runs } = serviceFixture();
    addRun(runs, 'run-A1', 'owner-A');
    addRun(runs, 'run-B1', 'agent-B');
    service.inherit('run-B1', 'run-A1');
    runs.delete('run-A1');
    service.release('run-A1', 'workspace');
    addRun(runs, 'run-A2', 'owner-A');
    const orchestration = new NodeOrchestration(service);
    orchestration.prepareInput(
      'run-B1',
      'old-message',
      { runId: 'run-A2', hasMessage: true },
      false
    );
    runs.delete('run-A2');
    service.release('run-A2', 'workspace');
    addRun(runs, 'run-A3', 'owner-A');
    orchestration.prepareInput(
      'run-B1',
      'rejected',
      { runId: 'run-A3', hasMessage: true },
      false
    )();
    orchestration.prepareInput(
      'run-B1',
      'goal-only',
      { runId: 'run-A3', hasMessage: false },
      false
    );
    const context = orchestration.context(() => 'run-B1', { collect: () => [] });
    const request = (clientMessageIds: string[]) =>
      context.requestContext!({ clientMessageIds, signal: new AbortController().signal });
    expect(
      contextBoard((await request(['old-message', 'rejected', 'goal-only'])).items, 'followed')
    ).toBeUndefined();
    expect(service.isDetached('run-B1')).toBe(true);
    orchestration.prepareInput(
      'run-B1',
      'new-message',
      { runId: 'run-A3', hasMessage: true },
      false
    );
    expect((await request(['new-message'])).accept?.(() => true)).toBe(true);
    expect(followedBoard(service, 'run-B1')?.boardId).toBe('owner-A');
  });

  it('rejects a reconnect snapshot captured before its source ends', async () => {
    const { service, runs } = serviceFixture();
    addRun(runs, 'run-A1', 'owner-A');
    addRun(runs, 'run-B1', 'agent-B');
    service.inherit('run-B1', 'run-A1');
    runs.delete('run-A1');
    service.release('run-A1', 'workspace');
    addRun(runs, 'run-A2', 'owner-A');
    service.update('run-A2', {
      expectedBoardId: 'owner-A',
      ops: [{ op: 'add', content: 'only while A2 is active' }]
    });
    const orchestration = new NodeOrchestration(service);
    orchestration.prepareInput('run-B1', 'message', { runId: 'run-A2', hasMessage: true }, false);
    const context = orchestration.context(() => 'run-B1', { collect: () => [] });
    const request = () =>
      context.requestContext!({
        clientMessageIds: ['message'],
        signal: new AbortController().signal
      });
    const candidate = await request();
    expect(candidate.items).toHaveLength(2);
    runs.delete('run-A2');
    service.release('run-A2', 'workspace');
    expect(candidate.accept?.(() => true)).toBe(false);
    const retry = await request();
    expect(contextBoard(retry.items, 'followed')).toBeUndefined();
    expect(retry.accept?.(() => true)).toBe(true);
    expect(service.isDetached('run-B1')).toBe(true);
  });

  it('keeps an unread peer edit after more than ten own edits, but does not wake for those own edits', async () => {
    const { service, runs } = serviceFixture();
    addRun(runs, 'run-A1', 'owner-A');
    addRun(runs, 'run-B1', 'agent-B');
    service.inherit('run-B1', 'run-A1');
    const context = new NodeOrchestration(service).context(() => 'run-B1', { collect: () => [] });
    service.update('run-B1', { expectedBoardId: 'owner-A', ops: [{ op: 'add', content: 'own' }] });
    expect(context.wake?.pending()).toBe(false);
    service.update('run-A1', {
      expectedBoardId: 'owner-A',
      ops: [{ op: 'add', content: 'unread peer edit' }]
    });
    for (let i = 0; i < 11; i++) {
      service.update('run-B1', {
        expectedBoardId: 'owner-A',
        ops: [{ op: 'add', content: `own ${i}` }]
      });
    }
    expect(
      service
        .read('run-B1', 'owner-A')
        .recentChanges.every(({ actorAgentId }) => actorAgentId === 'agent-B')
    ).toBe(true);
    expect(context.wake?.pending()).toBe(true);
    acknowledgeContext(
      await context.requestContext!({ clientMessageIds: [], signal: new AbortController().signal })
    );
    expect(context.wake?.pending()).toBe(false);
  });
});
