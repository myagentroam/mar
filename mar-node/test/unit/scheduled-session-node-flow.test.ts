import { serializeComposerTag } from '@myagentroam/protocol';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
import type { ScheduledSessionCoordinator } from '../../src/service/scheduled-session-coordinator.js';

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
          cron: '0 * * * *',
          timezone: 'UTC'
        });
        const dueAt = task.nextRunAt!;
        vi.setSystemTime(dueAt + offset);
        const service = new SessionScheduleService({
          database: () => database,
          runtime: { getAgentSession: () => session } as never,
          projection: {} as never,
          present: (value) => value,
          emitSession: vi.fn(),
          awaitNativeSessionId: async () => session.id
        });
        const save = service.operations()['session.schedule.save']!;
        const scope = { sessionId: session.id, workspaceId: workspace.id, __requestUserId: 2 };
        await save({
          ...scope,
          expectedRevision: task.revision,
          objective: 'Updated',
          cron: task.cron,
          enabled: true,
          notifyOnTerminal: true
        });
        expect(store.get(session.id)).toMatchObject({
          nextRunAt: dueAt,
          revision: 2,
          objective: 'Updated',
          ownerUserId: 2,
          notifyOnTerminal: true
        });
        await save({ ...scope, expectedRevision: 2, objective: 'Partial edit' });
        expect(store.get(session.id)).toMatchObject({ nextRunAt: dueAt, revision: 3 });
        vi.setSystemTime(dueAt + 1000);
        expect(store.listDue(Date.now()).map((entry) => entry.sessionId)).toEqual([session.id]);
        const occurrenceId = store.claim(session.id, dueAt, 3);
        expect(occurrenceId).toBe(`${task.id}:${dueAt}`);
        expect(store.claim(session.id, dueAt, 3)).toBeUndefined();
        expect(store.recent(task.id)).toHaveLength(1);
        expect(store.get(session.id)?.nextRunAt).toBe(dueAt + 3_600_000);
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
        model: 'claude-sonnet',
        access: 'full'
      });
      await internals.executeNodeOperation('session.schedule.save', {
        sessionId: session.id,
        workspaceId: workspace.id,
        __requestUserId: 7,
        objective: 'Inspect the repository',
        cron: '0 * * * *',
        enabled: true
      });
      const store = new ScheduledSessionStore(database.raw);
      const task = store.get(session.id)!;
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
      const awaitNativeSessionId = vi.fn(async () => {
        pending.id = 'promoted';
        pending.externalSessionId = 'promoted';
        database.saveNativeSessionMetadata({
          runner: 'codex',
          externalSessionId: 'promoted',
          workspaceId: workspace.id,
          customTitle: pending.title
        });
        return 'promoted';
      });
      const service = new SessionScheduleService({
        database: () => database,
        runtime: {
          getAgentSession: (id: string) =>
            id === 'pending' || id === pending.externalSessionId
              ? pending
              : sessions.find((session) => session.id === id),
          updateSessionMetadata: vi.fn()
        } as never,
        projection: { rename: async () => undefined } as never,
        present: (session) => session,
        emitSession: vi.fn(),
        awaitNativeSessionId,
        proposed
      });
      const handlers = service.operations();
      const first = { sessionId: 'first', workspaceId: workspace.id, __requestUserId: 7 };
      const create = (scope: Record<string, unknown>) =>
        handlers['session.schedule.agent.save']!({
          ...scope,
          mode: 'create',
          objective: 'Check tests',
          cron: '0 9 * * *'
        });
      for (const session of sessions)
        await create({ ...first, sessionId: session.id, workspaceId: session.workspaceId });
      await expect(create(first)).rejects.toThrow('SCHEDULE_ALREADY_EXISTS');
      const page = (await handlers['session.schedule.list']!({
        workspaceId: workspace.id,
        limit: 1
      })) as { tasks: Array<{ sessionId: string; sessionTitle: string }>; nextCursor: string };
      const next = (await handlers['session.schedule.list']!({
        workspaceId: workspace.id,
        limit: 1,
        cursor: page.nextCursor
      })) as typeof page;
      expect(page.tasks).toHaveLength(1);
      expect(next.tasks).toHaveLength(1);
      expect(new Set([...page.tasks, ...next.tasks].map((task) => task.sessionId))).toEqual(
        new Set(['first', 'second'])
      );
      expect([...page.tasks, ...next.tasks].map((task) => task.sessionTitle).sort()).toEqual([
        'fixer#1',
        'fixer#2'
      ]);
      await expect(
        Promise.resolve().then(() =>
          handlers['session.schedule.list']!({ workspaceId: foreign.id, cursor: page.nextCursor })
        )
      ).rejects.toThrow('SCHEDULE_INVALID');
      const updated = await handlers['session.schedule.agent.save']!({
        ...first,
        mode: 'update',
        expectedRevision: 1,
        objective: 'Updated'
      });
      expect(updated).toMatchObject({
        task: { revision: 2, ownerUserId: 7, objective: 'Updated' }
      });
      await expect(
        handlers['session.schedule.agent.save']!({
          ...first,
          mode: 'update',
          expectedRevision: 1,
          objective: 'Stale'
        })
      ).rejects.toThrow('SCHEDULE_REVISION_CONFLICT');
      const proposal = await handlers['session.schedule.agent.save']!({
        ...first,
        __requestUserId: 8,
        mode: 'update',
        expectedRevision: 2,
        objective: 'Proposed'
      });
      expect(proposal).toMatchObject({ status: 'PENDING', proposalId: expect.any(String) });
      expect(proposed).toHaveBeenCalledWith('first', expect.any(String));
      expect(await handlers['session.schedule.get']!(first)).toMatchObject({
        task: { revision: 2, ownerUserId: 7, objective: 'Updated' }
      });
      await expect(
        handlers['session.schedule.agent.save']!({
          ...first,
          workspaceId: foreign.id,
          mode: 'update',
          expectedRevision: 2,
          objective: 'Wrong scope'
        })
      ).rejects.toThrow('SESSION_NOT_FOUND');
      expect(
        database.raw.prepare('SELECT COUNT(*) AS n FROM scheduled_session_proposals').get()
      ).toMatchObject({ n: 1 });
      await expect(
        create({ ...first, sessionId: 'pending', workspaceId: foreign.id })
      ).rejects.toThrow('SESSION_NOT_FOUND');
      expect(awaitNativeSessionId).not.toHaveBeenCalled();
      await expect(create({ ...first, sessionId: 'pending' })).resolves.toMatchObject({
        task: { sessionId: 'promoted', ownerUserId: 7, revision: 1 }
      });
      expect(awaitNativeSessionId).toHaveBeenCalledWith('pending');
      expect(new ScheduledSessionStore(database.raw).get('pending')).toBeUndefined();
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
        present: vi.fn(),
        emitSession: vi.fn(),
        awaitNativeSessionId: vi.fn()
      });
      const get = service.operations()['session.schedule.get']!;
      const input = { sessionId: session.id, workspaceId: workspace.id };
      expect(await get(input)).toMatchObject({
        task: null,
        occurrences: [],
        occurrenceTotal: 0,
        occurrencePage: 1
      });
      const store = new ScheduledSessionStore(database.raw, () => now);
      const task = store.create({
        sessionId: session.id,
        workspaceId: workspace.id,
        runner: 'codex',
        ownerUserId: 1,
        objective: 'Check',
        cron: '0 * * * *',
        timezone: 'UTC'
      });
      for (let index = 0; index < 12; index++) {
        now = store.get(task.sessionId)!.nextRunAt!;
        store.finish(store.claim(task.sessionId, now, task.revision)!, 'SUCCEEDED');
      }
      const first = (await get(input)) as { occurrences: unknown[] };
      expect(first.occurrences).toHaveLength(10);
      const last = (await get({ ...input, occurrencePage: 3 })) as { occurrences: unknown[] };
      expect(last).toMatchObject({ occurrenceTotal: 12, occurrencePage: 2 });
      expect(last.occurrences).toHaveLength(2);
      for (const page of [0, -1, 1.5, '2', null, Number.MAX_SAFE_INTEGER + 1])
        await expect(get({ ...input, occurrencePage: page })).rejects.toThrow('SCHEDULE_INVALID');
      await expect(get({ ...input, workspaceId: 'another-workspace' })).rejects.toThrow(
        'SESSION_NOT_FOUND'
      );
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
      runtime: { createAgentSession(input: Record<string, unknown>): { id: string } };
      sessionIdentityService: { promote(sessionId: string, nativeSessionId: string): void };
      sessionScheduleService: {
        createFromMcp(input: {
          sessionId: string;
          workspaceId: string;
          actorUserId: number;
          objective: string;
          cron: string;
        }): Promise<{ sessionId: string; ownerUserId: number }>;
      };
    };
    try {
      const session = internals.runtime.createAgentSession({
        workspaceId: workspace.id,
        runner: 'claude-code',
        cwd: workspace.path,
        model: 'claude-sonnet',
        effort: 'medium',
        access: 'full-access'
      });
      const creating = internals.sessionScheduleService.createFromMcp({
        sessionId: session.id,
        workspaceId: workspace.id,
        actorUserId: 7,
        objective: 'Review every day',
        cron: '0 9 * * *'
      });
      internals.sessionIdentityService.promote(session.id, 'native-new-session');
      expect(await creating).toMatchObject({
        sessionId: 'native-new-session',
        ownerUserId: 7
      });
      expect(new ScheduledSessionStore(database.raw).get('native-new-session')).toBeDefined();
    } finally {
      await connector.stop();
    }
  });

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
            status: 'SUCCEEDED'
          ): void;
        };
      };
      emitWorkbenchEvent: (category: string, payload: unknown) => void;
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
        model: 'claude-sonnet'
      });
      internals.claudeClient.execution.managedNativeIds.add(session.id);
      await internals.executeNodeOperation('session.schedule.save', {
        sessionId: session.id,
        workspaceId: workspace.id,
        __requestUserId: 7,
        objective: 'Review changes',
        cron: '0 * * * *',
        enabled: true
      });
      internals.scheduledRunAuthorization.authorize = vi.fn(async () => ({
        secretEnvironment: {}
      }));
      internals.scheduledSessions.start();
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      await vi.waitFor(() =>
        expect(prompts).toContain(
          serializeComposerTag('mar_schedule', { objective: 'Review changes' })
        )
      );
      expect(startedConfigurations[0]).toMatchObject({
        model: 'claude-sonnet',
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
            objective: 'Review follow-up changes'
          })
        ).content
      ).toContain('Review follow-up changes');
      const store = new ScheduledSessionStore(database.raw);
      const task = store.get(session.id)!;
      expect(task).toMatchObject({
        objective: 'Review follow-up changes',
        ownerUserId: 7,
        revision: 2
      });
      const occurrence = store.recent(task.id)[0]!;
      expect(occurrence).toMatchObject({ status: 'SUBMITTED' });
      expect(internals.runtime.getRun(occurrence['run_id'] as string)?.source).toBe('SCHEDULED');
      const notifications = vi.spyOn(internals, 'emitWorkbenchEvent');
      const edited = (await internals.executeNodeOperation('session.schedule.save', {
        sessionId: session.id,
        workspaceId: workspace.id,
        __requestUserId: 8,
        expectedRevision: task.revision,
        notifyOnTerminal: true
      })) as { task: { ownerUserId: number; notifyOnTerminal: boolean } };
      expect(edited.task).toMatchObject({
        ownerUserId: 8,
        notifyOnTerminal: true
      });
      internals.runEventService.options.onTerminalRun(
        internals.runtime.getRun(occurrence['run_id'] as string)!,
        'SUCCEEDED'
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
              payload: expect.objectContaining({ userId: 8, outcome: 'SUCCEEDED' })
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
          model: 'claude-sonnet',
          access: 'full'
        });
        internals.claudeClient.execution.managedNativeIds.add(session.id);
        const saved = (await internals.executeNodeOperation('session.schedule.save', {
          sessionId: session.id,
          workspaceId: workspace.id,
          __requestUserId: 7,
          objective: 'Inspect the repository',
          cron: '0 * * * *',
          enabled: true
        })) as {
          task: { readonly nextRunAt: number; readonly timezone: string };
          session: { readonly runtime: { readonly capabilities: readonly string[] } };
        };
        expect(saved.task.nextRunAt).toBe(Date.parse('2025-01-01T01:00:00Z'));
        expect(saved.task.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
        expect(saved.session.runtime.capabilities).toContain('session.schedule');
        expect(
          database.getNativeSessionMetadata('claude-code', session.id, workspace.id)?.pinOrder
        ).toBe(0);
        if (notifyOnTerminal)
          await internals.executeNodeOperation('session.schedule.save', {
            sessionId: session.id,
            workspaceId: workspace.id,
            __requestUserId: 8,
            expectedRevision: 1,
            notifyOnTerminal: true
          });
        internals.scheduledRunAuthorization.authorize = vi.fn(async () => ({
          secretEnvironment: {}
        }));
        internals.scheduledSessions.start();
        await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
        const task = new ScheduledSessionStore(database.raw).get(session.id)!;
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
            initiatedByUserId: notifyOnTerminal ? 8 : 7
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
          expect.objectContaining({ ownerUserId: notifyOnTerminal ? 8 : 7 })
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
          expect(occurrence).toMatchObject({ status: 'FAILED', run_id: expect.any(String) });
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
            ? [expect.objectContaining({ userId: 8, kind: 'SCHEDULE_TERMINAL' })]
            : []
        );
      } finally {
        internals.scheduledSessions.stop();
        await connector.stop();
      }
    }
  );
});
