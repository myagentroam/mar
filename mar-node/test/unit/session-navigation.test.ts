import { describe, expect, it, vi } from 'vitest';
import { NodeDatabase } from '../../src/database.js';
import { NodeRuntimeState } from '../../src/runtime-state.js';
import { NativeSessionProjectionService } from '../../src/session/native-session-projection-service.js';
import { SessionCatalogService } from '../../src/session/session-catalog-service.js';
import type { RunnerRegistry } from '../../src/runner/runner-registry.js';
import type { NodeAgentSession } from '../../src/session/contracts.js';

function fixture() {
  const database = new NodeDatabase(':memory:', 'session-navigation');
  const workspace = database.saveWorkspace({
    path: '/navigation',
    kind: 'DIRECTORY',
    gitSummary: null
  });
  let now = 1000;
  const runtime = new NodeRuntimeState(
    () => 'node',
    (id) => database.getWorkspace(id),
    () => now
  );
  const runners = {
    require: () => ({ managedAliasId: () => undefined })
  } as unknown as RunnerRegistry;
  const native: NodeAgentSession[] = [];
  const cachedNative = vi.fn(() => native);
  const present = vi.fn((session: NodeAgentSession) => session);
  const discovery = vi.fn(async () => []);
  const history = vi.fn(async () => ({ turns: [], nextCursor: null }));
  const catalog = new SessionCatalogService({
    database: () => database,
    nodeId: () => 'node',
    runtime,
    runners,
    projection: new NativeSessionProjectionService({ runtime, runners } as never),
    runnerAvailable: () => true,
    cachedNative,
    cachedWorkspace: discovery,
    discoverWorkspace: discovery,
    discoveryPending: () => false,
    present,
    nativeIds: () => new Set(),
    forget: () => undefined,
    refreshActivity: async () => undefined,
    externalActivity: () => undefined,
    isWatching: () => false,
    history,
    invalidateHistory: () => undefined,
    invalidateWorkspaceSessions: () => undefined,
    emitSession: () => undefined
  });
  function register(id: string, parentSessionId?: string, workspaceId = workspace.id) {
    database.saveNativeSessionMetadata({
      runner: 'codex',
      externalSessionId: id,
      workspaceId,
      ...(parentSessionId === undefined ? {} : { parentSessionId })
    });
  }
  function activate(id: string, sleeping = false) {
    runtime.createAgentSession({
      workspaceId: workspace.id,
      cwd: workspace.path,
      runner: 'codex',
      externalSessionId: id,
      nativeControl: 'MAR_MANAGED'
    });
    const { run } = runtime.createMessageRun({
      sessionId: id,
      clientMessageId: id,
      content: 'Work'
    });
    runtime.transitionRun(run.id, 'RUNNING');
    if (sleeping)
      runtime.appendRunEvent({
        runId: run.id,
        sequence: 1,
        eventType: 'conversation.item',
        payload: {
          itemId: 'sleep',
          kind: 'tool_call',
          status: 'IN_PROGRESS',
          payload: {
            toolName: 'sleep',
            toolPresentation: { kind: 'SLEEP', startedAt: '2026-11-04T00:00:00.000Z' }
          }
        }
      });
    return run;
  }
  function navigation(limit = 100) {
    return catalog.navigation({
      workspaceId: workspace.id,
      sessionIds: [],
      summaryAnchors: ['root'],
      treeAnchor: 'root',
      limit
    });
  }
  register('root');
  return {
    database,
    workspace,
    runtime,
    native,
    present,
    cachedNative,
    setTime: (time: number) => {
      now = time;
    },
    catalog,
    discovery,
    history,
    register,
    activate,
    navigation
  };
}

describe('Session Navigation bounded tree', () => {
  it('selects active descendants first and newest idle descendants before the cap using a request-local lookup', () => {
    const f = fixture();
    try {
      for (let index = 0; index < 185; index++) {
        const id = `idle-${String(index).padStart(3, '0')}`;
        f.register(id, 'root');
        f.runtime.createAgentSession({
          workspaceId: f.workspace.id,
          cwd: f.workspace.path,
          runner: 'codex',
          externalSessionId: id,
          lastActivityAt: index + 100
        });
      }
      f.register('z-running', 'root');
      f.setTime(10);
      f.activate('z-running');
      f.register('z-sleeping', 'root');
      f.setTime(20);
      f.activate('z-sleeping', true);
      const lookup = vi.spyOn(f.runtime, 'getAgentSession');
      const indexes = vi.spyOn(f.runtime, 'createSessionLookup');
      const tails = vi.spyOn(f.runtime, 'conversationTail');
      const prepare = vi.spyOn(f.database.raw, 'prepare');
      const snapshot = f.navigation(5);
      expect(snapshot.tree?.nodes.map((node) => node.id)).toEqual([
        'z-sleeping',
        'z-running',
        'idle-184',
        'idle-183',
        'idle-182'
      ]);
      expect(snapshot.tree?.nodes.map((node) => node.lastActivityAt)).toEqual([
        20, 10, 284, 283, 282
      ]);
      expect(snapshot.summaries[0]).toMatchObject({ descendantCount: 187, activeCount: 2 });
      expect(snapshot.tree?.truncated).toBe(true);
      expect(f.present).toHaveBeenCalledTimes(5);
      expect(lookup).not.toHaveBeenCalled();
      expect(indexes).toHaveBeenCalledTimes(1);
      expect(tails).toHaveBeenCalledTimes(2);
      expect(prepare.mock.calls.length).toBeLessThanOrEqual(3);
      expect(f.discovery).not.toHaveBeenCalled();
      expect(f.history).not.toHaveBeenCalled();
    } finally {
      f.database.close();
    }
  });

  it('retains ancestry when a recent idle grandchild is selected ahead of older siblings', () => {
    const f = fixture();
    try {
      f.register('idle-parent', 'root');
      f.register('recent-grandchild', 'idle-parent');
      f.runtime.createAgentSession({
        workspaceId: f.workspace.id,
        cwd: f.workspace.path,
        runner: 'codex',
        externalSessionId: 'recent-grandchild',
        lastActivityAt: 5000
      });
      f.register('other-idle', 'root');
      f.runtime.createAgentSession({
        workspaceId: f.workspace.id,
        cwd: f.workspace.path,
        runner: 'codex',
        externalSessionId: 'other-idle',
        lastActivityAt: 3000
      });
      f.register('active-parent', 'root');
      f.register('active-grandchild', 'active-parent');
      f.activate('active-grandchild');
      const snapshot = f.navigation(4);
      expect(snapshot.tree?.nodes.map((node) => node.id)).toEqual([
        'active-grandchild',
        'active-parent',
        'recent-grandchild',
        'idle-parent'
      ]);
      expect(snapshot.tree?.nodes).toHaveLength(4);
      expect(snapshot.tree?.truncated).toBe(true);
    } finally {
      f.database.close();
    }
  });

  it.each([2, 100])(
    'does not let an oversized active path displace a fitting active session at limit %i',
    (limit) => {
      const f = fixture();
      try {
        let parent = 'root';
        for (let index = 0; index < limit; index++) {
          const id = `ancestor-${String(index).padStart(3, '0')}`;
          f.register(id, parent);
          parent = id;
        }
        f.register('deep-running', parent);
        f.setTime(2000);
        f.activate('deep-running');
        f.register('direct-running', 'root');
        f.setTime(1000);
        f.activate('direct-running');
        const snapshot = f.navigation(limit);
        expect(snapshot.tree?.nodes).toHaveLength(limit);
        expect(snapshot.tree?.nodes).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: 'direct-running', status: 'RUNNING' })
          ])
        );
        expect(snapshot.tree?.nodes.some((node) => node.id === 'deep-running')).toBe(false);
        expect(snapshot.tree?.truncated).toBe(true);
        expect(snapshot.summaries[0]).toMatchObject({ activeCount: 2, descendantCount: limit + 2 });
        const selected = new Set(['root', ...snapshot.tree!.nodes.map((node) => node.id)]);
        expect(snapshot.tree!.nodes.every((node) => selected.has(node.parentSessionId!))).toBe(
          true
        );
      } finally {
        f.database.close();
      }
    }
  );

  it('bounds ancestor reads for multiple oversized active paths while retaining a fitting candidate', () => {
    const f = fixture();
    try {
      const depth = 160;
      const limit = 5;
      let parent = 'root';
      for (let index = 0; index < depth; index++) {
        const id = `chain-${String(index).padStart(3, '0')}`;
        f.register(id, parent);
        parent = id;
      }
      for (const [id, time] of [
        ['deep-a', 4000],
        ['deep-b', 3000],
        ['deep-c', 2000]
      ] as const) {
        f.register(id, parent);
        f.setTime(time);
        f.activate(id);
      }
      f.register('direct-running', 'root');
      f.setTime(1000);
      f.activate('direct-running');

      let parentReads = 0;
      const originalSessionTreeRecords = f.database.sessionTreeRecords.bind(f.database);
      vi.spyOn(f.database, 'sessionTreeRecords').mockImplementation((workspaceId, sessionId) =>
        originalSessionTreeRecords(workspaceId, sessionId).map(
          (record) =>
            new Proxy(record, {
              get(target, property, receiver) {
                if (property !== 'metadata') return Reflect.get(target, property, receiver);
                return new Proxy(target.metadata, {
                  get(metadata, metadataProperty, metadataReceiver) {
                    if (metadataProperty === 'parentSessionId') parentReads++;
                    return Reflect.get(metadata, metadataProperty, metadataReceiver);
                  }
                });
              }
            })
        )
      );

      const snapshot = f.navigation(limit);
      const nodes = snapshot.tree?.nodes ?? [];
      expect(nodes).toHaveLength(limit);
      expect(nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'direct-running', status: 'RUNNING' })
        ])
      );
      expect(nodes.some((node) => node.id.startsWith('deep-'))).toBe(false);
      const selected = new Set(['root', ...nodes.map((node) => node.id)]);
      expect(nodes.every((node) => selected.has(node.parentSessionId!))).toBe(true);
      expect(parentReads).toBeLessThanOrEqual(2 * depth + 3 * 2 * (limit + 1) + 4 * limit + 10);
    } finally {
      f.database.close();
    }
  });

  it('uses cached native activity, puts unknown times last, and breaks equal-time ties by stable id', () => {
    const f = fixture();
    try {
      for (const id of ['unknown-z', 'unknown-a', 'cached', 'equal-z', 'equal-a'])
        f.register(id, 'root');
      for (const id of ['equal-z', 'equal-a'])
        f.runtime.createAgentSession({
          workspaceId: f.workspace.id,
          cwd: f.workspace.path,
          runner: 'codex',
          externalSessionId: id,
          lastActivityAt: 100
        });
      const cached = f.runtime.createAgentSession({
        workspaceId: f.workspace.id,
        cwd: f.workspace.path,
        runner: 'codex',
        externalSessionId: 'cached',
        lastActivityAt: 50
      });
      f.native.push({ ...cached, lastActivityAt: 200 });
      expect(f.navigation().tree?.nodes.map((node) => [node.id, node.lastActivityAt])).toEqual([
        ['cached', 200],
        ['equal-a', 100],
        ['equal-z', 100],
        ['unknown-a', 0],
        ['unknown-z', 0]
      ]);
      expect(f.navigation().tree?.truncated).toBe(false);
    } finally {
      f.database.close();
    }
  });

  it('does not project native or live session details for summary-only watches', () => {
    const f = fixture();
    try {
      f.register('child', 'root');
      f.activate('child');
      const snapshot = f.catalog.navigation({
        workspaceId: f.workspace.id,
        sessionIds: [],
        summaryAnchors: ['root'],
        limit: 100
      });
      expect(snapshot.summaries[0]).toMatchObject({ descendantCount: 1, activeCount: 1 });
      expect(snapshot.tree).toBe(null);
      expect(f.cachedNative).not.toHaveBeenCalled();
      expect(f.present).not.toHaveBeenCalled();
    } finally {
      f.database.close();
    }
  });

  it('selects running and sleeping descendants beyond the first 100 records before truncating', () => {
    const f = fixture();
    try {
      for (let index = 0; index < 120; index++)
        f.register(`idle-${String(index).padStart(3, '0')}`, 'root');
      f.register('z-running', 'root');
      f.register('z-sleeping', 'root');
      const running = f.activate('z-running');
      const sleeping = f.activate('z-sleeping', true);
      const snapshot = f.navigation();
      expect(snapshot.tree?.nodes).toHaveLength(100);
      expect(snapshot.tree?.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'z-running', status: 'RUNNING' }),
          expect.objectContaining({ id: 'z-sleeping', status: 'SLEEPING' })
        ])
      );
      expect(snapshot.tree?.truncated).toBe(true);
      expect(snapshot.summaries).toEqual([
        expect.objectContaining({
          descendantCount: 122,
          runningCount: 1,
          sleepingCount: 1,
          activeCount: 2
        })
      ]);
      expect(f.navigation(2).tree?.nodes.map((node) => node.id)).toEqual([
        'z-running',
        'z-sleeping'
      ]);
      f.runtime.transitionRun(running.id, 'SUCCEEDED');
      f.runtime.transitionRun(sleeping.id, 'SUCCEEDED');
      expect(f.navigation().summaries[0]).toMatchObject({
        activeCount: 0,
        hasActiveDescendants: false
      });
      expect(f.navigation().tree?.nodes.every((node) => node.status === 'IDLE')).toBe(true);
      expect(f.discovery).not.toHaveBeenCalled();
      expect(f.history).not.toHaveBeenCalled();
    } finally {
      f.database.close();
    }
  });

  it('keeps an idle ancestor of a late active grandchild without filling the cap with idle branches', () => {
    const f = fixture();
    try {
      f.register('a-running', 'root');
      f.activate('a-running');
      for (let index = 0; index < 120; index++) {
        f.register(`idle-${index}`, 'root');
        f.register(`nested-idle-${index}`, 'a-running');
      }
      f.register('z-branch', 'root');
      f.register('z-grandchild', 'z-branch');
      f.activate('z-grandchild');
      const snapshot = f.navigation(3);
      expect(snapshot.tree?.nodes.map((node) => node.id)).toEqual([
        'a-running',
        'z-grandchild',
        'z-branch'
      ]);
      expect(snapshot.tree?.nodes.find((node) => node.id === 'z-branch')?.status).toBe('IDLE');
      expect(snapshot.summaries[0]).toMatchObject({ descendantCount: 243, activeCount: 2 });
      expect(snapshot.tree?.truncated).toBe(true);
    } finally {
      f.database.close();
    }
  });

  it('caps even active-only trees and retains complete summaries', () => {
    const f = fixture();
    try {
      for (let index = 0; index < 101; index++) {
        const id = `active-${index}`;
        f.register(id, 'root');
        f.activate(id);
      }
      expect(f.navigation().tree?.nodes).toHaveLength(100);
      expect(f.navigation().tree?.truncated).toBe(true);
      expect(f.navigation().summaries[0]).toMatchObject({ descendantCount: 101, activeCount: 101 });
    } finally {
      f.database.close();
    }
  });
});

describe('Registered Session tree traversal', () => {
  it('reads a large subtree with bounded SQL statements, preserving breadth-first sibling order and workspace scope', () => {
    const f = fixture();
    try {
      for (let index = 0; index < 1000; index++) f.register(`child-${index}`, 'root');
      f.register('grandchild', 'child-0');
      const foreign = f.database.saveWorkspace({
        path: '/foreign',
        kind: 'DIRECTORY',
        gitSummary: null
      });
      f.register('foreign-child', 'root', foreign.id);
      f.register('foreign-grandchild', 'foreign-child');
      const prepare = vi.spyOn(f.database.raw, 'prepare');
      const records = f.database.sessionTreeRecords(f.workspace.id, 'root');
      expect(records).toHaveLength(1002);
      expect(records[0]?.id).toBe('root');
      expect(records[1]?.id).toBe('child-0');
      expect(records.at(-1)?.id).toBe('grandchild');
      expect(records.some((record) => record.id.startsWith('foreign-'))).toBe(false);
      // Protect both the statement budget and indexed lookups, not elapsed wall time.
      expect(prepare.mock.calls.length).toBeLessThanOrEqual(2);
      const sql = prepare.mock.calls[0]![0];
      prepare.mockRestore();
      const plan = f.database.raw
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(f.workspace.id, 'root', f.workspace.id);
      expect(plan).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            detail: expect.stringMatching(/SEARCH .*workspace_id=\? AND parent_session_id=\?/)
          })
        ])
      );
      expect(plan.some((row) => /^SCAN (child|session)\b/.test(String(row['detail'])))).toBe(false);
      expect(() => f.database.sessionTreeRecords(foreign.id, 'root')).toThrow('SESSION_NOT_FOUND');
      expect(() => f.database.sessionTreeRecords(f.workspace.id, 'missing')).toThrow(
        'SESSION_NOT_FOUND'
      );
    } finally {
      f.database.close();
    }
  });

  it('rejects cyclic registered relationships instead of hanging or returning a partial tree', () => {
    const f = fixture();
    try {
      f.register('child', 'root');
      f.database.raw
        .prepare('UPDATE agent_sessions SET parent_session_id = ? WHERE id = ?')
        .run('child', 'root');
      expect(() => f.database.sessionTreeRecords(f.workspace.id, 'root')).toThrow(
        'SESSION_RELATION_INVALID'
      );
    } finally {
      f.database.close();
    }
  });
});
