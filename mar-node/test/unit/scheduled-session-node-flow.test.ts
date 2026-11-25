// @test-covers mar-node/src/application/scheduled-execution-service.ts
import { serializeComposerTag } from '@myagentroam/protocol';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScheduledExecutionService } from '../../src/application/scheduled-execution-service.js';
import { NodeConnector } from '../../src/connector.js';
import { NodeDatabase } from '../../src/database.js';
import { MarAgentMcpClientPool } from '../../src/runner/mar-agent/mcp-client-pool.js';
import type { ScheduleMcpBridge } from '../../src/service/schedule-mcp-bridge.js';
import { ScheduledSessionStore } from '../../src/service/scheduled-session-store.js';
import { SessionScheduleService } from '../../src/session/session-schedule-service.js';
import type { NodeRuntimeState } from '../../src/runtime-state.js';
import type { NodeRunEventBridge } from '../../src/service/node-run-event-bridge.js';
import type { RunnerRegistry } from '../../src/runner/runner-registry.js';
import type { RunnerInteractionService } from '../../src/service/runner-interaction-service.js';
import { dailyGroups, hourlyGroups } from './scheduled-task-fixtures.js';
import type { ScheduledSessionCoordinator } from '../../src/service/scheduled-session-coordinator.js';
import type { SessionMessageService } from '../../src/session/session-message-service.js';
import type { GitOperationService } from '../../src/service/git-operation-service.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe('scheduled Node session flow', () => {
  it.each(['identity-timeout', 'receipt-failed'] as const)(
    'leaves the admitted bootstrap lifecycle to its owner (%s)',
    async (outcome) => {
      const begin = vi.fn();
      const submitScheduled = vi.fn(
        async (input: Parameters<SessionMessageService['submitScheduled']>[0]) => {
          expect(begin).not.toHaveBeenCalled();
          input.begin();
          if (outcome === 'receipt-failed') throw new Error('RECEIPT_FAILED');
          return { run: { id: 'accepted-run' } };
        }
      );
      const execute = vi.fn(
        async (_operation: string, data: unknown, next: (data: unknown) => Promise<unknown>) =>
          next(data)
      );
      const service = new ScheduledExecutionService({
        runtime: {} as never,
        projection: {} as never,
        authorization: {} as never,
        runners: {} as never,
        git: { execute },
        messages: { submitScheduled },
        lifecycle: {} as never
      });
      const release = vi.fn();
      const receipt = service.submit(
        {
          id: 'task-1',
          sessionId: null,
          newSession: { model: { kind: 'default' }, runner: 'codex' },
          workspaceId: 'workspace-1',
          runner: 'codex',
          ownerUserId: 7,
          notifyOnTerminal: true,
          graceMinutes: 60,
          name: 'Check',
          objective: 'Send once',
          groups: hourlyGroups,
          timezone: 'UTC',
          enabled: true,
          revision: 1,
          nextRunAt: 60_000,
          createdAt: 0,
          updatedAt: 0
        },
        'occurrence-1',
        {
          sessionId: 'bootstrap',
          release,
          awaitIdentity: async () => {
            expect(begin).toHaveBeenCalledOnce();
            throw new Error('SESSION_NATIVE_ID_TIMEOUT');
          },
          secretEnvironment: {},
          executionContext: { runner: 'codex' }
        },
        begin
      );
      if (outcome === 'identity-timeout')
        await expect(receipt).resolves.toEqual({ runId: 'accepted-run' });
      else await expect(receipt).rejects.toThrow('RECEIPT_FAILED');
      expect(submitScheduled).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          sessionId: 'bootstrap',
          occurrenceId: 'occurrence-1',
          objective: 'Send once'
        })
      );
      expect(release).not.toHaveBeenCalled();
    }
  );

  it('returns only the bounded, Workspace-scoped system index projection', async () => {
    const database = new NodeDatabase(':memory:', 'schedule-index');
    try {
      const workspace = database.saveWorkspace({
        path: '/schedule-index',
        kind: 'DIRECTORY',
        gitSummary: null
      });
      const other = database.saveWorkspace({
        path: '/other-index',
        kind: 'DIRECTORY',
        gitSummary: null
      });
      database.saveNativeSessionMetadata({
        runner: 'codex',
        externalSessionId: 'thread',
        workspaceId: workspace.id
      });
      const service = new SessionScheduleService({
        database: () => database,
        runtime: {} as never,
        projection: {} as never,
        emitSession: vi.fn()
      });
      const index = service.operations()['schedule.index.list']!;
      const insert = database.raw.prepare(`INSERT INTO scheduled_session_tasks
        (id,workspace_id,runner,owner_user_id,name,objective,time_groups,timezone,enabled,revision,created_at,updated_at,session_id,new_session)
        VALUES (?,?,'codex',7,'Task','Do not index',?,'UTC',0,1,0,0,?,?)`);
      const groups = JSON.stringify(hourlyGroups);
      insert.run('050-other', other.id, groups, null, null);
      for (let i = 0; i <= 100; i++)
        insert.run(
          String(i).padStart(3, '0'),
          workspace.id,
          groups,
          i === 98 ? 'thread' : null,
          i === 99
            ? JSON.stringify({
                runner: 'codex',
                model: { kind: 'fixed', modelId: 'not indexed' }
              })
            : null
        );
      const scope = {
        workspaceId: workspace.id,
        __requestUserId: 0,
        __workspaceWatchSessionHash: 'scheduled-task-index'
      };
      const first = (await index(scope)) as {
        tasks: readonly Record<string, unknown>[];
        nextCursor: string | null;
      };
      expect(first.tasks.map((task) => task.id)).toEqual(
        Array.from({ length: 100 }, (_, i) => String(i).padStart(3, '0'))
      );
      expect(first.nextCursor).toBe('099');
      expect(first.tasks.slice(-2)).toEqual([
        {
          id: '098',
          workspaceId: workspace.id,
          name: 'Task',
          ownerUserId: 7,
          runner: 'codex',
          sessionId: 'thread',
          targetKind: 'existing',
          enabled: false,
          nextRunAt: null
        },
        {
          id: '099',
          workspaceId: workspace.id,
          name: 'Task',
          ownerUserId: 7,
          runner: 'codex',
          sessionId: null,
          targetKind: 'newSession',
          enabled: false,
          nextRunAt: null
        }
      ]);
      expect(await index({ ...scope, afterTaskId: first.nextCursor })).toEqual({
        tasks: [
          {
            id: '100',
            workspaceId: workspace.id,
            name: 'Task',
            ownerUserId: 7,
            runner: 'codex',
            sessionId: null,
            targetKind: 'unbound',
            enabled: false,
            nextRunAt: null
          }
        ],
        nextCursor: null
      });
      expect(() => index({ ...scope, workspaceId: 'unknown' })).toThrow('WORKSPACE_NOT_FOUND');
      expect(() => index({ ...scope, __requestUserId: 7 })).toThrow('USER_AUTHORIZATION_REQUIRED');
    } finally {
      database.close();
    }
  });

  it.each([-1000, 1000])(
    'preserves the due occurrence when a full form is saved %s ms from its due time',
    async (offset) => {
      vi.useFakeTimers();
      vi.setSystemTime(Date.parse('2026-10-23T00:00:00Z'));
      const database = new NodeDatabase(':memory:', 'schedule-edit');
      try {
        const workspace = database.saveWorkspace({
          path: '/schedule-edit',
          kind: 'DIRECTORY',
          gitSummary: null
        });
        database.saveNativeSessionMetadata({
          runner: 'codex',
          externalSessionId: 'editable',
          workspaceId: workspace.id,
          pinned: true
        });
        const session = {
          id: 'editable',
          externalSessionId: 'editable',
          workspaceId: workspace.id,
          runner: 'codex'
        };
        const store = new ScheduledSessionStore(database.raw);
        const task = store.create({
          sessionId: session.id,
          workspaceId: workspace.id,
          runner: 'codex',
          ownerUserId: 1,
          objective: 'Original',
          name: 'Hourly check',
          groups: hourlyGroups,
          timezone: 'UTC'
        });
        const dueAt = task.nextRunAt!;
        vi.setSystemTime(dueAt + offset);
        const service = new SessionScheduleService({
          database: () => database,
          runtime: { getAgentSession: () => session } as never,
          projection: {} as never,
          emitSession: vi.fn()
        });
        const save = service.operations()['schedule.task.update']!;
        const scope = {
          sessionId: session.id,
          taskId: task.id,
          workspaceId: workspace.id,
          __requestUserId: 1
        };
        await expect(
          save({
            ...scope,
            __requestUserId: 2,
            expectedRevision: 1,
            patch: { objective: 'Not mine' }
          })
        ).rejects.toThrow('SCHEDULE_OWNER_REQUIRED');
        await save({
          ...scope,
          expectedRevision: task.revision,
          patch: {
            objective: 'Updated',
            groups: task.groups,
            enabled: true,
            notifyOnTerminal: true
          }
        });
        expect(store.getById(task.id)).toMatchObject({
          nextRunAt: dueAt,
          revision: 2,
          objective: 'Updated',
          ownerUserId: 1,
          notifyOnTerminal: true
        });
        await save({ ...scope, expectedRevision: 2, patch: { objective: 'Partial edit' } });
        expect(store.getById(task.id)).toMatchObject({ nextRunAt: dueAt, revision: 3 });
        vi.setSystemTime(dueAt + 1000);
        expect(store.listDue(Date.now()).map((entry) => entry.sessionId)).toEqual([session.id]);
        const occurrenceId = store.claim(task.id, dueAt, 3);
        expect(occurrenceId).toBe(`${task.id}:${dueAt}`);
        expect(store.claim(task.id, dueAt, 3)).toBeUndefined();
        expect(store.recent(task.id)).toHaveLength(1);
        expect(store.getById(task.id)?.nextRunAt).toBe(dueAt + 3_600_000);
      } finally {
        database.close();
      }
    }
  );

  it.each([false, true])(
    'keeps approval ownership in Runner interactions (scheduled: %s)',
    async (scheduled) => {
      const database = new NodeDatabase(':memory:', 'approval-owner');
      const workspace = database.saveWorkspace({
        path: '/approval-owner',
        kind: 'DIRECTORY',
        gitSummary: null
      });
      const connector = new NodeConnector({ reconnect: false, database });
      const target = connector as unknown as {
        runtime: NodeRuntimeState;
        runEventBridge: NodeRunEventBridge;
        runners: RunnerRegistry;
        runnerInteractionService: RunnerInteractionService;
      };
      const session = target.runtime.createAgentSession({
        workspaceId: workspace.id,
        runner: 'codex',
        cwd: workspace.path
      });
      const { run } = target.runtime.createMessageRun({
        sessionId: session.id,
        clientMessageId: 'approval',
        content: 'work',
        ...(scheduled ? { source: 'SCHEDULED' as const } : {})
      });
      const input = {
        runId: run.id,
        approvalId: 'approval',
        payload: { toolName: 'command' },
        expiresAt: Date.now() + 60_000
      };
      target.runtime.createApproval(input);
      const forward = vi
        .spyOn(target.runEventBridge, 'publishApproval')
        .mockImplementation(() => {});
      const decide = vi.spyOn(target.runners, 'decideApproval').mockReturnValue(true);
      try {
        target.runnerInteractionService.publishApproval(input);
        await Promise.resolve();
        expect(target.runtime.getApproval(input.approvalId)?.status).toBe(
          scheduled ? 'APPROVED' : 'PENDING'
        );
        if (scheduled) {
          expect(decide).toHaveBeenCalledExactlyOnceWith({
            runId: run.id,
            approvalId: input.approvalId,
            decision: 'APPROVED'
          });
          expect(forward).not.toHaveBeenCalled();
        } else {
          expect(forward).toHaveBeenCalledExactlyOnceWith(input);
          expect(decide).not.toHaveBeenCalled();
        }
      } finally {
        await connector.stop();
      }
    }
  );

  it('keeps the database available until an in-flight scheduled authorization settles on stop', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2025-01-01T00:00:00Z'));
    const database = new NodeDatabase(':memory:', 'schedule-stop', Date.now);
    const workspace = database.saveWorkspace({
      path: '/schedule-stop',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({ reconnect: false, database });
    const internals = connector as unknown as {
      runtime: NodeRuntimeState;
      controlChannel: { connected(): boolean };
      scheduledRunAuthorization: {
        authorize(input: unknown): Promise<unknown>;
        close(): void;
      };
      scheduledSessions: ScheduledSessionCoordinator;
      executeNodeOperation(operation: string, input: unknown): Promise<unknown>;
    };
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const session = internals.runtime.createAgentSession({
        workspaceId: workspace.id,
        runner: 'claude-code',
        externalSessionId: 'schedule-stop-session',
        nativeControl: 'MAR_MANAGED',
        cwd: workspace.path,
        modelId: 'claude-sonnet',
        access: 'full'
      });
      const created = (await internals.executeNodeOperation('schedule.task.create', {
        target: { kind: 'existing', sessionId: session.id },
        workspaceId: workspace.id,
        __requestUserId: 7,
        objective: 'Inspect the repository',
        name: 'Hourly check',
        groups: hourlyGroups,
        enabled: true
      })) as { task: { id: string } };
      const store = new ScheduledSessionStore(database.raw);
      const task = store.getById(created.task.id)!;
      const authorize = vi
        .spyOn(internals.scheduledRunAuthorization, 'authorize')
        .mockImplementation(async () => {
          await pending;
          return { secretEnvironment: {} };
        });
      const authorizationClose = vi.spyOn(internals.scheduledRunAuthorization, 'close');
      const closedOccurrences: unknown[] = [];
      const close = database.close.bind(database);
      const databaseClose = vi.spyOn(database, 'close').mockImplementation(() => {
        closedOccurrences.push(...store.recent(task.id));
        close();
      });
      vi.spyOn(internals.controlChannel, 'connected').mockReturnValue(true);
      internals.scheduledSessions.start();
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(authorize).toHaveBeenCalledOnce();
      const stopping = connector.stop();
      await vi.waitFor(() => expect(authorizationClose).toHaveBeenCalledOnce());
      expect(databaseClose).not.toHaveBeenCalled();
      release();
      await stopping;
      expect(databaseClose).toHaveBeenCalledOnce();
      expect(closedOccurrences).toMatchObject([
        { status: 'SKIPPED', code: 'SCHEDULE_NODE_STOPPED' }
      ]);
    } finally {
      release();
      await connector.stop();
      vi.useRealTimers();
    }
  });

  it('shares agent edits with MCP and lists only Workspace tasks with bounded cursors', async () => {
    const database = new NodeDatabase(':memory:', 'marctl-schedule-service');
    try {
      const workspace = database.saveWorkspace({
        path: '/marctl-schedule',
        kind: 'DIRECTORY',
        gitSummary: null
      });
      const foreign = database.saveWorkspace({
        path: '/marctl-other',
        kind: 'DIRECTORY',
        gitSummary: null
      });
      const sessions = [
        {
          id: 'first',
          externalSessionId: 'first',
          workspaceId: workspace.id,
          runner: 'codex',
          title: 'fixer#1'
        },
        {
          id: 'second',
          externalSessionId: 'second',
          workspaceId: workspace.id,
          runner: 'codex',
          title: 'fixer#2'
        },
        {
          id: 'foreign',
          externalSessionId: 'foreign',
          workspaceId: foreign.id,
          runner: 'codex',
          title: 'Foreign'
        }
      ];
      for (const session of sessions)
        database.saveNativeSessionMetadata({
          runner: 'codex',
          externalSessionId: session.id,
          workspaceId: session.workspaceId,
          customTitle: session.title
        });
      const proposed = vi.fn();
      const pending = {
        id: 'pending',
        externalSessionId: null as string | null,
        workspaceId: workspace.id,
        runner: 'codex',
        title: 'New Session'
      };
      const service = new SessionScheduleService({
        database: () => database,
        runtime: {
          getAgentSession: (id: string) =>
            id === 'pending' ? pending : sessions.find((session) => session.id === id),
          updateSessionMetadata: vi.fn()
        } as never,
        projection: {
          rename: async () => undefined,
          createMetadataProjection: async () => undefined
        } as never,
        emitSession: vi.fn(),
        proposed
      });
      const handlers = service.operations();
      const scope = { workspaceId: workspace.id, __requestUserId: 7 };
      const create = (sessionId: string, workspaceId = workspace.id) =>
        handlers['schedule.task.create']!({
          ...scope,
          workspaceId,
          target: { kind: 'existing', sessionId },
          name: 'Daily check',
          objective: 'Check tests',
          groups: dailyGroups('09:00')
        }) as Promise<{ task: { id: string } }>;
      const first = (await create('first')).task;
      const second = (await create('first')).task;
      await create('second');
      await create('foreign', foreign.id);
      expect(first.id).not.toBe(second.id);
      const list = handlers['schedule.task.list']!;
      const page = (await list({ ...scope, limit: 1 })) as {
        tasks: Array<{ id: string; sessionId: string; sessionTitle: string }>;
        nextCursor: string;
      };
      const next = (await list({ ...scope, limit: 2, cursor: page.nextCursor })) as typeof page;
      expect(page.tasks).toHaveLength(1);
      expect(page.tasks[0]).toMatchObject({
        targetKind: 'existing',
        objectivePreview: 'Check tests'
      });
      for (const field of ['objective', 'groups', 'newSession', 'revision'])
        expect(page.tasks[0]).not.toHaveProperty(field);
      expect(next.tasks).toHaveLength(2);
      expect(new Set([...page.tasks, ...next.tasks].map((task) => task.id)).size).toBe(3);
      expect([...page.tasks, ...next.tasks].map((task) => task.sessionTitle).sort()).toEqual([
        'fixer#1',
        'fixer#1',
        'fixer#2'
      ]);
      await expect(
        Promise.resolve().then(() => list({ workspaceId: foreign.id, cursor: page.nextCursor }))
      ).rejects.toThrow('SCHEDULE_INVALID');
      expect(await list({ ...scope, sessionId: 'first', offset: 0, limit: 0 })).toEqual({
        total: 2,
        tasks: []
      });
      expect(await list({ ...scope, offset: 1, limit: 2 })).toEqual({
        total: 3,
        tasks: next.tasks
      });
      await expect(
        Promise.resolve().then(() => list({ ...scope, offset: 0, cursor: page.nextCursor }))
      ).rejects.toThrow('SCHEDULE_INVALID');
      const update = handlers['schedule.task.propose']!;
      const taskScope = { ...scope, taskId: first.id };
      expect(
        await update({ ...taskScope, expectedRevision: 1, patch: { objective: 'Updated' } })
      ).toMatchObject({ task: { revision: 2, ownerUserId: 7, objective: 'Updated' } });
      await expect(
        update({ ...taskScope, expectedRevision: 1, patch: { objective: 'Stale' } })
      ).rejects.toThrow('SCHEDULE_REVISION_CONFLICT');
      expect(
        await update({
          ...taskScope,
          __requestUserId: 8,
          expectedRevision: 2,
          patch: { objective: 'Proposed' }
        })
      ).toMatchObject({ status: 'PENDING', proposalId: expect.any(String) });
      expect(proposed).toHaveBeenCalledWith(first.id, expect.any(String));
      expect(
        await service.invokeMcp(
          { actorUserId: 7, workspaceId: workspace.id, sessionId: 'first' },
          'get_scheduled_task',
          { taskId: first.id }
        )
      ).toMatchObject({ revision: 2, objective: 'Updated' });
      expect(await handlers['schedule.task.get']!({ ...scope, taskId: second.id })).toMatchObject({
        task: { revision: 1, ownerUserId: 7, objective: 'Check tests' },
        proposals: []
      });
      await expect(
        update({
          ...taskScope,
          workspaceId: foreign.id,
          expectedRevision: 2,
          patch: { objective: 'Wrong scope' }
        })
      ).rejects.toThrow('SCHEDULE_NOT_FOUND');
      expect(
        database.raw.prepare('SELECT COUNT(*) AS n FROM scheduled_session_proposals').get()
      ).toMatchObject({ n: 1 });
      await expect(create('pending', foreign.id)).rejects.toThrow('SESSION_NOT_FOUND');
      await expect(create('pending')).rejects.toThrow('SESSION_NOT_FOUND');
    } finally {
      database.close();
    }
  });

  it('returns bounded occurrence pages only for the requested Workspace session', async () => {
    let now = Date.parse('2025-01-01T00:00:00Z');
    const database = new NodeDatabase(':memory:', 'schedule-page-service', () => now);
    try {
      const workspace = database.saveWorkspace({
        path: '/schedule-page-service',
        kind: 'DIRECTORY',
        gitSummary: null
      });
      database.saveNativeSessionMetadata({
        runner: 'codex',
        externalSessionId: 'session-page',
        workspaceId: workspace.id
      });
      const session = {
        id: 'session-page',
        externalSessionId: 'session-page',
        workspaceId: workspace.id
      };
      const service = new SessionScheduleService({
        database: () => database,
        runtime: {
          getAgentSession: (id: string) => (id === session.id ? session : undefined)
        } as never,
        projection: { createMetadataProjection: async () => undefined } as never,
        emitSession: vi.fn()
      });
      const handlers = service.operations();
      const get = async (input: Record<string, unknown>) =>
        handlers['schedule.occurrence.list']!(input);
      const store = new ScheduledSessionStore(database.raw, () => now);
      const task = store.create({
        sessionId: session.id,
        workspaceId: workspace.id,
        runner: 'codex',
        ownerUserId: 1,
        objective: 'Check',
        name: 'Hourly check',
        groups: hourlyGroups,
        timezone: 'UTC'
      });
      const input = {
        taskId: task.id,
        sessionId: session.id,
        workspaceId: workspace.id,
        occurrencePage: 1
      };
      expect(await get(input)).toMatchObject({
        occurrences: [],
        occurrenceTotal: 0,
        occurrencePage: 1
      });
      for (let index = 0; index < 12; index++) {
        now = store.getById(task.id)!.nextRunAt!;
        store.finish(store.claim(task.id, now, task.revision)!, 'SUCCEEDED');
      }
      const first = (await get(input)) as { occurrences: unknown[] };
      expect(first.occurrences).toHaveLength(10);
      expect(first.occurrences[0]).toMatchObject({
        taskId: task.id,
        name: 'Hourly check',
        state: 'SUCCEEDED'
      });
      expect(JSON.stringify(first.occurrences)).not.toContain('objective');
      const browserScope = {
        workspaceId: workspace.id,
        sessionId: session.id,
        offset: 10,
        limit: 10
      };
      const browserTail = (await get(browserScope)) as { total: number; items: unknown[] };
      expect(browserTail.total).toBe(12);
      expect(browserTail.items).toHaveLength(2);
      expect(await get({ ...browserScope, offset: 12 })).toEqual({ total: 12, items: [] });
      expect(await get({ ...browserScope, sessionId: 'another-session' })).toEqual({
        total: 0,
        items: []
      });
      await expect(get({ ...browserScope, offset: -1 })).rejects.toThrow('SCHEDULE_INVALID');
      const last = (await get({ ...input, occurrencePage: 3 })) as { occurrences: unknown[] };
      expect(last).toMatchObject({ occurrenceTotal: 12, occurrencePage: 2 });
      expect(last.occurrences).toHaveLength(2);
      for (const page of [0, -1, 1.5, '2', null, Number.MAX_SAFE_INTEGER + 1])
        await expect(get({ ...input, occurrencePage: page })).rejects.toThrow('SCHEDULE_INVALID');
      await expect(get({ ...input, sessionId: 'another-session' })).resolves.toMatchObject({
        occurrences: [],
        occurrenceTotal: 0
      });
      await expect(get({ ...input, workspaceId: 'another-workspace' })).rejects.toThrow(
        'WORKSPACE_NOT_FOUND'
      );
    } finally {
      database.close();
    }
  });

  it('filters history by the trigger-time Session and keeps the marctl views minimal after rebind', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2025-01-01T00:00:00Z'));
    const database = new NodeDatabase(':memory:', 'schedule-scoped-history');
    try {
      const workspace = database.saveWorkspace({
        path: '/scoped-history',
        kind: 'DIRECTORY',
        gitSummary: null
      });
      const runtime = new Map(
        ['old-target', 'new-target'].map((id) => [
          id,
          {
            id,
            externalSessionId: id,
            workspaceId: workspace.id,
            runner: 'codex' as const
          }
        ])
      );
      for (const id of runtime.keys())
        database.saveNativeSessionMetadata({
          runner: 'codex',
          externalSessionId: id,
          workspaceId: workspace.id,
          pinned: true
        });
      const service = new SessionScheduleService({
        database: () => database,
        runtime: { getAgentSession: (id: string) => runtime.get(id) } as never,
        projection: {} as never,
        emitSession: vi.fn()
      });
      const ops = service.operations();
      const scope = { workspaceId: workspace.id, __requestUserId: 7 };
      const created = (await ops['schedule.task.create']!({
        ...scope,
        view: 'marctl',
        target: { kind: 'existing', sessionId: 'old-target' },
        name: 'Keep time',
        objective: 'Original private objective',
        groups: hourlyGroups
      })) as { taskId: string; nextRunAt: number };
      expect(created).toEqual({
        view: 'marctl',
        taskId: expect.any(String),
        revision: 1,
        nextRunAt: expect.any(Number),
        timezone: expect.any(String)
      });
      const taskId = created.taskId;
      const store = new ScheduledSessionStore(database.raw);
      vi.setSystemTime(created.nextRunAt);
      const id = store.claim(taskId, created.nextRunAt, 1)!;
      store.beginSubmission(id, 'old-target');
      store.finish(id, 'SUCCEEDED', undefined, 'old-run');
      await ops['schedule.task.update']!({
        ...scope,
        taskId,
        expectedRevision: 1,
        patch: {
          target: { kind: 'existing', sessionId: 'new-target' },
          objective: 'Current private objective'
        }
      });
      const oldHistory = await ops['schedule.occurrence.list']!({
        ...scope,
        taskId,
        sessionId: 'old-target'
      });
      expect(oldHistory).toMatchObject({
        items: [{ occurrenceId: id, run: { runId: 'old-run', sessionId: 'old-target' } }]
      });
      expect(
        await ops['schedule.occurrence.list']!({ ...scope, taskId, sessionId: 'new-target' })
      ).toEqual({ total: 0, items: [] });
      await expect(
        Promise.resolve().then(() =>
          ops['schedule.occurrence.get']!({ ...scope, occurrenceId: id, sessionId: 'new-target' })
        )
      ).rejects.toThrow('SCHEDULE_NOT_FOUND');
      expect(
        await ops['schedule.task.list']!({ ...scope, view: 'marctl', sessionId: 'old-target' })
      ).toEqual({ view: 'marctl', tasks: [], nextCursor: null });
      expect(
        await ops['schedule.task.list']!({ ...scope, view: 'marctl', sessionId: 'new-target' })
      ).toEqual({
        view: 'marctl',
        tasks: [
          {
            taskId,
            name: 'Keep time',
            revision: 2,
            nextRunAt: expect.any(Number),
            state: 'SCHEDULED'
          }
        ],
        nextCursor: null
      });
      expect(await ops['schedule.task.get']!({ ...scope, view: 'marctl', taskId })).toEqual({
        view: 'marctl',
        task: {
          taskId,
          name: 'Keep time',
          revision: 2,
          nextRunAt: expect.any(Number),
          state: 'SCHEDULED',
          objective: 'Current private objective',
          groups: hourlyGroups,
          timezone: expect.any(String)
        }
      });
      expect(await ops['schedule.occurrence.list']!({ ...scope, taskId, view: 'marctl' })).toEqual({
        view: 'marctl',
        occurrencePage: 1,
        occurrenceTotal: 1,
        occurrences: [{ dueAt: created.nextRunAt, state: 'SUCCEEDED', runId: 'old-run' }]
      });
      const proposal = await ops['schedule.task.propose']!({
        ...scope,
        __requestUserId: 11,
        view: 'marctl',
        taskId,
        expectedRevision: 2,
        patch: { objective: 'Proposed' }
      });
      expect(proposal).toEqual({ view: 'marctl', proposalId: expect.any(String), baseRevision: 2 });
      expect(store.getById(taskId)).toMatchObject({ ownerUserId: 7, revision: 2 });
      expect(store.historyDetail(workspace.id, id)?.snapshot).toMatchObject({
        objective: 'Original private objective'
      });
    } finally {
      database.close();
    }
  });

  it('creates a task from a new conversation after its native session ID is ready', async () => {
    const database = new NodeDatabase(':memory:', 'node-schedule-new-conversation');
    const workspace = database.saveWorkspace({
      path: '/workspace/schedule-new-conversation',
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
        claudeCode: { available: false }
      }
    });
    const internals = connector as unknown as {
      runtime: NodeRuntimeState;
      sessionIdentityService: {
        wait(sessionId: string): Promise<string>;
        promote(sessionId: string, nativeSessionId: string): void;
      };
      scheduleMcpBridge: ScheduleMcpBridge;
    };
    let pool: MarAgentMcpClientPool | undefined;
    try {
      const session = internals.runtime.createAgentSession({
        workspaceId: workspace.id,
        runner: 'claude-code',
        cwd: workspace.path,
        modelId: 'sonnet',
        effort: 'medium',
        access: 'full-access'
      });
      const run = internals.runtime.createMessageRun({
        sessionId: session.id,
        clientMessageId: 'bootstrap',
        content: 'Configure a schedule',
        initiatedByUserId: 7
      }).run;
      const execution = internals.runtime.createExecution(run.id);
      const descriptor = await internals.scheduleMcpBridge.prepare({
        sessionId: session.id,
        executionId: execution.id,
        workspaceId: workspace.id,
        actorUserId: 7
      });
      pool = await MarAgentMcpClientPool.connect([descriptor], process.cwd());
      const wait = vi.spyOn(internals.sessionIdentityService, 'wait');
      const creating = pool.call('mcp__mar_schedule__create_scheduled_task', {
        name: 'Review',
        objective: 'Review every day',
        groups: dailyGroups('09:00')
      });
      await vi.waitFor(() => expect(wait).toHaveBeenCalledWith(session.id));
      internals.sessionIdentityService.promote(session.id, 'native-new-session');
      await expect(creating).resolves.toMatchObject({ content: expect.stringContaining('taskId') });
      const store = new ScheduledSessionStore(database.raw);
      expect(store.list(workspace.id, undefined, 10, 'native-new-session').tasks).toEqual([
        expect.objectContaining({ ownerUserId: 7, objective: 'Review every day' })
      ]);
    } finally {
      await pool?.close();
      await connector.stop();
    }
  });

  it.each([
    'denied',
    'changed',
    'paused-during-preparation',
    'edited-during-preparation',
    'accepted'
  ] as const)(
    'authorizes and launches a new-session target only for the still-current occurrence (%s)',
    async (outcome) => {
      const directory = await realpath(await mkdtemp(join(tmpdir(), 'schedule-bootstrap-')));
      temporaryDirectories.push(directory);
      vi.useFakeTimers();
      vi.setSystemTime(Date.parse('2025-01-01T00:00:00Z'));
      const database = new NodeDatabase(':memory:', 'schedule-bootstrap');
      const workspace = database.saveWorkspace({
        path: directory,
        kind: 'DIRECTORY',
        gitSummary: null
      });
      const defaults = (modelId: string) => ({
        runner: 'claude-code' as const,
        modelId,
        effort: 'medium',
        access: 'default'
      });
      database.saveRunnerDefaults(defaults('before-saving'));
      const startChannel = vi.fn((input: { onMessage(message: unknown): void }) => ({
        completed: new Promise<void>((resolve) =>
          setTimeout(() => {
            input.onMessage({ type: 'system', subtype: 'init', session_id: 'promoted-scheduled' });
            resolve();
          }, 5)
        ),
        deliver: async () => undefined,
        interrupt: async () => undefined,
        cancel: () => undefined
      }));
      const connector = new NodeConnector({
        database,
        reconnect: false,
        claudeClient: { startChannel } as never,
        capabilities: {
          platform: 'linux',
          architecture: 'x64',
          nodeVersion: process.version,
          codex: { available: false },
          claudeCode: { available: true }
        }
      });
      const node = connector as unknown as {
        capabilities: { scheduledTasks?: { apiVersion: number } };
        controlChannel: { connected(): boolean };
        gitOperationService: GitOperationService;
        executeNodeOperation(operation: string, data: unknown): Promise<unknown>;
        emitWorkbenchEvent(category: string, payload: unknown): void;
        scheduledSessions: ScheduledSessionCoordinator;
        scheduledRunAuthorization: {
          authorize(input: {
            sessionId: string;
          }): Promise<{ secretEnvironment: Record<string, string> }>;
        };
        runtime: NodeRuntimeState;
      };
      try {
        const events = vi.spyOn(node, 'emitWorkbenchEvent');
        expect(node.capabilities.scheduledTasks).toEqual({ apiVersion: 1 });
        const scope = { workspaceId: workspace.id, __requestUserId: 17 };
        const { task } = (await node.executeNodeOperation('schedule.task.create', {
          ...scope,
          target: {
            kind: 'newSession',
            runner: 'claude-code',
            model: { kind: 'default' },
            effort: 'high'
          },
          name: 'New every hour',
          objective: 'This is the first and only message',
          notifyOnTerminal: true,
          groups: hourlyGroups
        })) as { task: { id: string; nextRunAt: number } };
        expect(startChannel).not.toHaveBeenCalled();
        expect(events).toHaveBeenCalledExactlyOnceWith('workspace', {
          workspaceId: workspace.id,
          topic: 'schedule.changed'
        });
        database.saveRunnerDefaults(defaults('at-trigger-model'));
        const changed = outcome !== 'denied' && outcome !== 'accepted';
        const update = (patch: { enabled: false } | { objective: string }) =>
          node.executeNodeOperation('schedule.task.update', {
            ...scope,
            taskId: task.id,
            expectedRevision: 1,
            patch
          });
        let bootstrapId = '';
        const authorize = vi
          .spyOn(node.scheduledRunAuthorization, 'authorize')
          .mockImplementation(async (request) => {
            bootstrapId = request.sessionId;
            expect(node.runtime.getAgentSession(bootstrapId)?.externalSessionId).toBeNull();
            expect(database.getSessionRecord(bootstrapId)).toBeUndefined();
            expect(startChannel).not.toHaveBeenCalled();
            if (outcome === 'denied') throw new Error('WORKSPACE_ACCESS_DENIED');
            if (outcome === 'changed') await update({ enabled: false });
            return { secretEnvironment: {} };
          });
        if (outcome === 'paused-during-preparation' || outcome === 'edited-during-preparation') {
          const execute = node.gitOperationService.execute.bind(node.gitOperationService);
          vi.spyOn(node.gitOperationService, 'execute').mockImplementation(
            async (operation, input, next) => {
              if (operation === 'session.message') {
                expect(new ScheduledSessionStore(database.raw).recent(task.id)[0]?.status).toBe(
                  'CLAIMED'
                );
                await update(
                  outcome === 'paused-during-preparation'
                    ? { enabled: false }
                    : { objective: 'Edited during preparation' }
                );
              }
              return execute(operation, input, next);
            }
          );
        }
        vi.spyOn(node.controlChannel, 'connected').mockReturnValue(true);
        node.scheduledSessions.start();
        await vi.advanceTimersByTimeAsync(task.nextRunAt - Date.now());
        const store = new ScheduledSessionStore(database.raw);
        const occurrenceId = `${task.id}:${task.nextRunAt}`;
        const detail = () => store.historyDetail(workspace.id, occurrenceId);
        await vi.waitFor(() =>
          expect(detail()).toMatchObject(
            outcome === 'accepted'
              ? {
                  state: 'SUCCEEDED',
                  run: { sessionId: 'promoted-scheduled', runId: expect.any(String) },
                  startedAt: expect.any(Number),
                  endedAt: expect.any(Number)
                }
              : {
                  state: 'SKIPPED',
                  reason:
                    outcome === 'denied' ? 'WORKSPACE_ACCESS_DENIED' : 'SCHEDULE_TASK_CHANGED',
                  run: null,
                  startedAt: null,
                  endedAt: null
                }
          )
        );
        expect(authorize).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            targetKind: 'newSession',
            taskId: task.id,
            revision: 1,
            occurrenceId,
            workspaceId: workspace.id,
            ownerUserId: 17,
            sessionId: bootstrapId,
            runner: 'claude-code',
            modelId: 'at-trigger-model'
          })
        );
        expect(database.getSessionRecord(bootstrapId)).toBeUndefined();
        expect(database.getRunnerDefaults()).toEqual([defaults('at-trigger-model')]);
        expect(detail()?.snapshot).toMatchObject({
          objective: 'This is the first and only message',
          matchedGroups: [0]
        });
        const changes = events.mock.calls.filter(([category]) => category === 'workspace');
        const taskChanges = [
          { workspaceId: workspace.id, topic: 'schedule.changed' }, // Create
          { workspaceId: workspace.id, topic: 'schedule.changed' }, // Claim advances the cursor
          ...(changed ? [{ workspaceId: workspace.id, topic: 'schedule.changed' }] : []) // Edit or pause
        ];
        expect(
          changes.filter(
            ([, payload]) => (payload as { topic: string }).topic === 'schedule.changed'
          )
        ).toEqual(taskChanges.map((payload) => ['workspace', payload]));
        expect(changes).toContainEqual([
          'workspace',
          { workspaceId: workspace.id, topic: 'schedule.occurrence.changed' }
        ]);
        if (outcome === 'accepted') {
          expect(
            events.mock.calls.filter(
              ([category, payload]) =>
                category === 'conversation' &&
                (payload as { event?: { payload?: { kind?: string } } }).event?.payload?.kind ===
                  'SCHEDULE_TERMINAL'
            )
          ).toEqual([
            [
              'conversation',
              expect.objectContaining({
                event: expect.objectContaining({
                  eventType: 'notification',
                  payload: expect.objectContaining({
                    targetType: 'WORKSPACE_SESSION',
                    userId: 17,
                    sessionId: 'promoted-scheduled',
                    outcome: 'SUCCEEDED'
                  })
                })
              })
            ]
          ]);
          expect(startChannel).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
              model: 'at-trigger-model',
              effort: 'high',
              prompt: serializeComposerTag('mar_schedule', {
                objective: 'This is the first and only message'
              })
            })
          );
          expect(startChannel.mock.calls[0]![0]).not.toHaveProperty('resumeSessionId');
          expect(database.getSessionRecord('promoted-scheduled')?.workspaceId).toBe(workspace.id);
          expect(
            database.getNativeSessionMetadata('claude-code', 'promoted-scheduled', workspace.id)
              ?.pinOrder
          ).toBeNull();
        } else {
          expect(node.runtime.getAgentSession(bootstrapId)).toBeUndefined();
          expect(startChannel).not.toHaveBeenCalled();
          expect(events).toHaveBeenCalledWith(
            'conversation',
            expect.objectContaining({
              event: expect.objectContaining({
                eventType: 'notification',
                payload: expect.objectContaining({
                  targetType: 'SCHEDULED_TASK',
                  workspaceId: workspace.id,
                  taskId: task.id,
                  taskName: 'New every hour',
                  userId: 17,
                  kind: 'SCHEDULE_SKIPPED',
                  reference: { kind: 'occurrence', id: expect.any(String) },
                  code: outcome === 'denied' ? 'WORKSPACE_ACCESS_DENIED' : 'SCHEDULE_TASK_CHANGED'
                })
              })
            })
          );
        }
        events.mockClear();
        await node.executeNodeOperation('schedule.task.propose', {
          workspaceId: workspace.id,
          __requestUserId: 42,
          taskId: task.id,
          expectedRevision: changed ? 2 : 1,
          patch: { objective: 'Proposed change' }
        });
        expect(events).toHaveBeenCalledWith(
          'conversation',
          expect.objectContaining({
            event: expect.objectContaining({
              eventType: 'notification',
              payload: expect.objectContaining({
                targetType: 'SCHEDULED_TASK',
                workspaceId: workspace.id,
                taskId: task.id,
                taskName: 'New every hour',
                userId: 17,
                kind: 'SCHEDULE_PROPOSAL',
                reference: { kind: 'proposal', id: expect.any(String) }
              })
            })
          })
        );
      } finally {
        await connector.stop();
      }
    }
  );

  it('starts the saved objective in the existing Claude Code session and permits schedule edits', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'schedule-success-')));
    temporaryDirectories.push(directory);
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2025-01-01T00:00:00Z'));
    const database = new NodeDatabase(':memory:', 'node-schedule-success', Date.now);
    const workspace = database.saveWorkspace({
      path: directory,
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const prompts: string[] = [];
    const startedConfigurations: {
      readonly model?: string;
      readonly effort?: string;
      readonly access?: string;
    }[] = [];
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
        startChannel(input: { prompt: string; model?: string; effort?: string; access?: string }) {
          prompts.push(input.prompt);
          startedConfigurations.push(input);
          return {
            completed: new Promise<void>(() => undefined),
            deliver: async () => undefined,
            interrupt: async () => undefined,
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
      runtime: {
        createAgentSession(input: Record<string, unknown>): { id: string };
        getRun(runId: string): import('../../src/runtime-model.js').NodeAgentRun | undefined;
      };
      claudeClient: { execution: { managedNativeIds: Set<string> } };
      runners: RunnerRegistry;
      runEventService: {
        options: {
          onTerminalRun(
            run: import('../../src/runtime-model.js').NodeAgentRun,
            status: 'SUCCEEDED',
            at: number
          ): void;
        };
      };
      emitWorkbenchEvent: (category: string, payload: unknown) => void;
      controlChannel: { connected(): boolean };
      scheduledRunAuthorization: { authorize: (input: unknown) => Promise<unknown> };
      scheduledSessions: { start(): void; stop(): void };
      scheduleMcpBridge: ScheduleMcpBridge;
      executeNodeOperation(operation: string, input: unknown): Promise<unknown>;
    };
    const preparedSchedule = vi.spyOn(internals.scheduleMcpBridge, 'prepare');
    let scheduleTools: MarAgentMcpClientPool | undefined;
    try {
      vi.spyOn(internals.runners.require('claude-code'), 'discoverSessions').mockResolvedValue([]);
      const session = internals.runtime.createAgentSession({
        workspaceId: workspace.id,
        runner: 'claude-code',
        externalSessionId: 'claude-session',
        nativeControl: 'MAR_MANAGED',
        cwd: workspace.path,
        modelId: 'sonnet'
      });
      internals.claudeClient.execution.managedNativeIds.add(session.id);
      const created = (await internals.executeNodeOperation('schedule.task.create', {
        target: { kind: 'existing', sessionId: session.id },
        workspaceId: workspace.id,
        __requestUserId: 7,
        objective: 'Review changes',
        name: 'Hourly check',
        groups: hourlyGroups,
        enabled: true
      })) as { task: { id: string } };
      internals.scheduledRunAuthorization.authorize = vi.fn(async () => ({
        secretEnvironment: {}
      }));
      vi.spyOn(internals.controlChannel, 'connected').mockReturnValue(true);
      internals.scheduledSessions.start();
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      await vi.waitFor(() =>
        expect(prompts).toContain(
          serializeComposerTag('mar_schedule', { objective: 'Review changes' })
        )
      );
      expect(startedConfigurations[0]).toMatchObject({
        model: 'sonnet',
        effort: 'medium',
        access: 'default'
      });
      const descriptor = await preparedSchedule.mock.results[0]!.value;
      scheduleTools = await MarAgentMcpClientPool.connect([descriptor], process.cwd());
      expect(scheduleTools.catalog().tools.map((tool) => tool.rawName)).toEqual(
        expect.arrayContaining([
          'get_scheduled_task',
          'create_scheduled_task',
          'update_scheduled_task'
        ])
      );
      expect(
        (
          await scheduleTools.call('mcp__mar_schedule__update_scheduled_task', {
            taskId: created.task.id,
            expectedRevision: 1,
            patch: { objective: 'Review follow-up changes' }
          })
        ).content
      ).toContain('"revision":2');
      const store = new ScheduledSessionStore(database.raw);
      const task = store.getById(created.task.id)!;
      expect(task).toMatchObject({
        objective: 'Review follow-up changes',
        ownerUserId: 7,
        revision: 2
      });
      const occurrence = store.recent(task.id)[0]!;
      expect(occurrence).toMatchObject({ status: 'SUBMITTED' });
      expect(internals.runtime.getRun(occurrence['run_id'] as string)?.source).toBe('SCHEDULED');
      const notifications = vi.spyOn(internals, 'emitWorkbenchEvent');
      const edited = (await internals.executeNodeOperation('schedule.task.update', {
        taskId: task.id,
        workspaceId: workspace.id,
        __requestUserId: 7,
        expectedRevision: task.revision,
        patch: { notifyOnTerminal: true }
      })) as { task: { ownerUserId: number; notifyOnTerminal: boolean } };
      expect(edited.task).toMatchObject({
        ownerUserId: 7,
        notifyOnTerminal: true
      });
      internals.runEventService.options.onTerminalRun(
        internals.runtime.getRun(occurrence['run_id'] as string)!,
        'SUCCEEDED',
        Date.now()
      );
      expect(store.recent(task.id)[0]).toMatchObject({ status: 'SUCCEEDED' });
      expect(
        notifications.mock.calls.filter(
          ([category, payload]) =>
            category === 'conversation' && JSON.stringify(payload).includes('SCHEDULE_TERMINAL')
        )
      ).toEqual([
        [
          'conversation',
          expect.objectContaining({
            event: expect.objectContaining({
              payload: expect.objectContaining({ userId: 7, outcome: 'SUCCEEDED' })
            })
          })
        ]
      ]);
    } finally {
      internals.scheduledSessions.stop();
      await scheduleTools?.close();
      await connector.stop();
    }
  });

  it.each([
    ['Runner start', false],
    ['Runner start', true],
    ['input preparation', false],
    ['input preparation', true]
  ] as const)(
    'pins a session and records a scheduled message and %s failure (terminal notifications: %s)',
    async (failureStage, notifyOnTerminal) => {
      const failDuringInputPreparation = failureStage === 'input preparation';
      const directory = await realpath(await mkdtemp(join(tmpdir(), 'schedule-failure-')));
      temporaryDirectories.push(directory);
      vi.useFakeTimers();
      vi.setSystemTime(Date.parse('2025-01-01T00:00:00Z'));
      const database = new NodeDatabase(':memory:', 'node-schedule-flow', Date.now);
      const workspace = database.saveWorkspace({
        path: directory,
        kind: 'DIRECTORY',
        gitSummary: null
      });
      const startChannel = vi.fn(() => {
        throw new Error('CLAUDE_RUN_START_FAILED');
      });
      const connector = new NodeConnector({
        reconnect: false,
        database,
        capabilities: {
          platform: 'linux',
          architecture: 'x64',
          nodeVersion: process.version,
          codex: { available: false },
          claudeCode: { available: true }
        },
        claudeClient: { startChannel } as never
      });
      const internals = connector as unknown as {
        runtime: {
          createAgentSession(input: Record<string, unknown>): { id: string };
          conversationTurnForRun(
            runId: string
          ): { items: readonly { kind: string; payload: Record<string, unknown> }[] } | undefined;
          getRun(
            runId: string
          ): { id: string; source?: string; initiatedByUserId?: number } | undefined;
        };
        claudeClient: { execution: { managedNativeIds: Set<string> } };
        runners: {
          require(name: string): {
            prepareMessageInput(input: string, mode: string): string;
            discoverSessions(): Promise<readonly unknown[]>;
          };
        };
        runEventBridge: { emitRun: (...args: unknown[]) => unknown };
        emitWorkbenchEvent: (category: string, payload: unknown) => void;
        controlChannel: { connected(): boolean };
        scheduledRunAuthorization: { authorize: (input: unknown) => Promise<unknown> };
        scheduledSessions: { start(): void; stop(): Promise<void> | undefined };
        executeNodeOperation(operation: string, input: unknown): Promise<unknown>;
      };
      try {
        const observedRuns: {
          id: string;
          source?: string;
          initiatedByUserId?: number;
        }[] = [];
        const getRun = internals.runtime.getRun.bind(internals.runtime);
        vi.spyOn(internals.runtime, 'getRun').mockImplementation((runId) => {
          const run = getRun(runId);
          if (run !== undefined) observedRuns.push(run);
          return run;
        });
        vi.spyOn(internals.runners.require('claude-code'), 'discoverSessions').mockResolvedValue(
          []
        );
        const emitted = vi.spyOn(internals.runEventBridge, 'emitRun');
        const workbench = vi.spyOn(internals, 'emitWorkbenchEvent');
        const prepared = vi.spyOn(internals.runners.require('claude-code'), 'prepareMessageInput');
        if (failDuringInputPreparation)
          prepared.mockImplementation(() => {
            throw new Error('SCHEDULE_INPUT_PREPARATION_FAILED');
          });
        const session = internals.runtime.createAgentSession({
          workspaceId: workspace.id,
          runner: 'claude-code',
          externalSessionId: 'session-1',
          nativeControl: 'MAR_MANAGED',
          cwd: workspace.path,
          modelId: 'sonnet',
          access: 'full'
        });
        internals.claudeClient.execution.managedNativeIds.add(session.id);
        const saved = (await internals.executeNodeOperation('schedule.task.create', {
          target: { kind: 'existing', sessionId: session.id },
          workspaceId: workspace.id,
          __requestUserId: 7,
          objective: 'Inspect the repository',
          name: 'Hourly check',
          groups: hourlyGroups,
          enabled: true
        })) as {
          task: { readonly id: string; readonly nextRunAt: number; readonly timezone: string };
        };
        expect(saved.task.nextRunAt).toBe(Date.parse('2025-01-01T01:00:00Z'));
        expect(saved.task.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
        expect(
          database.getNativeSessionMetadata('claude-code', session.id, workspace.id)?.pinOrder
        ).toBe(0);
        if (notifyOnTerminal)
          await internals.executeNodeOperation('schedule.task.update', {
            taskId: saved.task.id,
            workspaceId: workspace.id,
            __requestUserId: 7,
            expectedRevision: 1,
            patch: { notifyOnTerminal: true }
          });
        internals.scheduledRunAuthorization.authorize = vi.fn(async () => ({
          secretEnvironment: {}
        }));
        vi.spyOn(internals.controlChannel, 'connected').mockReturnValue(true);
        internals.scheduledSessions.start();
        await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
        const task = new ScheduledSessionStore(database.raw).getById(saved.task.id)!;
        let submittedRunId: string | undefined;
        if (!failDuringInputPreparation) {
          await vi.waitFor(
            () =>
              expect(new ScheduledSessionStore(database.raw).recent(task.id)[0]).toMatchObject({
                status: 'SUBMITTED'
              }),
            { interval: 1 }
          );
          const submitted = new ScheduledSessionStore(database.raw).recent(task.id)[0]!;
          submittedRunId = submitted['run_id'] as string;
          expect(observedRuns.find((run) => run.id === submittedRunId)).toMatchObject({
            source: 'SCHEDULED',
            initiatedByUserId: 7
          });
          expect(
            internals.runtime
              .conversationTurnForRun(submittedRunId)
              ?.items.find((item) => item.kind === 'user_message')?.payload
          ).toMatchObject({ text: 'Inspect the repository', source: 'SCHEDULED' });
        }
        const terminalEvent = failDuringInputPreparation ? 'run.rejected' : 'run.failed';
        await vi.waitFor(
          () => expect(emitted.mock.calls.some((call) => call[1] === terminalEvent)).toBe(true),
          { interval: 1 }
        );
        await internals.scheduledSessions.stop();
        await vi.waitFor(
          () =>
            expect(new ScheduledSessionStore(database.raw).recent(task.id)[0]).toMatchObject({
              status: 'FAILED'
            }),
          { interval: 1 }
        );
        const occurrence = new ScheduledSessionStore(database.raw).recent(task.id)[0]!;
        expect(internals.scheduledRunAuthorization.authorize).toHaveBeenCalledWith(
          expect.objectContaining({ ownerUserId: 7 })
        );
        expect(prepared).toHaveBeenCalledWith(
          serializeComposerTag('mar_schedule', { objective: 'Inspect the repository' }),
          'default'
        );
        if (failDuringInputPreparation) {
          expect(occurrence).toMatchObject({ status: 'FAILED' });
          expect(startChannel).not.toHaveBeenCalled();
          expect(emitted.mock.calls.find((call) => call[1] === 'run.rejected')).toBeDefined();
        } else {
          const runId = submittedRunId!;
          expect(occurrence).toMatchObject({ status: 'FAILED', run_id: runId });
          expect(startChannel).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ cwd: directory, resumeSessionId: session.id })
          );
          expect(emitted.mock.calls.find((call) => call[1] === 'run.failed')?.[2]).toMatchObject({
            code: 'CLAUDE_RUN_START_FAILED'
          });
        }
        const notifications = workbench.mock.calls
          .filter(
            ([category, payload]) =>
              category === 'conversation' &&
              (JSON.stringify(payload).includes('SCHEDULE_FAILED') ||
                JSON.stringify(payload).includes('SCHEDULE_TERMINAL'))
          )
          .map(
            ([, payload]) =>
              (payload as { event: { payload: Record<string, unknown> } }).event.payload
          );
        expect(notifications).toEqual(
          notifyOnTerminal
            ? [expect.objectContaining({ userId: 7, kind: 'SCHEDULE_TERMINAL' })]
            : []
        );
      } finally {
        internals.scheduledSessions.stop();
        await connector.stop();
      }
    }
  );
});
