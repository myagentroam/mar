import { withNonImageAttachmentPrompt } from '../../src/util/node-operation-parsers.js';
import { MarAgentRunner } from '../../src/runner/mar-agent-runner.js';
import { describe, expect, it, vi } from 'vitest';
import { NodeRuntimeState } from '../../src/runtime-state.js';
import {
  ContinuousRunCoordinator,
  type PreparedExecutionInput
} from '../../src/service/continuous-run-coordinator.js';
import type { ResolvedMcpServer } from '../../src/mcp/model.js';
import { resolveNotificationCapability } from '../../src/service/notification-mcp-bridge.js';
import { RunWorkbenchService } from '../../src/service/run-workbench-service.js';
import { WorkspaceQueueWorkbenchService } from '../../src/service/workspace-queue-workbench-service.js';
import { ConversationHistoryService } from '../../src/service/conversation-history-service.js';
import { ConversationSegmentService } from '../../src/service/conversation-segment-service.js';
import type { RunnerName } from '@myagentroam/protocol';

function fixture(runner: RunnerName = 'codex') {
  let now = 100;
  const runtime = new NodeRuntimeState(
    () => 'node-1',
    (id) =>
      id === 'workspace-1'
        ? {
            id,
            path: '/workspace',
            kind: 'DIRECTORY',
            gitSummary: null,
            createdAt: 1,
            updatedAt: 1
          }
        : undefined,
    () => now++
  );
  const session = runtime.createAgentSession({
    workspaceId: 'workspace-1',
    runner,
    cwd: '/workspace'
  });
  return { runtime, session };
}

describe('Node Runtime history boundaries', () => {
  it('guards queued history mutations without consuming accepted inputs', () => {
    const { runtime, session } = fixture();
    const message = { sessionId: session.id, clientMessageId: 'retained', content: 'keep me' };
    const queued = runtime.createQueueItem(message).item;
    runtime.pauseSessionQueue(session.id);
    const before = runtime.sessionQueue(session.id);
    expect(() => runtime.beginSessionHistoryMutation(session.id)).toThrow(
      'SESSION_QUEUE_NOT_EMPTY'
    );
    const release = runtime.beginSessionHistoryMutation(session.id, { allowQueued: true });
    try {
      expect(() => runtime.beginSessionHistoryMutation(session.id, { allowQueued: true })).toThrow(
        'SESSION_ACTIVE'
      );
      expect(() => runtime.createMessageRun({ ...message, clientMessageId: 'racing-run' })).toThrow(
        'SESSION_ACTIVE'
      );
      expect(() =>
        runtime.createQueueItem({ ...message, clientMessageId: 'racing-queue' })
      ).toThrow('SESSION_ACTIVE');
      expect(() => runtime.startRunFromQueueItem(queued.id)).toThrow('SESSION_ACTIVE');
      expect(runtime.sessionQueue(session.id)).toEqual(before);
      expect(runtime.getQueueItem(queued.id)).toEqual(queued);
      expect(runtime.listRunsForSession(session.id)).toEqual([]);
      const other = runtime.createAgentSession({
        workspaceId: session.workspaceId,
        runner: session.runner,
        cwd: session.cwd
      });
      expect(runtime.createMessageRun({ ...message, sessionId: other.id }).created).toBe(true);
    } finally {
      release();
    }
    release();
    const nextRelease = runtime.beginSessionHistoryMutation(session.id, { allowQueued: true });
    release();
    expect(() => runtime.startRunFromQueueItem(queued.id)).toThrow('SESSION_ACTIVE');
    nextRelease();
    expect(runtime.createQueueItem(message)).toEqual({ item: queued, created: false });
    const started = runtime.startRunFromQueueItem(queued.id);
    expect(started.run.clientMessageId).toBe(message.clientMessageId);
    expect(runtime.sessionQueue(session.id).itemIds).toEqual([]);
    expect(() => runtime.beginSessionHistoryMutation(session.id, { allowQueued: true })).toThrow(
      'SESSION_ACTIVE'
    );
  });

  it('retains prepared queue inputs and environment leases when history mutation rejects resume', async () => {
    const { runtime, session } = fixture();
    const released = vi.fn();
    const coordinator = new ContinuousRunCoordinator({
      runtime,
      emitQueue: vi.fn(),
      emitConversation: vi.fn(),
      clearImages: vi.fn(),
      cleanupAttachments: vi.fn(),
      migrateAssets: vi.fn(),
      emitRun: vi.fn(),
      control: vi.fn(),
      stopped: () => false,
      markInterrupted: vi.fn(),
      mcps: () => [],
      retainEnvironment: () => released
    });
    runtime.pauseSessionQueue(session.id);
    const message = {
      runId: 'prepared-queue',
      sessionId: session.id,
      clientMessageId: 'prepared-message',
      content: 'keep prepared input'
    };
    const item = runtime.createQueueItem(message).item;
    const input = prepared(item.id, session.id);
    coordinator.prepare(item.id, input);
    const release = runtime.beginSessionHistoryMutation(session.id, { allowQueued: true });
    try {
      await expect(coordinator.resume(session.id)).rejects.toThrow('SESSION_ACTIVE');
      expect(runtime.activeSessionRun(session.id)).toBeUndefined();
      expect(runtime.getQueueItem(item.id)).toEqual(item);
      expect(coordinator.pending(item.id)).toBe(input);
      expect(released).not.toHaveBeenCalled();
    } finally {
      release();
    }
    try {
      await coordinator.resume(session.id);
      expect(runtime.activeSessionRun(session.id)?.clientMessageId).toBe(message.clientMessageId);
      expect(runtime.sessionQueue(session.id).itemIds).toEqual([]);
      expect(released).not.toHaveBeenCalled();
    } finally {
      coordinator.clear();
    }
    expect(released).toHaveBeenCalledOnce();
  });

  it('looks up a known Run only within its owning Session after identity promotion', () => {
    const { runtime, session } = fixture();
    const unrelated = runtime.createMessageRun({
      sessionId: session.id,
      clientMessageId: 'unrelated-message',
      content: 'unrelated message'
    }).run;
    const target = runtime.createAgentSession({
      workspaceId: session.workspaceId,
      runner: session.runner,
      cwd: session.cwd
    });
    const run = runtime.createMessageRun({
      sessionId: target.id,
      clientMessageId: 'target-message',
      content: 'target message'
    }).run;
    const execution = runtime.createExecution(run.id);
    const promoted = runtime.promoteSessionIdentity(target.id, 'lookup-native-session');
    const expected = runtime.listConversationTurns({ sessionId: promoted.id }).turns[0]!;
    const unrelatedTurn = runtime.listConversationTurns({ sessionId: session.id }).turns[0]!;
    const readUnrelatedRunId = vi.fn(() => unrelated.id);
    Object.defineProperty(unrelatedTurn, 'runId', { get: readUnrelatedRunId });

    expect(runtime.conversationTurnForRun(run.id)).toBe(expected);
    expect(runtime.conversationTurnForRun(execution.id)).toBe(expected);
    expect(readUnrelatedRunId).not.toHaveBeenCalled();
  });

  it('returns no Turn for an adopted Run until its first ConversationItem', () => {
    const { runtime, session } = fixture();
    const run = runtime.adoptRun({
      runId: 'adopted-run',
      sessionId: session.id,
      workspaceId: session.workspaceId,
      runner: session.runner,
      cwd: session.cwd
    });
    expect(runtime.conversationTurnForRun(run.id)).toBeUndefined();
    runtime.recordCommandExecution({
      sessionId: session.id,
      command: 'pwd',
      cwd: session.cwd,
      outputPreview: session.cwd
    });
    expect(runtime.conversationTurnForRun(run.id)).toBeUndefined();

    runtime.appendRunEvent({
      runId: run.id,
      sequence: 1,
      eventType: 'conversation.item',
      payload: {
        itemId: 'first-reply',
        kind: 'assistant_message',
        status: 'IN_PROGRESS',
        payload: { text: 'first reply' }
      }
    });

    expect(runtime.conversationTurnForRun(run.id)).toMatchObject({
      runId: run.id,
      items: [expect.objectContaining({ payload: { text: 'first reply' } })]
    });
  });

  it('keeps retained Turns queryable after terminal Run metadata eviction and promotion', () => {
    const { runtime, session } = fixture();
    const retained = runtime.createMessageRun({
      sessionId: session.id,
      clientMessageId: 'retained-message',
      content: 'retained history'
    }).run;
    runtime.finishRun(retained.id, 'SUCCEEDED');
    runtime.removeTerminalRun(retained.id);
    const other = runtime.createAgentSession({
      workspaceId: session.workspaceId,
      runner: session.runner,
      cwd: session.cwd
    });
    for (let index = 0; index < 1_024; index += 1) {
      const run = runtime.createMessageRun({
        sessionId: other.id,
        clientMessageId: String(index),
        content: 'other history'
      }).run;
      runtime.finishRun(run.id, 'SUCCEEDED');
      runtime.removeTerminalRun(run.id);
    }
    expect(runtime.listRunsForSession(session.id, { includeTerminal: true })).toEqual([]);
    const promoted = runtime.promoteSessionIdentity(session.id, 'retained-native-session');

    expect(runtime.conversationTurnForRun(retained.id)).toMatchObject({
      runId: retained.id,
      sessionId: promoted.id,
      status: 'SUCCEEDED'
    });
  });

  it.each(['mar-agent', 'codex', 'claude-code', 'opencode'] as const)(
    'does not advertise earlier history after promoting a complete new-session window (%s)',
    async (runner) => {
      const { runtime, session } = fixture(runner);
      const promoted = runtime.promoteSessionIdentity(session.id, 'new-native-session');
      runtime.createMessageRun({
        sessionId: promoted.id,
        clientMessageId: 'new-message',
        content: 'first message'
      });
      const history = new ConversationHistoryService({
        runtime,
        runners: {} as never,
        capabilities: () => ({}) as never,
        attachments: {} as never,
        snapshotSequence: () => 1,
        hasManagedActiveRun: () => true,
        setExternalActivity: vi.fn()
      });
      const readOfficial = vi.spyOn(history, 'readOfficial');
      const segments = new ConversationSegmentService((target, input) =>
        history.read(target, input)
      );
      const page = await segments.read(promoted, { limit: 10 });
      expect(page.segments).toHaveLength(1);
      expect(page.nextCursor).toBeNull();
      expect(
        segments.projectInitial(promoted, await history.read(promoted, { limit: 10 }), 10)
          .nextCursor
      ).toBeNull();
      expect(readOfficial).not.toHaveBeenCalled();
    }
  );

  it('pages through local new-session Segments without advertising a native-history tail', async () => {
    const { runtime, session } = fixture('mar-agent');
    const promoted = runtime.promoteSessionIdentity(session.id, 'local-history-session');
    for (let index = 0; index < 3; index += 1) {
      const run = runtime.createMessageRun({
        sessionId: promoted.id,
        clientMessageId: `local-message-${index}`,
        content: `local message ${index}`
      }).run;
      if (index < 2) runtime.finishRun(run.id, 'INTERRUPTED');
    }
    const history = new ConversationHistoryService({
      runtime,
      runners: {} as never,
      capabilities: () => ({}) as never,
      attachments: {} as never,
      snapshotSequence: () => 1,
      hasManagedActiveRun: () => true,
      setExternalActivity: vi.fn()
    });
    const readOfficial = vi.spyOn(history, 'readOfficial');
    const segments = new ConversationSegmentService((target, input) => history.read(target, input));
    let cursor: string | null = null;
    for (let index = 2; index >= 0; index -= 1) {
      const page = await segments.read(promoted, {
        limit: 1,
        ...(cursor === null ? {} : { cursor })
      });
      expect(page.segments).toHaveLength(1);
      expect(page.segments[0]?.items[0]?.payload).toMatchObject({ text: `local message ${index}` });
      cursor = page.nextCursor;
      if (index > 0) expect(cursor).not.toBeNull();
      else expect(cursor).toBeNull();
    }
    expect(readOfficial).not.toHaveBeenCalled();
  });

  it.each(['SESSION', 'WORKSPACE'] as const)(
    'releases history completeness with the %s lifecycle',
    (target) => {
      const { runtime, session } = fixture();
      const promoted = runtime.promoteSessionIdentity(session.id, 'reused-native-session');
      const run = runtime.createMessageRun({
        sessionId: promoted.id,
        clientMessageId: 'removed-history',
        content: 'removed history'
      }).run;
      runtime.finishRun(run.id, 'SUCCEEDED');
      runtime.removeTerminalRun(run.id);
      expect(runtime.conversationTurnForRun(run.id)?.runId).toBe(run.id);
      if (target === 'SESSION') runtime.removeAgentSession(promoted.id);
      else runtime.removeWorkspace(session.workspaceId);
      expect(runtime.conversationTurnForRun(run.id)).toBeUndefined();
      const resumed = runtime.createAgentSession({
        workspaceId: session.workspaceId,
        runner: session.runner,
        cwd: session.cwd,
        externalSessionId: promoted.id,
        nativeControl: 'MAR_MANAGED'
      });
      expect(runtime.listConversationTurns({ sessionId: resumed.id }).historyComplete).toBe(false);
    }
  );

  it('preserves native pagination for resumed sessions and evicted Runtime history', async () => {
    const { runtime, session } = fixture();
    const promoted = runtime.promoteSessionIdentity(session.id, 'bounded-native-session');
    const resumed = runtime.createAgentSession({
      workspaceId: 'workspace-1',
      runner: 'codex',
      cwd: '/workspace',
      externalSessionId: 'resumed-native-session',
      nativeControl: 'MAR_MANAGED'
    });
    const history = new ConversationHistoryService({
      runtime,
      runners: {} as never,
      capabilities: () => ({}) as never,
      attachments: {} as never,
      snapshotSequence: () => 1,
      hasManagedActiveRun: () => true,
      setExternalActivity: vi.fn()
    });
    expect((await history.read(resumed, { limit: 10 })).nextCursor).not.toBeNull();
    let oldestRunId = '';
    for (let index = 0; index < 11; index += 1) {
      const run = runtime.createMessageRun({
        sessionId: promoted.id,
        clientMessageId: `message-${index}`,
        content: 'message'
      }).run;
      if (index === 0) oldestRunId = run.id;
      runtime.finishRun(run.id, 'INTERRUPTED');
      runtime.removeTerminalRun(run.id);
      expect(runtime.listConversationTurns({ sessionId: promoted.id }).historyComplete).toBe(
        index < 10
      );
    }
    expect(runtime.conversationTurnForRun(oldestRunId)).toBeUndefined();
    expect(
      runtime.listConversationTurns({ sessionId: promoted.id, limit: 500 }).turns
    ).toHaveLength(10);
    expect((await history.read(promoted, { limit: 10 })).nextCursor).not.toBeNull();
    runtime.resetAgentSessionHistory(promoted.id, 1_000);
    expect((await history.read(promoted, { limit: 10 })).nextCursor).not.toBeNull();
  });

  it('invalidates completeness when cleanup filters a failed Turn before window eviction', () => {
    const { runtime, session } = fixture();
    const run = runtime.createMessageRun({
      sessionId: session.id,
      clientMessageId: 'failed-message',
      content: 'failed message'
    }).run;
    runtime.finishRun(run.id, 'FAILED');
    runtime.removeTerminalRun(run.id);
    expect(runtime.conversationTurnForRun(run.id)).toBeUndefined();
    expect(runtime.listConversationTurns({ sessionId: session.id })).toMatchObject({
      historyComplete: false,
      turns: []
    });
  });
});

describe('Node execution directory admission', () => {
  it('dispatches edited input when successful settle directory validation becomes stale', async () => {
    const { runtime, session } = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const resolveExecutionDirectory = vi.fn(async () => session.cwd);
    resolveExecutionDirectory.mockImplementationOnce(async () => {
      await gate;
      return session.cwd;
    });
    const control = vi.fn();
    const coordinator = new ContinuousRunCoordinator({
      runtime,
      control,
      resolveExecutionDirectory,
      stopped: () => false,
      emitQueue: vi.fn(),
      emitConversation: vi.fn(),
      clearImages: vi.fn(),
      cleanupAttachments: vi.fn(),
      migrateAssets: vi.fn(),
      emitRun: vi.fn(),
      markInterrupted: vi.fn(),
      mcps: () => []
    });
    const item = runtime.createQueueItem({
      sessionId: session.id,
      clientMessageId: 'settle-edit-race',
      content: 'original input'
    }).item;
    coordinator.prepare(item.id, prepared(item.id, session.id));
    const service = new WorkspaceQueueWorkbenchService({
      runtime,
      coordinator,
      resolve: async (id) => runtime.getAgentSession(id),
      emit: vi.fn(),
      prepareInput: (_runner, input) => input
    });
    try {
      const settled = coordinator.settle({
        submissionId: item.id,
        intent: 'SEND',
        queueBefore: { paused: false, itemIds: [] }
      });
      service.operations()['workspace.queue.message.update']!({
        workspaceId: session.workspaceId,
        queueItemId: item.id,
        content: 'edited input'
      });
      release();
      await expect(settled).resolves.toBe('QUEUED');
      await vi.waitFor(() =>
        expect(control).toHaveBeenCalledWith(
          'run.start',
          expect.objectContaining({ input: 'edited input' })
        )
      );
      expect(control).toHaveBeenCalledOnce();
      expect(runtime.sessionQueue(session.id).itemIds).toEqual([]);
    } finally {
      release();
      coordinator.clear();
    }
  });

  it.each(['reorder', 'delete'] as const)(
    'rechecks the current queue after a directory rejection overlaps %s',
    async (change) => {
      const { runtime, session } = fixture();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const directoryError = Object.assign(new Error('The execution directory is unavailable.'), {
        code: 'SESSION_EXECUTION_DIRECTORY_INVALID'
      });
      const resolveExecutionDirectory = vi.fn(async () => {
        throw directoryError;
      });
      resolveExecutionDirectory.mockImplementationOnce(async () => {
        await gate;
        throw directoryError;
      });
      const control = vi.fn();
      const coordinator = new ContinuousRunCoordinator({
        runtime,
        resolveExecutionDirectory,
        control,
        stopped: () => false,
        emitQueue: vi.fn(),
        emitConversation: vi.fn(),
        clearImages: vi.fn(),
        cleanupAttachments: vi.fn(),
        migrateAssets: vi.fn(),
        emitRun: vi.fn(),
        markInterrupted: vi.fn(),
        mcps: () => []
      });
      const first = runtime.createQueueItem({
        sessionId: session.id,
        clientMessageId: 'stale-first',
        content: 'first'
      }).item;
      const second = runtime.createQueueItem({
        sessionId: session.id,
        clientMessageId: 'stale-second',
        content: 'second'
      }).item;
      coordinator.prepare(first.id, prepared(first.id, session.id));
      const retainedInput = prepared(second.id, session.id);
      coordinator.prepare(second.id, retainedInput);
      try {
        const dispatched = coordinator.dispatch(session.id);
        expect(resolveExecutionDirectory).toHaveBeenCalledOnce();
        if (change === 'delete') coordinator.deleteQueueItem(first.id);
        else
          runtime.reorderSessionQueue(session.id, runtime.sessionQueue(session.id).version, [
            second.id,
            first.id
          ]);
        release();
        await dispatched;
        await vi.waitFor(() => expect(runtime.sessionQueue(session.id).paused).toBe(true));
        expect(runtime.sessionQueue(session.id).itemIds).toEqual(
          change === 'delete' ? [second.id] : [second.id, first.id]
        );
        expect(coordinator.pending(second.id)).toBe(retainedInput);
        expect(resolveExecutionDirectory).toHaveBeenCalledTimes(2);
        expect(runtime.listRunsForSession(session.id)).toEqual([]);
        expect(control).not.toHaveBeenCalled();
      } finally {
        release();
        coordinator.clear();
      }
    }
  );

  it('preserves the resumed queue intent across shutdown without starting an execution', async () => {
    const { runtime, session } = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const control = vi.fn();
    const coordinator = new ContinuousRunCoordinator({
      runtime,
      control,
      stopped: () => false,
      resolveExecutionDirectory: async () => {
        await gate;
        return session.cwd;
      },
      emitQueue: vi.fn(),
      emitConversation: vi.fn(),
      clearImages: vi.fn(),
      cleanupAttachments: vi.fn(),
      migrateAssets: vi.fn(),
      emitRun: vi.fn(),
      markInterrupted: vi.fn(),
      mcps: () => []
    });
    const { item } = runtime.createQueueItem({
      sessionId: session.id,
      clientMessageId: 'shutdown-queued',
      content: 'keep this input'
    });
    coordinator.prepare(item.id, prepared(item.id, session.id));
    runtime.pauseSessionQueue(session.id);
    try {
      const resumed = coordinator.resume(session.id);
      coordinator.suspend();
      release();
      await resumed;
      expect(runtime.sessionQueue(session.id)).toMatchObject({ paused: false, itemIds: [item.id] });
      expect(runtime.listRunsForSession(session.id)).toEqual([]);
      expect(control).not.toHaveBeenCalled();
    } finally {
      release();
      coordinator.clear();
    }
  });

  it('retains an idle QueueItem and prepared resources after directory failure, then resumes after repair', async () => {
    const { runtime, session } = fixture();
    const acceptedLeaseRelease = vi.fn();
    const preparedLeaseRelease = vi.fn();
    let retainedLeases = 0;
    let directoryAvailable = false;
    const directoryError = Object.assign(new Error('execution directory unavailable'), {
      code: 'WORKSPACE_DIRECTORY_INVALID'
    });
    const resolveExecutionDirectory = vi.fn(async () => {
      if (!directoryAvailable) throw directoryError;
      return '/workspace/validated';
    });
    const starts: Array<Record<string, unknown>> = [];
    const coordinator = new ContinuousRunCoordinator({
      runtime,
      resolveExecutionDirectory,
      emitQueue: vi.fn(),
      emitConversation: vi.fn(),
      clearImages: vi.fn(),
      cleanupAttachments: vi.fn(),
      migrateAssets: vi.fn(),
      emitRun: vi.fn(),
      control: (operation, payload) => {
        if (operation === 'run.start') starts.push(payload);
      },
      stopped: () => false,
      markInterrupted: vi.fn(),
      mcps: () => [],
      retainEnvironment: () =>
        ++retainedLeases === 1 ? acceptedLeaseRelease : preparedLeaseRelease
    });
    const previous = runtime.createMessageRun({
      sessionId: session.id,
      clientMessageId: 'previous-message',
      content: 'previous turn'
    }).run;
    const attachments = [{ name: 'diagram.png', mime: 'image/png', dataBase64: 'cG5n' }];
    const accepted = coordinator.accept(
      {
        runId: 'directory-queued',
        sessionId: session.id,
        clientMessageId: 'directory-message',
        content: 'queued with attachment',
        attachments
      },
      { ACCEPTED_ENVIRONMENT: 'accepted' }
    );
    const item = accepted.queueItem!;
    const input = {
      ...prepared(item.id, session.id),
      input: 'prepared queued input',
      secretEnvironment: { PREPARED_ENVIRONMENT: 'retained' }
    };
    coordinator.prepare(item.id, input);
    runtime.finishRun(previous.id, 'SUCCEEDED');

    try {
      await expect(coordinator.resume(session.id)).rejects.toBe(directoryError);
      expect(runtime.sessionQueue(session.id)).toMatchObject({ paused: true, itemIds: [item.id] });
      expect(runtime.getQueueItem(item.id)).toEqual(item);
      expect(coordinator.pending(item.id)).toBe(input);
      expect(acceptedLeaseRelease).toHaveBeenCalledOnce();
      expect(preparedLeaseRelease).not.toHaveBeenCalled();

      directoryAvailable = true;
      await coordinator.resume(session.id);
      const resumed = runtime.activeSessionRun(session.id)!;
      expect(resumed.clientMessageId).toBe('directory-message');
      expect(runtime.sessionQueue(session.id).itemIds).toEqual([]);
      expect(coordinator.pending(resumed.id)).toMatchObject({
        input: 'prepared queued input',
        attachmentPaths: [],
        secretEnvironment: { PREPARED_ENVIRONMENT: 'retained' }
      });
      await coordinator.dispatch(session.id);

      expect(starts).toHaveLength(1);
      expect(starts[0]).toMatchObject({
        runId: expect.any(String),
        input: 'prepared queued input',
        cwd: '/workspace/validated'
      });
      expect(runtime.conversationTurnForRun(resumed.id)).toMatchObject({
        items: [
          expect.objectContaining({
            payload: expect.objectContaining({
              attachments: [
                expect.objectContaining({
                  name: 'diagram.png',
                  runId: starts[0]?.runId,
                  imageIndex: 0
                })
              ]
            })
          })
        ]
      });
    } finally {
      coordinator.clear();
    }
    expect(preparedLeaseRelease).toHaveBeenCalledOnce();
  });

  it('settles an accepted Run as rejected when its execution directory cannot be resolved', async () => {
    const { runtime, session } = fixture();
    const directoryError = Object.assign(new Error('execution directory unavailable'), {
      code: 'WORKSPACE_DIRECTORY_INVALID'
    });
    const emitRun = vi.fn();
    const starts: unknown[] = [];
    const coordinator = new ContinuousRunCoordinator({
      runtime,
      resolveExecutionDirectory: async () => {
        throw directoryError;
      },
      emitQueue: vi.fn(),
      emitConversation: vi.fn(),
      clearImages: vi.fn(),
      cleanupAttachments: vi.fn(),
      migrateAssets: vi.fn(),
      emitRun,
      control: (operation, payload) => {
        if (operation === 'run.start') starts.push(payload);
      },
      stopped: () => false,
      markInterrupted: vi.fn(),
      mcps: () => []
    });
    const accepted = coordinator.accept({
      runId: 'rejected-directory-run',
      sessionId: session.id,
      clientMessageId: 'rejected-directory-message',
      content: 'must be rejected before execution'
    });
    const input = prepared(accepted.run.id, session.id);
    coordinator.prepare(accepted.run.id, input);

    try {
      await coordinator.dispatch(session.id);

      expect(emitRun).toHaveBeenCalledWith(
        accepted.run.id,
        'run.rejected',
        { code: 'WORKSPACE_DIRECTORY_INVALID' },
        'FAILED'
      );
      expect(starts).toEqual([]);
      expect(coordinator.pending(accepted.run.id)).toBe(input);
      expect(runtime.currentExecutionId(accepted.run.id)).toBeUndefined();
    } finally {
      coordinator.clear();
    }
  });

  it('does not create a Turn or Execution when directory validation fails before an active Run continuation', async () => {
    const { runtime, session } = fixture();
    let directoryAvailable = true;
    const directoryError = Object.assign(new Error('execution directory unavailable'), {
      code: 'WORKSPACE_DIRECTORY_INVALID'
    });
    const resolveExecutionDirectory = vi.fn(async () => {
      if (!directoryAvailable) throw directoryError;
      return '/workspace/validated';
    });
    const starts: Array<Record<string, unknown>> = [];
    const coordinator = new ContinuousRunCoordinator({
      runtime,
      resolveExecutionDirectory,
      emitQueue: vi.fn(),
      emitConversation: vi.fn(),
      clearImages: vi.fn(),
      cleanupAttachments: vi.fn(),
      migrateAssets: vi.fn(),
      emitRun: vi.fn(),
      control: (operation, payload) => {
        if (operation === 'run.start') starts.push(payload);
      },
      stopped: () => false,
      markInterrupted: vi.fn(),
      mcps: () => []
    });
    const first = coordinator.accept({
      runId: 'active-directory-run',
      sessionId: session.id,
      clientMessageId: 'active-directory-message',
      content: 'first turn'
    });
    coordinator.prepare(first.run.id, prepared(first.run.id, session.id));
    const queued = coordinator.accept({
      runId: 'waiting-directory-turn',
      sessionId: session.id,
      clientMessageId: 'waiting-directory-message',
      content: 'waiting next turn'
    });
    const input = prepared(queued.queueItem!.id, session.id);
    coordinator.prepare(queued.queueItem!.id, input);

    try {
      await coordinator.dispatch(session.id);
      const firstExecutionId = String(starts[0]?.runId);
      runtime.appendRunEvent({
        runId: firstExecutionId,
        sequence: 1,
        eventType: 'run.completed',
        payload: {},
        status: 'SUCCEEDED'
      });
      coordinator.remove(firstExecutionId);
      const turnCount = runtime.listConversationTurns({ sessionId: session.id }).turns.length;
      directoryAvailable = false;

      await expect(coordinator.dispatch(session.id)).resolves.toBeUndefined();

      expect(runtime.sessionQueue(session.id)).toMatchObject({
        paused: true,
        itemIds: [queued.queueItem!.id]
      });
      expect(runtime.getQueueItem(queued.queueItem!.id)).toBe(queued.queueItem);
      expect(coordinator.pending(queued.queueItem!.id)).toBe(input);
      expect(runtime.currentExecutionId(first.run.id)).toBeUndefined();
      expect(runtime.listConversationTurns({ sessionId: session.id }).turns).toHaveLength(
        turnCount
      );
      expect(starts).toHaveLength(1);
    } finally {
      coordinator.clear();
    }
  });

  it('rechecks reordered, deleted, and paused queue state across concurrent same-session directory checks', async () => {
    const { runtime, session } = fixture();
    let blockDirectoryChecks = false;
    let enteredChecks = 0;
    let releaseDirectoryGate!: () => void;
    let signalBothChecks!: () => void;
    const directoryGate = new Promise<void>((resolve) => {
      releaseDirectoryGate = resolve;
    });
    const bothChecksEntered = new Promise<void>((resolve) => {
      signalBothChecks = resolve;
    });
    const resolveExecutionDirectory = vi.fn(async () => {
      if (blockDirectoryChecks) {
        enteredChecks += 1;
        if (enteredChecks === 2) signalBothChecks();
        await directoryGate;
      }
      return '/workspace/validated';
    });
    const starts: Array<Record<string, unknown>> = [];
    const coordinator = new ContinuousRunCoordinator({
      runtime,
      resolveExecutionDirectory,
      emitQueue: vi.fn(),
      emitConversation: vi.fn(),
      clearImages: vi.fn(),
      cleanupAttachments: vi.fn(),
      migrateAssets: vi.fn(),
      emitRun: vi.fn(),
      control: (operation, payload) => {
        if (operation === 'run.start') starts.push(payload);
      },
      stopped: () => false,
      markInterrupted: vi.fn(),
      mcps: () => []
    });
    const first = coordinator.accept({
      runId: 'gate-active-run',
      sessionId: session.id,
      clientMessageId: 'gate-active-message',
      content: 'active turn'
    });
    coordinator.prepare(first.run.id, prepared(first.run.id, session.id));
    const firstQueued = coordinator.accept({
      runId: 'gate-first-queued',
      sessionId: session.id,
      clientMessageId: 'gate-first-message',
      content: 'will be removed'
    });
    const secondQueued = coordinator.accept({
      runId: 'gate-second-queued',
      sessionId: session.id,
      clientMessageId: 'gate-second-message',
      content: 'retained after deletion'
    });
    const thirdQueued = coordinator.accept({
      runId: 'gate-third-queued',
      sessionId: session.id,
      clientMessageId: 'gate-third-message',
      content: 'reordered to the head'
    });
    const firstQueuedInput = prepared(firstQueued.queueItem!.id, session.id);
    const secondQueuedInput = prepared(secondQueued.queueItem!.id, session.id);
    const thirdQueuedInput = prepared(thirdQueued.queueItem!.id, session.id);
    coordinator.prepare(firstQueued.queueItem!.id, firstQueuedInput);
    coordinator.prepare(secondQueued.queueItem!.id, secondQueuedInput);
    coordinator.prepare(thirdQueued.queueItem!.id, thirdQueuedInput);

    try {
      await coordinator.dispatch(session.id);
      const firstExecutionId = String(starts[0]?.runId);
      runtime.appendRunEvent({
        runId: firstExecutionId,
        sequence: 1,
        eventType: 'run.completed',
        payload: {},
        status: 'SUCCEEDED'
      });
      coordinator.remove(firstExecutionId);
      const turnCount = runtime.listConversationTurns({ sessionId: session.id }).turns.length;
      blockDirectoryChecks = true;
      const pendingChecks = [coordinator.dispatch(session.id), coordinator.dispatch(session.id)];
      await bothChecksEntered;

      const queue = runtime.sessionQueue(session.id);
      runtime.reorderSessionQueue(session.id, queue.version, [
        thirdQueued.queueItem!.id,
        firstQueued.queueItem!.id,
        secondQueued.queueItem!.id
      ]);
      coordinator.deleteQueueItem(firstQueued.queueItem!.id);
      runtime.pauseSessionQueue(session.id);
      releaseDirectoryGate();
      await Promise.all(pendingChecks);

      expect(runtime.sessionQueue(session.id)).toMatchObject({
        paused: true,
        itemIds: [thirdQueued.queueItem!.id, secondQueued.queueItem!.id]
      });
      expect(coordinator.pending(firstQueued.queueItem!.id)).toBeUndefined();
      expect(coordinator.pending(secondQueued.queueItem!.id)).toBe(secondQueuedInput);
      expect(coordinator.pending(thirdQueued.queueItem!.id)).toBe(thirdQueuedInput);
      expect(runtime.listConversationTurns({ sessionId: session.id }).turns).toHaveLength(
        turnCount
      );
      expect(starts).toHaveLength(1);

      blockDirectoryChecks = false;
      await coordinator.resume(session.id);
      await vi.waitFor(() => expect(starts).toHaveLength(2));
      expect(runtime.currentExecutionId(first.run.id)).toBe(String(starts[1]?.runId));
      expect(runtime.sessionQueue(session.id).itemIds).toEqual([secondQueued.queueItem!.id]);
      expect(runtime.conversationTurnForExecution(String(starts[1]?.runId))?.runId).toBe(
        first.run.id
      );
      await Promise.all([coordinator.dispatch(session.id), coordinator.dispatch(session.id)]);
      expect(starts).toHaveLength(2);
    } finally {
      releaseDirectoryGate();
      coordinator.clear();
    }
  });

  it('keeps an active Run and paused queue unchanged when settle directory admission races with pause', async () => {
    const { runtime, session } = fixture();
    let waitForDirectory = false;
    let releaseDirectoryGate!: () => void;
    let signalDirectoryCheck!: () => void;
    const directoryGate = new Promise<void>((resolve) => {
      releaseDirectoryGate = resolve;
    });
    const directoryCheckEntered = new Promise<void>((resolve) => {
      signalDirectoryCheck = resolve;
    });
    const resolveExecutionDirectory = vi.fn(async () => {
      if (waitForDirectory) {
        signalDirectoryCheck();
        await directoryGate;
      }
      return '/workspace/validated';
    });
    const starts: Array<Record<string, unknown>> = [];
    const coordinator = new ContinuousRunCoordinator({
      runtime,
      resolveExecutionDirectory,
      emitQueue: vi.fn(),
      emitConversation: vi.fn(),
      clearImages: vi.fn(),
      cleanupAttachments: vi.fn(),
      migrateAssets: vi.fn(),
      emitRun: vi.fn(),
      control: (operation, payload) => {
        if (operation === 'run.start') starts.push(payload);
      },
      stopped: () => false,
      markInterrupted: vi.fn(),
      mcps: () => []
    });
    const active = coordinator.accept({
      runId: 'settle-active-run',
      sessionId: session.id,
      clientMessageId: 'settle-active-message',
      content: 'active input'
    });
    coordinator.prepare(active.run.id, prepared(active.run.id, session.id));
    const queued = coordinator.accept({
      runId: 'settle-queued-item',
      sessionId: session.id,
      clientMessageId: 'settle-queued-message',
      content: 'keep queued while paused'
    });
    const queuedInput = prepared(queued.queueItem!.id, session.id);
    coordinator.prepare(queued.queueItem!.id, queuedInput);

    try {
      await coordinator.dispatch(session.id);
      const executionId = String(starts[0]?.runId);
      const turnCount = runtime.listConversationTurns({ sessionId: session.id }).turns.length;
      const queueBefore = runtime.sessionQueue(session.id);
      waitForDirectory = true;
      const settling = coordinator.settle({
        submissionId: queued.queueItem!.id,
        intent: 'QUEUE',
        queueBefore: { paused: queueBefore.paused, itemIds: queueBefore.itemIds }
      });
      await directoryCheckEntered;

      runtime.pauseSessionQueue(session.id);
      releaseDirectoryGate();
      await expect(settling).resolves.toBe('QUEUED');

      expect(runtime.sessionQueue(session.id)).toMatchObject({
        paused: true,
        itemIds: [queued.queueItem!.id]
      });
      expect(runtime.getQueueItem(queued.queueItem!.id)).toBe(queued.queueItem);
      expect(coordinator.pending(queued.queueItem!.id)).toBe(queuedInput);
      expect(runtime.currentExecutionId(active.run.id)).toBe(executionId);
      expect(runtime.listConversationTurns({ sessionId: session.id }).turns).toHaveLength(
        turnCount
      );
      expect(starts).toHaveLength(1);
    } finally {
      releaseDirectoryGate();
      coordinator.clear();
    }
  });
});

describe('Node continuous Run lifecycle', () => {
  it('retains independent Runner input snapshots while queued inputs wait for FIFO dispatch', async () => {
    const { runtime, session } = fixture('mar-agent');
    const control = vi.fn();
    const coordinator = new ContinuousRunCoordinator({
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
      mcps: () => []
    });
    const runner = new MarAgentRunner();
    const wire = {
      marAgentModel: { id: 'model-before' },
      marAgentModels: [{ id: 'subagent-before' }],
      marAgentCompact: { id: 'compact-before' },
      marAgentRuntimeScopeId: 'scope-before'
    };
    runtime.pauseSessionQueue(session.id);
    const first = runtime.createQueueItem({
      sessionId: session.id,
      clientMessageId: 'first-snapshot',
      content: 'first'
    }).item;
    const firstContext = runner.prepareExecutionContext(wire);
    coordinator.prepare(first.id, {
      ...prepared(first.id, session.id),
      executionContext: firstContext
    });
    wire.marAgentModel.id = 'model-after';
    wire.marAgentModels[0]!.id = 'subagent-after';
    wire.marAgentCompact.id = 'compact-after';
    wire.marAgentRuntimeScopeId = 'scope-after';
    const second = runtime.createQueueItem({
      sessionId: session.id,
      clientMessageId: 'second-snapshot',
      content: 'second'
    }).item;
    const secondContext = runner.prepareExecutionContext(wire);
    coordinator.prepare(second.id, {
      ...prepared(second.id, session.id),
      executionContext: secondContext
    });
    try {
      expect(coordinator.pending(first.id)?.executionContext).toBe(firstContext);
      await coordinator.resume(session.id);
      await vi.waitFor(() => expect(control).toHaveBeenCalledOnce());
      expect(control.mock.calls[0]).toMatchObject([
        'run.start',
        {
          runner: 'mar-agent',
          runnerInput: {
            model: { id: 'model-before' },
            models: [{ id: 'subagent-before' }],
            compact: { id: 'compact-before' },
            runtimeScopeId: 'scope-before'
          }
        }
      ]);
      const active = runtime.activeSessionRun(session.id)!;
      const execution = runtime.currentExecutionId(active.id)!;
      runtime.appendRunEvent({
        runId: execution,
        sequence: 1,
        eventType: 'run.completed',
        payload: {},
        status: 'SUCCEEDED'
      });
      coordinator.remove(execution);
      await coordinator.resume(session.id);
      await vi.waitFor(() => expect(control).toHaveBeenCalledTimes(2));
      expect(control.mock.calls[1]?.[1]).toMatchObject({
        runnerInput: {
          model: { id: 'model-after' },
          models: [{ id: 'subagent-after' }],
          compact: { id: 'compact-after' },
          runtimeScopeId: 'scope-after'
        }
      });
      expect(control.mock.calls[0]?.[1]).not.toHaveProperty('marAgentModel');
    } finally {
      coordinator.clear();
    }
  });

  it.each(['preparation', 'control'] as const)(
    'revokes prepared MCP capabilities when %s fails',
    async (phase) => {
      const { runtime, session } = fixture();
      const revokeExecutionMcps = vi.fn();
      const goalMcp = vi.fn(async (): Promise<ResolvedMcpServer> => ({
        name: 'mar_goal',
        origin: 'BUILTIN',
        lifecycle: 'EXECUTION',
        transport: 'STDIO',
        command: process.execPath,
        environment: { MAR_GOAL_MCP_TOKEN: 'execution-only' }
      }));
      const coordinator = new ContinuousRunCoordinator({
        runtime,
        emitQueue: vi.fn(),
        emitConversation: vi.fn(),
        clearImages: vi.fn(),
        cleanupAttachments: vi.fn(),
        migrateAssets: vi.fn(),
        emitRun: vi.fn(),
        stopped: () => false,
        markInterrupted: vi.fn(),
        mcps: () => [],
        goalMcp,
        revokeExecutionMcps,
        scheduleMcp: async () => {
          if (phase === 'preparation') throw new Error('FIXTURE_PREPARATION_FAILED');
          return undefined;
        },
        control: () => {
          throw new Error('FIXTURE_CONTROL_FAILED');
        }
      });
      const accepted = coordinator.accept({
        runId: 'failed-preparation',
        sessionId: session.id,
        clientMessageId: 'failed-preparation',
        content: 'objective'
      });
      coordinator.prepare(accepted.run.id, {
        ...prepared(accepted.run.id, session.id),
        goal: { id: 'goal', revision: 1, epoch: 1 }
      });
      try {
        await coordinator.dispatch(session.id);
        expect(goalMcp).toHaveBeenCalledOnce();
        expect(revokeExecutionMcps).toHaveBeenCalledExactlyOnceWith(
          runtime.currentExecutionId(accepted.run.id)
        );
        expect(JSON.stringify(runtime.getAgentSession(session.id))).not.toContain('execution-only');
      } finally {
        coordinator.clear();
      }
    }
  );

  it('revokes capabilities prepared after their Execution was removed', async () => {
    const { runtime, session } = fixture();
    const revokeExecutionMcps = vi.fn();
    const control = vi.fn();
    let release!: () => void;
    let entered = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const coordinator = new ContinuousRunCoordinator({
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
      revokeExecutionMcps,
      notificationMcp: async () => {
        entered = true;
        await gate;
        return {
          name: 'mar_notification',
          origin: 'BUILTIN',
          lifecycle: 'EXECUTION',
          transport: 'STDIO',
          command: process.execPath
        };
      }
    });
    const accepted = coordinator.accept({
      runId: 'cancelled-preparation',
      sessionId: session.id,
      clientMessageId: 'cancelled-preparation',
      content: 'notify'
    });
    coordinator.prepare(accepted.run.id, prepared(accepted.run.id, session.id));
    const dispatch = coordinator.dispatch(session.id);
    try {
      await vi.waitFor(() => expect(entered).toBe(true));
      const executionId = runtime.currentExecutionId(accepted.run.id)!;
      coordinator.remove(executionId);
      release();
      await dispatch;
      expect(control).not.toHaveBeenCalled();
      expect(revokeExecutionMcps).toHaveBeenCalledExactlyOnceWith(executionId);
    } finally {
      release();
      await dispatch;
      coordinator.clear();
    }
  });

  it('binds every built-in MCP to the dispatched Execution on initial and queued turns', async () => {
    const { runtime, session } = fixture();
    const starts: Record<string, unknown>[] = [];
    const bindings: Array<{ name: string; executionId: string; userId: number | undefined }> = [];
    const executionMcp = (name: string): ResolvedMcpServer => ({
      name,
      origin: 'BUILTIN',
      lifecycle: 'EXECUTION',
      transport: 'STDIO',
      command: process.execPath,
      args: []
    });
    const bind = async (name: string, input: PreparedExecutionInput) => {
      const run = runtime.getRun(input.runId);
      bindings.push({ name, executionId: input.runId, userId: run?.initiatedByUserId });
      return executionMcp(name);
    };
    const coordinator = new ContinuousRunCoordinator({
      runtime,
      emitQueue: vi.fn(),
      emitConversation: vi.fn(),
      clearImages: vi.fn(),
      cleanupAttachments: vi.fn(),
      migrateAssets: vi.fn(),
      emitRun: vi.fn(),
      control: (_operation, payload) => starts.push(payload),
      stopped: () => false,
      markInterrupted: vi.fn(),
      mcps: () => [],
      goalMcp: (input) => bind('mar_goal', input),
      scheduleMcp: (input) => bind('mar_schedule', input),
      notificationMcp: (input) => bind('mar_notification', input)
    });
    const prepare = (id: string) =>
      coordinator.prepare(id, {
        ...prepared(id, session.id),
        secretEnvironment: {
          MAR_CTL_NODE_ID: 'forged',
          MAR_CTL_WORKSPACE_ID: 'forged',
          MAR_CTL_SESSION_ID: 'forged',
          MAR_CTL_RUN_ID: 'forged',
          MAR_CTL_RUNNER: 'forged'
        },
        goal: { id: 'goal-1', revision: 1, epoch: 1 }
      });
    try {
      const first = coordinator.accept({
        runId: 'continuous-mcp-run',
        sessionId: session.id,
        clientMessageId: 'first-mcp-message',
        content: 'first',
        initiatedByUserId: 7
      });
      prepare(first.run.id);
      await coordinator.dispatch(session.id);
      const firstExecutionId = runtime.currentExecutionId(first.run.id)!;
      const queued = coordinator.accept({
        runId: 'queued-mcp-message',
        sessionId: session.id,
        clientMessageId: 'second-mcp-message',
        content: 'create schedule',
        initiatedByUserId: 7
      });
      prepare(queued.queueItem!.id);
      runtime.appendRunEvent({
        runId: firstExecutionId,
        sequence: 1,
        eventType: 'run.completed',
        payload: {},
        status: 'SUCCEEDED'
      });
      coordinator.remove(firstExecutionId);
      await coordinator.dispatch(session.id);
      const secondExecutionId = runtime.currentExecutionId(first.run.id)!;
      expect(firstExecutionId).not.toBe(first.run.id);
      expect(secondExecutionId).not.toBe(firstExecutionId);
      expect(secondExecutionId).not.toBe(queued.queueItem!.id);
      expect(bindings).toEqual(
        [firstExecutionId, secondExecutionId].flatMap((executionId) =>
          ['mar_goal', 'mar_schedule', 'mar_notification'].map((name) => ({
            name,
            executionId,
            userId: 7
          }))
        )
      );
      expect(starts.map((start) => start.runId)).toEqual([firstExecutionId, secondExecutionId]);
      expect(starts.map((start) => start.secretEnvironment)).toEqual(
        Array.from({ length: 2 }, () => ({
          MAR_CTL_NODE_ID: 'node-1',
          MAR_CTL_WORKSPACE_ID: 'workspace-1',
          MAR_CTL_SESSION_ID: session.id,
          MAR_CTL_RUN_ID: first.run.id,
          MAR_CTL_RUNNER: 'codex'
        }))
      );
      expect(
        starts.map((start) =>
          (start.executionMcpServers as ResolvedMcpServer[]).map((mcp) => mcp.name)
        )
      ).toEqual(Array.from({ length: 2 }, () => ['mar_goal', 'mar_schedule', 'mar_notification']));
    } finally {
      coordinator.clear();
    }
  });

  it('binds the notification MCP to the dispatched Execution rather than its continuous Run', async () => {
    const { runtime, session } = fixture();
    let installedExecutionId: string | undefined;
    const coordinator = new ContinuousRunCoordinator({
      runtime,
      emitQueue: vi.fn(),
      emitConversation: vi.fn(),
      clearImages: vi.fn(),
      cleanupAttachments: vi.fn(),
      migrateAssets: vi.fn(),
      emitRun: vi.fn(),
      control: vi.fn(),
      stopped: () => false,
      markInterrupted: vi.fn(),
      mcps: () => [],
      notificationMcp: async (input) => {
        installedExecutionId = input.runId;
        return undefined;
      }
    });
    const accepted = coordinator.accept({
      runId: 'continuous-run',
      sessionId: session.id,
      clientMessageId: 'message-1',
      content: 'notify',
      initiatedByUserId: 7
    });
    coordinator.prepare(accepted.run.id, prepared(accepted.run.id, session.id));
    await coordinator.dispatch(session.id);

    const executionId = runtime.currentExecutionId(accepted.run.id);
    expect(executionId).toBeDefined();
    expect(executionId).not.toBe(accepted.run.id);
    expect(installedExecutionId).toBe(executionId);
    expect(
      resolveNotificationCapability(runtime, {
        executionId: installedExecutionId!,
        sessionId: session.id,
        workspaceId: session.workspaceId,
        userId: 7,
        source: 'MANUAL'
      })
    ).toBeDefined();
  });

  it('retains personal Git context at admission before deferred preparation and releases it on failure', () => {
    const { runtime, session } = fixture();
    const release = vi.fn();
    const retainEnvironment = vi.fn(() => release);
    const coordinator = new ContinuousRunCoordinator({
      runtime,
      emitQueue: vi.fn(),
      emitConversation: vi.fn(),
      clearImages: vi.fn(),
      cleanupAttachments: vi.fn(),
      migrateAssets: vi.fn(),
      emitRun: vi.fn(),
      control: vi.fn(),
      stopped: () => false,
      markInterrupted: vi.fn(),
      mcps: () => [],
      retainEnvironment
    });
    const environment = { MAR_GIT_TOKEN: 'test-capability' };
    const accepted = coordinator.accept(
      {
        runId: 'deferred-git',
        sessionId: session.id,
        clientMessageId: 'deferred-git',
        content: 'work'
      },
      environment
    );
    expect(retainEnvironment).toHaveBeenCalledWith(environment);
    expect(release).not.toHaveBeenCalled();
    coordinator.failPreparation(accepted.run.id, 'MESSAGE_PREPARATION_FAILED');
    expect(release).toHaveBeenCalledOnce();
    coordinator.clear();
    expect(release).toHaveBeenCalledOnce();
  });

  it('reschedules a Goal continuation queued after the previous Execution ended', async () => {
    const { runtime, session } = fixture();
    const starts: string[] = [];
    const coordinator = new ContinuousRunCoordinator({
      runtime,
      emitQueue: () => undefined,
      emitConversation: () => undefined,
      clearImages: () => undefined,
      cleanupAttachments: () => undefined,
      migrateAssets: () => undefined,
      emitRun: () => undefined,
      control: (_operation, payload) => starts.push(String(payload.runId)),
      stopped: () => false,
      markInterrupted: () => undefined,
      mcps: () => []
    });
    const accepted = coordinator.accept({
      runId: 'goal-run-late-continuation',
      sessionId: session.id,
      clientMessageId: 'goal-start',
      content: 'goal'
    });
    coordinator.prepare(accepted.run.id, prepared(accepted.run.id, session.id));
    await coordinator.dispatch(session.id);
    const executionId = starts[0]!;
    runtime.appendRunEvent({
      runId: executionId,
      sequence: 1,
      eventType: 'run.completed',
      payload: {},
      status: 'SUCCEEDED'
    });
    coordinator.remove(executionId);

    const continuation = coordinator.accept({
      runId: 'goal-late-continuation',
      sessionId: session.id,
      clientMessageId: 'goal-continuation',
      content: 'Goal Continue'
    });
    coordinator.prepare(
      continuation.queueItem!.id,
      prepared(continuation.queueItem!.id, session.id)
    );
    expect(
      coordinator.settle({
        submissionId: continuation.queueItem!.id,
        intent: 'QUEUE',
        queueBefore: { paused: false, itemIds: [] }
      })
    ).toBe('STARTED');
    await coordinator.dispatch(session.id);

    expect(starts).toHaveLength(2);
    expect(runtime.listRunsForSession(session.id)).toHaveLength(1);
  });

  it('reuses the continuous Run after inserting a new target during the Goal retry wait', async () => {
    const { runtime, session } = fixture();
    const starts: string[] = [];
    const coordinator = new ContinuousRunCoordinator({
      runtime,
      emitQueue: () => undefined,
      emitConversation: () => undefined,
      clearImages: () => undefined,
      cleanupAttachments: () => undefined,
      migrateAssets: () => undefined,
      emitRun: () => undefined,
      control: (_operation, payload) => starts.push(String(payload.runId)),
      stopped: () => false,
      markInterrupted: () => undefined,
      mcps: () => []
    });
    const accepted = coordinator.accept({
      runId: 'goal-run-retry-gap',
      sessionId: session.id,
      clientMessageId: 'goal-start',
      content: 'goal'
    });
    coordinator.prepare(accepted.run.id, prepared(accepted.run.id, session.id));
    await coordinator.dispatch(session.id);
    const executionId = starts[0]!;
    runtime.appendRunEvent({
      runId: executionId,
      sequence: 1,
      eventType: 'run.completed',
      payload: {},
      status: 'SUCCEEDED'
    });
    coordinator.remove(executionId);

    const replacement = coordinator.accept({
      runId: 'goal-replacement',
      sessionId: session.id,
      clientMessageId: 'goal-edit',
      content: 'edited goal'
    });
    coordinator.prepare(replacement.queueItem!.id, prepared(replacement.queueItem!.id, session.id));
    expect(
      coordinator.settle({
        submissionId: replacement.queueItem!.id,
        intent: 'REPLACE_CURRENT',
        queueBefore: { paused: false, itemIds: [] },
        activeRunId: accepted.run.id
      })
    ).toBe('ACCEPTED');
    await coordinator.dispatch(session.id);

    expect(starts).toHaveLength(2);
    expect(runtime.listRunsForSession(session.id)).toHaveLength(1);
    expect(runtime.conversationTurnForRun(accepted.run.id)?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'user_message',
          payload: expect.objectContaining({ text: 'edited goal' })
        })
      ])
    );
  });

  it('adds a Goal continuation only after the Runner confirms Execution startup', async () => {
    const { runtime, session } = fixture();
    const afterExecutionStarted = vi.fn(async () => undefined);
    const starts: string[] = [];
    const coordinator = new ContinuousRunCoordinator({
      runtime,
      emitQueue: () => undefined,
      emitConversation: () => undefined,
      clearImages: () => undefined,
      cleanupAttachments: () => undefined,
      migrateAssets: () => undefined,
      emitRun: () => undefined,
      control: (_operation, payload) => starts.push(String(payload.runId)),
      stopped: () => false,
      markInterrupted: () => undefined,
      mcps: () => [],
      afterExecutionStarted
    });
    const accepted = coordinator.accept({
      runId: 'goal-run',
      sessionId: session.id,
      clientMessageId: 'goal-message',
      content: 'goal'
    });
    coordinator.prepare(accepted.run.id, {
      ...prepared(accepted.run.id, session.id),
      goal: { id: 'goal-1', revision: 1, epoch: 0 }
    });

    await coordinator.dispatch(session.id);
    expect(afterExecutionStarted).not.toHaveBeenCalled();
    coordinator.executionStarted(starts[0]!);
    coordinator.executionStarted(starts[0]!);
    expect(afterExecutionStarted).toHaveBeenCalledOnce();
  });

  it('does not create an unhandled Promise rejection when Goal continuation callback fails', async () => {
    const { runtime, session } = fixture();
    const coordinator = new ContinuousRunCoordinator({
      runtime,
      emitQueue: () => undefined,
      emitConversation: () => undefined,
      clearImages: () => undefined,
      cleanupAttachments: () => undefined,
      migrateAssets: () => undefined,
      emitRun: () => undefined,
      control: () => undefined,
      stopped: () => false,
      markInterrupted: () => undefined,
      mcps: () => [],
      afterExecutionStarted: async () => {
        throw new Error('continuation failed');
      }
    });
    const accepted = coordinator.accept({
      runId: 'goal-run',
      sessionId: session.id,
      clientMessageId: 'goal-message',
      content: 'goal'
    });
    coordinator.prepare(accepted.run.id, {
      ...prepared(accepted.run.id, session.id),
      goal: { id: 'goal-1', revision: 1, epoch: 0 }
    });

    coordinator.executionStarted(accepted.run.id);
    await Promise.resolve();

    expect(coordinator.hasExecutionStarted(accepted.run.id)).toBe(true);
  });

  it('passes isolated capabilities to MCP resolution for multiple Goal sessions', async () => {
    const { runtime, session } = fixture();
    const secondSession = runtime.createAgentSession({
      workspaceId: 'workspace-1',
      runner: 'codex',
      cwd: '/workspace'
    });
    const controls: Array<{ operation: string; payload: Record<string, unknown> }> = [];
    let capability = 0;
    const coordinator = new ContinuousRunCoordinator({
      runtime,
      emitQueue: () => undefined,
      emitConversation: () => undefined,
      clearImages: () => undefined,
      cleanupAttachments: () => undefined,
      migrateAssets: () => undefined,
      emitRun: () => undefined,
      control: (operation, payload) => controls.push({ operation, payload }),
      stopped: () => false,
      markInterrupted: () => undefined,
      mcps: () => [],
      goalMcp: async () => {
        capability += 1;
        return {
          name: 'mar_goal',
          origin: 'BUILTIN',
          lifecycle: 'EXECUTION',
          transport: 'STDIO',
          command: process.execPath,
          args: [],
          environment: { MAR_GOAL_MCP_TOKEN: `token-${capability}` }
        };
      }
    });
    for (const [index, target] of [session, secondSession].entries()) {
      const accepted = coordinator.accept({
        runId: `goal-run-${index}`,
        sessionId: target.id,
        clientMessageId: `goal-message-${index}`,
        content: `goal-${index}`
      });
      coordinator.prepare(accepted.run.id, {
        ...prepared(accepted.run.id, target.id),
        secretEnvironment: { USER_API_KEY: 'shared-user-secret' },
        goal: { id: `goal-${index}`, revision: 1, epoch: 0 }
      });
      await coordinator.dispatch(target.id);
    }

    const starts = controls.filter(({ operation }) => operation === 'run.start');
    expect(starts).toHaveLength(2);
    expect(starts.map(({ payload }) => payload.secretEnvironment)).toEqual([
      {
        USER_API_KEY: 'shared-user-secret',
        MAR_CTL_NODE_ID: 'node-1',
        MAR_CTL_WORKSPACE_ID: 'workspace-1',
        MAR_CTL_SESSION_ID: session.id,
        MAR_CTL_RUN_ID: 'goal-run-0',
        MAR_CTL_RUNNER: session.runner
      },
      {
        USER_API_KEY: 'shared-user-secret',
        MAR_CTL_NODE_ID: 'node-1',
        MAR_CTL_WORKSPACE_ID: 'workspace-1',
        MAR_CTL_SESSION_ID: secondSession.id,
        MAR_CTL_RUN_ID: 'goal-run-1',
        MAR_CTL_RUNNER: secondSession.runner
      }
    ]);
    expect(
      starts.map(
        ({ payload }) => (payload.executionMcpServers as ResolvedMcpServer[])[0]?.environment
      )
    ).toEqual([{ MAR_GOAL_MCP_TOKEN: 'token-1' }, { MAR_GOAL_MCP_TOKEN: 'token-2' }]);
    for (const { payload } of starts) {
      expect(payload).not.toHaveProperty('mcpSecretEnvironment');
      expect(payload.mcpInstallations).toEqual([]);
    }
    expect(JSON.stringify(runtime.getAgentSession(session.id))).not.toContain('token-');
  });

  it('drops a stale Goal queue item before it can be claimed', async () => {
    const { runtime, session } = fixture();
    const controls: unknown[] = [];
    const coordinator = new ContinuousRunCoordinator({
      runtime,
      emitQueue: () => undefined,
      emitConversation: () => undefined,
      clearImages: () => undefined,
      cleanupAttachments: () => undefined,
      migrateAssets: () => undefined,
      emitRun: () => undefined,
      control: (_operation, payload) => controls.push(payload),
      stopped: () => false,
      markInterrupted: () => undefined,
      mcps: () => [],
      goalCurrent: () => false
    });
    runtime.createMessageRun({
      sessionId: session.id,
      clientMessageId: 'active-message',
      content: 'active'
    });
    const queued = coordinator.accept({
      runId: 'stale-goal-item',
      sessionId: session.id,
      clientMessageId: 'stale-goal-message',
      content: 'Goal Continue'
    });
    coordinator.prepare(queued.queueItem!.id, {
      ...prepared(queued.queueItem!.id, session.id),
      goal: { id: 'goal-1', revision: 1, epoch: 1 }
    });

    await coordinator.dispatch(session.id);

    expect(runtime.sessionQueue(session.id).itemIds).toEqual([]);
    expect(controls).toEqual([]);
  });

  it('drops a stale Goal queue item instead of starting an idle Run', async () => {
    const { runtime, session } = fixture();
    const controls: unknown[] = [];
    const coordinator = new ContinuousRunCoordinator({
      runtime,
      emitQueue: () => undefined,
      emitConversation: () => undefined,
      clearImages: () => undefined,
      cleanupAttachments: () => undefined,
      migrateAssets: () => undefined,
      emitRun: () => undefined,
      control: (_operation, payload) => controls.push(payload),
      stopped: () => false,
      markInterrupted: () => undefined,
      mcps: () => [],
      goalCurrent: () => false
    });
    const active = runtime.createMessageRun({
      sessionId: session.id,
      clientMessageId: 'active-before-stale-idle-goal',
      content: 'active'
    }).run;
    const queued = coordinator.accept({
      runId: 'stale-idle-goal-item',
      sessionId: session.id,
      clientMessageId: 'stale-idle-goal-message',
      content: 'Goal Continue'
    });
    coordinator.prepare(queued.queueItem!.id, {
      ...prepared(queued.queueItem!.id, session.id),
      goal: { id: 'goal-1', revision: 1, epoch: 1 }
    });
    runtime.finishRun(active.id, 'SUCCEEDED');

    await expect(coordinator.resume(session.id)).resolves.toBeUndefined();

    expect(runtime.activeSessionRun(session.id)).toBeUndefined();
    expect(runtime.sessionQueue(session.id).itemIds).toEqual([]);
    expect(controls).toEqual([]);
  });

  it('rechecks Goal validity after asynchronous MCP resolution', async () => {
    const { runtime, session } = fixture();
    const controls: unknown[] = [];
    const terminal: Array<{ runId: string; status?: string }> = [];
    let current = true;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const coordinator = new ContinuousRunCoordinator({
      runtime,
      emitQueue: () => undefined,
      emitConversation: () => undefined,
      clearImages: () => undefined,
      cleanupAttachments: () => undefined,
      migrateAssets: () => undefined,
      emitRun: (runId, _eventType, _payload, status) =>
        terminal.push({ runId, ...(status === undefined ? {} : { status }) }),
      control: (_operation, payload) => controls.push(payload),
      stopped: () => false,
      markInterrupted: () => undefined,
      mcps: () => [],
      goalCurrent: () => current,
      goalMcp: async () => {
        await gate;
        return {
          name: 'mar_goal',
          origin: 'BUILTIN',
          lifecycle: 'EXECUTION',
          transport: 'STDIO',
          command: process.execPath,
          args: []
        };
      }
    });
    const accepted = coordinator.accept({
      runId: 'goal-run',
      sessionId: session.id,
      clientMessageId: 'goal-message',
      content: 'Goal Start'
    });
    coordinator.prepare(accepted.run.id, {
      ...prepared(accepted.run.id, session.id),
      goal: { id: 'goal-1', revision: 1, epoch: 1 }
    });

    const dispatch = coordinator.dispatch(session.id);
    current = false;
    release();
    await dispatch;

    expect(controls).toEqual([]);
    expect(terminal).toEqual([expect.objectContaining({ status: 'INTERRUPTED' })]);
  });

  it('prepends the original input to a replacement input when a message arrives before Runner startup', async () => {
    const { runtime, session } = fixture();
    const controls: Array<{ operation: string; payload: Record<string, unknown> }> = [];
    const coordinator = new ContinuousRunCoordinator({
      runtime,
      emitQueue: () => undefined,
      emitConversation: () => undefined,
      clearImages: () => undefined,
      cleanupAttachments: () => undefined,
      migrateAssets: () => undefined,
      emitRun: () => undefined,
      control: (operation, payload) => controls.push({ operation, payload }),
      stopped: () => false,
      markInterrupted: () => undefined,
      mcps: () => []
    });
    const first = coordinator.accept({
      runId: 'run-before-runner-start',
      sessionId: session.id,
      clientMessageId: 'message-first',
      content: 'first intent'
    });
    coordinator.prepare(first.run.id, {
      ...prepared(first.run.id, session.id),
      input: 'first intent',
      clientMessageId: 'message-first'
    });
    await coordinator.dispatch(session.id);
    expect(controls[0]?.payload.clientMessageId).toBe('message-first');
    const firstExecutionId = String(controls[0]?.payload.runId);
    const inserted = coordinator.accept({
      runId: 'insert-before-runner-start',
      sessionId: session.id,
      clientMessageId: 'message-inserted',
      content: 'inserted intent'
    });
    const attachmentPath = '.mar/temp-files/insert-before-runner-start/notes.pdf';
    const insertedInput = withNonImageAttachmentPrompt('inserted intent', [attachmentPath]);
    coordinator.prepare(inserted.queueItem!.id, {
      ...prepared(inserted.queueItem!.id, session.id),
      input: insertedInput,
      attachmentPaths: [attachmentPath]
    });

    expect(() =>
      coordinator.settle({
        submissionId: inserted.queueItem!.id,
        intent: 'REPLACE_CURRENT',
        queueBefore: { paused: false, itemIds: [] },
        activeRunId: first.run.id
      })
    ).not.toThrow();
    expect(coordinator.pending(inserted.queueItem!.id)?.input).toBe(
      `first intent\n\n${insertedInput}`
    );
    expect(runtime.getQueueItem(inserted.queueItem!.id)?.content).toBe('inserted intent');
    expect(controls).toContainEqual({
      operation: 'run.interrupt',
      payload: { runId: firstExecutionId }
    });
    runtime.appendRunEvent({
      runId: firstExecutionId,
      sequence: 1,
      eventType: 'run.completed',
      payload: {},
      status: 'INTERRUPTED'
    });
    coordinator.remove(firstExecutionId);
    await coordinator.dispatch(session.id);
    expect(runtime.listConversationTurns({ sessionId: session.id }).turns).toMatchObject([
      {
        items: [
          expect.objectContaining({
            kind: 'user_message',
            payload: expect.objectContaining({ text: 'first intent' })
          })
        ]
      },
      {
        items: [
          expect.objectContaining({
            kind: 'user_message',
            payload: expect.objectContaining({ text: insertedInput })
          })
        ]
      }
    ]);
  });

  it('does not duplicate the accepted original input when a message arrives after Runner startup', async () => {
    const { runtime, session } = fixture();
    const coordinator = new ContinuousRunCoordinator({
      runtime,
      emitQueue: () => undefined,
      emitConversation: () => undefined,
      clearImages: () => undefined,
      cleanupAttachments: () => undefined,
      migrateAssets: () => undefined,
      emitRun: () => undefined,
      control: () => undefined,
      stopped: () => false,
      markInterrupted: () => undefined,
      mcps: () => []
    });
    const first = coordinator.accept({
      runId: 'run-after-runner-start',
      sessionId: session.id,
      clientMessageId: 'message-first-started',
      content: 'first intent'
    });
    coordinator.prepare(first.run.id, {
      ...prepared(first.run.id, session.id),
      input: 'first intent'
    });
    await coordinator.dispatch(session.id);
    const executionId = runtime.currentExecutionId(first.run.id)!;
    coordinator.executionStarted(executionId);
    const inserted = coordinator.accept({
      runId: 'insert-after-runner-start',
      sessionId: session.id,
      clientMessageId: 'message-inserted-started',
      content: 'inserted intent'
    });
    coordinator.prepare(inserted.queueItem!.id, {
      ...prepared(inserted.queueItem!.id, session.id),
      input: 'inserted intent'
    });

    coordinator.settle({
      submissionId: inserted.queueItem!.id,
      intent: 'REPLACE_CURRENT',
      queueBefore: { paused: false, itemIds: [] },
      activeRunId: first.run.id
    });

    expect(coordinator.pending(inserted.queueItem!.id)?.input).toBe('inserted intent');
  });

  it('publishes a queue snapshot immediately when a new QueueItem is created during an active Run', () => {
    const { runtime, session } = fixture();
    const emitQueue = vi.fn();
    const coordinator = new ContinuousRunCoordinator({
      runtime,
      emitQueue,
      emitConversation: () => undefined,
      clearImages: () => undefined,
      cleanupAttachments: () => undefined,
      migrateAssets: () => undefined,
      emitRun: () => undefined,
      control: () => undefined,
      stopped: () => false,
      markInterrupted: () => undefined,
      mcps: () => []
    });

    coordinator.accept({
      runId: 'run-1',
      sessionId: session.id,
      clientMessageId: 'message-1',
      content: 'currently running'
    });
    expect(emitQueue).not.toHaveBeenCalled();

    const queued = coordinator.accept({
      runId: 'queue-1',
      sessionId: session.id,
      clientMessageId: 'message-2',
      content: 'waiting to run'
    });
    expect(queued).toMatchObject({ queueItem: { id: 'queue-1' }, created: true });
    expect(emitQueue).toHaveBeenCalledOnce();
    expect(emitQueue).toHaveBeenCalledWith('workspace-1', session.id);

    coordinator.prepare(queued.queueItem!.id, prepared(queued.queueItem!.id, session.id));
    expect(
      coordinator.settle({
        submissionId: queued.queueItem!.id,
        intent: 'QUEUE',
        queueBefore: { paused: false, itemIds: [] }
      })
    ).toBe('QUEUED');
    expect(emitQueue).toHaveBeenCalledOnce();

    coordinator.accept({
      runId: 'queue-retry',
      sessionId: session.id,
      clientMessageId: 'message-2',
      content: 'waiting to run'
    });
    expect(emitQueue).toHaveBeenCalledOnce();

    coordinator.removePendingQueue(session.id);
    expect(runtime.sessionQueue(session.id).itemIds).toEqual([]);
    expect(coordinator.pending(queued.queueItem!.id)).toBeUndefined();
    expect(emitQueue).toHaveBeenCalledTimes(2);
  });

  it('resumes the FIFO after a paused queue and continues the existing QueueItem', async () => {
    const { runtime, session } = fixture();
    const starts: string[] = [];
    const emitQueue = vi.fn((_workspaceId: string, sessionId: string) =>
      runtime.sessionQueue(sessionId)
    );
    const coordinator = new ContinuousRunCoordinator({
      runtime,
      emitQueue,
      emitConversation: () => undefined,
      clearImages: () => undefined,
      cleanupAttachments: () => undefined,
      migrateAssets: () => undefined,
      emitRun: () => undefined,
      control: (operation, payload) => {
        if (operation === 'run.start') starts.push(String(payload.runId));
      },
      stopped: () => false,
      markInterrupted: () => undefined,
      mcps: () => []
    });
    const previous = runtime.createMessageRun({
      sessionId: session.id,
      clientMessageId: 'previous-run',
      content: 'previous message'
    }).run;
    runtime.finishRun(previous.id, 'INTERRUPTED');
    runtime.removeTerminalRun(previous.id);
    const waiting = runtime.createQueueItem({
      sessionId: session.id,
      clientMessageId: 'waiting-message',
      content: 'original queued message'
    }).item;
    coordinator.prepare(waiting.id, prepared(waiting.id, session.id));
    runtime.pauseSessionQueue(session.id);
    const pausedVersion = runtime.sessionQueue(session.id).version;
    const resumed = coordinator.accept({
      runId: 'new-run-after-pause',
      sessionId: session.id,
      clientMessageId: 'new-message',
      content: 'continue sending'
    });
    coordinator.prepare(resumed.run.id, prepared(resumed.run.id, session.id));

    expect(
      coordinator.settle({
        submissionId: resumed.run.id,
        intent: 'QUEUE',
        queueBefore: { paused: true, itemIds: [waiting.id] }
      })
    ).toBe('STARTED');
    expect(runtime.sessionQueue(session.id).paused).toBe(false);
    expect(emitQueue).toHaveBeenCalledExactlyOnceWith(session.workspaceId, session.id);
    expect(emitQueue).toHaveLastReturnedWith({
      version: pausedVersion + 1,
      paused: false,
      itemIds: [waiting.id]
    });
    await coordinator.dispatch(session.id);
    expect(starts).toHaveLength(1);
    const resumedExecutionId = starts[0]!;
    runtime.appendRunEvent({
      runId: resumedExecutionId,
      sequence: 1,
      eventType: 'run.completed',
      payload: {},
      status: 'SUCCEEDED'
    });
    coordinator.remove(resumedExecutionId);
    await coordinator.dispatch(session.id);
    expect(starts).toHaveLength(2);
    expect(runtime.sessionQueue(session.id).itemIds).toEqual([]);
  });

  it('lets the coordinator claim the queue head and create the next Execution after the current Execution terminates', async () => {
    const { runtime, session } = fixture();
    const starts: string[] = [];
    const projectedTurns: unknown[] = [];
    const coordinator = new ContinuousRunCoordinator({
      runtime,
      emitQueue: () => undefined,
      emitConversation: (turn) => projectedTurns.push(turn),
      clearImages: () => undefined,
      cleanupAttachments: () => undefined,
      migrateAssets: () => undefined,
      emitRun: () => undefined,
      control: (operation, payload) => {
        if (operation === 'run.start' && typeof payload.runId === 'string')
          starts.push(payload.runId);
      },
      stopped: () => false,
      markInterrupted: () => undefined,
      mcps: () => []
    });
    const first = coordinator.accept({
      runId: 'run-1',
      sessionId: session.id,
      clientMessageId: 'message-1',
      content: 'first message'
    });
    coordinator.prepare(first.run.id, prepared(first.run.id, session.id));
    const second = coordinator.accept({
      runId: 'queue-1',
      sessionId: session.id,
      clientMessageId: 'message-2',
      content: 'second message',
      attachments: [{ name: 'diagram.png', mime: 'image/png', dataBase64: 'cG5n' }]
    });
    coordinator.prepare(second.queueItem!.id, prepared(second.queueItem!.id, session.id));

    await coordinator.dispatch(session.id);
    const firstExecutionId = starts[0]!;
    runtime.appendRunEvent({
      runId: firstExecutionId,
      sequence: 1,
      eventType: 'run.completed',
      payload: {},
      status: 'SUCCEEDED'
    });
    coordinator.remove(firstExecutionId);
    await coordinator.dispatch(session.id);

    expect(starts).toHaveLength(2);
    expect(starts[1]).not.toBe(firstExecutionId);
    expect(projectedTurns.at(-1)).toMatchObject({
      items: [
        expect.objectContaining({
          payload: expect.objectContaining({
            attachments: [expect.objectContaining({ runId: starts[1], imageIndex: 0 })]
          })
        })
      ]
    });
    expect(runtime.sessionQueue(session.id).itemIds).toEqual([]);
    expect(runtime.listConversationTurns({ sessionId: session.id }).turns).toMatchObject([
      { runId: first.run.id, status: 'SUCCEEDED' },
      { runId: first.run.id, status: 'PREPARING' }
    ]);
  });

  it('waits for queue-head preparation to finish before claiming it when the current Execution finishes first', async () => {
    const { runtime, session } = fixture();
    const starts: string[] = [];
    const coordinator = new ContinuousRunCoordinator({
      runtime,
      emitQueue: () => undefined,
      emitConversation: () => undefined,
      clearImages: () => undefined,
      cleanupAttachments: () => undefined,
      migrateAssets: () => undefined,
      emitRun: () => undefined,
      control: (operation, payload) => {
        if (operation === 'run.start' && typeof payload.runId === 'string')
          starts.push(payload.runId);
      },
      stopped: () => false,
      markInterrupted: () => undefined,
      mcps: () => []
    });
    const first = coordinator.accept({
      runId: 'run-1',
      sessionId: session.id,
      clientMessageId: 'message-1',
      content: 'first message'
    });
    coordinator.prepare(first.run.id, prepared(first.run.id, session.id));
    const second = coordinator.accept({
      runId: 'queue-1',
      sessionId: session.id,
      clientMessageId: 'message-2',
      content: 'second message'
    });

    await coordinator.dispatch(session.id);
    const firstExecutionId = starts[0]!;
    runtime.appendRunEvent({
      runId: firstExecutionId,
      sequence: 1,
      eventType: 'run.completed',
      payload: {},
      status: 'SUCCEEDED'
    });
    coordinator.remove(firstExecutionId);

    await expect(coordinator.dispatch(session.id)).resolves.toBeUndefined();
    expect(runtime.sessionQueue(session.id).itemIds).toEqual([second.queueItem!.id]);
    expect(starts).toHaveLength(1);

    coordinator.prepare(second.queueItem!.id, prepared(second.queueItem!.id, session.id));
    await coordinator.dispatch(session.id);
    expect(runtime.sessionQueue(session.id).itemIds).toEqual([]);
    expect(starts).toHaveLength(2);
  });

  it('settles the continuous Run when the last QueueItem fails preparation after the current Execution ended', async () => {
    const { runtime, session } = fixture();
    const starts: string[] = [];
    const terminal: { runId: string; status?: string }[] = [];
    const coordinator = new ContinuousRunCoordinator({
      runtime,
      emitQueue: () => undefined,
      emitConversation: () => undefined,
      clearImages: () => undefined,
      cleanupAttachments: () => undefined,
      migrateAssets: () => undefined,
      emitRun: (runId, _eventType, _payload, status) =>
        terminal.push({ runId, ...(status === undefined ? {} : { status }) }),
      control: (operation, payload) => {
        if (operation === 'run.start' && typeof payload.runId === 'string')
          starts.push(payload.runId);
      },
      stopped: () => false,
      markInterrupted: () => undefined,
      mcps: () => []
    });
    const first = coordinator.accept({
      runId: 'run-1',
      sessionId: session.id,
      clientMessageId: 'message-1',
      content: 'first message'
    });
    coordinator.prepare(first.run.id, prepared(first.run.id, session.id));
    const second = coordinator.accept({
      runId: 'queue-1',
      sessionId: session.id,
      clientMessageId: 'message-2',
      content: 'second message'
    });

    await coordinator.dispatch(session.id);
    const firstExecutionId = starts[0]!;
    runtime.appendRunEvent({
      runId: firstExecutionId,
      sequence: 1,
      eventType: 'run.completed',
      payload: {},
      status: 'SUCCEEDED'
    });
    coordinator.remove(firstExecutionId);

    coordinator.failPreparation(second.queueItem!.id, 'MESSAGE_PREPARATION_FAILED');

    expect(runtime.sessionQueue(session.id).itemIds).toEqual([]);
    expect(terminal).toEqual([{ runId: first.run.id, status: 'FAILED' }]);
  });

  it('claims multiple QueueItems in order within one Run without changing runId or startedAt', () => {
    const { runtime, session } = fixture();
    const first = runtime.createMessageRun({
      sessionId: session.id,
      clientMessageId: 'message-1',
      content: 'first message',
      initiatedByUserId: 7
    }).run;
    const firstExecution = runtime.createExecution(first.id);
    runtime.appendRunEvent({
      runId: firstExecution.id,
      sequence: 1,
      eventType: 'run.running',
      payload: {},
      status: 'RUNNING'
    });
    const second = runtime.createQueueItem({
      sessionId: session.id,
      clientMessageId: 'message-2',
      content: 'second message',
      initiatedByUserId: 7
    }).item;

    runtime.appendRunEvent({
      runId: firstExecution.id,
      sequence: 2,
      eventType: 'run.completed',
      payload: {},
      status: 'SUCCEEDED'
    });
    expect(runtime.currentExecutionId(first.id)).toBeUndefined();
    const claimed = runtime.claimNextQueueItem(session.id);
    expect(claimed?.item.id).toBe(second.id);
    expect(runtime.findMessageSubmission(session.id, 'message-2')).toMatchObject({
      kind: 'run',
      run: { id: first.id }
    });
    const secondExecution = runtime.createExecution(first.id);

    expect(secondExecution.id).not.toBe(firstExecution.id);
    expect(runtime.conversationTurnForRun(first.id)?.id).toBe(claimed?.turn.id);
    expect(runtime.conversationTurnForRun(firstExecution.id)?.id).toBe(claimed?.turn.id);
    expect(runtime.conversationTurnForRun(secondExecution.id)?.id).toBe(claimed?.turn.id);
    expect(runtime.conversationTurnForExecution(firstExecution.id)?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'user_message',
          payload: expect.objectContaining({ text: 'first message' })
        })
      ])
    );
    expect(runtime.conversationTurnForExecution(secondExecution.id)?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'user_message',
          payload: expect.objectContaining({ text: 'second message' })
        })
      ])
    );
    expect(runtime.activeSessionRun(session.id)).toMatchObject({
      id: first.id,
      startedAt: first.startedAt,
      status: 'RUNNING'
    });
    expect(runtime.listConversationTurns({ sessionId: session.id }).turns).toMatchObject([
      { runId: first.id, status: 'SUCCEEDED' },
      { runId: first.id, status: 'PREPARING' }
    ]);
  });

  it('preserves the Execution association of a bounded historical Turn after Run cleanup', () => {
    const { runtime, session } = fixture();
    const run = runtime.createMessageRun({
      sessionId: session.id,
      clientMessageId: 'message-terminal',
      content: 'terminal history'
    }).run;
    const execution = runtime.createExecution(run.id);
    runtime.appendRunEvent({
      runId: execution.id,
      sequence: 1,
      eventType: 'run.completed',
      payload: {},
      status: 'SUCCEEDED'
    });
    runtime.finishRun(run.id, 'SUCCEEDED');

    runtime.removeTerminalRun(run.id);

    expect(runtime.getRun(run.id)).toBeUndefined();
    expect(runtime.conversationTurnForRun(run.id)).toMatchObject({
      runId: run.id,
      status: 'SUCCEEDED'
    });
    expect(runtime.conversationTurnForRun('unknown-run')).toBeUndefined();
    expect(runtime.conversationTurnForExecution(execution.id)).toMatchObject({
      runId: run.id,
      status: 'SUCCEEDED'
    });

    runtime.resetAgentSessionHistory(session.id, 1_000);
    expect(runtime.conversationTurnForRun(run.id)).toBeUndefined();
    expect(runtime.conversationTurnForExecution(execution.id)).toBeUndefined();
  });

  it('preserves MAR Agent todo items in the live Conversation projection', () => {
    const { runtime, session } = fixture();
    const run = runtime.createMessageRun({
      sessionId: session.id,
      clientMessageId: 'mar-agent-todo',
      content: 'run a multi-stage task'
    }).run;
    const execution = runtime.createExecution(run.id);

    runtime.appendRunEvent({
      runId: execution.id,
      sequence: 1,
      eventType: 'conversation.item',
      payload: {
        itemId: 'mar-agent-todo-list:execution',
        kind: 'todo_list',
        status: 'COMPLETED',
        payload: {
          items: [
            { id: 'inspect', text: 'inspect the implementation', status: 'COMPLETED' },
            { id: 'fix', text: 'fix the projection', status: 'IN_PROGRESS' }
          ]
        },
        merge: true
      }
    });

    expect(runtime.conversationTurnForExecution(execution.id)?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'todo_list',
          status: 'COMPLETED',
          payload: {
            items: [
              { id: 'inspect', text: 'inspect the implementation', status: 'COMPLETED' },
              { id: 'fix', text: 'fix the projection', status: 'IN_PROGRESS' }
            ]
          }
        })
      ])
    );
  });

  it('interrupts the current Execution and keeps the same Run when a QueueItem is run immediately', async () => {
    const { runtime, session } = fixture();
    const interrupted: string[] = [];
    const controls: { operation: string; payload: Record<string, unknown> }[] = [];
    const coordinator = new ContinuousRunCoordinator({
      runtime,
      emitQueue: () => undefined,
      emitConversation: () => undefined,
      clearImages: () => undefined,
      cleanupAttachments: () => undefined,
      migrateAssets: () => undefined,
      emitRun: () => undefined,
      control: (operation, payload) => controls.push({ operation, payload }),
      stopped: () => false,
      markInterrupted: (executionId) => interrupted.push(executionId),
      mcps: () => []
    });
    const run = runtime.createMessageRun({
      sessionId: session.id,
      clientMessageId: 'active',
      content: 'running'
    }).run;
    const execution = runtime.createExecution(run.id);
    const queued = coordinator.accept({
      runId: 'queued',
      sessionId: session.id,
      clientMessageId: 'queued',
      content: 'run with priority'
    });
    coordinator.prepare(queued.queueItem!.id, prepared(queued.queueItem!.id, session.id));

    await expect(coordinator.executeQueueItem(queued.queueItem!.id)).resolves.toMatchObject({
      run: { id: run.id },
      delivery: 'ACCEPTED'
    });
    expect(interrupted).toEqual([execution.id]);
    expect(controls).toEqual([{ operation: 'run.interrupt', payload: { runId: execution.id } }]);
  });

  it('rejects additional input from another user during an active Run', () => {
    const { runtime, session } = fixture();
    runtime.createMessageRun({
      sessionId: session.id,
      clientMessageId: 'owner-message',
      content: 'start',
      initiatedByUserId: 7
    });

    expect(() =>
      runtime.createQueueItem({
        sessionId: session.id,
        clientMessageId: 'other-message',
        content: 'unauthorized append',
        initiatedByUserId: 8
      })
    ).toThrow('RUN_OWNED_BY_ANOTHER_USER');
  });

  it('rejects additional queue entries from another user after the first user claims an ownerless Run', () => {
    const { runtime, session } = fixture();
    runtime.adoptRun({
      runId: 'ownerless-run-with-queue',
      sessionId: session.id,
      runner: session.runner,
      cwd: session.cwd,
      externalSessionId: 'ownerless-session-with-queue'
    });
    runtime.createQueueItem({
      sessionId: session.id,
      clientMessageId: 'owner-queued-message',
      content: 'run later',
      initiatedByUserId: 7
    });

    expect(() =>
      runtime.createQueueItem({
        sessionId: session.id,
        clientMessageId: 'other-queued-message',
        content: 'unauthorized queue entry',
        initiatedByUserId: 8
      })
    ).toThrow('RUN_OWNED_BY_ANOTHER_USER');
  });

  it('prioritizes queued input after stopping an immediate command Run with no Execution and waits for command completion', async () => {
    const { runtime, session } = fixture();
    const control = vi.fn();
    const markInterrupted = vi.fn();
    const coordinator = new ContinuousRunCoordinator({
      runtime,
      emitQueue: () => undefined,
      emitConversation: () => undefined,
      clearImages: () => undefined,
      cleanupAttachments: () => undefined,
      migrateAssets: () => undefined,
      emitRun: () => undefined,
      control,
      stopped: () => false,
      markInterrupted,
      mcps: () => []
    });
    const commandRun = runtime.adoptRun({
      runId: 'compact-command-run',
      sessionId: session.id,
      runner: session.runner,
      cwd: session.cwd,
      externalSessionId: 'thread-command'
    });
    runtime.appendRunEvent({
      runId: commandRun.id,
      sequence: 1,
      eventType: 'run.running',
      payload: {},
      status: 'RUNNING'
    });
    runtime.appendRunEvent({
      runId: commandRun.id,
      sequence: 2,
      eventType: 'conversation.item',
      payload: {
        itemId: 'compact-command',
        kind: 'context_compaction',
        status: 'IN_PROGRESS',
        payload: { phase: 'STARTED', summary: null },
        merge: true
      }
    });
    const queued = coordinator.accept({
      runId: 'replacement-message',
      sessionId: session.id,
      clientMessageId: 'replacement-message',
      content: 'prioritize after compaction completes'
    });
    coordinator.prepare(queued.queueItem!.id, prepared(queued.queueItem!.id, session.id));

    expect(
      coordinator.settle({
        submissionId: queued.queueItem!.id,
        intent: 'REPLACE_CURRENT',
        queueBefore: { paused: false, itemIds: [] },
        activeRunId: commandRun.id
      })
    ).toBe('QUEUED');
    expect(runtime.sessionQueue(session.id).itemIds).toEqual([queued.queueItem!.id]);
    expect(runtime.getRun(commandRun.id)?.status).toBe('RUNNING');
    expect(markInterrupted).not.toHaveBeenCalled();
    expect(control).not.toHaveBeenCalled();

    runtime.appendRunEvent({
      runId: commandRun.id,
      sequence: 3,
      eventType: 'run.completed',
      payload: {},
      status: 'SUCCEEDED'
    });
    await coordinator.dispatch(session.id);

    expect(runtime.sessionQueue(session.id).itemIds).toEqual([]);
    expect(control).toHaveBeenCalledWith(
      'run.start',
      expect.objectContaining({ input: 'message' })
    );
  });

  it('allows the user who claims a QueueItem in an ownerless Run to interrupt later Executions', async () => {
    const { runtime, session } = fixture();
    const control = vi.fn();
    const coordinator = new ContinuousRunCoordinator({
      runtime,
      emitQueue: () => undefined,
      emitConversation: () => undefined,
      clearImages: () => undefined,
      cleanupAttachments: () => undefined,
      migrateAssets: () => undefined,
      emitRun: () => undefined,
      control,
      stopped: () => false,
      markInterrupted: vi.fn(),
      mcps: () => []
    });
    const commandRun = runtime.adoptRun({
      runId: 'ownerless-command-run',
      sessionId: session.id,
      runner: session.runner,
      cwd: session.cwd,
      externalSessionId: 'ownerless-command-session'
    });
    runtime.appendRunEvent({
      runId: commandRun.id,
      sequence: 1,
      eventType: 'run.running',
      payload: {},
      status: 'RUNNING'
    });
    const queued = coordinator.accept({
      runId: 'owned-queued-message',
      sessionId: session.id,
      clientMessageId: 'owned-queued-message',
      content: 'continue after command completion',
      initiatedByUserId: 7
    });
    coordinator.prepare(queued.queueItem!.id, prepared(queued.queueItem!.id, session.id));

    await coordinator.dispatch(session.id);

    expect(runtime.getRun(commandRun.id)?.initiatedByUserId).toBe(7);
    const executionId = runtime.currentExecutionId(commandRun.id);
    expect(executionId).toBeDefined();
    const service = new RunWorkbenchService({
      runtime,
      readImage: async () => undefined,
      respondUserInput: vi.fn(),
      pauseQueue: vi.fn(),
      runInterrupted: vi.fn(),
      emitRun: vi.fn(),
      control,
      markInterrupted: vi.fn()
    });
    const interrupt = service.operations()['run.interrupt'];
    expect(() =>
      interrupt?.({
        runId: commandRun.id,
        __requestUserId: 8
      })
    ).toThrow('RUN_OWNED_BY_ANOTHER_USER');
    expect(() =>
      interrupt?.({
        runId: commandRun.id,
        __requestUserId: 7
      })
    ).not.toThrow();
    expect(control).toHaveBeenCalledWith('run.interrupt', { runId: executionId });
  });

  it('uses the root Run ID to interrupt the Runner after an immediate command creates an item-only Turn', () => {
    const { runtime, session } = fixture();
    const control = vi.fn();
    const commandRun = runtime.adoptRun({
      runId: 'item-only-command-run',
      sessionId: session.id,
      runner: session.runner,
      cwd: session.cwd,
      externalSessionId: 'item-only-command-session',
      initiatedByUserId: 7
    });
    runtime.appendRunEvent({
      runId: commandRun.id,
      sequence: 1,
      eventType: 'conversation.item',
      payload: {
        itemId: 'command-compaction',
        kind: 'context_compaction',
        status: 'IN_PROGRESS',
        payload: { phase: 'STARTED', summary: null }
      }
    });
    expect(runtime.conversationTurnForRun(commandRun.id)?.userItemId).toBeNull();
    const service = new RunWorkbenchService({
      runtime,
      readImage: async () => undefined,
      respondUserInput: vi.fn(),
      pauseQueue: vi.fn(),
      runInterrupted: vi.fn(),
      emitRun: vi.fn(),
      control,
      markInterrupted: vi.fn()
    });

    expect(() =>
      service.operations()['run.interrupt']?.({
        runId: commandRun.id,
        __requestUserId: 7
      })
    ).not.toThrow();
    expect(control).toHaveBeenCalledWith('run.interrupt', { runId: commandRun.id });
  });

  it('does not terminate the command Run when queued-message preparation fails during an immediate command', () => {
    const { runtime, session } = fixture();
    const emitRun = vi.fn();
    const coordinator = new ContinuousRunCoordinator({
      runtime,
      emitQueue: () => undefined,
      emitConversation: () => undefined,
      clearImages: () => undefined,
      cleanupAttachments: () => undefined,
      migrateAssets: () => undefined,
      emitRun,
      control: () => undefined,
      stopped: () => false,
      markInterrupted: () => undefined,
      mcps: () => []
    });
    const commandRun = runtime.adoptRun({
      runId: 'compact-command-preparation-failure',
      sessionId: session.id,
      runner: session.runner,
      cwd: session.cwd,
      externalSessionId: 'thread-command-failure'
    });
    runtime.appendRunEvent({
      runId: commandRun.id,
      sequence: 1,
      eventType: 'run.running',
      payload: {},
      status: 'RUNNING'
    });
    runtime.appendRunEvent({
      runId: commandRun.id,
      sequence: 2,
      eventType: 'conversation.item',
      payload: {
        itemId: 'compact-command-failure',
        kind: 'context_compaction',
        status: 'IN_PROGRESS',
        payload: { phase: 'STARTED', summary: null },
        merge: true
      }
    });
    const queued = coordinator.accept({
      runId: 'failed-replacement-message',
      sessionId: session.id,
      clientMessageId: 'failed-replacement-message',
      content: 'attachment preparation failed'
    });

    coordinator.failPreparation(queued.queueItem!.id, 'COMPOSER_ATTACHMENT_UNAVAILABLE');

    expect(runtime.sessionQueue(session.id).itemIds).toEqual([]);
    expect(runtime.getRun(commandRun.id)?.status).toBe('RUNNING');
    expect(emitRun).not.toHaveBeenCalled();
  });

  it('releases the Run according to the command result when the last QueueItem fails after command completion', () => {
    const { runtime, session } = fixture();
    const emitRun = vi.fn();
    const coordinator = new ContinuousRunCoordinator({
      runtime,
      emitQueue: () => undefined,
      emitConversation: () => undefined,
      clearImages: () => undefined,
      cleanupAttachments: () => undefined,
      migrateAssets: () => undefined,
      emitRun,
      control: () => undefined,
      stopped: () => false,
      markInterrupted: () => undefined,
      mcps: () => []
    });
    const commandRun = runtime.adoptRun({
      runId: 'completed-compact-command',
      sessionId: session.id,
      runner: session.runner,
      cwd: session.cwd,
      externalSessionId: 'completed-command-session'
    });
    runtime.appendRunEvent({
      runId: commandRun.id,
      sequence: 1,
      eventType: 'run.running',
      payload: {},
      status: 'RUNNING'
    });
    runtime.appendRunEvent({
      runId: commandRun.id,
      sequence: 2,
      eventType: 'conversation.item',
      payload: {
        itemId: 'completed-compact-item',
        kind: 'context_compaction',
        status: 'IN_PROGRESS',
        payload: { phase: 'STARTED', summary: null },
        merge: true
      }
    });
    const queued = coordinator.accept({
      runId: 'failed-after-command-completion',
      sessionId: session.id,
      clientMessageId: 'failed-after-command-completion',
      content: 'attachment preparation failed'
    });
    runtime.appendRunEvent({
      runId: commandRun.id,
      sequence: 3,
      eventType: 'run.completed',
      payload: {},
      status: 'SUCCEEDED'
    });

    coordinator.failPreparation(queued.queueItem!.id, 'COMPOSER_ATTACHMENT_UNAVAILABLE');

    expect(runtime.sessionQueue(session.id).itemIds).toEqual([]);
    expect(emitRun).toHaveBeenCalledWith(commandRun.id, 'run.completed', {}, 'SUCCEEDED');
  });

  it('creates a new Run from the queue head when a paused queue resumes', () => {
    const { runtime, session } = fixture();
    const initial = runtime.createMessageRun({
      sessionId: session.id,
      clientMessageId: 'initial',
      content: 'initial task',
      initiatedByUserId: 7
    }).run;
    const queued = runtime.createQueueItem({
      sessionId: session.id,
      clientMessageId: 'queued',
      content: 'retained task',
      initiatedByUserId: 7
    }).item;
    runtime.pauseSessionQueue(session.id);
    runtime.finishRun(initial.id, 'INTERRUPTED');

    runtime.resumeSessionQueue(session.id);
    const resumed = runtime.startRunFromQueueItem(queued.id);

    expect(resumed.run.id).not.toBe(initial.id);
    expect(resumed.run.clientMessageId).toBe('queued');
    expect(runtime.sessionQueue(session.id).itemIds).toEqual([]);
  });

  it('settles a late terminal state on the old Turn without replacing the current Execution', () => {
    const { runtime, session } = fixture();
    const run = runtime.createMessageRun({
      sessionId: session.id,
      clientMessageId: 'first',
      content: 'first message'
    }).run;
    const first = runtime.createExecution(run.id);
    runtime.appendRunEvent({
      runId: first.id,
      sequence: 1,
      eventType: 'run.completed',
      payload: {},
      status: 'SUCCEEDED'
    });
    runtime.createQueueItem({
      sessionId: session.id,
      clientMessageId: 'second',
      content: 'second message'
    });
    runtime.claimNextQueueItem(session.id);
    const current = runtime.createExecution(run.id);

    runtime.appendRunEvent({
      runId: first.id,
      sequence: 2,
      eventType: 'run.completed',
      payload: { duplicate: true },
      status: 'SUCCEEDED'
    });

    expect(runtime.currentExecutionId(run.id)).toBe(current.id);
    expect(runtime.activeSessionRun(session.id)?.id).toBe(run.id);
  });

  it('projects only a controlled image reference when an active Run claims an image-bearing queue message', () => {
    const { runtime, session } = fixture();
    const run = runtime.createMessageRun({
      sessionId: session.id,
      clientMessageId: 'first',
      content: 'first message'
    }).run;
    runtime.createQueueItem({
      sessionId: session.id,
      clientMessageId: 'image',
      content: 'view image',
      attachments: [{ name: 'diagram.png', mime: 'image/png', dataBase64: 'cG5n' }]
    });

    const claimed = runtime.claimNextQueueItem(session.id);

    expect(claimed?.turn.items[0]?.payload).toMatchObject({
      attachments: [
        {
          name: 'diagram.png',
          mime: 'image/png',
          byteSize: 3,
          runId: run.id,
          imageIndex: 0
        }
      ]
    });
    expect(JSON.stringify(claimed?.turn)).not.toContain('dataBase64');
  });
});

function prepared(runId: string, sessionId: string) {
  return {
    runId,
    sessionId,
    workspaceId: 'workspace-1',
    executionContext: { runner: 'codex' as const },
    input: 'message',
    attachments: [],
    attachmentPaths: [],
    cwd: '/workspace',
    externalSessionId: 'thread-1',
    model: null,
    effort: null,
    access: null,
    collaborationMode: 'default' as const,
    secretEnvironment: {}
  };
}
