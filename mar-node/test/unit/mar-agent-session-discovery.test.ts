import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JsonlSessionStore } from '../../../mar-agent/src/session/store/index.js';
import { NodeDatabase } from '../../src/database.js';
import { NodeRuntimeState } from '../../src/runtime-state.js';
import { unavailableCapabilities } from '../../src/capabilities.js';
import { CommandStateStore } from '../../src/runner-command-engine.js';
import { MarAgentRunner } from '../../src/runner/mar-agent-runner.js';
import { RunnerRegistry } from '../../src/runner/runner-registry.js';
import { NativeSessionProjectionService } from '../../src/session/native-session-projection-service.js';
import { SessionCatalogService } from '../../src/session/session-catalog-service.js';

const reads = vi.hoisted(() => ({
  snapshots: 0,
  pages: 0,
  active: 0,
  peak: 0,
  activeAtClose: 0,
  metadataFailureId: undefined as string | undefined,
  failure: undefined as Error | undefined
}));

vi.mock('@myagentroam/agent', async (importOriginal) => {
  const sdk = await importOriginal<typeof import('@myagentroam/agent')>();
  return {
    ...sdk,
    openAgentSessionCatalog: async (input: Parameters<typeof sdk.openAgentSessionCatalog>[0]) => {
      const catalog = await sdk.openAgentSessionCatalog(input);
      return {
        ...catalog,
        list: async (input: Parameters<typeof catalog.list>[0]) => {
          reads.pages++;
          return catalog.list(input);
        },
        listSnapshot: async () => {
          reads.snapshots++;
          if (reads.failure) throw reads.failure;
          return catalog.listSnapshot();
        },
        executionConfiguration: async (id: string) => {
          reads.active++;
          reads.peak = Math.max(reads.peak, reads.active);
          try {
            if (id === reads.metadataFailureId) throw new Error('Metadata unavailable');
            return await catalog.executionConfiguration(id);
          } finally {
            reads.active--;
          }
        },
        close: async () => {
          reads.activeAtClose = reads.active;
          return catalog.close();
        }
      };
    }
  };
});

beforeEach(() => {
  Object.assign(reads, {
    snapshots: 0,
    pages: 0,
    active: 0,
    peak: 0,
    activeAtClose: 0,
    metadataFailureId: undefined,
    failure: undefined
  });
});

describe('MAR Agent complete session discovery', () => {
  it.each([false, true])(
    'retains older parent and child activity beyond the first native page (cleanup=%s)',
    async (cleanup) => {
      const home = await mkdtemp(join(tmpdir(), 'mar-agent-discovery-pages-'));
      const database = new NodeDatabase(':memory:', 'mar-agent-discovery-pages');
      try {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-11-04T00:00:00.000Z'));
        const workspace = database.saveWorkspace({
          path: join(home, 'workspace'),
          kind: 'DIRECTORY',
          gitSummary: null
        });
        const otherPath = join(home, 'other');
        const store = await JsonlSessionStore.open(home);
        let parent;
        let child;
        try {
          parent = await store.createSession({ title: 'Parent', workspace: workspace.path });
          child = await store.createSession({
            title: 'Child',
            workspace: workspace.path,
            source: { type: 'user', parentSessionId: parent.id }
          });
          vi.setSystemTime(new Date('2026-11-04T01:00:00.000Z'));
          for (let index = 0; index < 200; index++)
            await store.createSession({
              title: `Newer ${index}`,
              workspace: index % 2 === 0 ? workspace.path : otherPath
            });
          const firstPage = await store.list({ limit: 200 });
          expect(firstPage.nextCursor).toEqual(expect.any(String));
          expect(firstPage.sessions.map((session) => session.id)).not.toContain(parent.id);
          expect(firstPage.sessions.map((session) => session.id)).not.toContain(child.id);
        } finally {
          await store.close();
        }

        const runtime = new NodeRuntimeState(
          () => 'node',
          (id) => database.getWorkspace(id)
        );
        const runners = new RunnerRegistry([new MarAgentRunner(home)]);
        const projection = new NativeSessionProjectionService({
          database: () => database,
          nodeId: () => 'node',
          runtime,
          runners,
          capabilities: unavailableCapabilities,
          commands: new CommandStateStore(),
          releaseResumeState: () => undefined,
          present: (session) => ({
            ...session,
            control: { level: 'MANAGED', capabilities: ['history.read'] }
          })
        });
        const discovered = await projection.discover('mar-agent', workspace.id, cleanup);
        expect(reads.snapshots).toBe(1);
        expect(reads.pages).toBe(0);
        expect(reads.active).toBe(0);
        expect(reads.peak).toBeLessThanOrEqual(8);
        expect(discovered).toHaveLength(102);
        expect(discovered.every((session) => session.workspaceId === workspace.id)).toBe(true);
        expect(discovered).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: parent.id,
              lastActivityAt: Date.parse(parent.lastActivityAt)
            }),
            expect.objectContaining({
              id: child.id,
              parentSessionId: parent.id,
              lastActivityAt: Date.parse(child.lastActivityAt)
            })
          ])
        );
        if (cleanup) return;

        const discovery = vi.fn(async () => discovered);
        const history = vi.fn(async () => ({ turns: [], nextCursor: null }));
        const catalog = new SessionCatalogService({
          database: () => database,
          nodeId: () => 'node',
          runtime,
          runners,
          projection,
          runnerAvailable: () => true,
          cachedNative: () => projection.cachedNative(),
          cachedWorkspace: discovery,
          discoverWorkspace: discovery,
          discoveryPending: () => false,
          present: (session) => session,
          nativeIds: (session) => new Set([session.id]),
          forget: () => undefined,
          refreshActivity: async () => undefined,
          externalActivity: () => undefined,
          isWatching: () => false,
          history,
          invalidateHistory: () => undefined,
          invalidateWorkspaceSessions: () => undefined,
          emitSession: () => undefined
        });
        const snapshot = catalog.navigation({
          workspaceId: workspace.id,
          sessionIds: [parent.id],
          summaryAnchors: [child.id],
          treeAnchor: child.id,
          limit: 100
        });
        expect(snapshot.tree?.parent).toMatchObject({
          id: parent.id,
          lastActivityAt: Date.parse(parent.lastActivityAt)
        });
        expect(
          catalog.navigation({
            workspaceId: workspace.id,
            sessionIds: [],
            summaryAnchors: [parent.id],
            treeAnchor: parent.id,
            limit: 100
          }).tree?.nodes
        ).toEqual([
          expect.objectContaining({
            id: child.id,
            lastActivityAt: Date.parse(child.lastActivityAt)
          })
        ]);
        expect(discovery).not.toHaveBeenCalled();
        expect(history).not.toHaveBeenCalled();

        const cached = projection.cachedNative();
        const failure = new Error('Catalog snapshot unavailable');
        reads.failure = failure;
        await expect(projection.discover('mar-agent', workspace.id)).rejects.toBe(failure);
        expect(projection.cachedNative()).toEqual(cached);
        reads.failure = undefined;
        reads.metadataFailureId = parent.id;
        await expect(projection.discover('mar-agent', workspace.id)).rejects.toThrow(
          'Metadata unavailable'
        );
        expect(reads.activeAtClose).toBe(0);
        expect(reads.active).toBe(0);
        expect(projection.cachedNative()).toEqual(cached);
      } finally {
        vi.useRealTimers();
        database.close();
        await rm(home, { recursive: true, force: true });
      }
    }
  );
});
