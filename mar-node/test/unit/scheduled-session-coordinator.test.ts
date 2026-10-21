import { describe, expect, it, vi } from 'vitest';
import { NodeDatabase } from '../../src/database.js';
import { ScheduledSessionCoordinator } from '../../src/service/scheduled-session-coordinator.js';
import { ScheduledSessionStore } from '../../src/service/scheduled-session-store.js';

function fixture(now: () => number) {
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
    objective: 'Check status',
    cron: '0 * * * *',
    timezone: 'UTC'
  });
  return { database, store, task };
}

describe('scheduled session coordinator', () => {
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
        return { secretEnvironment: {} };
      });
      const submit = vi.fn(async () => {
        if (stage === 'submission') await pending;
        return { runId: 'run-1' };
      });
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
      const current = store.update(task.sessionId, task.revision, { notifyOnTerminal });
      const occurrenceId = store.claim(task.sessionId, current.nextRunAt!, current.revision)!;
      store.finish(occurrenceId, 'SUBMITTED', undefined, 'run-1');
      const emit = vi.fn();
      const coordinator = new ScheduledSessionCoordinator({
        store: () => store,
        busy: () => false,
        authorize: async () => ({ secretEnvironment: {} }),
        submit: async () => ({ runId: 'run-1' }),
        emitNotification: emit,
        sessionTitle: () => 'Current title'
      });
      try {
        coordinator.stop();
        store.update(task.sessionId, current.revision, { ownerUserId: 7 });
        coordinator.executionTerminated(
          { id: 'run-1', clientMessageId: occurrenceId, source: 'SCHEDULED' },
          'FAILED'
        );
        expect(store.recent(task.id)[0]).toMatchObject({ status: 'FAILED', run_id: 'run-1' });
        expect(emit).toHaveBeenCalledOnce();
        expect(emit).toHaveBeenCalledWith(
          expect.objectContaining({
            event: expect.objectContaining({
              eventType: 'notification',
              payload: expect.objectContaining({
                userId: 7,
                sessionTitle: 'Current title',
                notificationId: `${notifyOnTerminal ? 'schedule-terminal' : 'schedule'}:${task.id}:${occurrenceId}`,
                kind: notifyOnTerminal ? 'SCHEDULE_TERMINAL' : 'SCHEDULE_FAILED'
              })
            })
          })
        );
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

  it('does not replay an overdue occurrence after restart', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.parse('2025-01-01T00:00:00Z'));
      const { database, store, task } = fixture(Date.now);
      vi.setSystemTime(Date.parse('2025-01-01T03:20:00Z'));
      const submit = vi.fn(async () => ({ runId: 'run-1' }));
      const notify = vi.fn();
      const coordinator = new ScheduledSessionCoordinator({
        store: () => store,
        busy: () => false,
        authorize: async () => ({ secretEnvironment: {} }),
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
      expect(store.get(task.sessionId)?.nextRunAt).toBe(Date.parse('2025-01-01T04:00:00Z'));
      coordinator.stop();
      database.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips a busy session without requesting credentials', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.parse('2025-01-01T00:00:00Z'));
      const { database, store, task } = fixture(Date.now);
      const authorize = vi.fn(async () => ({ secretEnvironment: {} }));
      const coordinator = new ScheduledSessionCoordinator({
        store: () => store,
        busy: () => true,
        authorize,
        submit: async () => ({ runId: 'run-1' }),
        emitNotification: vi.fn(),
        sessionTitle: (id) => id
      });
      coordinator.start();
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(store.recent(task.id)[0]).toMatchObject({
        status: 'SKIPPED',
        code: 'SCHEDULE_SESSION_BUSY'
      });
      expect(authorize).not.toHaveBeenCalled();
      coordinator.stop();
      database.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
