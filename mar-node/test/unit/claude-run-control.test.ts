vi.mock('ws', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ws')>();
  const { mockedWebSocket } = await import('./support/control-socket.js');
  return { ...actual, default: mockedWebSocket(actual.default) };
});
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope } from '../../../packages/protocol/src/index.js';
import { ClaudeAgentSdkAdapter } from '../../src/runner/claude/claude-agent-sdk.js';
import { NodeConnector } from '../../src/connector.js';
import { NodeDatabase } from '../../src/database.js';
import type { NodeRuntimeState } from '../../src/runtime-state.js';
import { ClaudeCodeRunner } from '../../src/runner/claude-code-runner.js';
import type { NodeAgentSession } from '../../src/session/contracts.js';
import { ClaudeChannelGate } from '../../src/runner/claude/claude-channel.js';
import {
  preparedDatabase,
  attachSocket,
  receive,
  bindings,
  permissionStream,
  pendingStream,
  resultThenPendingStream,
  capabilities,
  eventually
} from './support/claude-connector.js';

const temporaryWorkspaces: string[] = [];

function temporaryWorkspace(): string {
  const directory = mkdtempSync(join(tmpdir(), 'mar-claude-run-control-'));
  temporaryWorkspaces.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryWorkspaces.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('Claude Run queue, Channel, and lifecycle', () => {
  it('looks up owned native aliases without scanning the full registry and maintains reassignment', () => {
    const runner = new ClaudeCodeRunner();
    const first = { id: 'managed-first' } as NodeAgentSession;
    const second = { id: 'managed-second' } as NodeAgentSession;
    runner.rememberManagedNative(first, 'native-a');
    runner.rememberManagedNative(first, 'native-b');
    runner.rememberManagedNative(first, 'native-b');
    runner.rememberManagedNative(second, 'native-c');
    const scan = vi
      .spyOn(runner.execution.managedSessionByNativeId, Symbol.iterator)
      .mockImplementation(() => {
        throw new Error('The full alias registry must not be scanned for a single Session');
      });
    try {
      expect(runner.nativeAliasesFor(first.id)).toEqual(['native-a', 'native-b']);
      expect(runner.nativeAliasesFor(second.id)).toEqual(['native-c']);
      runner.rememberManagedNative(second, 'native-b');
      expect(runner.nativeAliasesFor(first.id)).toEqual(['native-a']);
      expect(runner.nativeAliasesFor(second.id)).toEqual(['native-c', 'native-b']);
      expect(runner.managedAliasId('native-b')).toBe(second.id);
      runner.forgetNativeAlias('native-a');
      expect(runner.nativeAliasesFor(first.id)).toEqual([]);
      expect(runner.managedAliasId('native-a')).toBeUndefined();
      expect(runner.execution.managedNativeIds.has('native-a')).toBe(false);
      expect(runner.nativeAliasesFor('missing')).toEqual([]);
    } finally {
      scan.mockRestore();
      runner.stop();
    }
  });

  it('releases SDK requests, timers and active handles through an idempotent Runner stop', async () => {
    vi.useFakeTimers();
    const runner = new ClaudeCodeRunner();
    const resolve = vi.fn();
    const reject = vi.fn();
    const expired = vi.fn();
    const cancel = vi.fn();
    runner.execution.approvals.set('approval', {
      runId: 'run',
      resolve,
      timer: setTimeout(() => expired(), 100)
    });
    runner.execution.userInputs.set('question', {
      runId: 'run',
      requestId: 'question',
      questions: [],
      input: {},
      resolve: vi.fn(),
      reject,
      timer: setTimeout(() => expired(), 100)
    });
    runner.execution.runs.set('run', {
      marSessionId: 'session',
      cwd: '/workspace',
      gate: new ClaudeChannelGate('session'),
      handle: {
        completed: Promise.resolve(),
        interrupt: async () => {},
        deliver: async () => {},
        cancel
      }
    });
    try {
      expect(vi.getTimerCount()).toBe(2);
      runner.stop();
      runner.stop();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(100);
      expect(resolve).toHaveBeenCalledExactlyOnceWith('REJECTED');
      expect(reject).toHaveBeenCalledExactlyOnceWith('NODE_STOPPED');
      expect(cancel).toHaveBeenCalledOnce();
      expect(expired).not.toHaveBeenCalled();
      expect(runner.execution.approvals.size).toBe(0);
      expect(runner.execution.userInputs.size).toBe(0);
      expect(runner.execution.runs.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('routes external Channel input through the message coordinator and assigns it to the continuous Run of the requesting user', async () => {
    const database = new NodeDatabase(':memory:', 'node-claude-channel-continuous-run');
    const workspace = database.saveWorkspace({
      path: temporaryWorkspace(),
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({
      reconnect: false,
      database,
      capabilities: capabilities()
    });
    const internals = connector as unknown as {
      runtime: {
        createAgentSession(input: Record<string, unknown>): { readonly id: string };
        setChannelToken(sessionId: string, token: string): void;
        sessionQueue(sessionId: string): { readonly itemIds: readonly string[] };
        activeSessionRun(sessionId: string): { readonly id: string } | undefined;
      };
      continuousRunCoordinator: { schedule(sessionId: string): void };
      executeNodeOperation(operation: string, data: unknown): Promise<unknown>;
    };
    const session = internals.runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'claude-code',
      cwd: workspace.path
    });
    const token = 'channel-token-for-continuous-run';
    internals.runtime.setChannelToken(session.id, token);
    vi.spyOn(internals.continuousRunCoordinator, 'schedule').mockImplementation(() => undefined);

    try {
      await expect(
        internals.executeNodeOperation('session.channel.message', {
          sessionId: session.id,
          token,
          clientMessageId: 'channel-first',
          content: 'first external message',
          __requestUserId: 7
        })
      ).resolves.toMatchObject({ delivery: 'STARTED' });
      const active = internals.runtime.activeSessionRun(session.id);
      expect(active).toBeDefined();

      await expect(
        internals.executeNodeOperation('session.channel.message', {
          sessionId: session.id,
          token,
          clientMessageId: 'channel-next',
          content: 'subsequent external message',
          __requestUserId: 7
        })
      ).resolves.toMatchObject({ delivery: 'QUEUED', run: { id: active?.id } });
      expect(internals.runtime.sessionQueue(session.id).itemIds).toHaveLength(1);

      await expect(
        internals.executeNodeOperation('session.channel.message', {
          sessionId: session.id,
          token,
          clientMessageId: 'channel-other-user',
          content: 'message from another user',
          __requestUserId: 8
        })
      ).rejects.toThrow('RUN_OWNED_BY_ANOTHER_USER');
    } finally {
      connector.stop();
    }
  });

  it('creates one Run for concurrent session messages and stores the rest as QueueItems', async () => {
    vi.useFakeTimers();
    const database = new NodeDatabase(':memory:', 'node-claude-concurrent-message-dispatch');
    const workspace = database.saveWorkspace({
      path: temporaryWorkspace(),
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({
      reconnect: false,
      database,
      capabilities: capabilities()
    });
    const internals = connector as unknown as {
      runtime: {
        createAgentSession(input: Record<string, unknown>): { readonly id: string };
        promoteSessionIdentity(sessionId: string, nativeSessionId: string): unknown;
        sessionQueue(sessionId: string): { readonly itemIds: readonly string[] };
      };
      continuousRunCoordinator: {
        clear(): void;
        dispatch(sessionId: string): Promise<void>;
        schedule(sessionId: string): void;
      };
      executeNodeOperation(operation: string, data: unknown): Promise<unknown>;
    };
    const session = internals.runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'claude-code',
      cwd: workspace.path
    });
    const dispatch = vi
      .spyOn(internals.continuousRunCoordinator, 'dispatch')
      .mockResolvedValue(undefined);

    try {
      const results = (await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          internals.executeNodeOperation('session.message', {
            sessionId: session.id,
            clientMessageId: `concurrent-message-${index}`,
            content: `concurrent message ${index}`
          })
        )
      )) as readonly { readonly delivery: string }[];

      expect(results.filter((result) => result.delivery === 'STARTED')).toHaveLength(1);
      expect(results.filter((result) => result.delivery === 'QUEUED')).toHaveLength(19);
      expect(internals.runtime.sessionQueue(session.id).itemIds).toHaveLength(19);
      await vi.advanceTimersByTimeAsync(1);
      expect(dispatch).toHaveBeenCalledOnce();
      expect(dispatch).toHaveBeenCalledWith(session.id);
      internals.continuousRunCoordinator.clear();
    } finally {
      connector.stop();
      vi.useRealTimers();
    }
  });

  it('assigns a QueueItem to a new Run when the previous Run ends during message preparation', async () => {
    const database = new NodeDatabase(':memory:', 'node-claude-queue-preparing-race');
    const workspace = database.saveWorkspace({
      path: temporaryWorkspace(),
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({
      reconnect: false,
      database,
      capabilities: capabilities()
    });
    const internals = connector as unknown as {
      runtime: {
        createAgentSession(input: Record<string, unknown>): { readonly id: string };
        createMessageRun(input: Record<string, unknown>): { readonly run: { readonly id: string } };
        finishRun(id: string, status: 'SUCCEEDED'): unknown;
        removeTerminalRun(id: string): void;
        sessionQueue(sessionId: string): { readonly itemIds: readonly string[] };
        activeSessionRun(sessionId: string): { readonly id: string } | undefined;
      };
      continuousRunCoordinator: { schedule(sessionId: string): void };
      runAttachmentService: {
        persistFiles(...input: readonly unknown[]): Promise<readonly string[]>;
      };
      executeNodeOperation(operation: string, data: unknown): Promise<unknown>;
    };
    const session = internals.runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'claude-code',
      cwd: workspace.path
    });
    const active = internals.runtime.createMessageRun({
      sessionId: session.id,
      clientMessageId: 'active-before-preparing',
      content: 'current message'
    }).run;
    vi.spyOn(internals.continuousRunCoordinator, 'schedule').mockImplementation(() => undefined);
    vi.spyOn(internals.runAttachmentService, 'persistFiles').mockImplementation(async () => {
      internals.runtime.finishRun(active.id, 'SUCCEEDED');
      internals.runtime.removeTerminalRun(active.id);
      return [];
    });

    const accepted = (await internals.executeNodeOperation('session.message', {
      sessionId: session.id,
      clientMessageId: 'preparing-at-terminal-boundary',
      content: 'boundary message',
      deliveryIntent: 'QUEUE'
    })) as { readonly delivery: string; readonly run: { readonly id: string } };
    expect(accepted.delivery).toBe('STARTED');
    expect(internals.runtime.activeSessionRun(session.id)?.id).not.toBe(active.id);
    expect(internals.runtime.sessionQueue(session.id).itemIds).toEqual([]);
    connector.stop();
  });

  it('shares Runner preparation failure across duplicate requests and settles the accepted Run', async () => {
    const database = new NodeDatabase(':memory:', 'node-claude-queue-preparation-failure');
    const workspace = database.saveWorkspace({
      path: temporaryWorkspace(),
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({
      reconnect: false,
      database,
      capabilities: capabilities()
    });
    const internals = connector as unknown as {
      runtime: {
        createAgentSession(input: Record<string, unknown>): { readonly id: string };
        sessionQueue(sessionId: string): { readonly itemIds: readonly string[] };
        findMessageRun(sessionId: string, clientMessageId: string): unknown;
      };
      runners: {
        require(name: string): {
          prepareMessageInput(input: string, mode: 'default' | 'plan'): string;
        };
      };
      runAttachmentService: {
        persistFiles(...input: readonly unknown[]): Promise<readonly string[]>;
      };
      workspaceUploadService: {
        reserve(workspaceId: string, ids: readonly string[]): Promise<unknown>;
      };
      executeNodeOperation(operation: string, data: unknown): Promise<unknown>;
    };
    const session = internals.runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'claude-code',
      cwd: workspace.path
    });
    const prepareMessage = vi
      .spyOn(internals.runners.require('claude-code'), 'prepareMessageInput')
      .mockImplementation(() => {
        throw new Error('RUNNER_PREPARATION_FAILED');
      });
    const reserveUploads = vi.spyOn(internals.workspaceUploadService, 'reserve');
    let finishPersistence!: () => void;
    let markPersistenceStarted!: () => void;
    const persistenceStarted = new Promise<void>((resolve) => {
      markPersistenceStarted = resolve;
    });
    const persistFiles = vi
      .spyOn(internals.runAttachmentService, 'persistFiles')
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            markPersistenceStarted();
            finishPersistence = () => resolve([]);
          })
      );

    const first = internals.executeNodeOperation('session.message', {
      sessionId: session.id,
      clientMessageId: 'failed-during-preparation',
      content: 'does not remain queued'
    });
    await persistenceStarted;
    expect(internals.runtime.findMessageRun(session.id, 'failed-during-preparation')).toBeDefined();
    expect(reserveUploads).not.toHaveBeenCalled();
    const repeated = internals.executeNodeOperation('session.message', {
      sessionId: session.id,
      clientMessageId: 'failed-during-preparation',
      content: 'does not remain queued'
    });
    finishPersistence();

    await expect(first).rejects.toThrow('RUNNER_PREPARATION_FAILED');
    await expect(repeated).rejects.toThrow('RUNNER_PREPARATION_FAILED');
    await expect(
      internals.executeNodeOperation('session.message', {
        sessionId: session.id,
        clientMessageId: 'failed-during-preparation',
        content: 'does not prepare again'
      })
    ).rejects.toThrow('RUNNER_PREPARATION_FAILED');

    expect(internals.runtime.sessionQueue(session.id).itemIds).toEqual([]);
    expect(
      internals.runtime.findMessageRun(session.id, 'failed-during-preparation')
    ).toBeUndefined();
    expect(persistFiles).toHaveBeenCalledTimes(1);
    expect(prepareMessage).toHaveBeenCalledTimes(1);
    expect(internals.runtime.sessionQueue(session.id).itemIds).toEqual([]);
    connector.stop();
  });

  it('interrupts the current Execution for immediate QueueItem execution while preserving the Run and Working start', async () => {
    const database = new NodeDatabase(':memory:', 'node-claude-queue-execute');
    const workspace = database.saveWorkspace({
      path: temporaryWorkspace(),
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({
      reconnect: false,
      database,
      capabilities: capabilities(),
      claudeClient: new ClaudeAgentSdkAdapter(bindings(() => pendingStream()))
    });
    const interrupt = vi.fn(async () => undefined);
    const internals = connector as unknown as {
      runtime: NodeRuntimeState;
      continuousRunCoordinator: {
        dispatch(sessionId: string): Promise<void>;
        schedule(sessionId: string): void;
      };
      claudeClient: {
        execution: {
          runs: Map<
            string,
            {
              readonly handle: { interrupt(): Promise<void>; cancel(): void };
              readonly marSessionId: string;
              readonly cwd: string;
            }
          >;
        };
      };
      executeNodeOperation(operation: string, data: unknown): Promise<unknown>;
    };
    const session = internals.runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'claude-code',
      cwd: workspace.path
    });
    const active = internals.runtime.createMessageRun({
      sessionId: session.id,
      clientMessageId: 'active-queue-execute',
      content: 'current task'
    }).run;
    const execution = internals.runtime.createExecution(active.id);
    internals.runtime.transitionRun(active.id, 'STARTING');
    internals.runtime.transitionRun(active.id, 'RUNNING');
    const startedAt = internals.runtime.getRun(active.id)!.startedAt;
    vi.spyOn(internals.continuousRunCoordinator, 'schedule').mockImplementation(() => undefined);
    internals.claudeClient.execution.runs.set(execution.id, {
      handle: { interrupt, cancel: () => undefined },
      marSessionId: session.id,
      cwd: workspace.path
    });
    const queued = (await internals.executeNodeOperation('session.message', {
      sessionId: session.id,
      clientMessageId: 'queue-execute',
      content: 'prioritized execution',
      deliveryIntent: 'QUEUE'
    })) as { readonly run: { readonly id: string }; readonly queueItemId: string };

    await expect(
      internals.executeNodeOperation('workspace.queue.message.execute', {
        workspaceId: workspace.id,
        queueItemId: queued.queueItemId
      })
    ).resolves.toMatchObject({ delivery: 'ACCEPTED', run: { id: active.id } });
    expect(internals.runtime.getRun(active.id)).toMatchObject({ status: 'RUNNING', startedAt });
    expect(internals.runtime.sessionQueue(session.id).itemIds).toEqual([queued.queueItemId]);
    expect(interrupt).toHaveBeenCalledOnce();
    // Replacement is claimed only after the old Execution has actually settled.
    internals.runtime.appendRunEvent({
      runId: execution.id,
      sequence: internals.runtime.lastRunSequence(active.id) + 1,
      eventType: 'run.completed',
      payload: {},
      status: 'INTERRUPTED'
    });
    await internals.continuousRunCoordinator.dispatch(session.id);
    expect(internals.runtime.sessionQueue(session.id).itemIds).toEqual([]);
    expect(internals.runtime.currentExecutionId(active.id)).toBeDefined();
    expect(internals.runtime.currentExecutionId(active.id)).not.toBe(execution.id);
    expect(internals.runtime.getRun(active.id)).toMatchObject({ status: 'RUNNING', startedAt });
    connector.stop();
  });

  it('reports STEERED only after the managed SDK stream consumes the Channel message', async () => {
    let input: AsyncIterator<unknown> | undefined;
    const connector = new NodeConnector({
      reconnect: false,
      capabilities: capabilities(),
      claudeClient: new ClaudeAgentSdkAdapter(
        bindings((request) => {
          if (typeof request.prompt !== 'string') input = request.prompt[Symbol.asyncIterator]();
          return pendingStream();
        })
      )
    });
    const sent = attachSocket(connector);
    const runtime = (
      connector as unknown as {
        runtime: { lastRunSequence(id: string): number };
      }
    ).runtime;
    const receive = (
      connector as unknown as { handleMessage(raw: string): void }
    ).handleMessage.bind(connector);
    receive(
      JSON.stringify(
        createEnvelope('run.start', {
          runId: 'channel-run',
          sessionId: 'channel-session',
          runner: 'claude-code',
          input: 'initial',
          cwd: '/workspace'
        })
      )
    );
    await eventually(() => sent.some((message) => message.type === 'session.channel.ready'));
    await input?.next();
    const ready = sent.find((message) => message.type === 'session.channel.ready');
    receive(
      JSON.stringify(
        createEnvelope('session.channel.message', {
          sessionId: 'channel-session',
          id: 'message-1',
          senderId: 'admin',
          token: ready?.payload.token,
          content: 'inserted'
        })
      )
    );
    receive(
      JSON.stringify(
        createEnvelope('session.channel.message', {
          sessionId: 'channel-session',
          id: 'message-1',
          senderId: 'admin',
          token: ready?.payload.token,
          content: 'duplicate must not be delivered'
        })
      )
    );
    expect(sent).toContainEqual(
      expect.objectContaining({
        type: 'ack',
        payload: { type: 'session.channel.message', delivery: 'PENDING_RECEIPT' }
      })
    );
    expect(sent.some((message) => message.payload?.eventType === 'channel.delivery')).toBe(false);
    const sequenceBeforeDelivery = runtime.lastRunSequence('channel-run');
    await input?.next();
    await eventually(() => runtime.lastRunSequence('channel-run') === sequenceBeforeDelivery + 1);
    expect(sent.some((message) => message.payload?.eventType === 'channel.delivery')).toBe(false);
  });

  it('settles the Run and releases its lease when the Channel stream remains open after result', async () => {
    const database = preparedDatabase();
    let closed = 0;
    const connector = new NodeConnector({
      reconnect: false,
      capabilities: capabilities(),
      database,
      claudeClient: new ClaudeAgentSdkAdapter(
        bindings(() => resultThenPendingStream(() => (closed += 1)))
      )
    });
    const runner = (connector as unknown as { claudeClient: ClaudeCodeRunner }).claudeClient;
    const migrate = vi.spyOn(runner, 'migrateSessionIdentity');
    attachSocket(connector);
    const runtime = (
      connector as unknown as {
        runtime: {
          createAgentSession(input: Record<string, unknown>): { id: string };
          createMessageRun(input: Record<string, unknown>): { run: { id: string } };
          getRun(id: string): { status: string } | undefined;
          findMessageSubmission(sessionId: string, clientMessageId: string): unknown;
          getAgentSession(id: string): { id: string; externalSessionId: string | null } | undefined;
          activeWorkspaceLeaseCount(): number;
        };
      }
    ).runtime;
    const session = runtime.createAgentSession({
      workspaceId: 'workspace-1',
      runner: 'claude-code',
      cwd: '/workspace'
    });
    const run = runtime.createMessageRun({
      sessionId: session.id,
      clientMessageId: 'result-with-open-channel',
      content: 'run'
    }).run;
    receive(
      connector,
      createEnvelope('run.start', {
        runId: run.id,
        sessionId: session.id,
        runner: 'claude-code',
        input: 'run',
        cwd: '/workspace'
      })
    );
    await eventually(() => runtime.getRun(run.id) === undefined);
    expect(migrate).toHaveBeenCalledExactlyOnceWith(session.id, 'native-1');
    expect(runtime.getAgentSession('native-1')).toMatchObject({
      id: 'native-1',
      externalSessionId: 'native-1'
    });
    expect(runtime.findMessageSubmission('native-1', 'result-with-open-channel')).toMatchObject({
      run: { id: run.id, sessionId: 'native-1', status: 'SUCCEEDED' }
    });
    expect(runner.execution.runs.size).toBe(0);
    expect(runtime.getRun(run.id)).toBeUndefined();
    expect(runtime.activeWorkspaceLeaseCount()).toBe(0);
    expect(closed).toBe(1);
    connector.stop();
  });

  it('keeps expired Claude approvals in memory, rejects SDK tools, and emits an event', async () => {
    const database = preparedDatabase();
    const connector = new NodeConnector({
      reconnect: false,
      capabilities: capabilities(),
      database,
      claudeApprovalTimeoutMs: 5,
      claudeClient: new ClaudeAgentSdkAdapter(
        bindings((input) => {
          if (typeof input.prompt !== 'string') void input.prompt[Symbol.asyncIterator]().next();
          return permissionStream(() =>
            input.options.canUseTool?.('Bash', { command: 'pwd' }, {} as never)
          );
        })
      )
    });
    const sent = attachSocket(connector);
    const runtime = (
      connector as unknown as {
        runtime: {
          createAgentSession(input: Record<string, unknown>): { id: string };
          createMessageRun(input: Record<string, unknown>): { run: { id: string } };
          getApproval(id: string): { status: string } | undefined;
          conversationTurnForRun(id: string):
            | {
                items: readonly {
                  id: string;
                  status: string;
                  payload: unknown;
                }[];
              }
            | undefined;
        };
      }
    ).runtime;
    const session = runtime.createAgentSession({
      workspaceId: 'workspace-1',
      runner: 'claude-code',
      cwd: '/workspace'
    });
    const run = runtime.createMessageRun({
      sessionId: session.id,
      clientMessageId: 'approval-expiry',
      content: 'run'
    }).run;
    receive(
      connector,
      createEnvelope('run.start', {
        runId: run.id,
        sessionId: session.id,
        runner: 'claude-code',
        input: 'run',
        cwd: '/workspace'
      })
    );
    await eventually(() => sent.some((message) => message.type === 'approval.request'));
    const approvalId = sent.find((message) => message.type === 'approval.request')?.payload
      .approvalId;
    expect(typeof approvalId).toBe('string');
    await eventually(() => {
      const item = runtime
        .conversationTurnForRun(run.id)
        ?.items.find((candidate) => candidate.id.endsWith(`approval:${String(approvalId)}`));
      return (
        item?.status === 'CANCELLED' &&
        (item.payload as { approvalStatus?: unknown }).approvalStatus === 'EXPIRED'
      );
    });
    expect(runtime.getApproval(approvalId as string)).toBeUndefined();
    expect(sent.some((message) => message.payload?.eventType === 'approval.expired')).toBe(false);
    connector.stop();
  });
});
