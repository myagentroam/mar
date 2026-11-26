// @test-covers mar-node/src/connector.ts
// @test-covers mar-node/src/service/planned-restart-handoff.ts
// @test-covers mar-node/src/service/continuous-run-coordinator.ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { NodeConnector } from '../../src/connector.js';
import { NodeDatabase } from '../../src/database.js';
import type { NodeRuntimeState } from '../../src/runtime-state.js';
import type { ContinuousRunCoordinator } from '../../src/service/continuous-run-coordinator.js';
import type { GitOperationService } from '../../src/service/git-operation-service.js';
import type { PlannedRestartHandoff } from '../../src/service/planned-restart-handoff.js';
import { RestartSessionRestorer } from '../../src/service/restart-session-restorer.js';
import type { RunAuthorizationControl } from '../../src/service/run-authorization-control.js';
import type { ScheduledSessionCoordinator } from '../../src/service/scheduled-session-coordinator.js';
import { ScheduledSessionStore } from '../../src/service/scheduled-session-store.js';
import type { SessionMessageService } from '../../src/session/session-message-service.js';
import type { WorkspaceQueueWorkbenchService } from '../../src/workspace/workspace-queue-workbench-service.js';

it.each([
  'queue deletion',
  'Goal cleanup',
  'restart restore',
  'failed restore',
  'missing manifest'
] as const)(
  'admits a waiting one-off occurrence when its only blocker clears: %s',
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), 'schedule-availability-'));
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2025-01-01T00:00:00Z'));
    const nodeId = 'schedule-availability';
    const serverUrl = 'https://server.example.test';
    const database = new NodeDatabase(':memory:', nodeId);
    const workspace = database.saveWorkspace({ path: root, kind: 'DIRECTORY', gitSummary: null });
    const connector = new NodeConnector({
      reconnect: false,
      database,
      config: {
        nodeId,
        serverUrl,
        allowedRoots: [root],
        dataDirectory: root,
        credential: 'test-only'
      }
    });
    const internals = connector as unknown as {
      runtime: NodeRuntimeState;
      continuousRunCoordinator: ContinuousRunCoordinator<never>;
      workspaceQueueWorkbenchService: WorkspaceQueueWorkbenchService;
      restartHandoff: PlannedRestartHandoff;
      scheduledSessions: ScheduledSessionCoordinator;
      controlChannel: { connected(): boolean };
      scheduledRunAuthorization: RunAuthorizationControl;
      gitOperationService: GitOperationService;
      sessionMessageService: SessionMessageService;
    };
    try {
      const queueBlocker = mode === 'queue deletion' || mode === 'Goal cleanup';
      const runner = mode === 'queue deletion' ? 'claude-code' : 'mar-agent';
      const session = internals.runtime.createAgentSession({
        workspaceId: workspace.id,
        runner,
        externalSessionId: 'scheduled-session',
        nativeControl: 'MAR_MANAGED',
        cwd: root,
        modelId: runner === 'claude-code' ? 'claude-sonnet' : 'test-model',
        access: 'full'
      });
      database.saveNativeSessionMetadata({
        runner,
        externalSessionId: session.id,
        workspaceId: workspace.id
      });
      const store = new ScheduledSessionStore(database.raw);
      const task = store.create({
        sessionId: session.id,
        workspaceId: workspace.id,
        runner,
        ownerUserId: 7,
        name: 'One-off check',
        objective: 'Run once',
        timezone: 'UTC',
        graceMinutes: 30,
        triggers: [{ kind: 'once', date: '2025-01-01', time: '00:01' }]
      });
      const occurrenceId = `${task.id}:${task.nextRunAt}`;
      vi.spyOn(internals.controlChannel, 'connected').mockReturnValue(true);
      const authorize = vi
        .spyOn(internals.scheduledRunAuthorization, 'authorize')
        .mockResolvedValue({ secretEnvironment: {} });
      vi.spyOn(internals.gitOperationService, 'execute').mockImplementation(
        async (_operation, data, next) => next(data)
      );
      const submit = vi
        .spyOn(internals.sessionMessageService, 'submitScheduled')
        .mockImplementation(async ({ begin }) => {
          begin();
          return { run: { id: 'scheduled-run' } };
        });

      let clearBlocker: () => unknown;
      if (queueBlocker) {
        const { item } = internals.runtime.createQueueItem({
          sessionId: session.id,
          clientMessageId: 'queued',
          content: 'Queued input',
          initiatedByUserId: 7
        });
        if (mode === 'Goal cleanup') {
          internals.continuousRunCoordinator.prepare(item.id, {
            ...session,
            runId: item.id,
            sessionId: session.id,
            input: item.content,
            attachments: [],
            attachmentPaths: [],
            collaborationMode: 'default',
            secretEnvironment: {},
            executionContext: { runner },
            goal: { id: 'goal', revision: 1, epoch: 1 }
          });
          clearBlocker = () =>
            expect(internals.continuousRunCoordinator.removeGoalQueue(session.id)).toBe(true);
        } else {
          clearBlocker = () =>
            internals.workspaceQueueWorkbenchService.operations()[
              'workspace.queue.message.delete'
            ]!({
              workspaceId: workspace.id,
              queueItemId: item.id,
              __requestUserId: 7
            });
        }
      } else {
        const { id, workspaceId, cwd, modelId, effort, access } = session;
        await internals.restartHandoff.publish({
          schemaVersion: 4,
          id: 'handoff',
          nodeId,
          serverUrl,
          createdAt: Date.now(),
          sessions: [
            {
              session: { id, workspaceId, cwd, modelId, effort, access },
              paused: false,
              plan: false,
              awaitingGoal: false,
              queue: []
            }
          ]
        });
        await internals.restartHandoff.load();
        expect(internals.restartHandoff.blocks(session.id)).toBe(true);
        if (mode === 'failed restore')
          vi.spyOn(RestartSessionRestorer.prototype, 'restore').mockRejectedValue(
            new Error('Restore failed')
          );
        if (mode === 'missing manifest') await rm(join(root, 'planned-restart-handoff.json'));
        clearBlocker = () => internals.restartHandoff.recover();
      }

      internals.scheduledSessions.start();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(store.occurrence(occurrenceId)?.status).toBe('WAITING');
      expect(authorize).not.toHaveBeenCalled();
      expect(internals.runtime.activeSessionRun(session.id)).toBeUndefined();

      await clearBlocker();
      await vi.advanceTimersByTimeAsync(0);
      expect(Date.now()).toBe(task.nextRunAt);
      expect(submit).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ occurrenceId, sessionId: session.id })
      );
      expect(store.occurrence(occurrenceId)).toMatchObject({
        status: 'SUBMITTED',
        run_id: 'scheduled-run'
      });
    } finally {
      try {
        await connector.stop();
      } finally {
        vi.restoreAllMocks();
        vi.useRealTimers();
        await rm(root, { recursive: true, force: true });
      }
    }
  }
);
