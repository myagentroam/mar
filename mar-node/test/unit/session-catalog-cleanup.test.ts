import { describe, expect, it, vi } from 'vitest';
import type { NodeAgentSession } from '../../src/database.js';
import { NodeDatabase } from '../../src/database.js';
import { NodeRuntimeState } from '../../src/runtime-state.js';
import { CodexRunner } from '../../src/runner/codex-runner.js';
import { type CodexAppServerClient } from '../../src/codex-app-server.js';
import { SessionCatalogService } from '../../src/service/session-catalog-service.js';
import { NativeSessionProjectionService } from '../../src/service/native-session-projection-service.js';
import { SessionDomainState } from '../../src/service/session-domain-state.js';
import { ExternalSessionResumeService } from '../../src/service/external-session-resume-service.js';
import { CommandStateStore } from '../../src/runner-command-engine.js';
import type {
  ExternalResumeContext,
  ExternalResumeResult
} from '../../src/runner/abstract-runner.js';
import * as nativeHistory from '../../src/native-session-history.js';

const { nodeLog } = vi.hoisted(() => ({ nodeLog: vi.fn() }));

vi.mock('../../src/operational.js', () => ({ nodeLog }));

const DAY_MS = 24 * 60 * 60 * 1000;
const now = 1_800_000_000_000;

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function removalFixture(nativeControl: NodeAgentSession['nativeControl'] = 'MAR_MANAGED') {
  const database = new NodeDatabase(':memory:', 'session-remove-admission');
  const workspace = database.saveWorkspace({
    path: '/workspace/remove',
    kind: 'DIRECTORY',
    gitSummary: null
  });
  const runtime = new NodeRuntimeState(
    () => 'node-1',
    (id) => database.getWorkspace(id)
  );
  const target = runtime.createAgentSession({
    workspaceId: workspace.id,
    runner: 'claude-code',
    cwd: workspace.path,
    externalSessionId: 'remove-native',
    nativeControl
  });
  const removeNative = vi.fn(
    async (_session: NodeAgentSession, _nativeId: string): Promise<boolean | 'MISSING'> => true
  );
  const aliases = new Map<string, string>();
  const runners = {
    require: () => ({
      removeNative,
      nativeAliasesFor: (id: string) =>
        [...aliases].filter(([, managedId]) => managedId === id).map(([nativeId]) => nativeId),
      managedAliasId: (id: string) => aliases.get(id),
      forgetNativeAlias: (id: string) => aliases.delete(id)
    })
  } as never;
  const state = new SessionDomainState<NodeAgentSession, unknown>();
  const commands = new CommandStateStore();
  const projection = new NativeSessionProjectionService({
    database: () => database,
    nodeId: () => 'node-1',
    runtime,
    runners,
    state,
    commands,
    releaseResumeState: (directIds, projectionIds) =>
      resume.forgetSessions(directIds, projectionIds),
    capabilities: () => ({
      platform: 'linux',
      architecture: 'x64',
      nodeVersion: process.version,
      codex: { available: false },
      claudeCode: { available: false }
    }),
    present: vi.fn()
  });
  const resumeNative = vi.fn(
    async (
      source: NodeAgentSession,
      context: ExternalResumeContext
    ): Promise<ExternalResumeResult> => ({ session: context.promote(source.id)! })
  );
  const resume = externalResumeFixture({ runtime, state, target }, resumeNative);
  projection.remember([target]);
  const refreshActivity = vi.fn(async (_session: NodeAgentSession) => {});
  const externalActivity = vi.fn((): unknown => 'IDLE');
  const invalidate = vi.fn();
  const service = new SessionCatalogService({
    database: () => database,
    nodeId: () => 'node-1',
    runtime,
    runners,
    projection,
    runnerAvailable: () => true,
    cachedNative: () => [],
    cachedWorkspace: async () => [],
    discoveryPending: () => false,
    discoverWorkspace: async () => [],
    present: (value) => value,
    nativeIds: (value) => projection.nativeIds(value),
    forget: (value, ids) => projection.forget(value, ids),
    refreshActivity,
    externalActivity,
    isWatching: () => false,
    history: async () => ({ turns: [], nextCursor: null }),
    invalidateHistory: vi.fn(),
    invalidateWorkspaceSessions: invalidate,
    emitSession: vi.fn()
  });
  return {
    database,
    runtime,
    target,
    projection,
    resume,
    resumeNative,
    aliases,
    commands,
    removeNative,
    state,
    refreshActivity,
    externalActivity,
    invalidate,
    remove: () => Promise.resolve(service.operations()['session.remove']!({ sessionId: target.id }))
  };
}

function externalResumeFixture(
  f: {
    runtime: NodeRuntimeState;
    state: SessionDomainState<NodeAgentSession, unknown>;
    target: NodeAgentSession;
  },
  resumeNative: (
    source: NodeAgentSession,
    context: ExternalResumeContext
  ) => Promise<ExternalResumeResult>
) {
  return new ExternalSessionResumeService({
    runtime: f.runtime,
    state: f.state,
    runners: { product: () => ({ resumeExternal: resumeNative }) } as never,
    available: () => true,
    projectionFor: (source) => f.runtime.getAgentSession(source.id),
    managedAliasFor: () => undefined,
    ensureConfiguration: (source) => source,
    configuration: () => ({
      runner: f.target.runner,
      model: 'default',
      effort: 'medium',
      access: 'workspace-write'
    }),
    workspacePath: () => f.target.cwd,
    rememberNative: vi.fn(),
    resolve: async () => f.target
  });
}

describe('External resume state ownership', () => {
  it('synchronously releases only matching direct and projection state through the resume owner', async () => {
    vi.useFakeTimers();
    const f = removalFixture('EXTERNAL');
    try {
      const direct = { ...f.target, id: 'target-direct' };
      const alias = { ...f.target, id: 'alias-direct', externalSessionId: 'alias-native' };
      const linked = { ...f.target, id: 'linked-direct', externalSessionId: 'linked-native' };
      const unrelated = f.runtime.createAgentSession({
        workspaceId: f.target.workspaceId,
        runner: f.target.runner,
        cwd: f.target.cwd,
        externalSessionId: 'unrelated-native'
      });
      const otherCwd = { ...f.target, id: 'other-cwd', cwd: '/workspace/other' };
      const otherRunner = { ...f.target, id: 'other-runner', runner: 'codex' as const };
      f.state.directNative.delete(f.target.id);
      f.projection.remember([direct, alias, linked, unrelated, otherCwd, otherRunner]);
      f.aliases.set('alias-native', f.target.id);
      f.aliases.set('unrelated-alias', unrelated.id);
      f.resumeNative.mockResolvedValue({
        failureCode: 'RESUME_FAILED',
        messageFailureCode: 'MESSAGE_RESUME_FAILED',
        failureDetail: 'Controlled resume failure'
      });
      for (const source of [direct, alias, linked, unrelated]) {
        await expect(f.resume.resume(source)).resolves.toBeUndefined();
        f.resume.setActivity(source.id, 'IDLE');
        f.state.resumedByDirectId.set(source.id, source.id);
      }
      f.state.resumedByDirectId.set(direct.id, f.target.id);
      f.state.resumedByDirectId.set(alias.id, f.target.id);
      f.state.resumedByDirectId.set(linked.id, f.target.id);
      f.resume.setActivity(f.target.id, 'BUSY');
      f.resume.setActivity('alias-native', 'BUSY');
      const command = {
        commandId: 'plan',
        active: true,
        label: 'Plan',
        detail: null,
        closable: true,
        closeInput: '/plan'
      };
      f.commands.set(f.target.id, command);
      f.commands.set(unrelated.id, command);
      const retainedTimers = new Map(
        [linked, unrelated].map((direct) => [direct.id, f.state.failureTimers.get(direct.id)!])
      );
      expect(vi.getTimerCount()).toBe(4);
      vi.advanceTimersByTime(29 * 60_000);
      const release = vi.spyOn(f.resume, 'forgetSessions');

      expect(f.projection.forget(f.target, new Set([f.target.externalSessionId!]))).toBeUndefined();

      expect(release).toHaveBeenCalledExactlyOnceWith(
        new Set([direct.id, alias.id]),
        new Set([f.target.id])
      );
      expect([...f.state.directNative.keys()]).toEqual([
        linked.id,
        unrelated.id,
        otherCwd.id,
        otherRunner.id
      ]);
      expect(f.runtime.getAgentSession(f.target.id)).toBeUndefined();
      expect(f.runtime.getAgentSession(unrelated.id)).toEqual(unrelated);
      expect(f.commands.list(f.target.id)).toEqual([]);
      expect(f.commands.list(unrelated.id)).toEqual([command]);
      expect([...f.aliases]).toEqual([['unrelated-alias', unrelated.id]]);
      expect([...f.state.resumedByDirectId]).toEqual([[unrelated.id, unrelated.id]]);
      expect([...f.state.externalActivity]).toEqual([
        [linked.id, 'IDLE'],
        [unrelated.id, 'IDLE'],
        ['alias-native', 'BUSY']
      ]);
      for (const failures of [
        f.state.resumeFailures,
        f.state.messageResumeFailures,
        f.state.resumeFailureDetails
      ])
        expect([...failures.keys()]).toEqual([linked.id, unrelated.id]);
      expect(f.state.resumeFailures.get(unrelated.id)).toBe('RESUME_FAILED');
      expect(f.state.messageResumeFailures.get(unrelated.id)).toBe('MESSAGE_RESUME_FAILED');
      expect(f.state.resumeFailureDetails.get(unrelated.id)).toBe('Controlled resume failure');
      expect(f.state.failureTimers).toEqual(retainedTimers);
      expect(vi.getTimerCount()).toBe(2);
      vi.advanceTimersByTime(59_999);
      expect(f.resume.failure(unrelated.id).code).toBe('RESUME_FAILED');
      vi.advanceTimersByTime(1);
      expect(f.state.resumeFailures.size).toBe(0);
      expect(f.state.messageResumeFailures.size).toBe(0);
      expect(f.state.resumeFailureDetails.size).toBe(0);
      expect(f.state.failureTimers.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      f.database.close();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it.each(['BUSY', undefined] as const)(
    'preserves resume failures and does not invent missing activity (%s)',
    async (activity) => {
      vi.useFakeTimers();
      const f = removalFixture('EXTERNAL');
      try {
        f.resumeNative.mockResolvedValue({
          ...(activity === undefined ? {} : { activity }),
          failureCode: 'RESUME_FAILED',
          messageFailureCode: 'MESSAGE_RESUME_FAILED',
          failureDetail: 'Controlled resume failure'
        });
        await expect(f.resume.resolveForMessage(f.target.id)).rejects.toThrow(
          activity === 'BUSY' ? 'EXTERNAL_SESSION_ACTIVE' : 'MESSAGE_RESUME_FAILED'
        );
        expect(f.state.externalActivity.has(f.target.id)).toBe(activity !== undefined);
        expect(f.state.externalActivity.get(f.target.id)).toBe(activity);
        expect(f.resume.failure(f.target.id)).toEqual({
          code: 'RESUME_FAILED',
          detail: 'Controlled resume failure'
        });
        expect(f.runtime.getAgentSession(f.target.id)?.nativeControl).toBe('EXTERNAL');
        expect(f.state.resumedByDirectId.size).toBe(0);
        vi.advanceTimersByTime(30 * 60_000 - 1);
        expect(f.resume.failure(f.target.id).code).toBe('RESUME_FAILED');
        vi.advanceTimersByTime(1);
        expect(f.resume.failure(f.target.id)).toEqual({ code: 'SESSION_RESUME_REJECTED' });
        expect(f.state.messageResumeFailures.size).toBe(0);
        expect(f.state.failureTimers.size).toBe(0);
      } finally {
        f.database.close();
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    }
  );
});

describe('SessionCatalogService removal admission', () => {
  it('rejects late external activation rather than recreating a deleted session and Run', async () => {
    const f = removalFixture('EXTERNAL');
    const deleting = gate();
    const finishDelete = gate();
    const finishResume = gate();
    const resumeNative = vi.fn(async (source: NodeAgentSession, context: ExternalResumeContext) => {
      await finishResume.promise;
      return { activity: 'IDLE' as const, session: context.create(source) };
    });
    f.resumeNative.mockImplementation(resumeNative);
    const resume = f.resume;
    f.removeNative.mockImplementation(async () => {
      deleting.resolve();
      await finishDelete.promise;
      return true;
    });
    const removing = f.remove();
    const removalSettled = removing.catch(() => undefined);
    let accepting: Promise<unknown> | undefined;
    try {
      await deleting.promise;
      accepting = resume.resolveForMessage(f.target.id).then((source) =>
        f.runtime.createMessageRun({
          sessionId: source.id,
          clientMessageId: 'late-resume',
          content: 'must not resurrect'
        })
      );
      void accepting.catch(() => undefined);
      finishDelete.resolve();
      await expect(removing).resolves.toEqual({ deleted: true });
      finishResume.resolve();
      await expect(accepting).rejects.toThrow('SESSION_ACTIVE');
      expect(resumeNative).not.toHaveBeenCalled();
      expect(f.runtime.getAgentSession(f.target.id)).toBeUndefined();
      expect(f.runtime.listRunsForSession(f.target.id)).toEqual([]);
      expect(f.state.resumedByDirectId.size).toBe(0);
    } finally {
      finishDelete.resolve();
      finishResume.resolve();
      await removalSettled;
      await accepting?.catch(() => undefined);
      f.database.close();
    }
  });

  it.each(['success', 'failure'] as const)(
    'blocks deletion during external activation and releases after %s',
    async (outcome) => {
      const f = removalFixture('EXTERNAL');
      const entered = gate();
      const complete = gate();
      const error = new Error('CONTROLLED_RESUME_FAILURE');
      const resumeNative = vi.fn(
        async (source: NodeAgentSession, context: ExternalResumeContext) => {
          entered.resolve();
          await complete.promise;
          if (outcome === 'failure') throw error;
          return { activity: 'IDLE' as const, session: context.promote(source.id)! };
        }
      );
      f.resumeNative.mockImplementation(resumeNative);
      const resume = f.resume;
      const message = {
        sessionId: f.target.id,
        clientMessageId: 'before-activation',
        content: 'retain queued message'
      };
      const queued = f.runtime.createQueueItem(message).item;
      f.runtime.pauseSessionQueue(f.target.id);
      const first = resume.resolveForMessage(f.target.id);
      const duplicate = resume.resolveForMessage(f.target.id);
      const settled = Promise.allSettled([first, duplicate]);
      try {
        await entered.promise;
        expect(resume.transitioning(f.target.id)).toBe(true);
        await expect(f.remove()).rejects.toThrow('SESSION_ACTIVE');
        expect(f.removeNative).not.toHaveBeenCalled();
        expect(f.database.getSessionRecord(f.target.id)).toBeDefined();
        expect(f.runtime.getQueueItem(queued.id)).toEqual(queued);
        expect(resumeNative).toHaveBeenCalledOnce();
        complete.resolve();
        if (outcome === 'failure') {
          await expect(first).rejects.toBe(error);
          await expect(duplicate).rejects.toBe(error);
          await expect(f.remove()).resolves.toEqual({ deleted: true });
        } else {
          const [one, two] = await Promise.all([first, duplicate]);
          expect(one).toEqual(two);
          expect(one.nativeControl).toBe('MAR_MANAGED');
          expect(f.runtime.createQueueItem(message)).toEqual({ item: queued, created: false });
          expect(f.runtime.startRunFromQueueItem(queued.id).run.clientMessageId).toBe(
            message.clientMessageId
          );
        }
        expect(resume.transitioning(f.target.id)).toBe(false);
      } finally {
        complete.resolve();
        await settled;
        f.database.close();
      }
    }
  );

  it.each(['refresh', 'second-native', 'file-fallback'] as const)(
    'blocks new inputs throughout %s and removes runtime and persisted records together',
    async (phase) => {
      const f = removalFixture(phase === 'refresh' ? 'EXTERNAL' : 'MAR_MANAGED');
      const entered = gate();
      const complete = gate();
      const wait = async () => {
        entered.resolve();
        await complete.promise;
      };
      const fallback = vi.spyOn(nativeHistory, 'removeNativeSession');
      if (phase === 'refresh') f.refreshActivity.mockImplementation(wait);
      if (phase === 'second-native') {
        vi.spyOn(f.projection, 'nativeIds').mockReturnValue(
          new Set([f.target.externalSessionId!, 'second-native'])
        );
        f.removeNative.mockImplementation(async (_session, nativeId) => {
          if (nativeId === 'second-native') await wait();
          return true;
        });
      }
      if (phase === 'file-fallback') {
        f.removeNative.mockResolvedValue(false);
        fallback.mockImplementation(wait);
      }
      const removing = f.remove();
      const settled = removing.catch(() => undefined);
      try {
        await entered.promise;
        const input = {
          sessionId: f.target.id,
          clientMessageId: 'racing-input',
          content: 'must not enter'
        };
        expect(() => f.runtime.createMessageRun(input)).toThrow('SESSION_ACTIVE');
        expect(() => f.runtime.createQueueItem(input)).toThrow('SESSION_ACTIVE');
        expect(f.runtime.listRunsForSession(f.target.id)).toEqual([]);
        expect(f.runtime.sessionQueue(f.target.id).itemIds).toEqual([]);
        expect(f.database.getSessionRecord(f.target.id)).toBeDefined();
        complete.resolve();
        await expect(removing).resolves.toEqual({ deleted: true });
        expect(f.runtime.getAgentSession(f.target.id)).toBeUndefined();
        expect(f.database.getSessionRecord(f.target.id)).toBeUndefined();
        expect(f.invalidate).toHaveBeenCalledWith(f.target.workspaceId);
        f.runtime.beginSessionHistoryMutation(f.target.id)();
      } finally {
        complete.resolve();
        await settled;
        fallback.mockRestore();
        f.database.close();
      }
    }
  );

  it('keeps explicit deletion compatible with a paused nonempty queue and unavailable native records', async () => {
    const f = removalFixture();
    const item = f.runtime.createQueueItem({
      sessionId: f.target.id,
      clientMessageId: 'queued',
      content: 'discard with session'
    }).item;
    f.runtime.pauseSessionQueue(f.target.id);
    f.removeNative.mockRejectedValue(new Error('NATIVE_TRANSCRIPT_UNAVAILABLE'));
    try {
      await expect(f.remove()).resolves.toEqual({ deleted: true });
      expect(f.runtime.getAgentSession(f.target.id)).toBeUndefined();
      expect(f.runtime.getQueueItem(item.id)).toBeUndefined();
      expect(f.database.getSessionRecord(f.target.id)).toBeUndefined();
      f.runtime.beginSessionHistoryMutation(f.target.id)();
    } finally {
      f.database.close();
    }
  });

  it('refuses deletion before native I/O when a Run won admission', async () => {
    const f = removalFixture();
    f.runtime.createMessageRun({
      sessionId: f.target.id,
      clientMessageId: 'first',
      content: 'already running'
    });
    try {
      await expect(f.remove()).rejects.toThrow('SESSION_ACTIVE');
      expect(f.removeNative).not.toHaveBeenCalled();
      expect(f.database.getSessionRecord(f.target.id)).toBeDefined();
    } finally {
      f.database.close();
    }
  });

  it('guards a discovered native session without creating a runtime projection', async () => {
    const f = removalFixture();
    f.runtime.removeAgentSession(f.target.id);
    const entered = gate();
    const complete = gate();
    f.removeNative.mockImplementation(async () => {
      entered.resolve();
      await complete.promise;
      return true;
    });
    const removing = f.remove();
    const settled = removing.catch(() => undefined);
    try {
      await entered.promise;
      expect(() =>
        f.runtime.adoptRun({
          runId: 'late-adoption',
          sessionId: f.target.id,
          workspaceId: f.target.workspaceId,
          runner: f.target.runner,
          cwd: f.target.cwd
        })
      ).toThrow('SESSION_ACTIVE');
      expect(f.runtime.listAgentSessions()).toEqual([]);
      expect(f.database.getSessionRecord(f.target.id)).toBeDefined();
      complete.resolve();
      await expect(removing).resolves.toEqual({ deleted: true });
      expect(f.runtime.listAgentSessions()).toEqual([]);
      expect(f.database.getSessionRecord(f.target.id)).toBeUndefined();
      f.runtime.beginSessionHistoryMutation(f.target.id)();
    } finally {
      complete.resolve();
      await settled;
      f.database.close();
    }
  });

  it.each(['native', 'metadata', 'forget'] as const)(
    'releases admission after a %s failure without hiding partial deletion',
    async (phase) => {
      const f = removalFixture();
      const error = new Error('CONTROLLED_DELETE_FAILURE');
      const message = {
        sessionId: f.target.id,
        clientMessageId: 'retained-on-failure',
        content: 'retain accepted input'
      };
      const queued = phase === 'native' ? f.runtime.createQueueItem(message).item : undefined;
      if (queued !== undefined) f.runtime.pauseSessionQueue(f.target.id);
      if (phase === 'native') f.removeNative.mockRejectedValue(error);
      const failing =
        phase === 'metadata'
          ? vi.spyOn(f.database, 'deleteSessionRecord').mockImplementation(() => {
              throw error;
            })
          : phase === 'forget'
            ? vi.spyOn(f.projection, 'forget').mockImplementation(() => {
                throw error;
              })
            : undefined;
      try {
        await expect(f.remove()).rejects.toBe(error);
        expect(f.database.getSessionRecord(f.target.id) !== undefined).toBe(phase !== 'forget');
        expect(f.runtime.getAgentSession(f.target.id)).toBeDefined();
        expect(f.invalidate).toHaveBeenCalledWith(f.target.workspaceId);
        f.runtime.beginSessionHistoryMutation(f.target.id, { allowQueued: true })();
        if (phase === 'native') {
          expect(f.runtime.createQueueItem(message)).toEqual({ item: queued, created: false });
          expect(f.runtime.startRunFromQueueItem(queued!.id).run.clientMessageId).toBe(
            message.clientMessageId
          );
        }
      } finally {
        failing?.mockRestore();
        f.database.close();
      }
    }
  );

  it.each(['busy', 'refresh-error'] as const)(
    'releases admission after external activity is %s',
    async (outcome) => {
      const f = removalFixture('EXTERNAL');
      if (outcome === 'busy') f.externalActivity.mockReturnValue('BUSY');
      else f.refreshActivity.mockRejectedValue(new Error('REFRESH_FAILED'));
      try {
        await expect(f.remove()).rejects.toThrow(
          outcome === 'busy' ? 'SESSION_ACTIVE' : 'REFRESH_FAILED'
        );
        expect(f.removeNative).not.toHaveBeenCalled();
        expect(f.database.getSessionRecord(f.target.id)).toBeDefined();
        expect(
          f.runtime.createMessageRun({
            sessionId: f.target.id,
            clientMessageId: 'after-refresh',
            content: 'guard released'
          }).created
        ).toBe(true);
      } finally {
        f.database.close();
      }
    }
  );
});

function session(
  id: string,
  workspaceId: string,
  lastActivityAt: number,
  overrides: Partial<NodeAgentSession> = {}
): NodeAgentSession {
  return {
    id,
    nodeId: 'node-1',
    workspaceId,
    runner: 'claude-code',
    externalSessionId: id,
    nativeControl: 'EXTERNAL',
    channelToken: null,
    cwd: '/workspace/cleanup',
    model: null,
    effort: null,
    access: null,
    customTitle: null,
    runnerTitle: id,
    pinnedAt: null,
    pinOrder: null,
    externalDiscovered: true,
    titleSource: 'RUNNER',
    lastActivityAt,
    createdAt: lastActivityAt,
    ...overrides
  };
}

describe('SessionCatalogService workspace session cleanup', () => {
  it.each(
    [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY].flatMap(
      (unknownActivityAt) => [1, 365].map((inactiveDays) => ({ unknownActivityAt, inactiveDays }))
    )
  )(
    'cleans expired and unknown-time ($unknownActivityAt) sessions at $inactiveDays days while keeping protected sessions',
    async ({ unknownActivityAt, inactiveDays }) => {
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const database = new NodeDatabase(':memory:', 'session-catalog-cleanup');
      const workspace = database.saveWorkspace({
        id: 'workspace-1',
        path: '/workspace/cleanup',
        kind: 'DIRECTORY',
        gitSummary: null
      });
      const otherWorkspace = database.saveWorkspace({
        id: 'workspace-2',
        path: '/workspace/other',
        kind: 'DIRECTORY',
        gitSummary: null
      });
      const runtime = new NodeRuntimeState(
        () => 'node-1',
        (id) => database.getWorkspace(id),
        () => now
      );
      const beginHistoryMutation = vi.spyOn(runtime, 'beginSessionHistoryMutation');
      const sessionQueue = runtime.sessionQueue.bind(runtime);
      vi.spyOn(runtime, 'sessionQueue').mockImplementation((id) =>
        id === 'unknown-queued'
          ? { ...sessionQueue(id), itemIds: ['queued-item'] }
          : sessionQueue(id)
      );
      vi.spyOn(runtime, 'listRunsForSession').mockImplementation((id) =>
        id === 'unknown-active'
          ? [{ status: 'RUNNING' } as ReturnType<typeof runtime.listRunsForSession>[number]]
          : []
      );
      const oldActivityAt = now - (inactiveDays + 1) * DAY_MS;
      const old = session('old', workspace.id, oldActivityAt);
      const oldOpenCode = session('old-opencode', workspace.id, oldActivityAt, {
        runner: 'opencode'
      });
      const oldMarAgent = session('old-mar-agent', workspace.id, oldActivityAt, {
        runner: 'mar-agent'
      });
      const staleMarAgent = session('stale-mar-agent', workspace.id, oldActivityAt, {
        runner: 'mar-agent'
      });
      const recent = session('recent', workspace.id, now - (inactiveDays - 1) * DAY_MS);
      const boundary = session('boundary', workspace.id, now - inactiveDays * DAY_MS);
      const pinned = session('pinned', workspace.id, oldActivityAt, { pinOrder: 0, pinnedAt: 1 });
      const unknown = session('unknown', workspace.id, unknownActivityAt);
      const unknownProtected = ['pinned', 'watched', 'queued', 'active', 'busy', 'recovering'].map(
        (name) =>
          session(
            `unknown-${name}`,
            workspace.id,
            unknownActivityAt,
            name === 'pinned' ? { pinOrder: 0, pinnedAt: 1 } : {}
          )
      );
      const watched = session('watched', workspace.id, oldActivityAt);
      const watchedDuringRefresh = session(
        'watched-during-refresh',
        workspace.id,
        unknownActivityAt
      );
      const other = session('other', otherWorkspace.id, oldActivityAt);
      const deleted: string[] = [];
      const runnerDeletes: string[] = [];
      const forgotten: string[] = [];
      const invalidated: string[] = [];
      let refreshingSessionId: string | undefined;
      const service = new SessionCatalogService({
        runnerAvailable: () => true,
        database: () => database,
        nodeId: () => 'node-1',
        runtime,
        runners: {
          require: (runner: string) => ({
            removeNative: async (value: NodeAgentSession, nativeId: string) => {
              runnerDeletes.push(`${runner}:${value.id}`);
              if (value.id === staleMarAgent.id) return 'MISSING' as const;
              deleted.push(nativeId);
              return true;
            }
          })
        } as never,
        projection: {
          resolve: async () => undefined,
          projectionForNative: () => undefined,
          projectionsForNative: () => new Map()
        } as never,
        cachedNative: () => [],
        cachedWorkspace: async () => [],
        discoveryPending: () => false,
        discoverWorkspace: async () => [
          old,
          oldOpenCode,
          oldMarAgent,
          staleMarAgent,
          recent,
          boundary,
          pinned,
          unknown,
          ...unknownProtected,
          watched,
          watchedDuringRefresh,
          other
        ],
        present: (value) => value,
        nativeIds: (value) => new Set([value.externalSessionId as string]),
        forget: (value) => forgotten.push(value.id),
        refreshActivity: async (value) => {
          refreshingSessionId = value.id;
        },
        externalActivity: (id) => (id === 'unknown-busy' ? 'BUSY' : undefined),
        isRecovering: (id) => id === 'unknown-recovering',
        isWatching: (sessionId) =>
          sessionId === watched.id ||
          sessionId === 'unknown-watched' ||
          (sessionId === watchedDuringRefresh.id && refreshingSessionId === sessionId),
        invalidateHistory: () => undefined,
        invalidateWorkspaceSessions: (workspaceId) => invalidated.push(workspaceId),
        history: async () => ({ turns: [], nextCursor: null }),
        emitSession: () => undefined
      });

      await expect(
        service.operations()['workspace.sessions.cleanup']!({
          workspaceId: workspace.id,
          inactiveDays
        })
      ).resolves.toEqual({
        deleted: 4,
        skipped: 12,
        failed: 0,
        deletedByRunner: { 'claude-code': 2, opencode: 1, 'mar-agent': 1 }
      });
      expect(deleted).toEqual(['old', 'old-opencode', 'old-mar-agent', 'unknown']);
      expect(runnerDeletes).toEqual([
        'claude-code:old',
        'opencode:old-opencode',
        'mar-agent:old-mar-agent',
        'mar-agent:stale-mar-agent',
        'claude-code:unknown'
      ]);
      expect(beginHistoryMutation).toHaveBeenCalledTimes(6);
      expect(beginHistoryMutation.mock.calls.map(([id]) => id)).toEqual([
        old.id,
        oldOpenCode.id,
        oldMarAgent.id,
        staleMarAgent.id,
        unknown.id,
        watchedDuringRefresh.id
      ]);
      expect(
        beginHistoryMutation.mock.calls.every(([, options]) => options?.allowQueued !== true)
      ).toBe(true);
      expect(forgotten).toEqual([
        'old',
        'old-opencode',
        'old-mar-agent',
        'stale-mar-agent',
        'unknown'
      ]);
      expect(invalidated).toEqual([workspace.id]);
      await expect(
        service.operations()['workspace.sessions.cleanup']!({
          workspaceId: workspace.id,
          inactiveDays: 0
        })
      ).rejects.toThrow('WORKSPACE_SESSION_CLEANUP_INVALID');
    }
  );

  it('clears unprotected local-only records after full discovery without probing or deleting native content', async () => {
    const database = new NodeDatabase(':memory:', 'cleanup-missing');
    const workspace = database.saveWorkspace({
      path: '/workspace/cleanup',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const ids = [
      'missing',
      'unavailable',
      'not-loaded',
      'pinned',
      'watched',
      'queued',
      'busy',
      'runtime',
      'disabled'
    ];
    for (const id of ids)
      database.saveNativeSessionMetadata({
        runner: id === 'disabled' ? 'opencode' : 'codex',
        externalSessionId: id,
        workspaceId: workspace.id,
        pinned: id === 'pinned'
      });
    const runtime = new NodeRuntimeState(
      () => 'node-1',
      (id) => database.getWorkspace(id)
    );
    vi.spyOn(runtime, 'getAgentSession').mockImplementation((id) =>
      id === 'runtime' ? session(id, workspace.id, 0) : undefined
    );
    const sessionQueue = runtime.sessionQueue.bind(runtime);
    vi.spyOn(runtime, 'sessionQueue').mockImplementation((id) =>
      id === 'queued' ? { ...sessionQueue(id), itemIds: ['queued-item'] } : sessionQueue(id)
    );
    const forgotten: string[] = [];
    const removeNative = vi.fn();
    const readThread = vi.fn();
    const runner = new CodexRunner({ readThread } as unknown as CodexAppServerClient);
    vi.spyOn(runner, 'removeNative').mockImplementation(removeNative);
    const requireRunner = vi.fn(() => runner);
    const refreshActivity = vi.fn(async () => undefined);
    const service = new SessionCatalogService({
      runnerAvailable: (runner) => runner !== 'opencode',
      database: () => database,
      nodeId: () => 'node-1',
      runtime,
      runners: { require: requireRunner } as never,
      projection: { projectionsForNative: () => new Map() } as never,
      cachedNative: () => [],
      cachedWorkspace: async () => [],
      discoveryPending: () => false,
      discoverWorkspace: async () => [],
      present: (value) => value,
      nativeIds: (value) => new Set([value.externalSessionId as string]),
      forget: (value) => {
        forgotten.push(value.id);
      },
      refreshActivity,
      externalActivity: (id) => (id === 'busy' ? 'BUSY' : undefined),
      isWatching: (id) => id === 'watched',
      invalidateHistory: () => undefined,
      invalidateWorkspaceSessions: () => undefined,
      history: vi.fn(),
      emitSession: () => undefined
    });
    await expect(
      service.operations()['workspace.sessions.cleanup']!({
        workspaceId: workspace.id,
        inactiveDays: 30
      })
    ).resolves.toEqual({ deleted: 3, skipped: 6, failed: 0, deletedByRunner: { codex: 3 } });
    expect(forgotten.toSorted()).toEqual(['missing', 'not-loaded', 'unavailable']);
    expect(
      database
        .listSessionRecords(workspace.id)
        .map((record) => record.id)
        .sort()
    ).toEqual(ids.filter((id) => !forgotten.includes(id)).sort());
    expect(removeNative).not.toHaveBeenCalled();
    expect(readThread).not.toHaveBeenCalled();
    expect(requireRunner).not.toHaveBeenCalled();
    expect(refreshActivity).not.toHaveBeenCalled();
    database.close();
  });

  it('invalidates the workspace after a partial native removal failure and preserves the error', async () => {
    const database = new NodeDatabase(':memory:', 'session-catalog-remove-failure');
    try {
      const workspace = database.saveWorkspace({
        id: 'workspace-remove-failure',
        path: '/workspace/cleanup',
        kind: 'DIRECTORY',
        gitSummary: null
      });
      const failed = session('partially-removed', workspace.id, now);
      database.saveNativeSessionMetadata({
        runner: failed.runner,
        externalSessionId: failed.id,
        workspaceId: workspace.id
      });
      const nativeRemoved: string[] = [];
      const invalidated: string[] = [];
      const failure = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      const runtime = new NodeRuntimeState(
        () => 'node-1',
        (id) => database.getWorkspace(id),
        () => now
      );
      const service = new SessionCatalogService({
        runnerAvailable: () => true,
        database: () => database,
        nodeId: () => 'node-1',
        runtime,
        runners: {
          require: () => ({
            removeNative: async (_session: NodeAgentSession, nativeId: string) => {
              nativeRemoved.push(nativeId);
              throw failure;
            }
          })
        } as never,
        projection: { resolve: async () => failed } as never,
        cachedNative: () => [],
        cachedWorkspace: async () => [],
        discoveryPending: () => false,
        discoverWorkspace: async () => [],
        present: (value) => value,
        nativeIds: (value) => new Set([value.externalSessionId as string]),
        forget: vi.fn(),
        refreshActivity: async () => undefined,
        externalActivity: () => undefined,
        isWatching: () => false,
        invalidateHistory: () => undefined,
        invalidateWorkspaceSessions: (workspaceId) => invalidated.push(workspaceId),
        history: async () => ({ turns: [], nextCursor: null }),
        emitSession: () => undefined
      });

      await expect(service.operations()['session.remove']!({ sessionId: failed.id })).rejects.toBe(
        failure
      );
      expect(nativeRemoved).toEqual([failed.id]);
      expect(invalidated).toEqual([workspace.id]);
      expect(database.getSessionRecord(failed.id)).toBeDefined();
    } finally {
      database.close();
    }
  });

  it('records an actual native deletion failure and continues with other candidates', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    nodeLog.mockReset();
    const database = new NodeDatabase(':memory:', 'session-catalog-cleanup-failure');
    const workspace = database.saveWorkspace({
      id: 'workspace-1',
      path: '/workspace/cleanup',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const failed = session('failed', workspace.id, now - 31 * DAY_MS);
    const deleted = session('deleted', workspace.id, now - 31 * DAY_MS);
    const runtime = new NodeRuntimeState(
      () => 'node-1',
      (id) => database.getWorkspace(id),
      () => now
    );
    const service = new SessionCatalogService({
      runnerAvailable: () => true,
      database: () => database,
      nodeId: () => 'node-1',
      runtime,
      runners: {
        require: () => ({
          removeNative: async (value: NodeAgentSession) => {
            if (value.id === failed.id) {
              const error = new Error('EACCES: permission denied');
              Object.assign(error, { code: 'EACCES' });
              throw error;
            }
            return true;
          }
        })
      } as never,
      projection: {
        resolve: async () => undefined,
        projectionForNative: () => undefined,
        projectionsForNative: () => new Map()
      } as never,
      cachedNative: () => [],
      cachedWorkspace: async () => [],
      discoveryPending: () => false,
      discoverWorkspace: async () => [failed, deleted],
      present: (value) => value,
      nativeIds: (value) => new Set([value.externalSessionId as string]),
      forget: () => undefined,
      refreshActivity: async () => undefined,
      externalActivity: () => undefined,
      isWatching: () => false,
      invalidateHistory: () => undefined,
      invalidateWorkspaceSessions: () => undefined,
      history: async () => ({ turns: [], nextCursor: null }),
      emitSession: () => undefined
    });

    await expect(
      service.operations()['workspace.sessions.cleanup']!({
        workspaceId: workspace.id,
        inactiveDays: 30
      })
    ).resolves.toEqual({
      deleted: 1,
      skipped: 0,
      failed: 1,
      deletedByRunner: { 'claude-code': 1 }
    });
    expect(nodeLog).toHaveBeenCalledWith('workspace.session.cleanup.failed', {
      workspaceId: workspace.id,
      sessionId: failed.id,
      runner: failed.runner,
      errorCode: 'EACCES',
      error: 'EACCES: permission denied'
    });
  });
});
