import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeRuntimeState } from '../../src/runtime-state.js';
import { CommandStateStore } from '../../src/runner-command-engine.js';
import { RunnerRegistry } from '../../src/runner/runner-registry.js';
import { MarAgentRunner } from '../../src/runner/mar-agent-runner.js';
import { ContinuousRunCoordinator } from '../../src/service/continuous-run-coordinator.js';
import { GoalRuntime } from '../../src/service/goal-runtime.js';
import { RunAttachmentService } from '../../src/service/run-attachment-service.js';
import { SessionMessageService } from '../../src/session/session-message-service.js';
import { RestartSessionRestorer } from '../../src/service/restart-session-restorer.js';
import {
  PlannedRestartHandoff,
  RESTART_NOTICE,
  type RestartSession
} from '../../src/service/planned-restart-handoff.js';
import { parseComposerTags } from '@myagentroam/protocol';
import type { RunnerImageAttachment } from '../../src/service/run-attachment-service.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture(parentSessionId?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'mar-restart-inputs-'));
  const runtime = new NodeRuntimeState(
    () => 'node',
    (id) => ({
      id,
      path: directory,
      kind: 'DIRECTORY',
      gitSummary: null,
      createdAt: 1,
      updatedAt: 1
    })
  );
  if (parentSessionId)
    runtime.createAgentSession({
      workspaceId: 'workspace',
      runner: 'mar-agent',
      externalSessionId: parentSessionId,
      cwd: directory,
      modelId: 'model',
      effort: 'high',
      access: 'auto'
    });
  const session = runtime.createAgentSession({
    workspaceId: 'workspace',
    runner: 'mar-agent',
    externalSessionId: 'session',
    ...(parentSessionId ? { parentSessionId } : {}),
    cwd: directory,
    modelId: 'model',
    effort: 'high',
    access: 'auto'
  });
  const goals = new GoalRuntime(vi.fn());
  const commands = new CommandStateStore();
  const control = vi.fn<(operation: string, input: Record<string, unknown>) => void>();
  const coordinator = new ContinuousRunCoordinator<RunnerImageAttachment>({
    executionTerminating: () => undefined,
    keepRunActive: () => false,
    runtime,
    emitQueue: vi.fn(),
    emitConversation: vi.fn(),
    clearImages: vi.fn(),
    cleanupAttachments: vi.fn(),
    migrateAssets: vi.fn(),
    emitRun: vi.fn(),
    control,
    stopped: () => false,
    markInterrupted: vi.fn(),
    mcps: () => [],
    goalActive: (id) => goals.get(id)?.status === 'active'
  });
  const attachments = new RunAttachmentService(
    () => [],
    () => true,
    () => directory
  );
  const runner = new MarAgentRunner(directory);
  const authorizedModels = [
    {
      id: 'model',
      name: 'Model',
      protocol: 'OPENAI_RESPONSES',
      baseUrl: 'https://example.test',
      modelId: 'model',
      contextWindowTokens: 200_000,
      maxOutputTokens: 4096,
      inputCapabilities: ['TEXT'],
      outputCapabilities: ['TEXT'],
      reasoningEfforts: ['high'],
      hostedWebSearch: false,
      enabled: true,
      sortOrder: 0,
      conversationModel: true,
      subagentModel: true
    }
  ];
  const messages = new SessionMessageService({
    runtime,
    coordinator,
    commands,
    attachments,
    uploads: {} as never,
    runners: new RunnerRegistry([runner]),
    resolve: async () => ({ session: runtime.getAgentSession(session.id)! }),
    workspacePath: () => directory,
    present: (value) => value,
    emitSession: vi.fn(),
    channelToken: () => undefined,
    goalMessage: () => undefined,
    prepareGoalInsertion: () => true,
    goalPreparationFailed: vi.fn()
  });
  const execution = {
    secretEnvironment: { FRESH_SECRET: 'new-value' },
    executionContext: runner.prepareExecutionContext({ marAgentModels: authorizedModels }),
    initiatedByUserId: 7
  };
  const inputState = vi.fn(
    async () => 'interrupted' as 'interrupted' | 'completed' | 'missing' | 'paused'
  );
  const restorer = new RestartSessionRestorer({
    runtime,
    goals,
    commands,
    coordinator,
    messages,
    resolve: async () => session,
    inputState,
    withGrant: (_context, work) => work(),
    goalReference: (sessionId) => {
      const goal = goals.get(sessionId)!;
      return { id: goal.id, revision: goal.revision, epoch: 19 };
    },
    publishGoal: vi.fn(),
    publishQueue: vi.fn()
  });
  const entry: RestartSession = {
    session: {
      id: session.id,
      workspaceId: session.workspaceId,
      cwd: directory,
      modelId: 'model',
      effort: 'high',
      access: 'auto'
    },
    execution,
    paused: false,
    plan: false,
    awaitingGoal: false,
    queue: [],
    current: {
      id: 'old-input',
      clientMessageId: 'old-client',
      content: 'original request',
      execution,
      attachments: [],
      immediate: false
    }
  };
  cleanups.push(async () => {
    coordinator.clear();
    attachments.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    runtime,
    session,
    goals,
    commands,
    coordinator,
    messages,
    execution,
    inputState,
    restorer,
    entry,
    control
  };
}

describe('Orderly restart input reconstruction', () => {
  it('continues the original execution state without an initiating user or restart authorization', async () => {
    const f = await fixture();
    f.entry.current!.execution = { ...f.execution, initiatedByUserId: undefined };

    await f.restorer.restore(f.entry, 'handoff');

    await vi.waitFor(() => expect(f.control).toHaveBeenCalledOnce());
    expect(f.runtime.activeSessionRun('session')!.initiatedByUserId).toBeUndefined();
    expect(f.control.mock.calls[0]![1]).toMatchObject({
      secretEnvironment: f.execution.secretEnvironment,
      ...f.execution.executionContext
    });
  });

  it('uses the input origin without requiring a separate Session owner', async () => {
    const f = await fixture();

    await f.restorer.restore(f.entry, 'handoff');

    await vi.waitFor(() => expect(f.control).toHaveBeenCalledOnce());
    expect(f.runtime.activeSessionRun('session')!.initiatedByUserId).toBe(7);
  });

  it('restores local command state without authorizing a new execution', async () => {
    const f = await fixture();
    delete f.entry.current;
    f.entry.awaitingGoal = true;

    await f.restorer.restore(f.entry, 'handoff');

    expect(f.commands.get('session', 'goal')?.active).toBe(true);
    expect(f.control).not.toHaveBeenCalled();
  });

  it('does not require initiating identity for an already completed input', async () => {
    const f = await fixture();
    delete f.entry.current!.execution;
    f.inputState.mockResolvedValue('completed');

    await f.restorer.restore(f.entry, 'handoff');

    expect(f.runtime.sessionQueue('session').itemIds).toEqual([]);
    expect(f.control).not.toHaveBeenCalled();
  });

  it('does not borrow a different execution context when a legacy input has none', async () => {
    const f = await fixture();
    delete f.entry.current!.execution;

    await expect(f.restorer.restore(f.entry, 'handoff')).rejects.toThrow(
      'RESTART_EXECUTION_CONTEXT_UNAVAILABLE'
    );

    expect(f.runtime.sessionQueue('session').itemIds).toEqual([]);
    expect(f.control).not.toHaveBeenCalled();
  });

  it('restores a managed child through its own normal handoff without resuming its parent', async () => {
    const f = await fixture('parent');
    await f.restorer.restore(f.entry, 'handoff');
    await vi.waitFor(() => expect(f.control).toHaveBeenCalledOnce());
    expect(f.control.mock.calls[0]).toMatchObject([
      'run.start',
      {
        sessionId: f.session.id,
        clientMessageId: 'restart:handoff:session'
      }
    ]);
    expect(f.runtime.getAgentSession(f.session.id)?.parentSessionId).toBe('parent');
    expect(f.runtime.activeSessionRun('parent')).toBeUndefined();
    expect(f.inputState).toHaveBeenCalledTimes(1);
  });
  it('uses a marked continuation with the original context instead of resending an accepted input', async () => {
    const f = await fixture();
    f.entry.current!.suppressNotifications = true;
    await f.restorer.restore(f.entry, 'handoff');
    await vi.waitFor(() => expect(f.control).toHaveBeenCalledOnce());
    expect(f.runtime.activeSessionRun('session')!.suppressNotifications).toBe(true);
    expect(f.control.mock.calls[0]).toMatchObject([
      'run.start',
      {
        sessionId: 'session',
        input: expect.stringContaining(RESTART_NOTICE),
        clientMessageId: 'restart:handoff:session',
        secretEnvironment: { FRESH_SECRET: 'new-value' },
        model: 'model',
        effort: 'high',
        access: 'auto'
      }
    ]);
    expect(parseComposerTags(f.control.mock.calls[0]![1].input as string)).toContainEqual(
      expect.objectContaining({ kind: 'mar_restart', payload: {} })
    );
    expect(f.control.mock.calls[0]![1].input).not.toContain('original request');
  });

  it('keeps a paused FIFO idle without creating a synthetic active Run', async () => {
    const f = await fixture();
    delete f.entry.current;
    f.entry.paused = true;
    f.entry.queue = [7, 7].map((owner, index) => ({
      id: `queue-${index}`,
      clientMessageId: `client-${index}`,
      content: `message-${index}`,
      attachments: [],
      execution: { ...f.execution, initiatedByUserId: owner },
      immediate: false
    }));
    f.entry.queue[0]!.suppressNotifications = true;
    await f.restorer.restore(f.entry, 'handoff');
    expect(f.runtime.activeSessionRun(f.session.id)).toBeUndefined();
    expect(f.runtime.sessionQueue(f.session.id)).toMatchObject({
      paused: true,
      itemIds: ['queue-0', 'queue-1']
    });
    expect(f.control).not.toHaveBeenCalled();
    expect(f.runtime.getQueueItem('queue-0')!.suppressNotifications).toBe(true);
    expect(f.runtime.getQueueItem('queue-1')!.suppressNotifications).toBeUndefined();
    f.coordinator.resume(f.session.id);
    await vi.waitFor(() => expect(f.control).toHaveBeenCalledOnce());
    expect(f.runtime.activeSessionRun('session')!.suppressNotifications).toBe(true);
    expect(f.control.mock.calls[0]![1]).toMatchObject({
      input: 'message-0',
      clientMessageId: 'client-0'
    });
  });

  it('reconstructs an unsubmitted input and its attachment without inserting a continuation', async () => {
    const f = await fixture();
    f.entry.current!.suppressNotifications = true;
    f.inputState.mockResolvedValue('missing');
    f.entry.current!.attachments = [
      { name: 'notes.txt', mime: 'text/plain', dataBase64: 'aGVsbG8=' }
    ];
    await f.restorer.restore(f.entry, 'handoff');
    await vi.waitFor(() => expect(f.control).toHaveBeenCalledOnce());
    expect(f.control.mock.calls[0]![1]).toMatchObject({
      clientMessageId: 'old-client',
      input: expect.stringContaining('original request')
    });
    expect(f.control.mock.calls[0]![1].input).not.toContain(RESTART_NOTICE);
    const run = f.runtime.activeSessionRun('session')!;
    expect(run.suppressNotifications).toBe(true);
    const prepared = f.coordinator.pending(f.runtime.currentExecutionId(run.id)!)!;
    expect(prepared.attachmentFiles).toMatchObject([{ name: 'notes.txt' }]);
    expect(await readFile(prepared.attachmentPaths[0]!, 'utf8')).toBe('hello');
  });

  it('does not rerun a completed input or a permission-stopped input automatically', async () => {
    const completed = await fixture();
    completed.inputState.mockResolvedValue('completed');
    await completed.restorer.restore(completed.entry, 'handoff');
    expect(completed.control).not.toHaveBeenCalled();
    expect(completed.runtime.activeSessionRun('session')).toBeUndefined();
    const paused = await fixture();
    paused.inputState.mockResolvedValue('paused');
    await paused.restorer.restore(paused.entry, 'handoff');
    expect(paused.control).not.toHaveBeenCalled();
    expect(paused.runtime.sessionQueue('session').paused).toBe(true);
  });

  it.each([true, false])(
    'restores the original Goal and FIFO with notification suppression %s',
    async (suppressNotifications) => {
      const f = await fixture();
      const submitGoal = vi.spyOn(f.messages, 'submitGoal');
      f.entry.suppressNotifications = suppressNotifications;
      f.goals.start('session', 'finish the feature');
      f.goals.recordTurn('session');
      f.goals.recordExecutionResult('session', { failed: true, progressed: false });
      f.entry.goal = {
        ...f.goals.restartState('session')!,
        goal: { ...f.goals.get('session')!, inputTags: '' }
      };
      f.goals.clear('session');
      f.entry.queue = [
        {
          id: 'ordinary',
          clientMessageId: 'ordinary',
          content: 'later',
          attachments: [],
          execution: f.execution,
          immediate: false
        }
      ];
      await f.restorer.restore(f.entry, 'handoff');
      expect(submitGoal).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          sessionId: 'session',
          restoreQueued: true,
          goal: { id: f.entry.goal.goal.id, revision: f.entry.goal.goal.revision, epoch: 19 }
        })
      );
      expect(f.goals.restartState('session')).toEqual(f.entry.goal);
      await vi.waitFor(() => expect(f.control).toHaveBeenCalledOnce());
      expect(f.control.mock.calls[0]![1].input).toContain('finish the feature');
      expect(f.control.mock.calls[0]![1].input).toContain(RESTART_NOTICE);
      expect(f.inputState).not.toHaveBeenCalled();
      expect(f.runtime.sessionQueue('session').itemIds).toEqual(['ordinary']);
      expect(f.runtime.activeSessionRun('session')!.suppressNotifications === true).toBe(
        suppressNotifications
      );
      expect(f.runtime.getQueueItem('ordinary')!.suppressNotifications).toBeUndefined();
    }
  );

  it('retains suppression when a restored paused Goal is handed off again before running', async () => {
    const f = await fixture();
    f.goals.start('session', 'finish the feature');
    f.entry.goal = {
      ...f.goals.restartState('session')!,
      goal: { ...f.goals.get('session')!, inputTags: '' }
    };
    f.goals.clear('session');
    f.entry.paused = true;
    f.entry.suppressNotifications = true;
    delete f.entry.current;
    await f.restorer.restore(f.entry, 'handoff');
    expect(f.runtime.activeSessionRun('session')).toBeUndefined();
    const writer = new PlannedRestartHandoff({
      directory: () => f.session.cwd,
      identity: () => ({ nodeId: 'node', serverUrl: 'https://server.example.test' }),
      credential: () => 'test-node-credential',
      runtime: f.runtime,
      goals: f.goals,
      coordinator: f.coordinator,
      commandActive: () => false,
      inputState: f.inputState,
      restore: async () => undefined,
      diagnose: vi.fn()
    });
    expect(writer.capture().sessions[0]!.suppressNotifications).toBe(true);
  });

  it('honors an accepted immediate replacement without resurrecting the replaced execution', async () => {
    const f = await fixture();
    f.entry.queue = [
      {
        id: 'replacement',
        clientMessageId: 'replacement',
        content: 'replace it',
        attachments: [],
        execution: f.execution,
        immediate: true
      }
    ];
    await f.restorer.restore(f.entry, 'handoff');
    await vi.waitFor(() => expect(f.control).toHaveBeenCalledOnce());
    expect(f.inputState).not.toHaveBeenCalled();
    expect(f.control.mock.calls[0]![1].input).toBe('replace it');
  });

  it('keeps a preparation failure paused', async () => {
    const failed = await fixture();
    failed.inputState.mockResolvedValue('missing');
    vi.spyOn(failed.messages, 'restoreQueued').mockRejectedValue(new Error('ATTACHMENT_MISSING'));
    await expect(failed.restorer.restore(failed.entry, 'handoff')).rejects.toThrow(
      'ATTACHMENT_MISSING'
    );
    expect(failed.runtime.sessionQueue('session').paused).toBe(true);
    expect(failed.control).not.toHaveBeenCalled();
  });

  it('preserves original FIFO ownership restrictions without requesting new authorization', async () => {
    const f = await fixture();
    delete f.entry.current;
    f.entry.queue = [7, 8].map((owner) => ({
      id: `queue-${owner}`,
      clientMessageId: `client-${owner}`,
      content: 'queued',
      attachments: [],
      execution: { ...f.execution, initiatedByUserId: owner },
      immediate: false
    }));
    await expect(f.restorer.restore(f.entry, 'handoff')).rejects.toThrow(
      'RUN_OWNED_BY_ANOTHER_USER'
    );
    expect(f.runtime.sessionQueue('session').paused).toBe(true);
    expect(f.control).not.toHaveBeenCalled();
  });
});
