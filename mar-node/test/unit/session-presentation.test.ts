import { describe, expect, it, vi } from 'vitest';
import { NodeDatabase } from '../../src/database.js';
import { NodeRuntimeState } from '../../src/runtime-state.js';
import { CommandStateStore } from '../../src/runner-command-engine.js';
import { CodexRunner } from '../../src/runner/codex-runner.js';
import { RunnerRegistry } from '../../src/runner/runner-registry.js';
import { hasManagedActiveRun } from '../../src/service/conversation-history-service.js';
import {
  SessionPresentationService,
  type PresentedSession
} from '../../src/service/session-presentation-service.js';
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
  const presentation = new SessionPresentationService({
    database: () => database,
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
    hasManagedActiveRun: (value) => hasManagedActiveRun(runtime, value),
    projectionForNative: () => runtime.getAgentSession(session.id)
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
  return { database, runtime, runner, session, presentation, start };
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
      releaseRead();
      await vi.waitFor(() => expect(snapshots).toHaveLength(2));
      expect(snapshots[1]).toMatchObject({
        nativeControl: 'MAR_MANAGED',
        activity: 'MANAGED_ACTIVE',
        access: 'workspace-write'
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
