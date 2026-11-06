import { describe, expect, it, vi } from 'vitest';
import { NodeDatabase } from '../../src/database.js';
import { NodeRuntimeState } from '../../src/runtime-state.js';
import { CommandStateStore } from '../../src/runner-command-engine.js';
import { CodexRunner } from '../../src/runner/codex-runner.js';
import { RunnerRegistry } from '../../src/runner/runner-registry.js';
import { hasManagedActiveRun } from '../../src/service/conversation-history-service.js';
import { composeSessionProjection } from '../../src/application/session-projection-composition.js';
import type { PresentedSession } from '../../src/session/session-presentation-service.js';
import { createTestSessionWatch } from './support/conversation-watch.js';

function fixture() {
  const database = new NodeDatabase(':memory:', 'session-presentation');
  const workspace = database.saveWorkspace({
    path: '/workspace/session-presentation',
    kind: 'DIRECTORY',
    gitSummary: null
  });
  const runtime = new NodeRuntimeState(
    () => 'node',
    (id) => database.getWorkspace(id)
  );
  const runner = new CodexRunner();
  const session = runtime.createAgentSession({
    workspaceId: workspace.id,
    runner: 'codex',
    cwd: workspace.path,
    externalSessionId: 'native-session',
    nativeControl: 'EXTERNAL',
    lastActivityAt: 10
  });
  const { presentation, native } = composeSessionProjection({
    database: () => database,
    nodeId: () => 'node',
    runtime,
    commands: new CommandStateStore(),
    runners: new RunnerRegistry([runner]),
    capabilities: () => ({
      platform: 'linux',
      architecture: 'x64',
      nodeVersion: process.version,
      codex: { available: true },
      claudeCode: { available: false }
    }),
    releaseResumeState: vi.fn()
  });
  const start = () => {
    runtime.setNativeControl(session.id, 'MAR_MANAGED');
    const run = runtime.createMessageRun({
      sessionId: session.id,
      clientMessageId: 'resume-message',
      content: 'Continue the existing session'
    }).run;
    runner.execution.runs.set(run.id, {
      sessionId: session.id,
      threadId: 'native-session',
      turnId: 'native-turn',
      cwd: session.cwd
    });
    return run;
  };
  return { database, runtime, runner, session, presentation, native, start };
}

describe('Current Session presentation', () => {
  it('uses current ownership for activity checks made with a pre-resume Session', () => {
    const f = fixture();
    try {
      expect(hasManagedActiveRun(f.runtime, f.session)).toBe(false);
      const run = f.start();
      expect(f.session.nativeControl).toBe('EXTERNAL');
      expect(hasManagedActiveRun(f.runtime, f.session)).toBe(true);
      f.runtime.transitionRun(run.id, 'RUNNING');
      expect(hasManagedActiveRun(f.runtime, f.session)).toBe(true);
      f.runtime.transitionRun(run.id, 'CANCELLING');
      expect(hasManagedActiveRun(f.runtime, f.session)).toBe(true);
      f.runtime.finishRun(run.id, 'INTERRUPTED');
      expect(hasManagedActiveRun(f.runtime, f.session)).toBe(false);
    } finally {
      f.database.close();
    }
  });

  it('publishes current ownership and activity without discarding newer discovery timestamps', () => {
    const f = fixture();
    try {
      f.start();
      const latest = f.runtime.getAgentSession(f.session.id)!;
      const lastActivityAt = latest.lastActivityAt + 100;
      const projected = f.presentation.present({
        ...f.session,
        lastActivityAt,
        externalDiscovered: true
      });
      expect(projected).toMatchObject({
        nativeControl: 'MAR_MANAGED',
        activity: 'MANAGED_ACTIVE',
        externalDiscovered: true,
        lastActivityAt
      });
      expect(projected.control.capabilities).not.toContain('turn.start');
      expect(projected.runtime.capabilities).toContain('turn.queue');
    } finally {
      f.database.close();
    }
  });

  it('keeps cached native activity consistent across list, selected Watch and terminal presentation', () => {
    const f = fixture();
    try {
      const run = f.start();
      f.runtime.transitionRun(run.id, 'RUNNING');
      const current = f.runtime.getAgentSession(f.session.id)!;
      const lastActivityAt = current.lastActivityAt + 150_000;
      const discovered = { ...f.session, lastActivityAt };
      f.native.remember([discovered]);
      const discover = vi.spyOn(f.runner, 'discoverSessions');
      expect(f.presentation.presentDiscovered([discovered])[0]).toMatchObject({
        activity: 'MANAGED_ACTIVE',
        lastActivityAt
      });
      for (const session of [f.session, current])
        expect(f.presentation.present(session)).toMatchObject({
          activity: 'MANAGED_ACTIVE',
          nativeControl: 'MAR_MANAGED',
          lastActivityAt
        });
      f.runtime.finishRun(run.id, 'SUCCEEDED');
      expect(f.presentation.present(f.runtime.getAgentSession(f.session.id)!)).toMatchObject({
        activity: 'IDLE',
        lastActivityAt
      });
      expect(discover).not.toHaveBeenCalled();
      expect(f.runtime.getAgentSession(f.session.id)?.lastActivityAt).toBe(current.lastActivityAt);
    } finally {
      f.database.close();
    }
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'does not replace known runtime activity with invalid cached activity %s',
    (lastActivityAt) => {
      const f = fixture();
      try {
        f.native.remember([{ ...f.session, lastActivityAt }]);
        expect(f.presentation.present(f.session).lastActivityAt).toBe(f.session.lastActivityAt);
      } finally {
        f.database.close();
      }
    }
  );

  it('uses replaced native and runtime activity after an explicit history rollback', () => {
    const f = fixture();
    try {
      f.native.remember([{ ...f.session, lastActivityAt: 1000 }]);
      expect(f.presentation.present(f.session).lastActivityAt).toBe(1000);
      const rolledBack = f.runtime.resetAgentSessionHistory(f.session.id, 5);
      f.native.remember([rolledBack]);
      expect(f.presentation.present(rolledBack).lastActivityAt).toBe(5);
    } finally {
      f.database.close();
    }
  });

  it.each(['runner', 'workspace', 'list'] as const)(
    'rejects late discovery activity after rollback through the %s entry',
    async (entry) => {
      const f = fixture();
      try {
        const stale = { ...f.session, lastActivityAt: 1000 };
        f.native.remember([stale]);
        let releaseRead!: () => void;
        const discover = vi.spyOn(f.runner, 'discoverSessions').mockImplementation(
          () =>
            new Promise((resolve) => {
              releaseRead = () => resolve([stale]);
            })
        );
        const pending =
          entry === 'runner'
            ? f.native.discover('codex', f.session.workspaceId)
            : entry === 'workspace'
              ? f.native.discoverWorkspace(f.session.workspaceId)
              : f.native.list();
        const rolledBack = f.runtime.resetAgentSessionHistory(f.session.id, 5);
        f.native.remember([rolledBack]);
        releaseRead();
        expect(await pending).toMatchObject([{ lastActivityAt: 5 }]);
        expect(f.presentation.present(rolledBack).lastActivityAt).toBe(5);
        expect(f.native.cachedNative()).toMatchObject([{ lastActivityAt: 5 }]);
        discover.mockResolvedValue([{ ...rolledBack, lastActivityAt: 6 }]);
        await f.native.discover('codex', f.session.workspaceId);
        expect(f.presentation.present(rolledBack).lastActivityAt).toBe(6);
      } finally {
        f.database.close();
      }
    }
  );

  it.each([{ workspaceId: 'another-workspace' }, { runner: 'mar-agent' as const }])(
    'does not borrow cached activity from a different identity %j',
    (identity) => {
      const f = fixture();
      try {
        if (identity.workspaceId !== undefined)
          f.database.saveWorkspace({
            id: identity.workspaceId,
            path: '/another-workspace',
            kind: 'DIRECTORY',
            gitSummary: null
          });
        f.native.remember([{ ...f.session, ...identity, lastActivityAt: 1000 }]);
        expect(f.presentation.present(f.session).lastActivityAt).toBe(f.session.lastActivityAt);
      } finally {
        f.database.close();
      }
    }
  );

  it('keeps a completed Runner batch from overwriting history during Workspace aggregation', async () => {
    const f = fixture();
    try {
      vi.spyOn(f.runner, 'discoverSessions').mockResolvedValue([
        { ...f.session, lastActivityAt: 1000 }
      ]);
      const sessions = await f.native.discoverWorkspace(f.session.workspaceId, () => {
        const rolledBack = f.runtime.resetAgentSessionHistory(f.session.id, 5);
        f.native.remember([rolledBack]);
      });
      expect(sessions).toMatchObject([{ lastActivityAt: 5 }]);
      expect(f.native.cachedNative()).toMatchObject([{ lastActivityAt: 5 }]);
    } finally {
      f.database.close();
    }
  });

  it('keeps the newer concurrent discovery when an older native snapshot completes last', async () => {
    const f = fixture();
    try {
      let finishOlder!: () => void;
      vi.spyOn(f.runner, 'discoverSessions')
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finishOlder = () => resolve([{ ...f.session, lastActivityAt: 1000 }]);
            })
        )
        .mockResolvedValueOnce([{ ...f.session, lastActivityAt: 2000 }]);
      const older = f.native.discover('codex', f.session.workspaceId);
      expect(await f.native.discover('codex', f.session.workspaceId)).toMatchObject([
        { lastActivityAt: 2000 }
      ]);
      finishOlder();
      expect(await older).toMatchObject([{ lastActivityAt: 2000 }]);
      expect(f.presentation.present(f.session).lastActivityAt).toBe(2000);
    } finally {
      f.database.close();
    }
  });

  it('includes native activity reached through a Runner-owned alias', () => {
    const f = fixture();
    try {
      vi.spyOn(f.runner, 'nativeAliasesFor').mockReturnValue(['native-alias']);
      f.native.remember([
        {
          ...f.session,
          id: 'native-alias',
          externalSessionId: 'native-alias',
          lastActivityAt: 1000
        }
      ]);
      expect(f.presentation.present(f.session).lastActivityAt).toBe(1000);
    } finally {
      f.database.close();
    }
  });

  it('converges a resumed Codex Watch before releasing its active Run events', async () => {
    const f = fixture();
    let releaseRead!: () => void;
    const pendingRead = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const snapshots: PresentedSession[] = [];
    const events: unknown[] = [];
    const readPage = vi.fn(async () => {
      if (hasManagedActiveRun(f.runtime, f.session)) await pendingRead;
      return { source: 'runtime' as const, turns: [] };
    });
    const watch = createTestSessionWatch({
      resolve: async () => f.runtime.getAgentSession(f.session.id),
      managedActive: (session) => hasManagedActiveRun(f.runtime, session),
      refreshActivity: async () => undefined,
      present: (session) => f.presentation.present(session),
      readPage,
      projectInitialPage: (session) => {
        const projected = f.presentation.present(session);
        snapshots.push(projected);
        return { session: projected };
      },
      emitSession: vi.fn(),
      emitPage: vi.fn(),
      emitWatchEvent: (event) => events.push(event)
    });
    try {
      await watch.operations()['session.watch']!({
        sessionId: f.session.id,
        workbenchConnectionId: 'browser',
        watchId: 'watch',
        mode: 'initial',
        unit: 'SEGMENT'
      });
      await vi.waitFor(() => expect(snapshots).toHaveLength(1));
      expect(snapshots[0]?.activity).toBe('IDLE');
      const run = f.start();
      events.length = 0;
      watch.emitRealtime(f.session.id, {
        sequence: 1,
        category: 'run',
        payload: { run }
      });
      await vi.waitFor(() => expect(readPage).toHaveBeenCalledTimes(2));
      expect(events).toHaveLength(0);
      f.runtime.updateAgentSessionAccess(f.session.id, 'workspace-write');
      const lastActivityAt = f.runtime.getAgentSession(f.session.id)!.lastActivityAt + 150_000;
      f.native.remember([{ ...f.session, lastActivityAt }]);
      releaseRead();
      await vi.waitFor(() => expect(snapshots).toHaveLength(2));
      expect(snapshots[1]).toMatchObject({
        nativeControl: 'MAR_MANAGED',
        activity: 'MANAGED_ACTIVE',
        access: 'workspace-write',
        lastActivityAt
      });
      expect(events).toMatchObject([
        { type: 'watch.session.snapshot', payload: { session: { activity: 'MANAGED_ACTIVE' } } },
        { type: 'watch.session.event', event: { category: 'run' } }
      ]);
    } finally {
      releaseRead();
      watch.clear();
      f.database.close();
    }
  });
});
