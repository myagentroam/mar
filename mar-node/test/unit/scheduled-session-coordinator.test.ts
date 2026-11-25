import { hourlyTriggers } from './scheduled-task-fixtures.js';
import { describe, expect, it, vi } from 'vitest';
import { NodeDatabase } from '../../src/database.js';
import { ScheduledSessionCoordinator } from '../../src/service/scheduled-session-coordinator.js';
import { ScheduledSessionStore } from '../../src/service/scheduled-session-store.js';
import type { ScheduledSessionTask } from '../../src/service/scheduled-session-store.js';
import type {
  BeginScheduledSubmission,
  ScheduledRunContext
} from '../../src/service/scheduled-session-coordinator.js';

function fixture(now: () => number, notifyOnTerminal = false) {
  const database = new NodeDatabase(':memory:', 'node-a', now);
  const workspace = database.saveWorkspace({
    path: '/schedule-coordinator-test',
    kind: 'DIRECTORY',
    gitSummary: null
  });
  database.saveNativeSessionMetadata({
    runner: 'codex',
    externalSessionId: 'thread-1',
    workspaceId: workspace.id,
    pinned: true
  });
  const store = new ScheduledSessionStore(database.raw, now);
  const task = store.create({
    sessionId: 'thread-1',
    workspaceId: workspace.id,
    runner: 'codex',
    ownerUserId: 1,
    notifyOnTerminal,
    objective: 'Check status',
    name: 'Schedule',
    triggers: hourlyTriggers,
    timezone: 'UTC'
  });
  return { database, store, task };
}

describe('scheduled session coordinator', () => {
  it.each(['resume', 'expire', 'zero grace'] as const)(
    'keeps a finite occurrence separate from a periodic one on availability change (%s)',
    async (mode) => {
      vi.useFakeTimers();
      vi.setSystemTime(Date.parse('2025-01-01T00:00:00Z'));
      const { database, store, task: periodic } = fixture(Date.now);
      const finite = store.create({
        sessionId: periodic.sessionId,
        workspaceId: periodic.workspaceId,
        runner: periodic.runner,
        ownerUserId: 1,
        name: 'Finite',
        objective: 'Run once',
        timezone: 'UTC',
        graceMinutes: mode === 'zero grace' ? 0 : 60,
        triggers: [
          {
            kind: 'once',
            date: '2025-01-01',
            time: '01:00'
          }
        ]
      });
      let online = false;
      const authorize = vi.fn(async () => ({
        secretEnvironment: {},
        executionContext: { runner: 'codex' as const }
      }));
      const submit = vi.fn(
        async (
          _task: ScheduledSessionTask,
          _id: string,
          _context: ScheduledRunContext,
          begin: BeginScheduledSubmission
        ) => {
          begin();
          return { runId: 'resumed-run' };
        }
      );
      const coordinator = new ScheduledSessionCoordinator({
        store: () => store,
        busy: () => false,
        available: () => online,
        authorize,
        submit,
        emitNotification: vi.fn(),
        sessionTitle: (id) => id
      });
      try {
        coordinator.start();
        await vi.advanceTimersByTimeAsync(60 * 60_000);
        expect(store.recent(periodic.id)[0]).toMatchObject({
          status: 'SKIPPED',
          code: 'SCHEDULE_CONTROL_UNAVAILABLE'
        });
        const occurrence = store.recent(finite.id)[0]!;
        expect(occurrence.status).toBe(mode === 'zero grace' ? 'SKIPPED' : 'WAITING');
        expect(store.getById(finite.id)?.nextRunAt).toBeNull();
        expect(authorize).not.toHaveBeenCalled();
        if (mode === 'expire') {
          await vi.advanceTimersByTimeAsync(60 * 60_000);
          expect(store.historyDetail(finite.workspaceId, String(occurrence.id))).toMatchObject({
            state: 'EXPIRED',
            startedAt: null,
            endedAt: null,
            run: null
          });
          expect(authorize).not.toHaveBeenCalled();
        } else {
          online = true;
          coordinator.connected();
          await vi.advanceTimersByTimeAsync(1);
          if (mode === 'resume') {
            expect(authorize).toHaveBeenCalledExactlyOnceWith(
              expect.objectContaining({ id: finite.id }),
              occurrence.id
            );
            expect(store.recent(finite.id)).toMatchObject([
              { id: occurrence.id, status: 'SUBMITTED', run_id: 'resumed-run' }
            ]);
          } else expect(submit).not.toHaveBeenCalled();
        }
      } finally {
        await coordinator.stop();
        database.close();
        vi.useRealTimers();
      }
    }
  );

  it.each(['authorization', 'submission'] as const)(
    'drains in-flight %s before its store can be closed',
    async (stage) => {
      vi.useFakeTimers();
      vi.setSystemTime(Date.parse('2025-01-01T00:00:00Z'));
      const { database, store, task } = fixture(Date.now);
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const authorize = vi.fn(async () => {
        if (stage === 'authorization') await pending;
        return { secretEnvironment: {}, executionContext: { runner: 'codex' as const } };
      });
      const submit = vi.fn(
        async (
          _task: ScheduledSessionTask,
          _id: string,
          _context: ScheduledRunContext,
          begin: BeginScheduledSubmission
        ) => {
          begin();
          if (stage === 'submission') await pending;
          return { runId: 'run-1' };
        }
      );
      const coordinator = new ScheduledSessionCoordinator({
        store: () => store,
        busy: () => false,
        authorize,
        submit,
        emitNotification: vi.fn(),
        sessionTitle: (id) => id
      });
      try {
        coordinator.start();
        await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
        expect(stage === 'authorization' ? authorize : submit).toHaveBeenCalledOnce();
        let stopped = false;
        const stopping = Promise.resolve(coordinator.stop()).then(() => {
          stopped = true;
        });
        await Promise.resolve();
        expect(stopped).toBe(false);
        release();
        await stopping;
        expect(store.recent(task.id)[0]).toMatchObject(
          stage === 'authorization'
            ? { status: 'SKIPPED', code: 'SCHEDULE_NODE_STOPPED' }
            : { status: 'SUBMITTED', run_id: 'run-1' }
        );
        if (stage === 'authorization') expect(submit).not.toHaveBeenCalled();
      } finally {
        release();
        await coordinator.stop();
        await vi.waitFor(() => expect(store.recent(task.id)[0]?.status).not.toBe('CLAIMED'));
        database.close();
        vi.useRealTimers();
      }
    }
  );

  it.each([false, true])(
    'settles a submitted Run after scheduling stops (terminal notifications: %s)',
    (notifyOnTerminal) => {
      const { database, store, task } = fixture(() => Date.parse('2025-01-01T00:00:00Z'));
      const current = store.update(task.id, task.revision, { notifyOnTerminal });
      const occurrenceId = store.claim(task.id, current.nextRunAt!, current.revision)!;
      store.finish(occurrenceId, 'SUBMITTED', undefined, 'run-1');
      const emit = vi.fn();
      const coordinator = new ScheduledSessionCoordinator({
        store: () => store,
        busy: () => false,
        authorize: async () => ({
          secretEnvironment: {},
          executionContext: { runner: 'codex' as const }
        }),
        submit: async () => ({ runId: 'run-1' }),
        emitNotification: emit,
        sessionTitle: () => 'Current title'
      });
      try {
        coordinator.stop();
        store.update(task.id, current.revision, { name: 'Renamed' });
        coordinator.executionTerminated(
          { id: 'run-1', clientMessageId: occurrenceId, source: 'SCHEDULED' },
          'FAILED'
        );
        expect(store.recent(task.id)[0]).toMatchObject({ status: 'FAILED', run_id: 'run-1' });
        if (notifyOnTerminal) {
          expect(emit).toHaveBeenCalledOnce();
          expect(emit).toHaveBeenCalledWith(
            expect.objectContaining({
              event: expect.objectContaining({
                eventType: 'notification',
                payload: expect.objectContaining({
                  userId: 1,
                  sessionTitle: 'Current title',
                  notificationId: `schedule-terminal:${task.id}:${occurrenceId}`,
                  kind: 'SCHEDULE_TERMINAL'
                })
              })
            })
          );
        } else expect(emit).not.toHaveBeenCalled();
        store.finish(occurrenceId, 'SUBMITTED', undefined, 'late-submit-result');
        expect(store.recent(task.id)[0]).toMatchObject({ status: 'FAILED', run_id: 'run-1' });
        emit.mockClear();
        coordinator.executionTerminated(
          { id: 'ordinary', clientMessageId: 'ordinary' },
          'SUCCEEDED'
        );
        expect(emit).not.toHaveBeenCalled();
      } finally {
        database.close();
      }
    }
  );

  it('returns whether finish matched an active occurrence', () => {
    const { database, store, task } = fixture(() => Date.parse('2025-01-01T00:00:00Z'));
    try {
      const occurrenceId = store.claim(task.id, task.nextRunAt!, task.revision)!;
      expect(store.finish('missing-occurrence', 'FAILED', 'SCHEDULE_EXECUTION_FAILED')).toBe(false);
      expect(store.finish(occurrenceId, 'SUBMITTED', undefined, 'run-1')).toBe(true);
      expect(store.finish(occurrenceId, 'FAILED', 'SCHEDULE_RUN_FAILED', 'run-1')).toBe(true);
      expect(store.finish(occurrenceId, 'SUCCEEDED', undefined, 'run-1')).toBe(false);
    } finally {
      database.close();
    }
  });

  it('does not notify after the task and occurrence are removed', () => {
    const { database, store, task } = fixture(() => Date.parse('2025-01-01T00:00:00Z'), true);
    const occurrenceId = store.claim(task.id, task.nextRunAt!, task.revision)!;
    const emit = vi.fn();
    const coordinator = new ScheduledSessionCoordinator({
      store: () => store,
      busy: () => false,
      authorize: async () => ({
        secretEnvironment: {},
        executionContext: { runner: 'codex' as const }
      }),
      submit: async () => ({ runId: 'run-1' }),
      emitNotification: emit,
      sessionTitle: (id) => id
    });
    try {
      expect(() => store.remove(task.id, task.revision)).toThrow('SCHEDULE_IN_PROGRESS');
      store.finish(occurrenceId, 'SKIPPED');
      store.remove(task.id, task.revision);
      coordinator.executionTerminated(
        { id: 'run-1', clientMessageId: occurrenceId, source: 'SCHEDULED' },
        'FAILED'
      );
      expect(store.recent(task.id)).toEqual([]);
      expect(emit).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });

  it.each([
    'terminal-before-submit-result',
    'terminal-before-submit-rejection',
    'submit-rejection-before-terminal'
  ] as const)(
    'publishes only the winning terminal notification when %s occurs',
    async (ordering) => {
      vi.useFakeTimers();
      vi.setSystemTime(Date.parse('2025-01-01T00:00:00Z'));
      const { database, store, task } = fixture(Date.now, true);
      const emit = vi.fn();
      const coordinator: ScheduledSessionCoordinator = new ScheduledSessionCoordinator({
        store: () => store,
        busy: () => false,
        authorize: async () => ({
          secretEnvironment: {},
          executionContext: { runner: 'codex' as const }
        }),
        submit: async (_task, occurrenceId, _context, begin) => {
          begin();
          if (ordering !== 'submit-rejection-before-terminal')
            coordinator.executionTerminated(
              { id: 'run-1', clientMessageId: occurrenceId, source: 'SCHEDULED' },
              'FAILED'
            );
          if (ordering !== 'terminal-before-submit-result')
            throw new Error('SCHEDULE_EXECUTION_FAILED');
          return { runId: 'run-1' };
        },
        emitNotification: emit,
        sessionTitle: (id) => id
      });
      try {
        coordinator.start();
        await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

        const terminalWon = ordering !== 'submit-rejection-before-terminal';
        expect(store.recent(task.id)[0]).toMatchObject({
          status: 'FAILED',
          code: terminalWon ? 'SCHEDULE_RUN_FAILED' : 'SCHEDULE_SUBMISSION_OUTCOME_UNKNOWN',
          run_id: terminalWon ? 'run-1' : null
        });
        expect(emit).toHaveBeenCalledOnce();
        expect(
          (emit.mock.calls[0]![0] as { event: { payload: Record<string, unknown> } }).event.payload
        ).toMatchObject({
          kind: terminalWon ? 'SCHEDULE_TERMINAL' : 'SCHEDULE_FAILED',
          notificationId: `${terminalWon ? 'schedule-terminal' : 'schedule'}:${task.id}:${store.recent(task.id)[0]!.id}`
        });

        coordinator.executionTerminated(
          {
            id: 'run-1',
            clientMessageId: store.recent(task.id)[0]!.id as string,
            source: 'SCHEDULED'
          },
          'FAILED'
        );
        expect(emit).toHaveBeenCalledOnce();
        expect(store.recent(task.id)[0]).toMatchObject({
          status: 'FAILED',
          code: terminalWon ? 'SCHEDULE_RUN_FAILED' : 'SCHEDULE_SUBMISSION_OUTCOME_UNKNOWN',
          run_id: terminalWon ? 'run-1' : null
        });
      } finally {
        await coordinator.stop();
        database.close();
        vi.useRealTimers();
      }
    }
  );

  it('notifies task change proposals even when task outcome notifications are disabled', () => {
    const { database, store, task } = fixture(Date.now);
    try {
      const notify = vi.fn();
      const coordinator = new ScheduledSessionCoordinator({
        store: () => store,
        busy: () => false,
        authorize: async () => ({
          secretEnvironment: {},
          executionContext: { runner: 'codex' as const }
        }),
        submit: async () => ({ runId: 'unused' }),
        sessionTitle: () => 'Session',
        emitNotification: notify
      });
      expect(task.notifyOnTerminal).toBe(false);
      coordinator.proposalCreated(task.id, 'proposal-1');
      expect(notify).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          event: expect.objectContaining({
            payload: expect.objectContaining({
              kind: 'SCHEDULE_PROPOSAL',
              userId: task.ownerUserId
            })
          })
        })
      );
    } finally {
      database.close();
    }
  });

  it('does not replay an overdue occurrence after restart', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.parse('2025-01-01T00:00:00Z'));
      const { database, store, task } = fixture(Date.now, true);
      vi.setSystemTime(Date.parse('2025-01-01T03:20:00Z'));
      const submit = vi.fn(async () => ({ runId: 'run-1' }));
      const notify = vi.fn();
      const coordinator = new ScheduledSessionCoordinator({
        store: () => store,
        busy: () => false,
        authorize: async () => ({
          secretEnvironment: {},
          executionContext: { runner: 'codex' as const }
        }),
        submit,
        emitNotification: notify,
        sessionTitle: (id) => id
      });
      coordinator.start();
      await vi.waitFor(() => expect(store.recent(task.id)).toHaveLength(1));
      expect(store.recent(task.id)[0]).toMatchObject({
        status: 'SKIPPED',
        code: 'SCHEDULE_NODE_RESTARTED'
      });
      expect(submit).not.toHaveBeenCalled();
      expect(notify).toHaveBeenCalledOnce();
      expect(store.getById(task.id)?.nextRunAt).toBe(Date.parse('2025-01-01T04:00:00Z'));
      coordinator.stop();
      database.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([false, true])(
    'skips a busy session without credentials (notifications: %s)',
    async (enabled) => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(Date.parse('2025-01-01T00:00:00Z'));
        const { database, store, task } = fixture(Date.now, enabled);
        const authorize = vi.fn(async () => ({
          secretEnvironment: {},
          executionContext: { runner: 'codex' as const }
        }));
        const notify = vi.fn();
        const coordinator = new ScheduledSessionCoordinator({
          store: () => store,
          busy: () => true,
          authorize,
          submit: async () => ({ runId: 'run-1' }),
          emitNotification: notify,
          sessionTitle: (id) => id
        });
        coordinator.start();
        await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
        expect(store.recent(task.id)[0]).toMatchObject({
          status: 'SKIPPED',
          code: 'SCHEDULE_SESSION_BUSY'
        });
        expect(authorize).not.toHaveBeenCalled();
        expect(notify).toHaveBeenCalledTimes(enabled ? 1 : 0);
        coordinator.stop();
        database.close();
      } finally {
        vi.useRealTimers();
      }
    }
  );

  it.each([false, true])(
    'records an unknown submission without a Run (notifications: %s)',
    async (enabled) => {
      vi.useFakeTimers();
      vi.setSystemTime(Date.parse('2025-01-01T00:00:00Z'));
      const { database, store, task } = fixture(Date.now, enabled);
      const notify = vi.fn();
      const coordinator = new ScheduledSessionCoordinator({
        store: () => store,
        busy: () => false,
        authorize: async () => ({
          secretEnvironment: {},
          executionContext: { runner: 'codex' as const }
        }),
        submit: async (_task, _id, _context, begin) => {
          begin();
          throw new Error('SCHEDULE_EXECUTION_FAILED');
        },
        emitNotification: notify,
        sessionTitle: (id) => id
      });
      try {
        coordinator.start();
        await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
        expect(store.recent(task.id)[0]).toMatchObject({
          status: 'FAILED',
          code: 'SCHEDULE_SUBMISSION_OUTCOME_UNKNOWN'
        });
        expect(notify).toHaveBeenCalledTimes(enabled ? 1 : 0);
      } finally {
        await coordinator.stop();
        database.close();
        vi.useRealTimers();
      }
    }
  );

  it('leaves a persisted Run in charge of the result if its receipt fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2025-01-01T00:00:00Z'));
    const { database, store, task } = fixture(Date.now, true);
    const emit = vi.fn();
    const coordinator: ScheduledSessionCoordinator = new ScheduledSessionCoordinator({
      store: () => store,
      busy: () => false,
      authorize: async () => ({ secretEnvironment: {}, executionContext: { runner: 'codex' } }),
      submit: async (_task, id, _context, begin) => {
        begin();
        coordinator.executionStarted(
          { id: 'run-1', clientMessageId: id, source: 'SCHEDULED', workspaceId: task.workspaceId },
          Date.now(),
          task.sessionId
        );
        throw new Error('SCHEDULE_EXECUTION_FAILED');
      },
      emitNotification: emit,
      sessionTitle: (id) => id
    });
    try {
      coordinator.start();
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      const [occurrence] = store.recent(task.id);
      expect(occurrence).toMatchObject({ status: 'SUBMITTED', run_id: 'run-1', code: null });
      expect(emit).not.toHaveBeenCalled();
      coordinator.executionTerminated(
        { id: 'run-1', clientMessageId: String(occurrence!.id), source: 'SCHEDULED' },
        'SUCCEEDED'
      );
      expect(store.recent(task.id)[0]).toMatchObject({ status: 'SUCCEEDED', run_id: 'run-1' });
      expect(emit).toHaveBeenCalledOnce();
    } finally {
      await coordinator.stop();
      database.close();
      vi.useRealTimers();
    }
  });

  it('uses the latest notification setting after authorization changes the task', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2025-01-01T00:00:00Z'));
    const { database, store, task } = fixture(Date.now, true);
    const notify = vi.fn();
    const submit = vi.fn(async () => ({ runId: 'run-1' }));
    const coordinator = new ScheduledSessionCoordinator({
      store: () => store,
      busy: () => false,
      authorize: async () => {
        store.update(task.id, task.revision, { notifyOnTerminal: false });
        return { secretEnvironment: {}, executionContext: { runner: 'codex' as const } };
      },
      submit,
      emitNotification: notify,
      sessionTitle: (id) => id
    });
    try {
      coordinator.start();
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(store.recent(task.id)[0]).toMatchObject({
        status: 'SKIPPED',
        code: 'SCHEDULE_TASK_CHANGED'
      });
      expect(submit).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
      coordinator.proposalCreated(task.id, 'proposal-1');
      expect(notify).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          event: expect.objectContaining({
            payload: expect.objectContaining({ kind: 'SCHEDULE_PROPOSAL' })
          })
        })
      );
    } finally {
      await coordinator.stop();
      database.close();
      vi.useRealTimers();
    }
  });

  it('does not admit the saved input when the owner pauses during submission preparation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2025-01-01T00:00:00Z'));
    const { database, store, task } = fixture(Date.now);
    const release = vi.fn();
    const accept = vi.fn();
    const coordinator = new ScheduledSessionCoordinator({
      store: () => store,
      busy: () => false,
      authorize: async () => ({
        release,
        secretEnvironment: {},
        executionContext: { runner: 'codex' }
      }),
      submit: async (_task, _id, _context, begin) => {
        expect(store.recent(task.id)[0]?.status).toBe('CLAIMED');
        await Promise.resolve();
        store.update(task.id, task.revision, { enabled: false });
        begin();
        accept();
        return { runId: 'not-accepted' };
      },
      emitNotification: vi.fn(),
      sessionTitle: (id) => id
    });
    try {
      coordinator.start();
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(accept).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledOnce();
      expect(store.recent(task.id)[0]).toMatchObject({
        status: 'SKIPPED',
        code: 'SCHEDULE_TASK_CHANGED',
        run_id: null
      });
    } finally {
      await coordinator.stop();
      database.close();
      vi.useRealTimers();
    }
  });
});
