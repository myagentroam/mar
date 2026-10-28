import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MarAgentRunner } from '../../src/runner/mar-agent-runner.js';
import type { GoalContinuationCoordinator } from '../../src/service/goal-continuation-coordinator.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { serializeComposerTag } from '@myagentroam/protocol';
import { NodeConnector } from '../../src/connector.js';
import { NodeDatabase } from '../../src/database.js';
import type { NodeRuntimeState } from '../../src/runtime-state.js';
import type { RunnerRegistry } from '../../src/runner/runner-registry.js';
import type { RunnerSteerResult } from '../../src/runner/contracts.js';
import type { ContinuousRunCoordinator } from '../../src/service/continuous-run-coordinator.js';

describe('Node Workbench Manifest and command control', () => {
  it.each(['command', 'message'] as const)(
    'keeps a Goal submitted during compaction out of every public queue snapshot (%s)',
    async (entry) => {
      const database = new NodeDatabase(':memory:', 'node-compacting-goal');
      const workspace = database.saveWorkspace({
        path: await workspacePath('compacting-goal'),
        kind: 'DIRECTORY',
        gitSummary: null
      });
      let notify: ((event: { method: string; params: unknown }) => void) | undefined;
      const createClient = () => ({
        onNotification(listener: typeof notify) {
          notify = listener;
          return () => undefined;
        },
        start: async () => undefined,
        resumeThread: async () => ({ thread: { id: 'compacting-goal' } }),
        request: vi.fn(async () => ({})),
        configureEnvironment: () => undefined,
        clearEnvironment: () => undefined,
        stop: () => undefined
      });
      const connector = new NodeConnector({
        reconnect: false,
        database,
        capabilities: {
          platform: 'linux',
          architecture: 'x64',
          nodeVersion: process.version,
          codex: { available: true, version: 'codex-cli 0.147.0' },
          claudeCode: { available: false }
        },
        codexClient: createClient() as never,
        codexRunClientFactory: () => createClient() as never
      });
      const internals = connector as unknown as {
        runtime: NodeRuntimeState;
        goalRuntime: { get(id: string): { objective: string } | undefined };
        runEventBridge: { emitQueue(workspaceId: string, sessionId: string): void };
        workspaceQueueWorkbenchService: {
          snapshot(id: string): { items: { queueItemId: string }[] };
          queuedCount(id: string): number;
        };
      };
      const session = internals.runtime.createAgentSession({
        workspaceId: workspace.id,
        runner: 'codex',
        cwd: workspace.path,
        externalSessionId: 'compacting-goal',
        nativeControl: 'MAR_MANAGED'
      });
      try {
        await operation(connector, 'session.command.execute', {
          sessionId: session.id,
          commandId: 'compact',
          input: '/compact'
        });
        const snapshots: unknown[] = [];
        vi.spyOn(internals.runEventBridge, 'emitQueue').mockImplementation((_workspaceId, id) => {
          snapshots.push(internals.workspaceQueueWorkbenchService.snapshot(id));
        });
        let result: { queueItemId?: string };
        if (entry === 'command') {
          result = (await operation(connector, 'session.command.execute', {
            sessionId: session.id,
            commandId: 'goal',
            input: '/goal Finish the feature'
          })) as typeof result;
        } else {
          await operation(connector, 'session.command.execute', {
            sessionId: session.id,
            commandId: 'goal',
            input: '/goal'
          });
          result = (await operation(connector, 'session.message', {
            sessionId: session.id,
            clientMessageId: 'goal-objective',
            content: 'Finish the feature',
            deliveryIntent: 'SEND'
          })) as typeof result;
          await expect(
            operation(connector, 'session.message', {
              sessionId: session.id,
              clientMessageId: 'goal-objective',
              content: 'Finish the feature',
              deliveryIntent: 'SEND'
            })
          ).resolves.toMatchObject({ queueItemId: result.queueItemId, idempotent: true });
        }
        expect(internals.goalRuntime.get(session.id)?.objective).toBe('Finish the feature');
        expect(internals.runtime.getQueueItem(result.queueItemId!)).toBeDefined();
        expect(snapshots.length).toBeGreaterThan(0);
        expect(
          snapshots.every((snapshot) => (snapshot as { items: unknown[] }).items.length === 0)
        ).toBe(true);
        expect(internals.workspaceQueueWorkbenchService.queuedCount(session.id)).toBe(0);
        await operation(connector, 'session.message', {
          sessionId: session.id,
          clientMessageId: 'goal:ordinary-message',
          content: 'After the Goal',
          deliveryIntent: 'QUEUE'
        });
        const queue = internals.workspaceQueueWorkbenchService.snapshot(session.id);
        expect(queue.items).toHaveLength(1);
        expect(internals.workspaceQueueWorkbenchService.queuedCount(session.id)).toBe(1);
        expect(internals.runtime.getQueueItem(queue.items[0]!.queueItemId)?.content).toBe(
          'After the Goal'
        );
        expect(
          internals.runtime
            .conversationTail(session.id)
            .flatMap((turn) => turn.items)
            .some((item) => item.kind === 'user_message')
        ).toBe(false);
        const revised = (await operation(connector, 'session.command.execute', {
          sessionId: session.id,
          commandId: 'goal',
          input: '/goal Finish the revised feature'
        })) as { queueItemId: string };
        expect(internals.goalRuntime.get(session.id)?.objective).toBe('Finish the revised feature');
        expect(internals.runtime.getQueueItem(result.queueItemId!)).toBeUndefined();
        expect(internals.runtime.getQueueItem(revised.queueItemId)).toBeDefined();
        expect(internals.workspaceQueueWorkbenchService.snapshot(session.id).items).toEqual(
          queue.items
        );
        expect(internals.workspaceQueueWorkbenchService.queuedCount(session.id)).toBe(1);
        await operation(connector, 'session.command.execute', {
          sessionId: session.id,
          commandId: 'goal',
          input: '/goal --clear'
        });
        expect(internals.goalRuntime.get(session.id)).toBeUndefined();
        expect(internals.runtime.getQueueItem(revised.queueItemId)).toBeUndefined();
        expect(internals.workspaceQueueWorkbenchService.snapshot(session.id).items).toEqual(
          queue.items
        );
      } finally {
        notify?.({
          method: 'turn/completed',
          params: { threadId: 'compacting-goal', turn: { id: 'compact', status: 'completed' } }
        });
        await connector.stop();
      }
    }
  );

  it.each(['accepted', 'handled'] as const)(
    'continues a Goal after repeated native steer without restarting or counting extra turns (%s)',
    async (status) => {
      const f = await nativeGoalFixture();
      f.steer.mockImplementation(async (input): Promise<RunnerSteerResult> =>
        status === 'handled'
          ? { status }
          : {
              status,
              item: {
                itemId: input.clientMessageId,
                kind: 'user_message',
                status: 'COMPLETED',
                payload: { text: input.prompt }
              }
            }
      );
      try {
        const goal = f.internals.goalRuntime.get(f.session.id)!;
        const run = f.internals.runtime.activeSessionRun(f.session.id)!;
        const executionId = f.internals.runtime.currentExecutionId(run.id)!;
        const turnId = f.internals.runtime.conversationTurnForRun(run.id)!.id;
        const queued = (await operation(f.connector, 'session.message', {
          sessionId: f.session.id,
          clientMessageId: 'ordinary',
          content: 'After the Goal',
          deliveryIntent: 'QUEUE'
        })) as { queueItemId: string };
        for (let i = 0; i < 2; i++) {
          await operation(f.connector, 'session.message', {
            sessionId: f.session.id,
            clientMessageId: 'native-guidance-' + i,
            content: 'Check the failing test',
            deliveryIntent: 'REPLACE_CURRENT',
            __marctlOrigin: { sessionId: 'coordinator', name: 'Coordinator#42' }
          });
          const queue = f.internals.runtime.sessionQueue(f.session.id).itemIds;
          expect(queue).toHaveLength(2);
          expect(queue).toContain(queued.queueItemId);
          const continuations = queue.filter(
            (id) => f.internals.continuousRunCoordinator.pending(id)?.goal !== undefined
          );
          expect(continuations).toHaveLength(1);
          expect(f.internals.continuousRunCoordinator.pending(executionId)?.goal).toEqual(
            f.internals.continuousRunCoordinator.pending(continuations[0]!)?.goal
          );
          expect(f.internals.goalRuntime.get(f.session.id)).toMatchObject({
            id: goal.id,
            revision: goal.revision,
            turns: 1,
            status: 'active'
          });
          expect(f.internals.runtime.currentExecutionId(run.id)).toBe(executionId);
          expect(f.internals.runtime.conversationTurnForRun(run.id)!.id).toBe(turnId);
          expect(f.interrupt).not.toHaveBeenCalled();
        }
        f.internals.emitRunEvent(executionId, 'run.completed', {}, 'SUCCEEDED');
        await vi.waitFor(() => expect(f.internals.goalRuntime.get(f.session.id)?.turns).toBe(2));
        expect(f.internals.runtime.activeSessionRun(f.session.id)!.id).toBe(run.id);
        expect(f.internals.runtime.currentExecutionId(run.id)).not.toBe(executionId);
        expect(f.internals.runtime.sessionQueue(f.session.id).itemIds).toContain(
          queued.queueItemId
        );
      } finally {
        await f.connector.stop();
      }
    }
  );

  it('preserves the latest Goal continuation when overlapping native steer receipts arrive out of order', async () => {
    const f = await nativeGoalFixture();
    const first = Promise.withResolvers<RunnerSteerResult>();
    const second = Promise.withResolvers<RunnerSteerResult>();
    f.steer
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const send = (clientMessageId: string) =>
      operation(f.connector, 'session.message', {
        sessionId: f.session.id,
        clientMessageId,
        content: clientMessageId,
        deliveryIntent: 'REPLACE_CURRENT'
      });
    try {
      const run = f.internals.runtime.activeSessionRun(f.session.id)!;
      const executionId = f.internals.runtime.currentExecutionId(run.id)!;
      const earlier = send('earlier-guidance');
      await vi.waitFor(() => expect(f.steer).toHaveBeenCalledTimes(1));
      const later = send('later-guidance');
      await vi.waitFor(() => expect(f.steer).toHaveBeenCalledTimes(2));
      second.resolve({ status: 'handled' });
      await later;
      const latestGoal = f.internals.continuousRunCoordinator.pending(executionId)!.goal;
      first.resolve({ status: 'handled' });
      await earlier;
      const queue = f.internals.runtime.sessionQueue(f.session.id).itemIds;
      expect(queue).toHaveLength(1);
      expect(latestGoal).toBeDefined();
      expect(f.internals.continuousRunCoordinator.pending(queue[0]!)?.goal).toEqual(latestGoal);
      expect(f.internals.continuousRunCoordinator.pending(executionId)?.goal).toEqual(latestGoal);
      expect(f.internals.goalRuntime.get(f.session.id)?.turns).toBe(1);
      expect(f.interrupt).not.toHaveBeenCalled();
    } finally {
      first.resolve({ status: 'handled' });
      second.resolve({ status: 'handled' });
      await f.connector.stop();
    }
  });

  it.each(['clear', 'edit'] as const)(
    'does not restore obsolete Goal continuation after late native steer acceptance (%s)',
    async (change) => {
      const f = await nativeGoalFixture();
      const gate = Promise.withResolvers<RunnerSteerResult>();
      f.steer.mockReturnValue(gate.promise);
      try {
        const sending = operation(f.connector, 'session.message', {
          sessionId: f.session.id,
          clientMessageId: 'late-guidance',
          content: 'Check the failing test',
          deliveryIntent: 'REPLACE_CURRENT'
        });
        await vi.waitFor(() => expect(f.steer).toHaveBeenCalledOnce());
        await operation(f.connector, 'session.command.execute', {
          sessionId: f.session.id,
          commandId: 'goal',
          input: change === 'clear' ? '/goal --clear' : '/goal Verify the revised feature'
        });
        const changedGoal = f.internals.goalRuntime.get(f.session.id);
        if (change === 'clear') expect(changedGoal).toBeUndefined();
        else expect(changedGoal).toMatchObject({ revision: 2, status: 'active', turns: 0 });
        const expectedQueue = f.internals.runtime
          .sessionQueue(f.session.id)
          .itemIds.filter(
            (id) => f.internals.runtime.getQueueItem(id)?.clientMessageId !== 'late-guidance'
          );
        expect(expectedQueue).toHaveLength(change === 'clear' ? 0 : 1);
        gate.resolve({ status: 'handled' });
        await sending;
        expect(f.internals.goalRuntime.get(f.session.id)).toEqual(changedGoal);
        expect(f.internals.runtime.sessionQueue(f.session.id).itemIds).toEqual(expectedQueue);
        if (change === 'clear') expect(f.interrupt).not.toHaveBeenCalled();
      } finally {
        gate.resolve({ status: 'handled' });
        await f.connector.stop();
      }
    }
  );

  it('queues ordinary Goal messages and only interrupts for explicit replacement without discarding FIFO messages', async () => {
    const database = new NodeDatabase(':memory:', 'node-goal-mode');
    const workspace = database.saveWorkspace({
      path: await workspacePath('goal-mode'),
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const prompts: string[] = [];
    const interrupts: Array<ReturnType<typeof vi.fn>> = [];
    const connector = new NodeConnector({
      reconnect: false,
      database,
      capabilities: {
        platform: 'linux',
        architecture: 'x64',
        nodeVersion: process.version,
        codex: { available: false },
        claudeCode: { available: true, version: '2.1.0' }
      },
      claudeClient: {
        startChannel(input: { prompt: string }) {
          prompts.push(input.prompt);
          const interrupt = vi.fn(async () => undefined);
          interrupts.push(interrupt);
          return {
            completed: new Promise<void>(() => undefined),
            deliver: async () => undefined,
            interrupt,
            cancel: () => undefined,
            getContextUsage: async () => ({
              model: 'claude-sonnet',
              usedTokens: 1,
              maxTokens: 2,
              rawMaxTokens: 2,
              percentage: 50
            })
          };
        }
      } as never
    });
    const internals = connector as unknown as {
      emitConversationTurn(turn: unknown): void;
      runtime: {
        createAgentSession(input: Record<string, unknown>): { id: string };
        sessionQueue(sessionId: string): { itemIds: readonly string[] };
        getQueueItem(
          itemId: string
        ): { content: string; suppressNotifications?: boolean } | undefined;
        activeSessionRun(sessionId: string): { suppressNotifications?: boolean } | undefined;
      };
      goalRuntime: {
        get(sessionId: string):
          | {
              id: string;
              sessionId: string;
              objective: string;
              revision: number;
              status: 'active' | 'completed' | 'blocked';
              turns: number;
              retryRequired: boolean;
              retryStartedAtTurn: number | null;
            }
          | undefined;
      };
      commandStates: {
        get(sessionId: string, commandId: string): { goal?: { turns?: number } } | undefined;
      };
      continuousRunCoordinator: {
        pending(submissionId: string): Record<string, unknown> | undefined;
      };
      goalCoordinator: {
        publishGoalState(session: { id: string }, goal: Record<string, unknown>): void;
      };
    };
    const publishedTurns = vi.spyOn(internals, 'emitConversationTurn');
    const session = internals.runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'claude-code',
      cwd: workspace.path,
      nativeControl: 'MAR_MANAGED'
    });

    const opened = (await operation(connector, 'session.command.execute', {
      sessionId: session.id,
      commandId: 'goal',
      input: '/goal'
    })) as { session: { commandStates: readonly { commandId: string; goal?: unknown }[] } };
    expect(opened.session.commandStates).toEqual(
      expect.arrayContaining([expect.objectContaining({ commandId: 'goal', active: true })])
    );
    expect(
      opened.session.commandStates.find((state) => state.commandId === 'goal')?.goal
    ).toBeUndefined();
    await expect(
      operation(connector, 'session.command.execute', {
        sessionId: session.id,
        commandId: 'goal',
        input: '/goal'
      })
    ).resolves.toMatchObject({ goalAlreadyActive: true });

    await expect(
      operation(connector, 'session.message', {
        sessionId: session.id,
        clientMessageId: 'goal-failed-objective',
        content: 'Start with a missing attachment',
        attachmentIds: ['missing-objective-upload']
      })
    ).rejects.toThrow();
    expect(internals.goalRuntime.get(session.id)).toBeUndefined();
    expect(internals.commandStates.get(session.id, 'goal')?.goal).toBeUndefined();

    const marAgentModel = { id: 'model-1', credential: { type: 'RUNTIME_TICKET' } };
    await expect(
      operation(connector, 'session.message', {
        sessionId: session.id,
        clientMessageId: 'goal-invalid-origin',
        content: 'Do not activate the pending Goal',
        __marctlOrigin: { sessionId: 'coordinator' }
      })
    ).rejects.toThrow();
    expect(internals.goalRuntime.get(session.id)).toBeUndefined();
    expect(internals.commandStates.get(session.id, 'goal')?.goal).toBeUndefined();
    const marAgentModels = [marAgentModel];
    const startedGoal = (await operation(connector, 'session.message', {
      sessionId: session.id,
      clientMessageId: 'goal-objective',
      __suppressNotifications: true,
      __marctlOrigin: { sessionId: 'coordinator', name: 'Coordinator#42' },
      content: 'Implement and verify the complete feature',
      marAgentRuntimeScopeId: 'scope-1',
      marAgentModel,
      marAgentModels,
      personalInstructions: {
        common: 'Follow personal rules',
        codex: '',
        claudeCode: '',
        openCode: ''
      }
    })) as {
      turn?: { items: readonly { kind: string; payload: { text?: string } }[] };
    };
    expect(startedGoal).not.toHaveProperty('turn');
    expect(publishedTurns).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: session.id,
        items: expect.arrayContaining([
          expect.objectContaining({
            kind: 'user_message',
            payload: expect.objectContaining({
              text: [
                serializeComposerTag('mar_goal_start', {
                  objective: 'Implement and verify the complete feature'
                }),
                serializeComposerTag('mar_session_origin', {
                  sessionId: 'coordinator',
                  name: 'Coordinator#42'
                })
              ].join('\n')
            })
          })
        ])
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(prompts[0]).toContain('A Goal has started or changed.');
    expect(prompts[0]).toContain('Implement and verify the complete feature');
    expect(prompts[0]).toContain(
      serializeComposerTag('mar_session_origin', {
        sessionId: 'coordinator',
        name: 'Coordinator#42'
      })
    );
    const continuationBeforeRetry = [...internals.runtime.sessionQueue(session.id).itemIds];
    expect(continuationBeforeRetry).toHaveLength(1);
    expect(internals.runtime.getQueueItem(continuationBeforeRetry[0]!)?.content).toBe(
      serializeComposerTag('mar_goal_continue', {})
    );
    expect(internals.runtime.getQueueItem(continuationBeforeRetry[0]!)?.suppressNotifications).toBe(
      true
    );
    expect(internals.runtime.activeSessionRun(session.id)?.suppressNotifications).toBe(true);
    expect(internals.continuousRunCoordinator.pending(continuationBeforeRetry[0]!)).toMatchObject({
      executionContext: { runner: 'claude-code' }
    });
    expect(
      internals.continuousRunCoordinator.pending(continuationBeforeRetry[0]!)?.executionContext
    ).not.toHaveProperty('runnerInput');
    expect(internals.commandStates.get(session.id, 'goal')?.goal?.turns).toBe(1);
    await operation(connector, 'session.message', {
      sessionId: session.id,
      clientMessageId: 'goal-objective',
      content: 'Implement and verify the complete feature'
    });
    expect(internals.runtime.sessionQueue(session.id).itemIds).toEqual(continuationBeforeRetry);
    await expect(
      operation(connector, 'session.message', {
        sessionId: session.id,
        clientMessageId: 'goal-failed-intervention',
        content: 'Use a missing attachment for intervention',
        attachmentIds: ['missing-upload']
      })
    ).rejects.toThrow();
    expect(internals.runtime.sessionQueue(session.id).itemIds).toEqual(continuationBeforeRetry);

    const goalBeforeIntervention = internals.goalRuntime.get(session.id)!;
    const ordinaryContents = ['Check the tests', 'Check the build', 'Check the result'];
    for (const [index, deliveryIntent] of [undefined, 'SEND', 'QUEUE'].entries()) {
      const queued = await operation(connector, 'session.message', {
        sessionId: session.id,
        clientMessageId: `goal-queued-${index}`,
        content: ordinaryContents[index],
        ...(deliveryIntent === undefined ? {} : { deliveryIntent })
      });
      expect(queued).toMatchObject({ delivery: 'QUEUED' });
      expect(interrupts[0]).not.toHaveBeenCalled();
    }
    expect(internals.runtime.sessionQueue(session.id).itemIds[0]).toBe(continuationBeforeRetry[0]);
    expect(internals.goalRuntime.get(session.id)).toMatchObject(goalBeforeIntervention);
    const ordinaryQueue = await operation(connector, 'workspace.queue.get', {
      workspaceId: workspace.id,
      sessionId: session.id
    });
    expect(ordinaryQueue).toMatchObject({
      queue: { items: ordinaryContents.map((content) => ({ content })) }
    });
    await operation(connector, 'session.message', {
      sessionId: session.id,
      clientMessageId: 'goal-queued-0',
      content: ordinaryContents[0],
      deliveryIntent: 'QUEUE'
    });
    expect(internals.runtime.sessionQueue(session.id).itemIds).toHaveLength(4);

    const intervention = (await operation(connector, 'session.message', {
      sessionId: session.id,
      clientMessageId: 'goal-intervention',
      content: 'Prioritize the failing test',
      deliveryIntent: 'REPLACE_CURRENT'
    })) as { delivery: string };
    expect(intervention.delivery).toBe('ACCEPTED');
    expect(interrupts[0]).toHaveBeenCalled();
    expect(internals.goalRuntime.get(session.id)).toMatchObject({
      id: goalBeforeIntervention.id,
      objective: goalBeforeIntervention.objective,
      revision: goalBeforeIntervention.revision
    });
    await vi.waitFor(async () => {
      const queue = (await operation(connector, 'workspace.queue.get', {
        workspaceId: workspace.id,
        sessionId: session.id
      })) as { queue: { items: readonly unknown[] } };
      expect(queue.queue.items).toEqual(
        ordinaryContents.map((content) => expect.objectContaining({ content }))
      );
    });

    const currentGoal = internals.goalRuntime.get(session.id)!;
    internals.goalCoordinator.publishGoalState(session, { ...currentGoal, status: 'completed' });
    expect(internals.commandStates.get(session.id, 'goal')).toBeUndefined();
    const clearResult = await operation(connector, 'session.command.execute', {
      sessionId: session.id,
      commandId: 'goal',
      input: '/goal --clear'
    });
    expect(clearResult).toMatchObject({
      cleared: true,
      goalExit: { status: 'removed', elapsedWallMs: expect.any(Number), turns: currentGoal.turns }
    });
    expect(internals.goalRuntime.get(session.id)).toBeUndefined();

    const directSession = internals.runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'claude-code',
      cwd: workspace.path,
      nativeControl: 'MAR_MANAGED'
    });
    await operation(connector, 'session.command.execute', {
      sessionId: directSession.id,
      commandId: 'goal',
      input: '/goal'
    });
    const directStarted = (await operation(connector, 'session.command.execute', {
      sessionId: directSession.id,
      commandId: 'goal',
      input: '/goal Update the objective through a command',
      __suppressNotifications: true
    })) as {
      turn?: { items: readonly { kind: string; payload: { text?: string } }[] };
    };
    expect(directStarted).not.toHaveProperty('turn');
    expect(internals.runtime.activeSessionRun(directSession.id)?.suppressNotifications).toBe(true);
    expect(publishedTurns).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: directSession.id,
        items: expect.arrayContaining([
          expect.objectContaining({
            kind: 'user_message',
            payload: expect.objectContaining({
              text: serializeComposerTag('mar_goal_start', {
                objective: 'Update the objective through a command'
              })
            })
          })
        ])
      })
    );
    connector.stop();
  });

  it.each(['completed', 'removed', 'automatic'] as const)(
    'drains ordinary FIFO only after the Goal exits (%s)',
    async (exit) => {
      const database = new NodeDatabase(':memory:', 'node-goal-message-fifo');
      const workspace = database.saveWorkspace({
        path: await workspacePath('goal-message-fifo'),
        kind: 'DIRECTORY',
        gitSummary: null
      });
      const prompts: string[] = [];
      const complete: Array<() => void> = [];
      const interrupt = vi.fn(async () => undefined);
      const connector = new NodeConnector({
        reconnect: false,
        database,
        capabilities: {
          platform: 'linux',
          architecture: 'x64',
          nodeVersion: process.version,
          codex: { available: false },
          claudeCode: { available: true, version: '2.1.0' }
        },
        claudeClient: {
          startChannel(input: { prompt: string }) {
            prompts.push(input.prompt);
            return {
              completed: new Promise<void>((resolve) => complete.push(resolve)),
              deliver: async () => undefined,
              interrupt,
              cancel: () => undefined,
              getContextUsage: async () => null
            };
          }
        } as never
      });
      const internals = connector as unknown as {
        runtime: {
          createAgentSession(input: Record<string, unknown>): { id: string };
        };
        goalRuntime: {
          get(sessionId: string): {
            id: string;
            objective: string;
            revision: number;
            status: string;
          };
          update(sessionId: string, goalId: string, revision: number, status: 'completed'): unknown;
        };
      };
      const session = internals.runtime.createAgentSession({
        workspaceId: workspace.id,
        runner: 'claude-code',
        cwd: workspace.path,
        nativeControl: 'MAR_MANAGED'
      });
      try {
        await operation(connector, 'session.command.execute', {
          sessionId: session.id,
          commandId: 'goal',
          input: '/goal Complete the feature'
        });
        await vi.waitFor(() => expect(prompts).toHaveLength(1));
        const goal = internals.goalRuntime.get(session.id);
        for (const [index, content] of ['Check tests first', 'Then check the build'].entries()) {
          await expect(
            operation(connector, 'session.message', {
              sessionId: session.id,
              clientMessageId: `ordinary-${index}`,
              content,
              deliveryIntent: 'QUEUE'
            })
          ).resolves.toMatchObject({ delivery: 'QUEUED' });
        }
        expect(interrupt).not.toHaveBeenCalled();
        expect(prompts).toHaveLength(1);
        complete[0]!();
        await vi.waitFor(() => expect(prompts).toHaveLength(2));
        expect(prompts[1]).toContain('<mar_goal_continue>');
        complete[1]!();
        await vi.waitFor(() => expect(prompts).toHaveLength(3));
        expect(prompts[2]).toContain('<mar_goal_continue>');
        expect(internals.goalRuntime.get(session.id)).toMatchObject({
          id: goal.id,
          objective: goal.objective,
          revision: goal.revision,
          status: 'active'
        });
        expect(
          await operation(connector, 'workspace.queue.get', {
            workspaceId: workspace.id,
            sessionId: session.id
          })
        ).toMatchObject({
          queue: { items: [{ content: 'Check tests first' }, { content: 'Then check the build' }] }
        });
        if (exit === 'completed')
          internals.goalRuntime.update(session.id, goal.id, goal.revision, 'completed');
        else if (exit === 'removed')
          await operation(connector, 'session.command.execute', {
            sessionId: session.id,
            commandId: 'goal',
            input: '/goal --clear'
          });
        // Even a terminal Goal must wait for its current Execution's final response.
        expect(prompts).toHaveLength(3);
        complete[2]!();
        await vi.waitFor(() => expect(prompts).toHaveLength(4));
        expect(prompts[3]).toBe('Check tests first');
        complete[3]!();
        await vi.waitFor(() => expect(prompts).toHaveLength(5));
        expect(prompts[4]).toBe('Then check the build');
        expect(
          await operation(connector, 'workspace.queue.get', {
            workspaceId: workspace.id,
            sessionId: session.id
          })
        ).toMatchObject({ queue: { items: [] } });
      } finally {
        await connector.stop();
      }
    }
  );

  it.each([
    { namespace: 'mar_goal', toolName: 'get_goal', progressed: false },
    { namespace: 'repo', toolName: 'get_goal', progressed: true },
    { namespace: '', toolName: 'mcp__mar_goal__get_goal', progressed: false },
    { namespace: '', toolName: 'mcp__repo__get_goal', progressed: true },
    { namespace: '', toolName: 'mar_goal.get_goal', progressed: false },
    { namespace: '', toolName: 'repo.get_goal', progressed: true },
    { namespace: '', toolName: 'mar_goal_get_goal', progressed: false },
    { namespace: '', toolName: 'repo_get_goal', progressed: true }
  ])(
    'distinguishes Goal bookkeeping from tool progress for $namespace/$toolName and completes after three idle turns',
    async ({ namespace, toolName, progressed }) => {
      const database = new NodeDatabase(':memory:', 'node-goal-no-progress');
      const workspace = database.saveWorkspace({
        path: await workspacePath('goal-no-progress'),
        kind: 'DIRECTORY',
        gitSummary: null
      });
      const prompts: string[] = [];
      const connector = new NodeConnector({
        reconnect: false,
        database,
        capabilities: {
          platform: 'linux',
          architecture: 'x64',
          nodeVersion: process.version,
          codex: { available: false },
          claudeCode: { available: true, version: '2.1.0' }
        },
        claudeClient: {
          startChannel(input: { prompt: string }) {
            prompts.push(input.prompt);
            return {
              completed: new Promise<void>(() => undefined),
              deliver: async () => undefined,
              interrupt: async () => undefined,
              cancel: () => undefined,
              getContextUsage: async () => null
            };
          }
        } as never
      });
      const internals = connector as unknown as {
        runtime: {
          createAgentSession(input: Record<string, unknown>): { id: string };
          activeSessionRun(sessionId: string): { id: string } | undefined;
          currentExecutionId(runId: string): string | undefined;
          sessionQueue(sessionId: string): { itemIds: readonly string[] };
        };
        goalRuntime: {
          get(sessionId: string):
            | {
                status: string;
                turns: number;
                consecutiveNoProgressTurns: number;
              }
            | undefined;
        };
        commandStates: {
          get(sessionId: string, commandId: string): unknown;
        };
        emitRunEvent(
          runId: string,
          eventType: string,
          payload: unknown,
          status?: 'SUCCEEDED' | 'FAILED' | 'INTERRUPTED'
        ): void;
        emitConversationItem(runId: string, item: unknown): void;
      };
      const session = internals.runtime.createAgentSession({
        workspaceId: workspace.id,
        runner: 'claude-code',
        cwd: workspace.path,
        nativeControl: 'MAR_MANAGED'
      });

      try {
        await operation(connector, 'session.command.execute', {
          sessionId: session.id,
          commandId: 'goal',
          input: '/goal'
        });
        await operation(connector, 'session.message', {
          sessionId: session.id,
          clientMessageId: 'goal-no-progress-objective',
          content: 'Implement and verify the complete feature'
        });
        await vi.waitFor(() => expect(prompts).toHaveLength(1));

        const firstRun = internals.runtime.activeSessionRun(session.id)!;
        const firstExecutionId = internals.runtime.currentExecutionId(firstRun.id)!;
        internals.emitConversationItem(firstExecutionId, {
          itemId: 'goal-state-read',
          kind: 'tool_call',
          status: 'COMPLETED',
          payload: { namespace, toolName }
        });
        internals.emitRunEvent(firstExecutionId, 'run.completed', {}, 'SUCCEEDED');
        await vi.waitFor(() => expect(prompts).toHaveLength(2));
        expect(internals.goalRuntime.get(session.id)).toMatchObject({
          status: 'active',
          consecutiveNoProgressTurns: progressed ? 0 : 1
        });

        const secondRun = internals.runtime.activeSessionRun(session.id)!;
        const secondExecutionId = internals.runtime.currentExecutionId(secondRun.id)!;
        internals.emitRunEvent(secondExecutionId, 'run.completed', {}, 'SUCCEEDED');
        await vi.waitFor(() => expect(prompts).toHaveLength(3));
        expect(internals.goalRuntime.get(session.id)).toMatchObject({
          status: 'active',
          consecutiveNoProgressTurns: progressed ? 1 : 2
        });

        const thirdRun = internals.runtime.activeSessionRun(session.id)!;
        const thirdExecutionId = internals.runtime.currentExecutionId(thirdRun.id)!;
        internals.emitRunEvent(thirdExecutionId, 'run.completed', {}, 'SUCCEEDED');
        if (progressed) {
          await vi.waitFor(() => expect(prompts).toHaveLength(4));
          expect(internals.goalRuntime.get(session.id)).toMatchObject({
            status: 'active',
            consecutiveNoProgressTurns: 2
          });
          const fourthRun = internals.runtime.activeSessionRun(session.id)!;
          internals.emitRunEvent(
            internals.runtime.currentExecutionId(fourthRun.id)!,
            'run.completed',
            {},
            'SUCCEEDED'
          );
        }
        await vi.waitFor(() =>
          expect(internals.runtime.activeSessionRun(session.id)).toBeUndefined()
        );
        expect(internals.runtime.sessionQueue(session.id).itemIds).toEqual([]);
        expect(internals.goalRuntime.get(session.id)).toMatchObject({
          status: 'completed',
          consecutiveNoProgressTurns: 3
        });
        expect(internals.commandStates.get(session.id, 'goal')).toBeUndefined();

        await operation(connector, 'session.message', {
          sessionId: session.id,
          clientMessageId: 'ordinary-after-no-progress',
          content: 'Start an ordinary task'
        });
        await vi.waitFor(() => expect(prompts).toHaveLength(progressed ? 5 : 4));
        expect(prompts.at(-1)).toBe('Start an ordinary task');
        expect(internals.goalRuntime.get(session.id)?.status).toBe('completed');
        expect(internals.commandStates.get(session.id, 'goal')).toBeUndefined();
      } finally {
        await connector.stop();
      }
    }
  );

  it('removes a continuation submission that finishes after no-progress completion invalidates it', async () => {
    const database = new NodeDatabase(':memory:', 'node-goal-paused-inflight-continuation');
    const workspace = database.saveWorkspace({
      path: await workspacePath('goal-paused-inflight-continuation'),
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
        claudeCode: { available: true, version: '2.1.0' }
      },
      claudeClient: {
        startChannel() {
          return {
            completed: new Promise<void>(() => undefined),
            deliver: async () => undefined,
            interrupt: async () => undefined,
            cancel: () => undefined,
            getContextUsage: async () => null
          };
        }
      } as never
    });
    const internals = connector as unknown as {
      runtime: {
        createAgentSession(input: Record<string, unknown>): { id: string };
        activeSessionRun(sessionId: string): { id: string } | undefined;
        currentExecutionId(runId: string): string | undefined;
        sessionQueue(sessionId: string): { itemIds: readonly string[] };
      };
      goalRuntime: {
        get(sessionId: string): { status: string; consecutiveNoProgressTurns: number } | undefined;
      };
      sessionMessageService: {
        submitGoal(input: Record<string, unknown>): Promise<unknown>;
      };
      emitRunEvent(
        runId: string,
        eventType: string,
        payload: unknown,
        status?: 'SUCCEEDED' | 'FAILED' | 'INTERRUPTED'
      ): void;
    };
    const session = internals.runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'claude-code',
      cwd: workspace.path,
      nativeControl: 'MAR_MANAGED'
    });
    const submitGoal = internals.sessionMessageService.submitGoal.bind(
      internals.sessionMessageService
    );
    let releaseThirdContinuation!: () => void;
    const thirdContinuationGate = new Promise<void>((resolve) => {
      releaseThirdContinuation = resolve;
    });
    let continuationCount = 0;
    internals.sessionMessageService.submitGoal = async (input) => {
      if (input.kind === 'continue' && ++continuationCount === 3) await thirdContinuationGate;
      return submitGoal(input);
    };

    try {
      await operation(connector, 'session.command.execute', {
        sessionId: session.id,
        commandId: 'goal',
        input: '/goal Complete the task'
      });
      await vi.waitFor(() => expect(continuationCount).toBe(1));
      const run = internals.runtime.activeSessionRun(session.id)!;
      const firstExecutionId = internals.runtime.currentExecutionId(run.id)!;
      internals.emitRunEvent(firstExecutionId, 'run.completed', {}, 'SUCCEEDED');
      await vi.waitFor(() => expect(continuationCount).toBe(2));

      const secondExecutionId = internals.runtime.currentExecutionId(run.id)!;
      internals.emitRunEvent(secondExecutionId, 'run.completed', {}, 'SUCCEEDED');
      await vi.waitFor(() => expect(continuationCount).toBe(3));

      const thirdExecutionId = internals.runtime.currentExecutionId(run.id)!;
      internals.emitRunEvent(thirdExecutionId, 'run.completed', {}, 'SUCCEEDED');
      expect(internals.goalRuntime.get(session.id)).toMatchObject({
        status: 'completed',
        consecutiveNoProgressTurns: 3
      });

      releaseThirdContinuation();
      await vi.waitFor(() => {
        expect(internals.runtime.sessionQueue(session.id).itemIds).toEqual([]);
        expect(internals.runtime.activeSessionRun(session.id)).toBeUndefined();
      });
    } finally {
      await connector.stop();
    }
  });

  it('rejects same-revision stale lifecycle callbacks after user intervention', async () => {
    const database = new NodeDatabase(':memory:', 'node-goal-intervention-inflight-continuation');
    const workspace = database.saveWorkspace({
      path: await workspacePath('goal-intervention-inflight-continuation'),
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
        claudeCode: { available: true, version: '2.1.0' }
      },
      claudeClient: {
        startChannel() {
          return {
            completed: new Promise<void>(() => undefined),
            deliver: async () => undefined,
            interrupt: async () => undefined,
            cancel: () => undefined,
            getContextUsage: async () => null
          };
        }
      } as never
    });
    const internals = connector as unknown as {
      runtime: {
        createAgentSession(input: Record<string, unknown>): { id: string };
        getAgentSession(sessionId: string): { id: string } | undefined;
        activeSessionRun(sessionId: string): { id: string } | undefined;
        currentExecutionId(runId: string): string | undefined;
        sessionQueue(sessionId: string): { itemIds: readonly string[] };
      };
      goalRuntime: {
        get(sessionId: string): { id: string; revision: number; status: string } | undefined;
        recordExecutionResult(
          sessionId: string,
          input: { failed: boolean; progressed: boolean }
        ): string;
      };
      continuousRunCoordinator: {
        pending(id: string): { goal?: { id: string; revision: number; epoch: number } } | undefined;
      };
      sessionMessageService: {
        submitGoal(input: Record<string, unknown>): Promise<unknown>;
      };
      emitRunEvent(runId: string, eventType: string, payload: unknown, status?: 'SUCCEEDED'): void;
      goalCoordinator: {
        handleGoalPreparationFailed(
          session: { id: string },
          goal: { id: string; revision: number; epoch: number },
          activated: boolean
        ): void;
      };
    };
    const session = internals.runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'claude-code',
      cwd: workspace.path,
      nativeControl: 'MAR_MANAGED'
    });
    const submitGoal = internals.sessionMessageService.submitGoal.bind(
      internals.sessionMessageService
    );
    let releaseOldContinuation!: () => void;
    const oldContinuationGate = new Promise<void>((resolve) => {
      releaseOldContinuation = resolve;
    });
    let continuationCount = 0;
    internals.sessionMessageService.submitGoal = async (input) => {
      if (input.kind === 'continue' && continuationCount++ === 0) await oldContinuationGate;
      return submitGoal(input);
    };

    try {
      await operation(connector, 'session.command.execute', {
        sessionId: session.id,
        commandId: 'goal',
        input: '/goal Complete the task'
      });
      await vi.waitFor(() => expect(continuationCount).toBe(1));
      const goal = internals.goalRuntime.get(session.id)!;
      const originalRun = internals.runtime.activeSessionRun(session.id)!;
      const originalExecutionId = internals.runtime.currentExecutionId(originalRun.id)!;
      const originalGeneration =
        internals.continuousRunCoordinator.pending(originalExecutionId)!.goal!;
      const recordExecutionResult = vi.spyOn(internals.goalRuntime, 'recordExecutionResult');

      await operation(connector, 'session.message', {
        sessionId: session.id,
        clientMessageId: 'goal-intervention-during-continuation',
        content: 'Prioritize the failing test',
        deliveryIntent: 'REPLACE_CURRENT'
      });
      await vi.waitFor(() => expect(continuationCount).toBe(2));

      recordExecutionResult.mockClear();
      internals.emitRunEvent(originalExecutionId, 'run.completed', {}, 'SUCCEEDED');
      expect(recordExecutionResult).not.toHaveBeenCalled();

      internals.goalCoordinator.handleGoalPreparationFailed(
        internals.runtime.getAgentSession(session.id)!,
        originalGeneration,
        true
      );
      expect(internals.goalRuntime.get(session.id)).toMatchObject({
        id: goal.id,
        revision: goal.revision,
        status: 'active'
      });

      releaseOldContinuation();

      await vi.waitFor(() => {
        const itemIds = internals.runtime.sessionQueue(session.id).itemIds;
        expect(itemIds).toHaveLength(1);
        expect(itemIds.map((id) => internals.continuousRunCoordinator.pending(id)?.goal)).toEqual([
          expect.objectContaining({ id: goal.id, revision: goal.revision })
        ]);
      });
    } finally {
      await connector.stop();
    }
  });

  it('discards an old Goal start that finishes after a newer edit', async () => {
    const database = new NodeDatabase(':memory:', 'node-goal-stale-start-after-edit');
    const workspace = database.saveWorkspace({
      path: await workspacePath('goal-stale-start-after-edit'),
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
        claudeCode: { available: true, version: '2.1.0' }
      },
      claudeClient: {
        startChannel() {
          return {
            completed: new Promise<void>(() => undefined),
            deliver: async () => undefined,
            interrupt: async () => undefined,
            cancel: () => undefined,
            getContextUsage: async () => null
          };
        }
      } as never
    });
    const internals = connector as unknown as {
      runtime: {
        createAgentSession(input: Record<string, unknown>): { id: string };
        activeSessionRun(sessionId: string): { id: string } | undefined;
        sessionQueue(sessionId: string): { itemIds: readonly string[] };
      };
      goalRuntime: {
        get(sessionId: string): { revision: number; objective: string; status: string } | undefined;
      };
      sessionMessageService: {
        submitGoal(input: Record<string, unknown>): Promise<unknown>;
      };
    };
    const session = internals.runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'claude-code',
      cwd: workspace.path,
      nativeControl: 'MAR_MANAGED'
    });
    const submitGoal = internals.sessionMessageService.submitGoal.bind(
      internals.sessionMessageService
    );
    let releaseOldStart!: () => void;
    const oldStartGate = new Promise<void>((resolve) => {
      releaseOldStart = resolve;
    });
    let startCount = 0;
    internals.sessionMessageService.submitGoal = async (input) => {
      if (input.kind === 'start' && startCount++ === 0) await oldStartGate;
      return submitGoal(input);
    };

    try {
      const oldStart = operation(connector, 'session.command.execute', {
        sessionId: session.id,
        commandId: 'goal',
        input: '/goal Complete the old objective'
      });
      await vi.waitFor(() => expect(startCount).toBe(1));
      await operation(connector, 'session.command.execute', {
        sessionId: session.id,
        commandId: 'goal',
        input: '/goal Complete the new objective'
      });
      releaseOldStart();
      await expect(oldStart).rejects.toThrow('GOAL_REVISION_STALE');
      expect(internals.goalRuntime.get(session.id)).toMatchObject({
        revision: 2,
        objective: 'Complete the new objective',
        status: 'active'
      });
      expect(internals.runtime.activeSessionRun(session.id)).toBeDefined();
      await vi.waitFor(() =>
        expect(internals.runtime.sessionQueue(session.id).itemIds).toHaveLength(1)
      );
    } finally {
      await connector.stop();
    }
  });

  it('MAR Agent preserves model and dynamic credential context when Goal starts through a command', async () => {
    const database = new NodeDatabase(':memory:', 'node-mar-agent-goal-model-context');
    const workspace = database.saveWorkspace({
      path: await workspacePath('mar-agent-goal-model-context'),
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
        marAgent: { available: true, version: '0.9.32' }
      }
    });
    const internals = connector as unknown as {
      runtime: {
        createAgentSession(input: Record<string, unknown>): { id: string };
      };
      sessionMessageService: {
        submitGoal(input: Record<string, unknown>): Promise<unknown>;
      };
    };
    const session = internals.runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'mar-agent',
      cwd: workspace.path,
      nativeControl: 'MAR_MANAGED',
      model: 'model-1'
    });
    const marAgentModel = { id: 'model-1', credential: { type: 'RUNTIME_TICKET' } };
    const marAgentModels = [marAgentModel];
    const submitGoal = vi.fn(async () => ({ run: { id: 'goal-run' } }));
    internals.sessionMessageService.submitGoal = submitGoal;

    try {
      await operation(connector, 'session.command.execute', {
        sessionId: session.id,
        commandId: 'goal',
        input: '/goal Complete and verify the long-running task',
        marAgentRuntimeScopeId: 'scope-1',
        marAgentModel,
        marAgentModels
      });

      expect(submitGoal).toHaveBeenCalledWith(
        expect.objectContaining({
          executionContext: new MarAgentRunner().prepareExecutionContext({
            marAgentRuntimeScopeId: 'scope-1',
            marAgentModel,
            marAgentModels
          })
        })
      );
    } finally {
      await connector.stop();
    }
  });

  it('preserves the Run owner when editing a Goal through a command', async () => {
    const database = new NodeDatabase(':memory:', 'node-goal-edit-owner');
    const workspace = database.saveWorkspace({
      path: await workspacePath('goal-edit-owner'),
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
        claudeCode: { available: true, version: '2.1.0' }
      },
      claudeClient: {
        startChannel() {
          return {
            completed: new Promise<void>(() => undefined),
            deliver: async () => undefined,
            interrupt: async () => undefined,
            cancel: () => undefined,
            getContextUsage: async () => null
          };
        }
      } as never
    });
    const internals = connector as unknown as {
      runtime: {
        createAgentSession(input: Record<string, unknown>): { id: string };
        activeSessionRun(sessionId: string): { id: string; initiatedByUserId?: number } | undefined;
        currentExecutionId(runId: string): string | undefined;
      };
      goalRuntime: {
        get(
          sessionId: string
        ):
          | { id: string; revision: number; objective: string; status: string; turns: number }
          | undefined;
        recordExecutionResult(
          sessionId: string,
          input: { failed: boolean; progressed: boolean }
        ): string;
      };
      emitRunEvent(runId: string, eventType: string, payload: unknown, status?: 'FAILED'): void;
    };
    const session = internals.runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'claude-code',
      cwd: workspace.path,
      nativeControl: 'MAR_MANAGED'
    });

    try {
      await operation(connector, 'session.command.execute', {
        sessionId: session.id,
        commandId: 'goal',
        input: '/goal',
        __requestUserId: 7
      });
      await operation(connector, 'session.message', {
        sessionId: session.id,
        clientMessageId: 'owned-goal-objective',
        content: 'Complete the original objective',
        __requestUserId: 7
      });
      await vi.waitFor(() =>
        expect(internals.runtime.activeSessionRun(session.id)?.initiatedByUserId).toBe(7)
      );
      await vi.waitFor(() =>
        expect(
          internals.runtime.currentExecutionId(internals.runtime.activeSessionRun(session.id)!.id)
        ).toBeTypeOf('string')
      );
      const original = internals.goalRuntime.get(session.id)!;
      const originalRun = internals.runtime.activeSessionRun(session.id)!;
      const originalExecutionId = internals.runtime.currentExecutionId(originalRun.id)!;
      const recordExecutionResult = vi.spyOn(internals.goalRuntime, 'recordExecutionResult');

      await expect(
        operation(connector, 'session.command.execute', {
          sessionId: session.id,
          commandId: 'goal',
          input: '/goal Complete the edited objective',
          __requestUserId: 7
        })
      ).resolves.toMatchObject({
        delivery: expect.stringMatching(/^(QUEUED|ACCEPTED)$/)
      });

      expect(internals.goalRuntime.get(session.id)).toMatchObject({
        id: original.id,
        revision: original.revision + 1,
        objective: 'Complete the edited objective',
        status: 'active'
      });
      expect(internals.runtime.activeSessionRun(session.id)?.initiatedByUserId).toBe(7);

      recordExecutionResult.mockClear();
      internals.emitRunEvent(
        originalExecutionId,
        'run.failed',
        { code: 'OLD_REVISION_FAILED' },
        'FAILED'
      );
      expect(recordExecutionResult).not.toHaveBeenCalled();
    } finally {
      await connector.stop();
    }
  });

  it('MAR Agent preserves model and dynamic credential context when Goal startup retries', async () => {
    vi.useFakeTimers();
    const database = new NodeDatabase(':memory:', 'node-mar-agent-goal-run-retry-context');
    const workspace = database.saveWorkspace({
      path: await workspacePath('mar-agent-goal-run-retry-context'),
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
        marAgent: { available: true, version: '0.9.32' }
      }
    });
    const internals = connector as unknown as {
      runtime: {
        createAgentSession(input: Record<string, unknown>): { id: string };
      };
      goalRuntime: {
        start(
          sessionId: string,
          objective: string
        ): { id: string; revision: number; objective: string };
      };
      continuousRunCoordinator: {
        accept(input: Record<string, unknown>): {
          run: { id: string };
          queueItem?: { id: string };
        };
        prepare(submissionId: string, input: Record<string, unknown>): void;
        dispatch(sessionId: string): Promise<void>;
      };
      sessionMessageService: {
        submitGoal(input: Record<string, unknown>): Promise<unknown>;
      };
    };
    const session = internals.runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'mar-agent',
      cwd: workspace.path,
      nativeControl: 'MAR_MANAGED',
      model: 'model-1',
      effort: 'high',
      access: 'full-access'
    });
    const goal = internals.goalRuntime.start(
      session.id,
      'Complete and verify the long-running task'
    );
    const accepted = internals.continuousRunCoordinator.accept({
      runId: 'goal-run-retry-context',
      sessionId: session.id,
      clientMessageId: 'goal-run-retry-context',
      content: 'Goal Start'
    });
    const marAgentModel = { id: 'model-1', credential: { type: 'RUNTIME_TICKET' } };
    const marAgentModels = [marAgentModel];
    internals.continuousRunCoordinator.prepare(accepted.run.id, {
      runId: accepted.run.id,
      sessionId: session.id,
      workspaceId: workspace.id,
      executionContext: new MarAgentRunner().prepareExecutionContext({
        marAgentModel,
        marAgentModels,
        marAgentRuntimeScopeId: 'scope-1'
      }),
      input: 'Goal Start',
      clientMessageId: 'goal-run-retry-context',
      attachments: [],
      attachmentPaths: [],
      cwd: workspace.path,
      externalSessionId: null,
      model: 'model-1',
      effort: 'high',
      access: 'full-access',
      collaborationMode: 'default',
      secretEnvironment: {},
      goal: (
        connector as unknown as { goalCoordinator: GoalContinuationCoordinator }
      ).goalCoordinator.reference(session.id)
    });
    const submitGoal = vi.fn(async () => ({ run: accepted.run }));
    internals.sessionMessageService.submitGoal = submitGoal;

    try {
      await internals.continuousRunCoordinator.dispatch(session.id);
      await vi.advanceTimersByTimeAsync(15_000);

      expect(submitGoal).toHaveBeenCalledWith(
        expect.objectContaining({
          executionContext: new MarAgentRunner().prepareExecutionContext({
            marAgentRuntimeScopeId: 'scope-1',
            marAgentModel,
            marAgentModels
          })
        })
      );
    } finally {
      await connector.stop();
      vi.useRealTimers();
    }
  });

  it('continues an active Goal when its first Execution promotes the Session ID during continuation submission', async () => {
    const database = new NodeDatabase(':memory:', 'node-goal-session-promotion-continuation');
    const workspace = database.saveWorkspace({
      path: await workspacePath('goal-session-promotion-continuation'),
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const prompts: string[] = [];
    const connector = new NodeConnector({
      reconnect: false,
      database,
      capabilities: {
        platform: 'linux',
        architecture: 'x64',
        nodeVersion: process.version,
        codex: { available: false },
        claudeCode: { available: true, version: '2.1.0' }
      },
      claudeClient: {
        startChannel(input: { prompt: string }) {
          prompts.push(input.prompt);
          return {
            completed: new Promise<void>(() => undefined),
            deliver: async () => undefined,
            interrupt: async () => undefined,
            cancel: () => undefined,
            getContextUsage: async () => null
          };
        }
      } as never
    });
    const internals = connector as unknown as {
      runtime: {
        createAgentSession(input: Record<string, unknown>): { id: string };
        getAgentSession(sessionId: string): { id: string } | undefined;
        sessionQueue(sessionId: string): { itemIds: readonly string[] };
        currentExecutionId(runId: string): string | undefined;
      };
      goalRuntime: {
        start(sessionId: string, objective: string): { id: string; revision: number };
        get(sessionId: string): { status: string; turns: number } | undefined;
      };
      continuousRunCoordinator: {
        accept(input: Record<string, unknown>): { run: { id: string } };
        prepare(submissionId: string, input: Record<string, unknown>): void;
        dispatch(sessionId: string): Promise<void>;
      };
      sessionIdentityService: { promote(sessionId: string, nativeSessionId: string): void };
      managedRunnerSessions: { remember(nativeSessionId: string, sessionId: string): void };
      sessionMessageService: {
        submitGoal(input: Record<string, unknown>): Promise<unknown>;
      };
      emitRunEvent(
        runId: string,
        eventType: string,
        payload: unknown,
        status?: 'STARTING' | 'RUNNING' | 'SUCCEEDED'
      ): void;
    };
    const session = internals.runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'claude-code',
      cwd: workspace.path,
      nativeControl: 'MAR_MANAGED'
    });
    const goal = internals.goalRuntime.start(session.id, 'Keep executing after Session promotion');
    const accepted = internals.continuousRunCoordinator.accept({
      runId: 'goal-promotion-run',
      sessionId: session.id,
      clientMessageId: 'goal-promotion-start',
      content: 'Goal Start'
    });
    internals.continuousRunCoordinator.prepare(accepted.run.id, {
      runId: accepted.run.id,
      sessionId: session.id,
      workspaceId: workspace.id,
      executionContext: { runner: 'claude-code' },
      input: serializeComposerTag('mar_goal_start', {
        objective: 'Keep executing after Session promotion',
        instruction: 'A Goal has started or changed.'
      }),
      clientMessageId: 'goal-promotion-start',
      attachments: [],
      attachmentPaths: [],
      cwd: workspace.path,
      externalSessionId: null,
      model: null,
      effort: null,
      access: 'bypass',
      collaborationMode: 'default',
      secretEnvironment: {},
      goal: (
        connector as unknown as { goalCoordinator: GoalContinuationCoordinator }
      ).goalCoordinator.reference(session.id)
    });
    const submitGoal = internals.sessionMessageService.submitGoal.bind(
      internals.sessionMessageService
    );
    let releaseContinuation!: () => void;
    const continuationGate = new Promise<void>((resolve) => {
      releaseContinuation = resolve;
    });
    const submitted = vi.fn(async (input: Record<string, unknown>) => {
      await continuationGate;
      return submitGoal(input);
    });
    internals.sessionMessageService.submitGoal = submitted;

    try {
      await internals.continuousRunCoordinator.dispatch(session.id);
      await vi.waitFor(() => expect(submitted).toHaveBeenCalledOnce());

      const nativeSessionId = 'native-goal-promotion-session';
      internals.managedRunnerSessions.remember(nativeSessionId, session.id);
      internals.sessionIdentityService.promote(session.id, nativeSessionId);
      releaseContinuation();

      await vi.waitFor(() =>
        expect(internals.runtime.sessionQueue(nativeSessionId).itemIds).toHaveLength(1)
      );
      expect(internals.goalRuntime.get(nativeSessionId)).toMatchObject({
        status: 'active',
        turns: 1
      });

      const firstExecutionId = internals.runtime.currentExecutionId(accepted.run.id);
      expect(firstExecutionId).toBeDefined();
      internals.emitRunEvent(firstExecutionId!, 'run.completed', {}, 'SUCCEEDED');
      await vi.waitFor(() => expect(prompts).toHaveLength(2));

      expect(internals.runtime.getAgentSession(session.id)?.id).toBe(nativeSessionId);
      expect(internals.runtime.currentExecutionId(accepted.run.id)).toBeDefined();
      expect(internals.goalRuntime.get(nativeSessionId)).toMatchObject({ status: 'active' });
    } finally {
      await connector.stop();
    }
  });

  it('drops an old continuation after a Goal is inserted during an ordinary Run and edited', async () => {
    const database = new NodeDatabase(':memory:', 'node-goal-stale-continuation-after-edit');
    const workspace = database.saveWorkspace({
      path: await workspacePath('goal-stale-continuation-after-edit'),
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
        claudeCode: { available: true, version: '2.1.0' }
      },
      claudeClient: {
        startChannel() {
          return {
            completed: new Promise<void>(() => undefined),
            deliver: async () => undefined,
            interrupt: async () => undefined,
            cancel: () => undefined,
            getContextUsage: async () => null
          };
        }
      } as never
    });
    const internals = connector as unknown as {
      runtime: {
        createAgentSession(input: Record<string, unknown>): { id: string };
        sessionQueue(sessionId: string): { itemIds: readonly string[] };
        getQueueItem(itemId: string): { content: string } | undefined;
        currentExecutionId(runId: string): string | undefined;
      };
      goalRuntime: {
        get(
          sessionId: string
        ):
          | { id: string; revision: number; objective: string; status: string; turns: number }
          | undefined;
      };
      continuousRunCoordinator: {
        pending(
          submissionId: string
        ): { goal?: { id: string; revision: number }; input: string } | undefined;
      };
      sessionMessageService: {
        submitGoal(input: Record<string, unknown>): Promise<unknown>;
      };
    };
    const session = internals.runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'claude-code',
      cwd: workspace.path,
      nativeControl: 'MAR_MANAGED'
    });
    const submitGoal = internals.sessionMessageService.submitGoal.bind(
      internals.sessionMessageService
    );
    let releaseOldContinuation!: () => void;
    let markOldContinuationSubmitted!: () => void;
    let markOldContinuationFinished!: () => void;
    const oldContinuationGate = new Promise<void>((resolve) => {
      releaseOldContinuation = resolve;
    });
    const oldContinuationSubmitted = new Promise<void>((resolve) => {
      markOldContinuationSubmitted = resolve;
    });
    const oldContinuationFinished = new Promise<void>((resolve) => {
      markOldContinuationFinished = resolve;
    });
    let continuationCount = 0;
    internals.sessionMessageService.submitGoal = async (input) => {
      if (input.kind === 'continue' && continuationCount++ === 0) {
        markOldContinuationSubmitted();
        await oldContinuationGate;
        try {
          return await submitGoal(input);
        } finally {
          markOldContinuationFinished();
        }
      }
      return submitGoal(input);
    };

    try {
      const ordinaryRun = (await operation(connector, 'session.message', {
        sessionId: session.id,
        clientMessageId: 'ordinary-run-before-goal',
        content: 'Finish the ordinary task before starting the Goal'
      })) as { run: { id: string } };
      await vi.waitFor(() =>
        expect(internals.runtime.currentExecutionId(ordinaryRun.run.id)).toBeDefined()
      );
      await operation(connector, 'session.command.execute', {
        sessionId: session.id,
        commandId: 'goal',
        input: '/goal Complete the original objective'
      });
      await vi.waitFor(() => expect(continuationCount).toBe(1));
      await oldContinuationSubmitted;
      const oldGoal = internals.goalRuntime.get(session.id)!;

      await operation(connector, 'session.command.execute', {
        sessionId: session.id,
        commandId: 'goal',
        input: '/goal Complete the edited objective instead'
      });
      const editedGoal = internals.goalRuntime.get(session.id)!;
      expect(editedGoal).toMatchObject({
        id: oldGoal.id,
        revision: oldGoal.revision + 1,
        objective: 'Complete the edited objective instead',
        status: 'active'
      });

      releaseOldContinuation();
      await oldContinuationFinished;
      await vi.waitFor(() => {
        const queueItemIds = internals.runtime.sessionQueue(session.id).itemIds;
        expect(queueItemIds).toHaveLength(1);
        expect(
          queueItemIds.map((itemId) => internals.continuousRunCoordinator.pending(itemId)?.goal)
        ).toEqual([expect.objectContaining({ id: editedGoal.id, revision: editedGoal.revision })]);
      });

      const queueItemIds = internals.runtime.sessionQueue(session.id).itemIds;
      expect(
        queueItemIds.map((itemId) => internals.continuousRunCoordinator.pending(itemId)?.input)
      ).toEqual(
        expect.arrayContaining([expect.stringContaining('Complete the edited objective instead')])
      );
      expect(internals.goalRuntime.get(session.id)).toMatchObject({
        id: editedGoal.id,
        revision: editedGoal.revision,
        objective: 'Complete the edited objective instead',
        status: 'active'
      });
    } finally {
      await connector.stop();
    }
  });

  it('queues Goal insertion while an ordinary Run is still preparing', async () => {
    vi.useFakeTimers();
    const database = new NodeDatabase(':memory:', 'node-goal-insertion-during-run-preparation');
    const workspace = database.saveWorkspace({
      path: await workspacePath('goal-insertion-during-run-preparation'),
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
        claudeCode: { available: true, version: '2.1.0' }
      },
      claudeClient: {
        startChannel() {
          return {
            completed: new Promise<void>(() => undefined),
            deliver: async () => undefined,
            interrupt: async () => undefined,
            cancel: () => undefined,
            getContextUsage: async () => null
          };
        }
      } as never
    });
    const internals = connector as unknown as {
      runtime: {
        createAgentSession(input: Record<string, unknown>): { id: string };
        sessionQueue(sessionId: string): { itemIds: readonly string[] };
      };
    };
    const session = internals.runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'claude-code',
      cwd: workspace.path,
      nativeControl: 'MAR_MANAGED'
    });

    try {
      await operation(connector, 'session.message', {
        sessionId: session.id,
        clientMessageId: 'ordinary-run-preparing',
        content: 'Start an ordinary task'
      });
      await expect(
        operation(connector, 'session.command.execute', {
          sessionId: session.id,
          commandId: 'goal',
          input: '/goal Insert the Goal while the Run is preparing'
        })
      ).resolves.toMatchObject({ delivery: 'QUEUED' });
      expect(internals.runtime.sessionQueue(session.id).itemIds).toHaveLength(1);
    } finally {
      await connector.stop();
      vi.useRealTimers();
    }
  });

  it('queues Goal continuation even when the updated Goal projection fails', async () => {
    const database = new NodeDatabase(':memory:', 'node-goal-continuation-projection-failure');
    const workspace = database.saveWorkspace({
      path: await workspacePath('goal-continuation-projection-failure'),
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
        claudeCode: { available: true, version: '2.1.0' }
      },
      claudeClient: {
        startChannel() {
          return {
            completed: new Promise<void>(() => undefined),
            deliver: async () => undefined,
            interrupt: async () => undefined,
            cancel: () => undefined,
            getContextUsage: async () => null
          };
        }
      } as never
    });
    const internals = connector as unknown as {
      runtime: {
        createAgentSession(input: Record<string, unknown>): { id: string };
        sessionQueue(sessionId: string): { itemIds: readonly string[] };
        getQueueItem(itemId: string): { content: string; initiatedByUserId?: number } | undefined;
      };
      goalCoordinator: { publishGoalState(session: { id: string }, goal: { turns: number }): void };
    };
    const session = internals.runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'claude-code',
      cwd: workspace.path,
      nativeControl: 'MAR_MANAGED'
    });
    const publishGoalState = internals.goalCoordinator.publishGoalState.bind(
      internals.goalCoordinator
    );
    internals.goalCoordinator.publishGoalState = (target, goal) => {
      if (goal.turns === 1) throw new Error('goal projection failed');
      publishGoalState(target, goal);
    };

    try {
      await operation(connector, 'session.command.execute', {
        sessionId: session.id,
        commandId: 'goal',
        input: '/goal'
      });
      await operation(connector, 'session.message', {
        sessionId: session.id,
        clientMessageId: 'owned-goal-objective',
        content: 'Complete the goal despite a projection failure',
        __requestUserId: 42
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      const queueItemIds = internals.runtime.sessionQueue(session.id).itemIds;
      expect(queueItemIds).toHaveLength(1);
      expect(internals.runtime.getQueueItem(queueItemIds[0]!)?.content).toBe(
        serializeComposerTag('mar_goal_continue', {})
      );
      expect(internals.runtime.getQueueItem(queueItemIds[0]!)?.initiatedByUserId).toBe(42);
    } finally {
      await connector.stop();
    }
  });

  it('retries a failed goal continuation submission every fifteen seconds without losing the active goal', async () => {
    vi.useFakeTimers();
    const database = new NodeDatabase(':memory:', 'node-goal-continuation-retry');
    const workspace = database.saveWorkspace({
      path: await workspacePath('goal-continuation-retry'),
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
        claudeCode: { available: true, version: '2.1.0' }
      },
      claudeClient: {
        startChannel() {
          return {
            completed: new Promise<void>(() => undefined),
            deliver: async () => undefined,
            interrupt: async () => undefined,
            cancel: () => undefined,
            getContextUsage: async () => null
          };
        }
      } as never
    });
    const internals = connector as unknown as {
      runtime: {
        createAgentSession(input: Record<string, unknown>): { id: string };
        sessionQueue(sessionId: string): { itemIds: readonly string[] };
      };
      sessionMessageService: {
        submitGoal(input: Record<string, unknown>): Promise<unknown>;
      };
      goalRuntime: {
        get(
          sessionId: string
        ):
          | { id: string; revision: number; objective: string; status: string; turns: number }
          | undefined;
        start(
          sessionId: string,
          objective: string
        ): {
          id: string;
          revision: number;
          objective: string;
        };
      };
      goalCoordinator: {
        enqueueGoalContinuation(input: {
          sessionId: string;
          goal: { id: string; revision: number };
          secretEnvironment: Readonly<Record<string, string>>;
        }): Promise<void>;
      };
    };
    const session = internals.runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'claude-code',
      cwd: workspace.path,
      nativeControl: 'MAR_MANAGED'
    });
    const submitGoal = internals.sessionMessageService.submitGoal.bind(
      internals.sessionMessageService
    );
    let attempts = 0;
    let firstFailureAt = 0;
    internals.sessionMessageService.submitGoal = async (input) => {
      if (input.kind !== 'continue') return submitGoal(input);
      attempts += 1;
      if (attempts === 1) {
        firstFailureAt = Date.now();
        throw new Error('temporary continuation failure');
      }
      return submitGoal(input);
    };

    try {
      await operation(connector, 'session.command.execute', {
        sessionId: session.id,
        commandId: 'goal',
        input: '/goal'
      });
      await operation(connector, 'session.message', {
        sessionId: session.id,
        clientMessageId: 'goal-retry-objective',
        content: 'Complete and verify the long-running task'
      });
      await vi.waitFor(() => expect(internals.goalRuntime.get(session.id)?.turns).toBe(1));
      await vi.waitFor(() => expect(attempts).toBe(1));
      await vi.advanceTimersByTimeAsync(14_999 - (Date.now() - firstFailureAt));
      expect(internals.runtime.sessionQueue(session.id).itemIds).toEqual([]);
      expect(internals.goalRuntime.get(session.id)).toMatchObject({
        status: 'active',
        turns: 1
      });

      await vi.advanceTimersByTimeAsync(1);
      expect(attempts).toBe(2);
      expect(internals.runtime.sessionQueue(session.id).itemIds).toHaveLength(1);

      let rejectStale!: (error: Error) => void;
      let staleAttempts = 0;
      internals.sessionMessageService.submitGoal = async () => {
        staleAttempts += 1;
        return new Promise((_, reject) => {
          rejectStale = reject;
        });
      };
      const staleGoal = internals.goalRuntime.get(session.id)!;
      const staleSubmission = internals.goalCoordinator.enqueueGoalContinuation({
        sessionId: session.id,
        goal: { id: staleGoal.id, revision: staleGoal.revision },
        secretEnvironment: {}
      });
      const revisedGoal = internals.goalRuntime.start(session.id, 'Updated long-running task');
      rejectStale(new Error('stale continuation failure'));
      await staleSubmission;
      await vi.advanceTimersByTimeAsync(15_000);
      expect(staleAttempts).toBe(1);
      expect(internals.goalRuntime.get(session.id)).toMatchObject({
        id: revisedGoal.id,
        revision: revisedGoal.revision,
        objective: 'Updated long-running task',
        status: 'active'
      });

      let failedAttempts = 0;
      internals.sessionMessageService.submitGoal = async () => {
        failedAttempts += 1;
        throw new Error('persistent continuation failure');
      };
      void internals.goalCoordinator.enqueueGoalContinuation({
        sessionId: session.id,
        goal: { id: revisedGoal.id, revision: revisedGoal.revision },
        secretEnvironment: {}
      });
      await vi.advanceTimersByTimeAsync(45_000);
      expect(failedAttempts).toBe(4);
      expect(internals.goalRuntime.get(session.id)?.status).toBe('blocked');
      await vi.waitFor(() =>
        expect(internals.runtime.sessionQueue(session.id).itemIds).toEqual([])
      );
    } finally {
      await connector.stop();
      vi.useRealTimers();
    }
  });
});

async function nativeGoalFixture() {
  const database = new NodeDatabase(':memory:', 'node-native-steer-goal');
  const workspace = database.saveWorkspace({
    path: await workspacePath('native-steer-goal'),
    kind: 'DIRECTORY',
    gitSummary: null
  });
  const interrupt = vi.fn(async () => undefined);
  const connector = new NodeConnector({
    reconnect: false,
    database,
    capabilities: {
      platform: 'linux',
      architecture: 'x64',
      nodeVersion: process.version,
      codex: { available: false },
      claudeCode: { available: true, version: '2.1.0' }
    },
    claudeClient: {
      startChannel() {
        return {
          completed: new Promise<void>(() => undefined),
          deliver: async () => undefined,
          interrupt,
          cancel: () => undefined,
          getContextUsage: async () => null
        };
      }
    } as never
  });
  const internals = connector as unknown as {
    runtime: NodeRuntimeState;
    runners: RunnerRegistry;
    continuousRunCoordinator: ContinuousRunCoordinator<unknown>;
    goalRuntime: {
      get(id: string): { id: string; revision: number; status: string; turns: number } | undefined;
    };
    emitRunEvent(id: string, type: string, payload: unknown, status?: 'SUCCEEDED'): void;
  };
  const runner = internals.runners.require('claude-code');
  // Exercise the optional Runner capability without starting a model or external SDK.
  vi.spyOn(runner, 'supportsNativeSteer').mockReturnValue(true);
  const steer = vi.spyOn(runner, 'steerManagedRun').mockResolvedValue({ status: 'handled' });
  const session = internals.runtime.createAgentSession({
    workspaceId: workspace.id,
    runner: 'claude-code',
    cwd: workspace.path,
    nativeControl: 'MAR_MANAGED'
  });
  await operation(connector, 'session.command.execute', {
    sessionId: session.id,
    commandId: 'goal',
    input: '/goal Complete and verify the feature'
  });
  await vi.waitFor(() => expect(internals.goalRuntime.get(session.id)?.turns).toBe(1));
  await vi.waitFor(() =>
    expect(internals.runtime.sessionQueue(session.id).itemIds).toHaveLength(1)
  );
  return { connector, internals, session, steer, interrupt };
}

function operation(connector: NodeConnector, operation: string, data: unknown): Promise<unknown> {
  return (
    connector as unknown as {
      executeNodeOperation(operation: string, data: unknown): Promise<unknown>;
    }
  ).executeNodeOperation(operation, data);
}

const workspacePaths: string[] = [];
afterEach(async () => {
  await Promise.all(
    workspacePaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function workspacePath(name: string): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), name + '-')));
  workspacePaths.push(path);
  return path;
}
