import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CodexAppServerClient } from '../../src/codex-app-server.js';
import { NodeConnector } from '../../src/connector.js';
import type { NativeSessionProjectionService } from '../../src/service/native-session-projection-service.js';
import type { ExternalSessionResumeService } from '../../src/service/external-session-resume-service.js';
import { NodeDatabase, type NodeAgentSession } from '../../src/database.js';
import { NodeRuntimeState } from '../../src/runtime-state.js';
import { SessionCatalogService } from '../../src/service/session-catalog-service.js';
import type { RunnerRegistry } from '../../src/runner/runner-registry.js';
import { capabilities, codexProfileClientFactory } from './support/codex-connector.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Node session records and external discovery merge', () => {
  it('rejects message admission through promoted aliases while native deletion is pending', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-remove-admission-'));
    const database = new NodeDatabase(':memory:', 'connector-remove-admission');
    const workspace = database.saveWorkspace({ path: root, kind: 'DIRECTORY', gitSummary: null });
    const client = {
      onNotification: () => () => undefined,
      start: async () => undefined,
      stop: () => undefined,
      configureEnvironment: () => undefined,
      clearEnvironment: () => undefined
    } as unknown as CodexAppServerClient;
    const connector = new NodeConnector({
      reconnect: false,
      database,
      capabilities: capabilities(),
      codexClient: client,
      codexRunClientFactory: () => client,
      codexProfileClientFactory
    });
    const node = connector as unknown as {
      runtime: NodeRuntimeState;
      runners: RunnerRegistry;
      executeNodeOperation(operation: string, data: unknown): Promise<unknown>;
    };
    const bootstrap = node.runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'codex',
      cwd: root
    });
    const target = node.runtime.promoteSessionIdentity(bootstrap.id, 'remove-admission-native');
    database.saveNativeSessionMetadata({
      runner: target.runner,
      workspaceId: workspace.id,
      externalSessionId: target.externalSessionId!
    });
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const removeNative = vi
      .spyOn(node.runners.require('codex'), 'removeNative')
      .mockImplementation(async () => {
        enter();
        await gate;
        return true;
      });
    let pending: Promise<unknown> | undefined;
    try {
      await node.executeNodeOperation('runner.profiles.list', {});
      pending = node.executeNodeOperation('session.remove', { sessionId: bootstrap.id });
      void pending.catch(() => undefined);
      await entered;
      for (const deliveryIntent of ['SEND', 'QUEUE']) {
        await expect(
          node.executeNodeOperation('session.message', {
            sessionId: bootstrap.id,
            clientMessageId: `during-remove-${deliveryIntent}`,
            content: 'must not be accepted',
            deliveryIntent
          })
        ).rejects.toThrow('SESSION_ACTIVE');
      }
      expect(node.runtime.listRunsForSession(target.id)).toEqual([]);
      expect(node.runtime.sessionQueue(target.id).itemIds).toEqual([]);
      expect(database.getSessionRecord(target.id)).toBeDefined();
      release();
      await expect(pending).resolves.toEqual({ deleted: true });
      expect(node.runtime.getAgentSession(bootstrap.id)).toBeUndefined();
      expect(node.runtime.getAgentSession(target.id)).toBeUndefined();
      expect(database.getSessionRecord(target.id)).toBeUndefined();
    } finally {
      release();
      await pending?.catch(() => undefined);
      removeNative.mockRestore();
      await connector.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['mar-agent', 'codex', 'claude-code', 'opencode'] as const)(
    'merges partial Session configuration without changing access or defaults (%s)',
    async (runner) => {
      const database = new NodeDatabase(':memory:', 'partial-config');
      const workspace = database.saveWorkspace({
        path: '/partial-config',
        kind: 'DIRECTORY',
        gitSummary: null
      });
      const connector = new NodeConnector({ reconnect: false, database });
      const internals = connector as unknown as {
        runtime: NodeRuntimeState;
        executeNodeOperation(operation: string, data: unknown): Promise<unknown>;
      };
      const access = runner === 'mar-agent' ? 'auto' : 'read-only';
      const session = internals.runtime.createAgentSession({
        workspaceId: workspace.id,
        runner,
        cwd: workspace.path,
        externalSessionId: 'native-partial-config',
        model: 'original-model',
        effort: 'high',
        access
      });
      const update = (fields: Record<string, unknown>) =>
        internals.executeNodeOperation('session.config.update', {
          sessionId: session.id,
          workspaceId: workspace.id,
          ...fields
        });
      const defaults = database.getRunnerDefaults();
      try {
        await expect(update({ model: 'next-model' })).resolves.toMatchObject({
          session: { model: 'next-model', effort: 'high', access }
        });
        await expect(update({ effort: '' })).resolves.toMatchObject({
          session: { model: 'next-model', effort: '', access }
        });
        expect(database.getSessionRecord(session.id)?.metadata).toMatchObject({
          model: 'next-model',
          effort: '',
          access
        });
        internals.runtime.removeAgentSession(session.id);
        await expect(update({ effort: 'low' })).resolves.toMatchObject({
          session: { model: 'next-model', effort: 'low', access }
        });
        expect(database.getRunnerDefaults()).toEqual(defaults);
        for (const fields of [
          {},
          { model: '' },
          { effort: null },
          { model: 'x'.repeat(121) },
          { workspaceId: 'foreign', model: 'denied' },
          ...(runner === 'mar-agent' ? [{ access: 'read-only' }] : [])
        ]) {
          await expect(update(fields)).rejects.toThrow();
        }
        expect(database.getSessionRecord(session.id)?.metadata).toMatchObject({
          model: 'next-model',
          effort: 'low',
          access
        });
        const bootstrap = internals.runtime.createAgentSession({
          workspaceId: workspace.id,
          runner,
          cwd: workspace.path
        });
        await expect(
          internals.executeNodeOperation('session.config.update', {
            sessionId: bootstrap.id,
            model: 'chosen'
          })
        ).resolves.toMatchObject({ session: { model: 'chosen', effort: null, access: null } });
      } finally {
        await connector.stop();
      }
    }
  );

  it('caps graphs and filters direct children before cursor pagination', async () => {
    const database = new NodeDatabase(':memory:', 'bounded-graph');
    const workspace = database.saveWorkspace({
      path: '/bounded-graph',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    database.saveNativeSessionMetadata({
      runner: 'codex',
      externalSessionId: 'root',
      workspaceId: workspace.id,
      pinned: true
    });
    for (let index = 0; index < 101; index += 1)
      database.saveNativeSessionMetadata({
        runner: 'codex',
        externalSessionId: 'child-' + index,
        workspaceId: workspace.id,
        parentSessionId: 'root'
      });
    const connector = new NodeConnector({ reconnect: false, database });
    const execute = (
      connector as unknown as {
        executeNodeOperation(operation: string, data: unknown): Promise<unknown>;
      }
    ).executeNodeOperation.bind(connector);
    try {
      const graph = (await execute('session.graph', {
        workspaceId: workspace.id,
        sessionId: 'root'
      })) as { nodes: { id: string }[]; truncated: boolean };
      expect(graph.nodes).toHaveLength(100);
      expect(graph.nodes[0]?.id).toBe('root');
      expect(graph.truncated).toBe(true);
      const page = (cursor?: string) =>
        execute('session.list', {
          workspaceId: workspace.id,
          registeredOnly: true,
          parentSessionId: 'root',
          limit: 1,
          ...(cursor === undefined ? {} : { cursor })
        }) as Promise<{ sessions: NodeAgentSession[]; nextCursor: string | null }>;
      const first = await page();
      expect(first.sessions).toHaveLength(1);
      expect(first.sessions[0]?.parentSessionId).toBe('root');
      expect(first.nextCursor).not.toBeNull();
      const second = await page(first.nextCursor!);
      expect(second.sessions[0]?.parentSessionId).toBe('root');
      expect(second.sessions[0]?.id).not.toBe(first.sessions[0]?.id);
      for (const limit of [0, 101, 1.5])
        await expect(
          execute('session.graph', { workspaceId: workspace.id, sessionId: 'root', limit })
        ).rejects.toThrow('SESSION_INVALID');
    } finally {
      await connector.stop();
    }
  });
  it('records canonical creation parents and reads bounded local descendants without discovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mar-session-parents-'));
    roots.push(root);
    const database = new NodeDatabase(':memory:', 'parent-test');
    const workspace = database.saveWorkspace({
      path: root,
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({ reconnect: false, database });
    const execute = (
      connector as unknown as {
        executeNodeOperation(operation: string, data: unknown): Promise<unknown>;
      }
    ).executeNodeOperation.bind(connector);
    const internals = connector as unknown as {
      runtime: NodeRuntimeState;
      nativeSessionProjectionService: NativeSessionProjectionService;
      sessionIdentityService: { promote(id: string, nativeId: string): void };
    };
    const discovery = vi.spyOn(internals.nativeSessionProjectionService, 'list');
    try {
      database.saveNativeSessionMetadata({
        runner: 'codex',
        externalSessionId: 'coordinator',
        workspaceId: workspace.id,
        customTitle: 'Coordinator#1'
      });
      const create = async (parentSessionId: string) =>
        (await execute('session.create', {
          workspaceId: workspace.id,
          runner: 'codex',
          cwd: workspace.path,
          model: 'test-model',
          effort: 'high',
          access: 'read-only',
          parentSessionId
        })) as { session: NodeAgentSession };
      const child = await create('coordinator');
      expect(child.session.parentSessionId).toBe('coordinator');
      internals.sessionIdentityService.promote(child.session.id, 'fixer');
      const grandchild = await create(child.session.id);
      expect(grandchild.session.parentSessionId).toBe('fixer');
      internals.sessionIdentityService.promote(grandchild.session.id, 'reviewer');
      expect(database.getSessionRecord('fixer')?.metadata.parentSessionId).toBe('coordinator');
      internals.runtime.removeAgentSession('fixer');
      internals.runtime.removeAgentSession('reviewer');
      const foreign = database.saveWorkspace({
        path: '/workspace/foreign',
        kind: 'DIRECTORY',
        gitSummary: null
      });
      database.saveNativeSessionMetadata({
        runner: 'codex',
        externalSessionId: 'foreign-child',
        workspaceId: foreign.id,
        parentSessionId: 'coordinator'
      });
      const graph = (await execute('session.graph', {
        workspaceId: workspace.id,
        sessionId: 'coordinator'
      })) as {
        rootSessionId: string;
        nodes: { id: string; parentSessionId: string | null }[];
        truncated: boolean;
      };
      expect(graph.rootSessionId).toBe('coordinator');
      expect(graph.nodes.map(({ id, parentSessionId }) => ({ id, parentSessionId }))).toEqual([
        { id: 'coordinator', parentSessionId: null },
        { id: 'fixer', parentSessionId: 'coordinator' },
        { id: 'reviewer', parentSessionId: 'fixer' }
      ]);
      expect(graph.truncated).toBe(false);
      expect(graph.nodes[0]).toHaveProperty('activity', 'IDLE');
      expect(graph.nodes[0]).not.toHaveProperty('sessionPrompt');
      const limited = (await execute('session.graph', {
        workspaceId: workspace.id,
        sessionId: 'coordinator',
        limit: 2
      })) as { nodes: unknown[]; truncated: boolean };
      expect(limited.nodes).toHaveLength(2);
      expect(limited.truncated).toBe(true);
      const list = () =>
        execute('session.list', {
          workspaceId: workspace.id,
          registeredOnly: true,
          parentSessionId: 'coordinator',
          limit: 1
        }) as Promise<{ sessions: NodeAgentSession[] }>;
      expect((await list()).sessions.map(({ id }) => id)).toEqual(['fixer']);
      for (const parent of ['missing', 'foreign-child'])
        await expect(create(parent)).rejects.toThrow('SESSION_NOT_FOUND');
      const bootstrap = internals.runtime.createAgentSession({
        workspaceId: workspace.id,
        runner: 'codex',
        cwd: workspace.path
      });
      await expect(create(bootstrap.id)).rejects.toThrow('SESSION_ACTIVATION_REQUIRED');
      await expect(
        execute('session.graph', { workspaceId: foreign.id, sessionId: 'coordinator' })
      ).rejects.toThrow('SESSION_NOT_FOUND');
      database.deleteSessionRecord('coordinator');
      expect((await list()).sessions.map(({ id }) => id)).toEqual(['fixer']);
      expect(database.getSessionRecord('fixer')?.metadata.parentSessionId).toBe('coordinator');
      expect(discovery).not.toHaveBeenCalled();
    } finally {
      await connector.stop();
    }
  });
  it('registers successful native discovery without rewriting unchanged or user-owned metadata', async () => {
    const database = new NodeDatabase(':memory:', 'node-register-discovery');
    const workspace = database.saveWorkspace({
      path: '/workspace/register',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({ reconnect: false, database });
    const internals = connector as unknown as {
      runners: RunnerRegistry;
      nativeSessionProjectionService: NativeSessionProjectionService;
    };
    const projection = internals.nativeSessionProjectionService;
    const runner = internals.runners.require('codex');
    vi.spyOn(runner, 'available').mockReturnValue(true);
    let title = 'First discovered title';
    vi.spyOn(runner, 'discoverSessions').mockImplementation(async () => [
      projection.project({
        workspace,
        runner: 'codex',
        externalSessionId: 'registered-native',
        cwd: workspace.path,
        title,
        titleOrigin: 'OFFICIAL'
      })
    ]);
    try {
      await projection.discover('codex', workspace.id);
      expect(database.getSessionRecord('registered-native')?.metadata.runnerTitle).toBe(title);
      database.saveNativeSessionMetadata({
        runner: 'codex',
        externalSessionId: 'registered-native',
        workspaceId: workspace.id,
        customTitle: 'User title',
        sessionPrompt: 'User instructions',
        pinned: true,
        model: 'model',
        effort: 'high',
        access: 'on-request'
      });
      title = 'Updated native title';
      await projection.discover('codex', workspace.id);
      expect(database.getSessionRecord('registered-native')).toMatchObject({
        pinOrder: 0,
        metadata: {
          runnerTitle: title,
          customTitle: 'User title',
          sessionPrompt: 'User instructions',
          model: 'model',
          effort: 'high',
          access: 'on-request'
        }
      });
      const write = vi.spyOn(database, 'saveNativeSessionMetadata');
      await projection.discover('codex', workspace.id);
      expect(write).not.toHaveBeenCalled();
      title = 'A'.repeat(200);
      await projection.discover('codex', workspace.id);
      expect(database.getSessionRecord('registered-native')?.metadata.runnerTitle).toHaveLength(
        160
      );
      database.saveNativeSessionMetadata({
        runner: 'codex',
        externalSessionId: 'registered-native',
        workspaceId: workspace.id,
        runnerTitle: 'Pending user rename',
        runnerTitlePending: true
      });
      write.mockClear();
      await projection.discover('codex', workspace.id);
      expect(database.getSessionRecord('registered-native')?.metadata).toMatchObject({
        runnerTitle: 'Pending user rename',
        runnerTitlePending: true
      });
      expect(write).not.toHaveBeenCalled();
    } finally {
      await connector.stop();
    }
  });

  it('lists, searches and resolves registered Sessions without discovery and scopes typo hints', async () => {
    const database = new NodeDatabase(':memory:', 'node-registered-only');
    const workspace = database.saveWorkspace({
      path: '/workspace/local-only',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const foreign = database.saveWorkspace({
      path: '/workspace/foreign-only',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const ids = ['1', '2', '3', '4'].map(
      (suffix) => 'b2191a41-fe60-4216-b7c5-f1b1ed92b3a' + suffix
    );
    for (const [index, id] of ids.entries())
      database.saveNativeSessionMetadata({
        runner: 'codex',
        externalSessionId: id,
        workspaceId: workspace.id,
        customTitle: 'fixer#CASE ' + index,
        pinned: index === 3
      });
    database.saveNativeSessionMetadata({
      runner: 'codex',
      externalSessionId: 'b2191a41-fe60-4216-b7c5-f1b1ed92b3a0',
      workspaceId: foreign.id,
      customTitle: 'PRIVATE foreign title'
    });
    const connector = new NodeConnector({ reconnect: false, database });
    const internals = connector as unknown as {
      nativeSessionProjectionService: NativeSessionProjectionService;
      runtime: NodeRuntimeState;
      sessionIdentityService: { promote(previousId: string, nativeId: string): void };
      executeNodeOperation(operation: string, data: unknown): Promise<unknown>;
    };
    const scan = vi
      .spyOn(internals.nativeSessionProjectionService, 'list')
      .mockRejectedValue(new Error('Unexpected native scan'));
    const discover = vi
      .spyOn(internals.nativeSessionProjectionService, 'discoverWorkspace')
      .mockRejectedValue(new Error('Unexpected workspace discovery'));
    const data = { workspaceId: workspace.id, registeredOnly: true };
    try {
      const created = internals.runtime.createAgentSession({
        workspaceId: workspace.id,
        runner: 'codex',
        cwd: workspace.path,
        customTitle: 'fixer#IDENTITY Keep this title',
        title: 'Temporary title'
      });
      internals.sessionIdentityService.promote(created.id, 'registered-promoted');
      expect(database.getSessionRecord('registered-promoted')).toMatchObject({
        metadata: { customTitle: 'fixer#IDENTITY Keep this title', runnerTitle: 'Temporary title' }
      });
      const page = (await internals.executeNodeOperation('session.list', {
        ...data,
        query: 'FIXER#case',
        limit: 1
      })) as { sessions: NodeAgentSession[]; nextCursor: string };
      expect(page.sessions.map((session) => session.id)).toEqual([ids[3]]);
      expect(page.sessions[0]?.externalDiscovered).toBe(false);
      const next = (await internals.executeNodeOperation('session.list', {
        ...data,
        query: 'FIXER#case',
        limit: 3,
        cursor: page.nextCursor
      })) as { sessions: NodeAgentSession[] };
      expect(next.sessions).toHaveLength(3);
      await expect(
        internals.executeNodeOperation('session.get', { ...data, sessionId: ids[0] })
      ).resolves.toMatchObject({ session: { id: ids[0], customTitle: 'fixer#CASE 0' } });
      await expect(
        internals.nativeSessionProjectionService.resolve(ids[0]!)
      ).resolves.toMatchObject({ id: ids[0] });
      const missing = (await internals
        .executeNodeOperation('session.get', {
          ...data,
          sessionId: 'b2191a41-fe60-4216-b7c5-f1b1ed92b3ax'
        })
        .catch((error: unknown) => error)) as Error & { publicDetails: string };
      expect(missing.message).toBe('SESSION_NOT_FOUND');
      expect(missing.publicDetails).toContain(ids[0] + ' fixer#CASE 0');
      expect(missing.publicDetails.split(String.fromCharCode(10)).slice(1)).toHaveLength(3);
      expect(missing.publicDetails).not.toContain('PRIVATE');
      await expect(
        internals.executeNodeOperation('session.get', {
          ...data,
          sessionId: 'b2191a41-fe60-4216-b7c5-f1b1ed92b3a0'
        })
      ).rejects.toThrow('SESSION_NOT_FOUND');
      const threeTypos = (await internals
        .executeNodeOperation('session.get', {
          ...data,
          sessionId: ids[0]!.replace('b2191a41-fe60-4216', 'b2181a41-fe61-4217')
        })
        .catch((error: unknown) => error)) as Error & { publicDetails: string };
      expect(threeTypos.publicDetails).toContain(ids[0]!);
      await expect(
        internals.executeNodeOperation('session.get', {
          ...data,
          sessionId: 'completely-unrelated'
        })
      ).rejects.toMatchObject({ message: 'SESSION_NOT_FOUND', publicDetails: undefined });
      const projection = internals.nativeSessionProjectionService;
      projection.remember(
        ids.map((id) =>
          projection.project({
            workspace,
            runner: 'codex',
            externalSessionId: id,
            cwd: workspace.path,
            title: 'Cached native title'
          })
        )
      );
      database.saveNativeSessionMetadata({
        runner: 'codex',
        externalSessionId: ids[0]!,
        workspaceId: workspace.id,
        pinned: true
      });
      await expect(
        internals.executeNodeOperation('session.list', { ...data, query: 'fixer#case', limit: 1 })
      ).resolves.toMatchObject({ sessions: [{ id: ids[0], pinOrder: 0 }] });
      database.movePinnedSession(ids[3]!, 'up');
      await expect(
        internals.executeNodeOperation('session.list', { ...data, query: 'fixer#case', limit: 1 })
      ).resolves.toMatchObject({ sessions: [{ id: ids[3], pinOrder: 0 }] });
      expect(scan).not.toHaveBeenCalled();
      expect(discover).not.toHaveBeenCalled();
    } finally {
      await connector.stop();
    }
  });

  it('continues publishing successful Runner discovery after another Runner fails', async () => {
    const database = new NodeDatabase(':memory:', 'node-independent-discovery-failure');
    const workspace = database.saveWorkspace({
      path: '/workspace/independent-discovery-failure',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({ reconnect: false, database });
    const internals = connector as unknown as {
      runners: RunnerRegistry;
      nativeSessionProjectionService: NativeSessionProjectionService;
    };
    for (const runner of internals.runners.advertised())
      vi.spyOn(runner, 'available').mockReturnValue(true);
    let finish!: (sessions: readonly NodeAgentSession[]) => void;
    vi.spyOn(internals.nativeSessionProjectionService, 'discover').mockImplementation((runner) => {
      if (runner === 'codex') return Promise.reject(new Error('Runner discovery failed'));
      if (runner === 'mar-agent') return new Promise((resolve) => (finish = resolve));
      return Promise.resolve([]);
    });
    const onBatch = vi.fn();
    const result = internals.nativeSessionProjectionService.discoverWorkspace(
      workspace.id,
      onBatch
    );
    const rejected = vi.fn();
    void result.catch(rejected);
    try {
      await Promise.resolve();
      await Promise.resolve();
      expect(rejected).not.toHaveBeenCalled();
      const session = internals.nativeSessionProjectionService.project({
        workspace,
        runner: 'mar-agent',
        externalSessionId: 'successful-session',
        cwd: workspace.path,
        title: 'Confirmed native title'
      });
      finish([session]);
      await expect(result).rejects.toThrow('Runner discovery failed');
      expect(onBatch).toHaveBeenCalledWith('mar-agent', [session]);
      expect(onBatch).not.toHaveBeenCalledWith('codex', expect.anything());
    } finally {
      finish([]);
      await connector.stop();
    }
  });

  it('returns discovered Runner batches without waiting for a slow Runner or exposing its custom metadata', async () => {
    vi.useFakeTimers();
    const database = new NodeDatabase(':memory:', 'node-progressive-session-titles');
    const workspace = database.saveWorkspace({
      path: '/workspace/progressive-session-titles',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    database.saveNativeSessionMetadata({
      runner: 'claude-code',
      externalSessionId: 'slow-custom',
      workspaceId: workspace.id,
      customTitle: 'My custom title',
      pinned: true
    });
    const connector = new NodeConnector({ reconnect: false, database });
    const internals = connector as unknown as {
      runners: RunnerRegistry;
      nativeSessionProjectionService: NativeSessionProjectionService;
      workspaceWorkbenchService: {
        invalidateTopic(workspaceId: string, topic: 'sessions'): Promise<void>;
      };
      executeNodeOperation(operation: string, data: unknown): Promise<unknown>;
    };
    const finishes = new Map<
      NodeAgentSession['runner'],
      (sessions: readonly NodeAgentSession[]) => void
    >();
    for (const runner of internals.runners.advertised())
      vi.spyOn(runner, 'available').mockReturnValue(true);
    const discover = vi
      .spyOn(internals.nativeSessionProjectionService, 'discover')
      .mockImplementation((runner) => new Promise((resolve) => finishes.set(runner, resolve)));
    const invalidate = vi
      .spyOn(internals.workspaceWorkbenchService, 'invalidateTopic')
      .mockResolvedValue(undefined);
    const native = (runner: NodeAgentSession['runner'], id: string) =>
      internals.nativeSessionProjectionService.project({
        workspace,
        runner,
        externalSessionId: id,
        cwd: workspace.path,
        title: `${runner} native title`,
        titleOrigin: 'OFFICIAL',
        lastActivityAt: 100
      });
    const list = () =>
      internals.executeNodeOperation('session.list', { workspaceId: workspace.id });
    try {
      const first = list();
      const concurrent = list();
      const resolved = vi.fn();
      void first.then(resolved);
      finishes.get('codex')!([]);
      await vi.advanceTimersByTimeAsync(500);
      expect(resolved).not.toHaveBeenCalled();
      finishes.get('mar-agent')!([native('mar-agent', 'fast-native')]);
      for (const result of [first, concurrent])
        await expect(result).resolves.toMatchObject({
          sessions: [
            expect.objectContaining({ id: 'fast-native', runnerTitle: 'mar-agent native title' })
          ]
        });
      expect(invalidate).not.toHaveBeenCalled();
      finishes.get('opencode')!([native('opencode', 'second-native')]);
      await vi.advanceTimersByTimeAsync(0);
      await expect(list()).resolves.toMatchObject({
        sessions: expect.arrayContaining([
          expect.objectContaining({ id: 'fast-native' }),
          expect.objectContaining({ id: 'second-native' })
        ])
      });
      const partial = (await list()) as { sessions: NodeAgentSession[] };
      expect(partial.sessions).toHaveLength(2);
      expect(invalidate).toHaveBeenCalledOnce();
      finishes.get('claude-code')!([native('claude-code', 'slow-custom')]);
      await vi.advanceTimersByTimeAsync(0);
      const complete = (await list()) as { sessions: NodeAgentSession[] };
      expect(complete.sessions).toHaveLength(3);
      expect(complete.sessions[0]).toMatchObject({
        id: 'slow-custom',
        customTitle: 'My custom title',
        titleSource: 'CUSTOM',
        pinOrder: 0,
        runnerTitle: 'claude-code native title',
        externalDiscovered: true
      });
      expect(discover).toHaveBeenCalledTimes(4);
      expect(invalidate).toHaveBeenCalledTimes(3);
    } finally {
      for (const finish of finishes.values()) finish([]);
      await connector.stop();
      vi.useRealTimers();
    }
  });

  it.each(['mar-agent', 'codex', 'claude-code', 'opencode'] as const)(
    'waits for native %s discovery after restart and preserves explicit custom titles',
    async (runner) => {
      vi.useFakeTimers();
      const database = new NodeDatabase(':memory:', 'node-cold-session-titles');
      const workspace = database.saveWorkspace({
        path: '/workspace/cold-session-titles',
        kind: 'DIRECTORY',
        gitSummary: null
      });
      for (const id of ['native-title', 'custom-title', 'missing-record'])
        database.saveNativeSessionMetadata({
          runner,
          externalSessionId: id,
          workspaceId: workspace.id,
          model: 'saved-model',
          ...(id === 'custom-title' ? { customTitle: 'New Session' } : {}),
          ...(id === 'native-title' ? { runnerTitle: 'Stale native title', pinned: true } : {})
        });
      const connector = new NodeConnector({ reconnect: false, database });
      const internals = connector as unknown as {
        nativeSessionProjectionService: NativeSessionProjectionService;
        discoverWorkspaceSessions(workspaceId: string): Promise<readonly NodeAgentSession[]>;
        executeNodeOperation(operation: string, data: unknown): Promise<unknown>;
      };
      let finishDiscovery!: (sessions: readonly NodeAgentSession[]) => void;
      const discover = vi
        .spyOn(internals, 'discoverWorkspaceSessions')
        .mockReturnValue(new Promise((resolve) => (finishDiscovery = resolve)));
      try {
        const first = internals.executeNodeOperation('session.list', {
          workspaceId: workspace.id
        });
        const resolved = vi.fn();
        void first.then(resolved);
        await vi.advanceTimersByTimeAsync(500);
        expect(resolved).not.toHaveBeenCalled();
        finishDiscovery(
          ['native-title', 'custom-title'].map((id) =>
            internals.nativeSessionProjectionService.project({
              workspace,
              runner,
              externalSessionId: id,
              cwd: workspace.path,
              title: 'Actual Runner title',
              titleOrigin: 'OFFICIAL',
              lastActivityAt: 100
            })
          )
        );
        await expect(first).resolves.toMatchObject({
          sessions: expect.arrayContaining([
            expect.objectContaining({
              id: 'custom-title',
              customTitle: 'New Session',
              titleSource: 'CUSTOM',
              externalDiscovered: true
            })
          ])
        });
        await vi.advanceTimersByTimeAsync(0);
        const next = (await internals.executeNodeOperation('session.list', {
          workspaceId: workspace.id
        })) as { sessions: readonly NodeAgentSession[] };
        expect(next.sessions).toHaveLength(3);
        expect(next.sessions.find((session) => session.id === 'native-title')).toMatchObject({
          customTitle: null,
          runnerTitle: 'Actual Runner title',
          titleSource: 'RUNNER',
          pinOrder: 0,
          model: 'saved-model',
          externalDiscovered: true
        });
        expect(next.sessions.find((session) => session.id === 'custom-title')).toMatchObject({
          customTitle: 'New Session',
          runnerTitle: 'Actual Runner title',
          titleSource: 'CUSTOM'
        });
        expect(next.sessions.find((session) => session.id === 'missing-record')).toMatchObject({
          externalDiscovered: false
        });
        expect(discover).toHaveBeenCalledOnce();
      } finally {
        finishDiscovery([]);
        await connector.stop();
        vi.useRealTimers();
      }
    }
  );

  it.each(
    (['mar-agent', 'codex', 'claude-code', 'opencode'] as const).flatMap((runner) =>
      [Date.parse('2026-09-29T10:29:28.787Z'), 0].map((lastActivityAt) => ({
        runner,
        lastActivityAt
      }))
    )
  )(
    'preserves native timestamps when opening and editing $runner with activity $lastActivityAt',
    async ({ runner, lastActivityAt }) => {
      const database = new NodeDatabase(':memory:', 'node-native-session-time');
      const workspace = database.saveWorkspace({
        path: '/workspace/native-session-time',
        kind: 'DIRECTORY',
        gitSummary: null
      });
      const connector = new NodeConnector({ reconnect: false, database });
      const internals = connector as unknown as {
        nativeSessionProjectionService: NativeSessionProjectionService;
        discoverWorkspaceSessions(): Promise<readonly NodeAgentSession[]>;
        executeNodeOperation(operation: string, data: unknown): Promise<unknown>;
      };
      const discovered = ['configuration', 'metadata'].map((action) =>
        internals.nativeSessionProjectionService.project({
          workspace,
          runner,
          externalSessionId: `native-${runner}-${action}`,
          cwd: workspace.path,
          lastActivityAt
        })
      );
      internals.nativeSessionProjectionService.remember(discovered);
      internals.discoverWorkspaceSessions = async () => discovered;
      try {
        for (const [index, native] of discovered.entries()) {
          const expected = {
            id: native.id,
            createdAt: native.createdAt,
            lastActivityAt
          };
          await expect(
            internals.executeNodeOperation('session.get', { sessionId: native.id })
          ).resolves.toMatchObject({ session: expected });
          await expect(
            internals.executeNodeOperation(
              index === 0 ? 'session.config.update' : 'session.metadata.update',
              index === 0
                ? {
                    sessionId: native.id,
                    model: 'replacement-model',
                    effort: 'low',
                    access: 'full-access'
                  }
                : { sessionId: native.id, pinned: true }
            )
          ).resolves.toMatchObject({ session: expected });
          await expect(
            internals.executeNodeOperation('session.get', { sessionId: native.id })
          ).resolves.toMatchObject({ session: expected });
        }
        const listed = (await internals.executeNodeOperation('session.list', {
          workspaceId: workspace.id
        })) as { sessions: NodeAgentSession[] };
        expect(listed.sessions).toHaveLength(discovered.length);
        expect(listed.sessions.map((session) => session.lastActivityAt)).toEqual([
          lastActivityAt,
          lastActivityAt
        ]);
      } finally {
        await connector.stop();
      }
    }
  );

  it('preserves native timestamps on MAR Agent activation and advances activity only for a new message', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mar-session-resume-time-'));
    roots.push(root);
    const database = new NodeDatabase(':memory:', 'node-native-resume-time');
    const workspace = database.saveWorkspace({
      path: root,
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({
      reconnect: false,
      database,
      capabilities: {
        platform: 'linux',
        architecture: 'x64',
        nodeVersion: process.version,
        codex: { available: false },
        claudeCode: { available: false },
        marAgent: { available: true, version: '0.9.134' }
      }
    });
    const internals = connector as unknown as {
      nativeSessionProjectionService: NativeSessionProjectionService;
      externalSessionResumeService: ExternalSessionResumeService;
      runtime: NodeRuntimeState;
    };
    const native = {
      ...internals.nativeSessionProjectionService.project({
        workspace,
        runner: 'mar-agent',
        externalSessionId: 'native-mar-resume-time',
        cwd: workspace.path,
        lastActivityAt: Date.parse('2026-09-29T10:29:28.787Z')
      }),
      createdAt: Date.parse('2026-09-29T10:17:24.980Z')
    };
    try {
      const resumed = await internals.externalSessionResumeService.resume(native);
      expect(resumed).toMatchObject({
        id: native.id,
        nativeControl: 'MAR_MANAGED',
        createdAt: native.createdAt,
        lastActivityAt: native.lastActivityAt
      });
      expect(await internals.externalSessionResumeService.resume(native)).toEqual(resumed);
      const { run } = internals.runtime.createMessageRun({
        sessionId: native.id,
        clientMessageId: 'new-message-after-resume',
        content: 'Continue the session'
      });
      expect(internals.runtime.getAgentSession(native.id)).toMatchObject({
        createdAt: native.createdAt,
        lastActivityAt: run.startedAt
      });
      expect(run.startedAt).toBeGreaterThan(native.lastActivityAt);
    } finally {
      await connector.stop();
    }
  });

  it('prioritizes pinned records, sorts discovered ordinary sessions by activity, and puts undiscovered records last', async () => {
    const database = new NodeDatabase(':memory:', 'node-session-records');
    try {
      const workspace = database.saveWorkspace({
        path: '/workspace/session-records',
        kind: 'DIRECTORY',
        gitSummary: null
      });
      database.saveNativeSessionMetadata({
        runner: 'codex',
        externalSessionId: 'pinned-missing',
        workspaceId: workspace.id,
        runnerTitle: 'pinned but undiscovered',
        pinned: true
      });
      database.saveNativeSessionMetadata({
        runner: 'codex',
        externalSessionId: 'missing-last',
        workspaceId: workspace.id,
        customTitle: 'undiscovered, sort last'
      });
      const connector = new NodeConnector({
        reconnect: false,
        database,
        capabilities: {
          platform: 'linux',
          architecture: 'x64',
          nodeVersion: process.version,
          codex: { available: false },
          claudeCode: { available: false }
        }
      });
      const internals = connector as unknown as {
        nativeSessionProjectionService: NativeSessionProjectionService;
        rememberDirectNativeSessions(sessions: readonly NodeAgentSession[]): void;
        discoverWorkspaceSessions(): Promise<readonly NodeAgentSession[]>;
        executeNodeOperation(operation: string, data: unknown): Promise<unknown>;
      };
      const discovered = [
        internals.nativeSessionProjectionService.project({
          workspace,
          runner: 'codex',
          externalSessionId: 'older',
          cwd: workspace.path,
          lastActivityAt: 100
        }),
        internals.nativeSessionProjectionService.project({
          workspace,
          runner: 'codex',
          externalSessionId: 'newer',
          cwd: workspace.path,
          lastActivityAt: 200
        })
      ];
      internals.nativeSessionProjectionService.remember(discovered);
      let currentDiscovery = discovered;
      internals.discoverWorkspaceSessions = async () => currentDiscovery;

      const result = (await internals.executeNodeOperation('session.list', {
        workspaceId: workspace.id,
        limit: 3
      })) as {
        sessions: readonly {
          id: string;
          pinOrder?: number | null;
          externalDiscovered?: boolean;
        }[];
      };
      expect(result.sessions.map((session) => session.id)).toEqual([
        'pinned-missing',
        'newer',
        'older'
      ]);
      expect(result.sessions[0]).toMatchObject({ pinOrder: 0, externalDiscovered: false });
      const firstPage = (await internals.executeNodeOperation('session.list', {
        workspaceId: workspace.id,
        limit: 3
      })) as { nextCursor: string };
      currentDiscovery = discovered.map((session) =>
        session.id === 'older' ? { ...session, lastActivityAt: 101 } : session
      );
      const secondPage = (await internals.executeNodeOperation('session.list', {
        workspaceId: workspace.id,
        limit: 3,
        cursor: firstPage.nextCursor
      })) as { sessions: readonly { id: string; externalDiscovered?: boolean }[] };
      expect(secondPage.sessions).toEqual([
        expect.objectContaining({ id: 'missing-last', externalDiscovered: false })
      ]);
    } finally {
      database.close();
    }
  });

  it('searches display titles after Runner discovery and identity mapping complete', async () => {
    const database = new NodeDatabase(':memory:', 'node-session-search');
    try {
      const workspace = database.saveWorkspace({
        path: '/workspace/session-search',
        kind: 'DIRECTORY',
        gitSummary: null
      });
      const runtime = new NodeRuntimeState(
        () => 'node-session-search',
        (workspaceId) => database.getWorkspace(workspaceId)
      );
      const discovered = [
        {
          id: 'release-session',
          nodeId: 'node-session-search',
          workspaceId: workspace.id,
          runner: 'codex',
          externalSessionId: 'release-session',
          nativeControl: 'EXTERNAL',
          channelToken: null,
          cwd: workspace.path,
          model: null,
          effort: null,
          access: null,
          customTitle: null,
          runnerTitle: 'Release checklist',
          pinnedAt: null,
          pinOrder: null,
          externalDiscovered: true,
          titleSource: 'RUNNER',
          lastActivityAt: 200,
          createdAt: 200
        },
        {
          id: 'other-session',
          nodeId: 'node-session-search',
          workspaceId: workspace.id,
          runner: 'codex',
          externalSessionId: 'other-session',
          nativeControl: 'EXTERNAL',
          channelToken: null,
          cwd: workspace.path,
          model: null,
          effort: null,
          access: null,
          customTitle: null,
          runnerTitle: 'Unrelated work',
          pinnedAt: null,
          pinOrder: null,
          externalDiscovered: true,
          titleSource: 'RUNNER',
          lastActivityAt: 300,
          createdAt: 300
        }
      ] satisfies NodeAgentSession[];
      const discoverWorkspaceSessions = vi.fn(async () => discovered);
      const service = new SessionCatalogService({
        runnerAvailable: () => true,
        database: () => database,
        nodeId: () => 'node-session-search',
        runtime,
        runners: {} as never,
        projection: { projectionsForNative: () => new Map() } as never,
        cachedNative: () => [],
        cachedWorkspace: async () => [discovered[1]!],
        discoveryPending: () => false,
        discoverWorkspace: discoverWorkspaceSessions,
        present: (session) => session,
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

      await expect(
        service.operations()['session.list']!({
          workspaceId: workspace.id,
          query: ' RELEASE ',
          limit: 10
        })
      ).resolves.toMatchObject({
        sessions: [expect.objectContaining({ runnerTitle: 'Release checklist' })],
        nextCursor: null
      });
      expect(discoverWorkspaceSessions).toHaveBeenCalledOnce();
    } finally {
      database.close();
    }
  });

  it('accepts move up/down only for pinned records', async () => {
    const database = new NodeDatabase(':memory:', 'node-session-pin-move');
    let connector: NodeConnector | undefined;
    try {
      const workspace = database.saveWorkspace({
        path: '/workspace/session-pin-move',
        kind: 'DIRECTORY',
        gitSummary: null
      });
      for (const id of ['one', 'two'])
        database.saveNativeSessionMetadata({
          runner: 'codex',
          externalSessionId: id,
          workspaceId: workspace.id,
          pinned: true
        });
      database.saveNativeSessionMetadata({
        runner: 'codex',
        externalSessionId: 'plain',
        workspaceId: workspace.id,
        customTitle: 'ordinary record'
      });
      connector = new NodeConnector({ reconnect: false, database });
      const internals = connector as unknown as {
        nativeSessionProjectionService: NativeSessionProjectionService;
        discoverWorkspaceSessions(workspaceId: string): Promise<readonly NodeAgentSession[]>;
        executeNodeOperation(operation: string, data: unknown): Promise<unknown>;
      };
      const discovered = ['one', 'two', 'plain'].map((id) =>
        internals.nativeSessionProjectionService.project({
          workspace,
          runner: 'codex',
          externalSessionId: id,
          cwd: workspace.path,
          title: id
        })
      );
      const discoverWorkspaceSessions = vi
        .spyOn(internals, 'discoverWorkspaceSessions')
        .mockResolvedValue(discovered);
      const execute = internals.executeNodeOperation.bind(connector);
      const beforeMove = (await execute('session.list', { workspaceId: workspace.id })) as {
        readonly sessions: readonly NodeAgentSession[];
      };
      expect(beforeMove.sessions.slice(0, 2).map((session) => session.id)).toEqual(['two', 'one']);
      await execute('session.pin.move', { sessionId: 'one', direction: 'up' });
      expect(
        database
          .listSessionRecords(workspace.id)
          .slice(0, 2)
          .map((record) => record.id)
      ).toEqual(['one', 'two']);
      const afterMove = (await execute('session.list', { workspaceId: workspace.id })) as {
        readonly sessions: readonly NodeAgentSession[];
      };
      expect(afterMove.sessions.slice(0, 2).map((session) => session.id)).toEqual(['one', 'two']);
      expect(discovered.find((session) => session.id === 'one')?.pinOrder).toBe(1);
      expect(discoverWorkspaceSessions).toHaveBeenCalledOnce();
      await expect(
        execute('session.pin.move', { sessionId: 'plain', direction: 'up' })
      ).rejects.toThrow('SESSION_NOT_PINNED');
    } finally {
      if (connector !== undefined) await connector.stop();
      else database.close();
    }
  });

  it('calculates movement across the complete pinned section without truncation by the first page', async () => {
    const database = new NodeDatabase(':memory:', 'node-session-pin-page');
    try {
      const workspace = database.saveWorkspace({
        path: '/workspace/session-pin-page',
        kind: 'DIRECTORY',
        gitSummary: null
      });
      for (let index = 0; index < 11; index += 1)
        database.saveNativeSessionMetadata({
          runner: 'codex',
          externalSessionId: `pinned-${index}`,
          workspaceId: workspace.id,
          pinned: true
        });
      const connector = new NodeConnector({
        reconnect: false,
        database,
        capabilities: capabilities(),
        codexProfileClientFactory
      });
      const internals = connector as unknown as {
        discoverWorkspaceSessions(): Promise<readonly NodeAgentSession[]>;
        executeNodeOperation(operation: string, data: unknown): Promise<unknown>;
      };
      internals.discoverWorkspaceSessions = async () => [];
      const result = (await internals.executeNodeOperation('session.list', {
        workspaceId: workspace.id,
        limit: 10
      })) as {
        sessions: readonly { id: string; canMovePinUp?: boolean; canMovePinDown?: boolean }[];
      };

      expect(result.sessions[0]).toMatchObject({ canMovePinUp: false, canMovePinDown: true });
      expect(result.sessions.at(-1)).toMatchObject({ canMovePinUp: true, canMovePinDown: true });
    } finally {
      database.close();
    }
  });

  it('does not create a persistent record for a new session with an external ID', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mar-session-no-record-'));
    roots.push(root);
    const database = new NodeDatabase(':memory:', 'node-session-create-no-record');
    try {
      const workspace = database.saveWorkspace({
        path: root,
        kind: 'DIRECTORY',
        gitSummary: null
      });
      const connector = new NodeConnector({
        reconnect: false,
        database,
        capabilities: capabilities(),
        codexProfileClientFactory
      });
      const execute = (
        connector as unknown as {
          executeNodeOperation(operation: string, data: unknown): Promise<unknown>;
        }
      ).executeNodeOperation.bind(connector);
      await execute('runner.profiles.list', {});

      const beforeCreate = Date.now();
      const created = (await execute('session.create', {
        workspaceId: workspace.id,
        runner: 'codex',
        cwd: workspace.path,
        externalSessionId: 'thread-created',
        model: 'gpt-5.6-sol',
        effort: 'medium',
        access: 'on-request'
      })) as { session: NodeAgentSession };

      expect(created.session.createdAt).toBeGreaterThanOrEqual(beforeCreate);
      expect(created.session.createdAt).toBeLessThanOrEqual(Date.now());
      expect(created.session.lastActivityAt).toBe(created.session.createdAt);
      expect(database.listSessionRecords(workspace.id)).toEqual([]);
    } finally {
      database.close();
    }
  });
});
