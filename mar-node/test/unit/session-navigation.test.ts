import { describe, expect, it, vi } from 'vitest';
import { NodeDatabase } from '../../src/database.js';
import { NodeRuntimeState } from '../../src/runtime-state.js';
import { NativeSessionProjectionService } from '../../src/session/native-session-projection-service.js';
import { SessionCatalogService } from '../../src/session/session-catalog-service.js';
import type { RunnerRegistry } from '../../src/runner/runner-registry.js';

function fixture() {
  const database = new NodeDatabase(':memory:', 'session-navigation');
  const workspace = database.saveWorkspace({
    path: '/navigation',
    kind: 'DIRECTORY',
    gitSummary: null
  });
  const runtime = new NodeRuntimeState(
    () => 'node',
    (id) => database.getWorkspace(id)
  );
  const runners = {} as RunnerRegistry;
  const discovery = vi.fn(async () => []);
  const history = vi.fn(async () => ({ turns: [], nextCursor: null }));
  const catalog = new SessionCatalogService({
    database: () => database,
    nodeId: () => 'node',
    runtime,
    runners,
    projection: new NativeSessionProjectionService({ runtime, runners } as never),
    runnerAvailable: () => true,
    cachedNative: () => [],
    cachedWorkspace: discovery,
    discoverWorkspace: discovery,
    discoveryPending: () => false,
    present: (session) => session,
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
    catalog,
    discovery,
    history,
    register,
    activate,
    navigation
  };
}

describe('Session Navigation bounded tree', () => {
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
        'z-branch',
        'z-grandchild'
      ]);
      expect(snapshot.tree?.nodes[1]?.status).toBe('IDLE');
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
