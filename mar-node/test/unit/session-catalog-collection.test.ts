import { describe, expect, it, vi } from 'vitest';
import { NodeDatabase, type NodeAgentSession } from '../../src/database.js';
import { NodeRuntimeState } from '../../src/runtime-state.js';
import { NativeSessionProjectionService } from '../../src/session/native-session-projection-service.js';
import { SessionCatalogService } from '../../src/session/session-catalog-service.js';
import type { RunnerRegistry } from '../../src/runner/runner-registry.js';

function fixture() {
  const database = new NodeDatabase(':memory:', 'catalog-collection');
  for (const id of ['workspace-a', 'workspace-b'])
    database.saveWorkspace({ id, path: '/' + id, kind: 'DIRECTORY', gitSummary: null });
  const runtime = new NodeRuntimeState(
    () => 'node',
    (id) => database.getWorkspace(id),
    () => 1000
  );
  const aliases = new Map<string, string>();
  const runners = {
    require: () => ({ managedAliasId: (id: string) => aliases.get(id) })
  } as unknown as RunnerRegistry;
  const projection = new NativeSessionProjectionService({ runtime, runners } as never);
  const native: NodeAgentSession[] = [];
  const present = vi.fn((session: NodeAgentSession) => session);
  const discover = vi.fn(async () => native);
  const catalog = new SessionCatalogService({
    database: () => database,
    nodeId: () => 'node',
    runtime,
    runners,
    projection,
    runnerAvailable: () => true,
    cachedNative: () => native,
    cachedWorkspace: async () => native,
    discoverWorkspace: discover,
    discoveryPending: () => false,
    present,
    nativeIds: () => new Set(),
    forget: () => undefined,
    refreshActivity: async () => undefined,
    externalActivity: () => undefined,
    isWatching: () => false,
    history: async () => ({ turns: [], nextCursor: null }),
    invalidateHistory: () => undefined,
    invalidateWorkspaceSessions: () => undefined,
    emitSession: () => undefined
  });
  const create = (workspaceId: string, externalSessionId?: string) =>
    runtime.createAgentSession({
      workspaceId,
      cwd: '/' + workspaceId,
      runner: 'claude-code',
      ...(externalSessionId === undefined
        ? {}
        : { externalSessionId, nativeControl: 'MAR_MANAGED' })
    });
  return { database, runtime, aliases, projection, catalog, native, present, discover, create };
}

describe('Session Catalog collection', () => {
  it('does not rebind a stale managed alias through an unrelated external ID fallback', () => {
    const f = fixture();
    try {
      f.runtime.adoptRun({
        runId: 'unrelated-run',
        sessionId: 'unrelated-managed',
        workspaceId: 'workspace-a',
        runner: 'claude-code',
        cwd: '/workspace-a',
        externalSessionId: 'retired-managed-id'
      });
      f.runtime.setNativeControl('unrelated-managed', 'MAR_MANAGED');
      const unrelated = f.runtime.getAgentSession('unrelated-managed')!;
      f.aliases.set('native-alias', 'retired-managed-id');
      const candidate = { ...unrelated, id: 'native:alias', externalSessionId: 'native-alias' };
      // General external-ID resolution remains available outside verified alias ownership.
      expect(f.runtime.getAgentSession('retired-managed-id')?.id).toBe('unrelated-managed');
      expect(f.projection.managedForNative(candidate)).toBeUndefined();
      expect(f.projection.projectionForNative(candidate)).toBeUndefined();
      expect(f.projection.projectionsForNative([candidate]).get(candidate)).toBeUndefined();
    } finally {
      f.database.close();
    }
  });

  it('keeps batch and single projections aligned across Workspace collisions and verified aliases', () => {
    const f = fixture();
    try {
      f.runtime.adoptRun({
        runId: 'run-a',
        sessionId: 'managed-a',
        workspaceId: 'workspace-a',
        runner: 'claude-code',
        cwd: '/workspace-a',
        externalSessionId: 'shared'
      });
      f.runtime.adoptRun({
        runId: 'run-b',
        sessionId: 'managed-b',
        workspaceId: 'workspace-b',
        runner: 'claude-code',
        cwd: '/workspace-b',
        externalSessionId: 'shared'
      });
      f.runtime.setNativeControl('managed-a', 'MAR_MANAGED');
      f.runtime.setNativeControl('managed-b', 'MAR_MANAGED');
      const b = f.runtime.getAgentSession('managed-b')!;
      const direct = { ...b, id: 'native:shared', nativeControl: 'EXTERNAL' as const };
      const aliasTarget = f.create('workspace-b');
      const previousId = aliasTarget.id;
      f.runtime.promoteSessionIdentity(previousId, 'promoted-target');
      f.aliases.set('verified-alias', previousId);
      const alias = { ...direct, id: 'native:alias', externalSessionId: 'verified-alias' };
      const wrongWorkspace = { ...alias, workspaceId: 'workspace-a' };
      const candidates = [direct, alias, wrongWorkspace, { ...direct, runner: 'codex' as const }];
      const batch = f.projection.projectionsForNative(candidates);
      expect(batch.get(direct)?.id).toBe('managed-b');
      expect(batch.get(alias)?.id).toBe('promoted-target');
      expect(batch.get(wrongWorkspace)).toBeUndefined();
      expect(batch.get(candidates[3]!)).toBeUndefined();
      for (const candidate of candidates)
        expect(f.projection.projectionForNative(candidate)).toEqual(batch.get(candidate));
    } finally {
      f.database.close();
    }
  });

  it('filters Workspace candidates before presentation and preserves first source and synchronized title', async () => {
    const f = fixture();
    try {
      const managed = f.create('workspace-a', 'managed');
      const foreign = f.create('workspace-b', 'foreign');
      f.native.push(
        {
          ...managed,
          id: 'native:first',
          runnerTitle: 'Official title',
          titleSource: 'RUNNER',
          pinnedAt: 1,
          pinOrder: 2
        },
        {
          ...managed,
          id: 'native:second',
          runnerTitle: 'Wrong later title',
          titleSource: 'RUNNER',
          pinOrder: 9
        },
        { ...foreign, id: 'native:foreign' }
      );
      const result = await f.catalog.operations()['session.list']!({
        workspaceId: 'workspace-a',
        registeredOnly: true
      });
      expect(result).toMatchObject({
        sessions: [{ id: managed.id, runnerTitle: 'Official title', pinOrder: 2 }]
      });
      expect(f.runtime.getAgentSession(managed.id)?.runnerTitle).toBe('Official title');
      expect(f.present.mock.calls.every(([session]) => session.workspaceId === 'workspace-a')).toBe(
        true
      );
      expect(f.discover).not.toHaveBeenCalled();
    } finally {
      f.database.close();
    }
  });

  it('keeps the mixed default list and counts active sessions before query, group, and paging', async () => {
    const f = fixture();
    const active = new Set(['main-active', 'child-active']);
    f.present.mockImplementation((session) => ({
      ...session,
      activity: active.has(session.id) ? 'MANAGED_ACTIVE' : 'IDLE'
    }));
    const create = (
      id: string,
      parentSessionId: string | null,
      customTitle: string
    ): NodeAgentSession =>
      f.runtime.createAgentSession({
        workspaceId: 'workspace-a',
        cwd: '/workspace-a',
        runner: 'claude-code',
        externalSessionId: id,
        parentSessionId,
        customTitle
      });
    try {
      create('main-active', null, 'Hidden running main');
      create('child-active', 'missing-parent', 'Hidden running child');
      create('main-visible', null, 'Visible main');
      create('grandchild-visible', 'child-active', 'Visible child');

      const list = f.catalog.operations()['session.list']!;
      const mixed = (await list({ workspaceId: 'workspace-a', registeredOnly: true })) as {
        sessions: NodeAgentSession[];
        runningCounts: { MAIN: number; CHILD: number };
      };
      expect(mixed.sessions.map(({ id }) => id)).toHaveLength(4);
      expect(mixed.sessions.map(({ id }) => id)).toEqual(
        expect.arrayContaining([
          'main-active',
          'child-active',
          'main-visible',
          'grandchild-visible'
        ])
      );
      expect(mixed.runningCounts).toEqual({ MAIN: 1, CHILD: 1 });

      const mainPage = (await list({
        workspaceId: 'workspace-a',
        registeredOnly: true,
        query: 'visible',
        sessionGroup: 'MAIN',
        limit: 1
      })) as { sessions: NodeAgentSession[]; runningCounts: { MAIN: number; CHILD: number } };
      expect(mainPage.sessions.map(({ id }) => id)).toEqual(['main-visible']);
      expect(mainPage.runningCounts).toEqual({ MAIN: 1, CHILD: 1 });

      const childPage = (await list({
        workspaceId: 'workspace-a',
        registeredOnly: true,
        query: 'visible',
        sessionGroup: 'CHILD',
        limit: 1
      })) as { sessions: NodeAgentSession[] };
      expect(childPage.sessions.map(({ id }) => id)).toEqual(['grandchild-visible']);

      const marctl = (await list({
        workspaceId: 'workspace-a',
        registeredOnly: true,
        view: 'marctl',
        parentSessionId: 'missing-parent'
      })) as { view: string; sessions: NodeAgentSession[]; nextCursor: string | null };
      expect(Object.keys(marctl).sort()).toEqual(['nextCursor', 'sessions', 'view']);
      expect(marctl.sessions.map(({ id }) => id)).toEqual(['child-active']);
      expect(marctl.sessions[0]).not.toHaveProperty('sessionGroup');
      expect(marctl.sessions[0]).not.toHaveProperty('runningCounts');
    } finally {
      f.database.close();
    }
  });

  it.each([20, 80])(
    'builds one request-local lookup instead of scanning for each of %s candidates',
    (size) => {
      const f = fixture();
      try {
        let reads = 0;
        for (let index = 0; index < size; index++) {
          const session = f.create('workspace-a', 'external-' + index);
          const external = session.externalSessionId;
          Object.defineProperty(session, 'externalSessionId', {
            get() {
              reads++;
              return external;
            }
          });
          f.native.push({ ...session, id: 'native:' + index });
          f.native.push({
            ...session,
            id: 'missing:' + index,
            externalSessionId: 'missing-' + index
          });
        }
        reads = 0;
        const batch = f.projection.projectionsForNative(f.native);
        expect(batch.size).toBe(size * 2);
        expect([...batch.values()].filter(Boolean)).toHaveLength(size);
        expect(reads).toBeLessThan(size * 12);
      } finally {
        f.database.close();
      }
    }
  );
});
