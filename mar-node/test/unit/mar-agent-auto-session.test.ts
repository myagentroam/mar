import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeDatabase } from '../../src/database.js';
import { NodeConnector } from '../../src/connector.js';
import type { NodeRuntimeState } from '../../src/runtime-state.js';
import type { NativeSessionProjectionService } from '../../src/session/native-session-projection-service.js';
import type { GoalRuntime } from '../../src/service/goal-runtime.js';
import type { ContinuousRunCoordinator } from '../../src/service/continuous-run-coordinator.js';
import type { RunEventService } from '../../src/service/run-event-service.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mar-auto-session-')));
  const database = new NodeDatabase(':memory:', 'node-auto-session');
  const workspace = database.saveWorkspace({ path: root, kind: 'DIRECTORY', gitSummary: null });
  const connector = new NodeConnector({
    configPath: join(root, 'node.json'),
    config: { serverUrl: 'http://127.0.0.1:1', allowedRoots: [root] },
    reconnect: false,
    database,
    capabilities: {
      platform: 'linux',
      architecture: 'x64',
      nodeVersion: process.version,
      codex: { available: false },
      claudeCode: { available: false },
      marAgent: { available: true, version: '0.10.25' }
    }
  });
  cleanup.push(async () => {
    await connector.stop();
    await rm(root, { recursive: true, force: true });
  });
  const internals = connector as unknown as {
    runtime: NodeRuntimeState;
    nativeSessionProjectionService: NativeSessionProjectionService;
    executeNodeOperation(operation: string, data: unknown): Promise<{ session: { id: string } }>;
  };
  const create = (access?: string) =>
    internals.executeNodeOperation('session.create', {
      workspaceId: workspace.id,
      runner: 'mar-agent',
      cwd: root,
      modelId: 'model-1',
      effort: '',
      ...(access ? { access } : {})
    });
  return { ...internals, internals, create };
}

describe('MAR Auto session boundaries', () => {
  it('defaults new sessions to Auto, accepts explicit Full access, and rejects unknown modes', async () => {
    const f = await fixture();
    const automatic = await f.create();
    const full = await f.create('full-access');
    expect(f.internals.runtime.getAgentSession(automatic.session.id)?.access).toBe('auto');
    expect(f.internals.runtime.getAgentSession(full.session.id)?.access).toBe('full-access');
    await expect(f.create('on-request')).rejects.toThrow('SESSION_INVALID');
    await f.internals.executeNodeOperation('session.config.update', {
      sessionId: full.session.id,
      modelId: 'model-1',
      effort: '',
      access: 'auto'
    });
    expect(f.internals.runtime.getAgentSession(full.session.id)?.access).toBe('auto');
  });

  it('preserves saved mode on resume and keeps missing legacy mode as Full access', async () => {
    const f = await fixture();
    const { session } = await f.create('auto');
    const stored = f.internals.runtime.getAgentSession(session.id)!;
    expect(f.internals.nativeSessionProjectionService.resumedConfiguration(stored).access).toBe(
      'auto'
    );
    expect(
      f.internals.nativeSessionProjectionService.resumedConfiguration({
        ...stored,
        access: 'full-access'
      }).access
    ).toBe('full-access');
    expect(
      f.internals.nativeSessionProjectionService.resumedConfiguration({ ...stored, access: null })
        .access
    ).toBe('full-access');
  });

  it('does not elevate Auto when entering Goal mode', async () => {
    const f = await fixture();
    const { session } = await f.create('auto');
    await f.internals.executeNodeOperation('session.command.execute', {
      sessionId: session.id,
      commandId: 'goal',
      input: '/goal'
    });
    expect(f.internals.runtime.getAgentSession(session.id)?.access).toBe('auto');
  });

  it('stops an active Goal and accepts ordinary input as an intervention without changing the objective', async () => {
    const f = await fixture();
    const { session } = await f.create('auto');
    const stored = f.internals.runtime.getAgentSession(session.id)!;
    const internals = f.internals as unknown as {
      goalRuntime: GoalRuntime;
      continuousRunCoordinator: ContinuousRunCoordinator<never>;
      runEventService: RunEventService;
      goalCoordinator: { goalContinuationPending: Map<string, unknown> };
      sessionMessageService: {
        options: {
          goalMessage(
            session: unknown,
            content: string,
            intent: string
          ): { activated: boolean; runnerContent: string } | undefined;
        };
      };
    };
    await f.internals.executeNodeOperation('session.command.execute', {
      sessionId: session.id,
      commandId: 'goal',
      input: '/goal'
    });
    const goal = internals.goalRuntime.start(session.id, 'Update only the shared target.');
    const accepted = internals.continuousRunCoordinator.accept({
      runId: 'goal-auto-run',
      sessionId: session.id,
      clientMessageId: 'goal-auto',
      content: 'Goal Start'
    });
    internals.continuousRunCoordinator.prepare(accepted.run.id, {
      runId: accepted.run.id,
      sessionId: session.id,
      workspaceId: stored.workspaceId,
      executionContext: { runner: 'mar-agent' },
      input: 'Goal Start',
      clientMessageId: 'goal-auto',
      attachments: [],
      attachmentPaths: [],
      cwd: stored.cwd,
      externalSessionId: null,
      modelId: 'model-1',
      effort: '',
      access: 'auto',
      collaborationMode: 'default',
      secretEnvironment: {},
      goal: { id: goal.id, revision: goal.revision, epoch: 0 }
    });
    const execution = f.internals.runtime.createExecution(accepted.run.id);
    internals.runEventService.emit(
      execution.id,
      'run.completed',
      {
        permissionStop: {
          action: 'ask',
          reason: 'Confirm this Code Mode call.',
          source: {
            sessionId: session.id,
            executionId: execution.id,
            callId: 'call',
            toolName: 'code_exec'
          }
        }
      },
      'INTERRUPTED'
    );
    expect(f.internals.runtime.activeSessionRun(session.id)).toBeUndefined();
    expect(f.internals.runtime.sessionQueue(session.id).paused).toBe(true);
    expect(internals.goalCoordinator.goalContinuationPending.size).toBe(0);
    expect(internals.goalRuntime.get(session.id)).toMatchObject({
      id: goal.id,
      status: 'active',
      objective: goal.objective
    });
    const intervention = internals.sessionMessageService.options.goalMessage(
      stored,
      'allow',
      'SEND'
    );
    expect(intervention).toMatchObject({ activated: false });
    expect(intervention?.runnerContent).toContain('allow');
    expect(internals.goalRuntime.get(session.id)?.objective).toBe(goal.objective);
  });
});
