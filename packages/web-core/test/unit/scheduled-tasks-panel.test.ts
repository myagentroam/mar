import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reactive } from 'vue';
import { scheduledTaskClient } from '../../src/service/scheduled-task-client.js';
import { i18n } from '../../src/service/locale-preference-service.js';
import ScheduledTasksPanel from '../../src/view/schedule/ScheduledTasksPanel.vue?unit-render';
import { parseTimeDraft, timeDraft } from '../../src/view/schedule/scheduled-time-draft.js';
import type {
  ScheduleHistoryTask,
  ScheduleSection
} from '../../src/view/schedule/scheduled-task-navigation.js';
import {
  flushComponent,
  renderComponent,
  textContent,
  trigger
} from './support/component-renderer.js';

const originalLocale = i18n.global.locale.value;
beforeEach(() => {
  i18n.global.locale.value = 'en-US';
});
afterEach(() => {
  i18n.global.locale.value = originalLocale;
});

const scope = { nodeId: 'a', workspaceId: 'work' };
const task = {
  ...scope,
  id: 'same-id',
  name: 'Task A',
  nodeName: 'Node A',
  workspaceName: 'project',
  sessionId: 'session',
  targetKind: 'existing' as const,
  enabled: true,
  nextRunAt: null,
  mine: true,
  ownerName: 'Owner'
};
const history = {
  ...scope,
  taskId: task.id,
  occurrenceId: 'record',
  dueAt: 1000,
  state: 'SUCCEEDED',
  name: task.name,
  reason: null,
  startedAt: 1001,
  endedAt: 2000,
  run: null
};
const node = { id: 'a', name: 'Node A', connected: true, supported: true };
const button = (view: ReturnType<typeof renderComponent>, label: string) =>
  view.findAll('MarButton').find((item) => textContent(item).trim() === label)!;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe('Scheduled tasks workbench', () => {
  it('keeps dates paired with their own times and validates unfinished edits', () => {
    const a = timeDraft(1);
    a.dayKind = 'weekdays';
    a.weekdays = [1, 3, 5];
    a.times = '10:00, 20:30';
    const b = timeDraft(2);
    b.dayKind = 'dates';
    b.dates = '2028-02-29';
    b.times = '14:30';
    expect(parseTimeDraft(a)).toMatchObject({
      success: true,
      data: { days: { weekdays: a.weekdays }, times: { times: ['10:00', '20:30'] } }
    });
    expect(parseTimeDraft(b)).toMatchObject({
      success: true,
      data: { days: { dates: ['2028-02-29'] }, times: { times: ['14:30'] } }
    });
    a.times += ',';
    expect(parseTimeDraft(a).success).toBe(false);
    b.dates = '2026-02-29';
    expect(parseTimeDraft(b).success).toBe(false);
  });

  it('addresses colliding task and occurrence IDs using their originating nodes', async () => {
    const request = vi.fn().mockResolvedValue({});
    const client = scheduledTaskClient(request);
    const b = { ...scope, nodeId: 'b', id: 'same-id' };
    const read = new AbortController();
    await client.detail(task, read.signal);
    await client.update(b, 4, { objective: 'Only B changes' });
    await client.occurrence({ ...history, nodeId: 'b' }, read.signal);
    expect(request.mock.calls).toMatchObject([
      ['/api/scheduled-tasks/same-id?nodeId=a&workspaceId=work', { signal: read.signal }],
      ['/api/scheduled-tasks/same-id', { method: 'PUT' }],
      ['/api/scheduled-occurrences/record?nodeId=b&workspaceId=work', { signal: read.signal }]
    ]);
    expect(JSON.parse(String(request.mock.calls[1]?.[1]?.body))).toEqual({
      nodeId: 'b',
      workspaceId: 'work',
      expectedRevision: 4,
      patch: { objective: 'Only B changes' }
    });
  });

  it('keeps the current history page on a failed load and retries only the selected task', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        items: [task],
        nodes: [node],
        upcoming: [],
        unavailableNodeIds: [],
        nextCursor: null
      })
      .mockResolvedValueOnce({ items: [history], unavailableNodeIds: [], nextCursor: 'cursor+1' })
      .mockRejectedValueOnce(new Error('Second page unavailable'))
      .mockResolvedValueOnce({
        items: [{ ...history, occurrenceId: 'another', name: 'Older record' }],
        unavailableNodeIds: [],
        nextCursor: null
      });
    const props = reactive({
      request,
      section: 'mine' as ScheduleSection,
      historyTask: undefined as ScheduleHistoryTask | undefined,
      onShowHistory: (historyTask?: ScheduleHistoryTask) => {
        props.section = 'history';
        props.historyTask = historyTask;
      }
    });
    const view = renderComponent(ScheduledTasksPanel, props);
    try {
      await flushComponent();
      await trigger(button(view, 'Execution records'), 'onClick');
      expect(request.mock.calls[1]?.[0]).toContain('taskId=same-id');
      expect(request.mock.calls[1]?.[0]).toContain('mine=false');
      await trigger(button(view, 'Load more'), 'onClick');
      expect(textContent(view.root)).toContain('Second page unavailable');
      expect(button(view, 'Task A')).toBeDefined();
      await trigger(button(view, 'Load more'), 'onClick');
      expect(request.mock.calls[2]?.[0]).toEqual(request.mock.calls[3]?.[0]);
      expect(request.mock.calls[2]?.[0]).toContain('cursor=cursor%2B1');
      expect(button(view, 'Older record')).toBeDefined();
      expect(button(view, 'Load more')).toBeUndefined();
    } finally {
      view.unmount();
    }
  });

  it('ignores a late list after unmount and never treats read failure as an empty create dialog', async () => {
    const read = deferred<unknown>();
    const request = vi
      .fn()
      .mockReturnValueOnce(read.promise)
      .mockRejectedValueOnce(new Error('Forbidden'));
    const first = renderComponent(ScheduledTasksPanel, { request, section: 'mine' });
    first.unmount();
    expect(request.mock.calls[0]?.[1].signal.aborted).toBe(true);
    const second = renderComponent(ScheduledTasksPanel, { request, section: 'mine' });
    try {
      read.resolve({
        items: [task],
        nodes: [node],
        upcoming: [],
        unavailableNodeIds: [],
        nextCursor: null
      });
      await flushComponent();
      expect(textContent(second.root)).toContain('Forbidden');
      expect(textContent(second.root)).not.toContain(task.name);
      expect(button(second, 'New schedule').props.disabled).toBe(true);
    } finally {
      second.unmount();
    }
  });

  it('keeps a scheduled refresh when a different Workspace changes and releases it on unmount', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const request = vi.fn(async () => ({ items: [], unavailableNodeIds: [], nextCursor: null }));
    const props = reactive({
      request,
      section: 'history' as const,
      initial: { ...scope, sessionId: 'session' },
      historyTask: { ...scope, id: task.id, name: task.name },
      invalidation: undefined as typeof scope | undefined
    });
    const view = renderComponent(ScheduledTasksPanel, props);
    let mounted = true;
    try {
      await flushComponent();
      props.invalidation = scope;
      await flushComponent();
      props.invalidation = { ...scope, workspaceId: 'other' };
      await flushComponent();
      await vi.runOnlyPendingTimersAsync();
      expect(request).toHaveBeenCalledTimes(2);
      props.invalidation = scope;
      await flushComponent();
      view.unmount();
      mounted = false;
      await vi.runOnlyPendingTimersAsync();
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      if (mounted) view.unmount();
      vi.useRealTimers();
    }
  });

  it('rechecks a linked run in its own node and sends only the exact authorized target', async () => {
    const run = { runId: 'run-1', sessionId: 'execution-session' };
    const record = { ...history, nodeId: 'b', run };
    let runWorkspace = 'other-workspace';
    const request = vi.fn(async (path: string) => {
      if (path.startsWith('/api/scheduled-occurrences?'))
        return { items: [record], unavailableNodeIds: [], nextCursor: null };
      if (path.startsWith('/api/scheduled-occurrences/record?'))
        return { ...record, snapshot: { objective: 'Frozen prompt' } };
      if (path.startsWith('/api/agent-runs/run-1?'))
        return {
          run: {
            id: run.runId,
            sessionId: run.sessionId,
            workspaceId: runWorkspace,
            status: 'SUCCEEDED'
          }
        };
      throw new Error(`Unexpected request: ${path}`);
    });
    const onOpenRun = vi.fn();
    const view = renderComponent(ScheduledTasksPanel, { request, onOpenRun, section: 'history' });
    try {
      await flushComponent();
      await trigger(button(view, 'Task A'), 'onClick');
      expect(textContent(view.root)).toContain('Frozen prompt');
      expect(button(view, 'Open run’s session')).toBeUndefined();
      expect(textContent(view.root)).not.toContain('run-1');
      runWorkspace = record.workspaceId;
      await trigger(button(view, 'Task A'), 'onClick');
      expect(textContent(view.root)).toContain('run-1');
      await trigger(button(view, 'Open run’s session'), 'onClick');
      expect(request.mock.calls.filter(([path]) => path.startsWith('/api/agent-runs/'))).toEqual([
        ['/api/agent-runs/run-1?nodeId=b&workspaceId=work', expect.anything()],
        ['/api/agent-runs/run-1?nodeId=b&workspaceId=work', expect.anything()]
      ]);
      expect(onOpenRun).toHaveBeenCalledExactlyOnceWith({ ...scope, nodeId: 'b', ...run });
    } finally {
      view.unmount();
    }
  });

  it('opens a proposal notification by task address without falling back to creation', async () => {
    const request = vi.fn(async (path: string) => {
      if (path.startsWith('/api/scheduled-tasks?'))
        return {
          items: [task],
          nodes: [node],
          upcoming: [],
          unavailableNodeIds: [],
          nextCursor: null
        };
      throw new Error('Linked task is no longer available');
    });
    const view = renderComponent(ScheduledTasksPanel, {
      request,
      section: 'mine',
      linkedTask: { ...scope, nodeId: 'b', id: task.id, reference: { kind: 'proposal', id: 'p' } }
    });
    try {
      await flushComponent();
      expect(request.mock.calls.map(([path]) => path)).toContain(
        '/api/scheduled-tasks/same-id?nodeId=b&workspaceId=work'
      );
      expect(textContent(view.root)).toContain('Linked task is no longer available');
      expect(view.findAll('ScheduledTaskEditor')).toHaveLength(0);
    } finally {
      view.unmount();
    }
  });

  it.each([true, false])(
    'opens only an occurrence that belongs to the linked task (matches: %s)',
    async (matches) => {
      const reference = { kind: 'occurrence', id: history.occurrenceId };
      const request = vi.fn(async (path: string) => {
        if (path.startsWith('/api/scheduled-occurrences?'))
          return { items: [], unavailableNodeIds: [], nextCursor: null };
        return {
          ...history,
          taskId: matches ? task.id : 'another-task',
          snapshot: { objective: 'Recorded prompt' }
        };
      });
      const view = renderComponent(ScheduledTasksPanel, {
        request,
        section: 'history',
        linkedTask: { ...scope, nodeId: 'b', id: task.id, reference }
      });
      try {
        await flushComponent();
        expect(request.mock.calls.map(([path]) => path)).toContain(
          '/api/scheduled-occurrences/record?nodeId=b&workspaceId=work'
        );
        expect(textContent(view.root).includes('Recorded prompt')).toBe(matches);
        expect(view.findAll('ScheduledTaskEditor')).toHaveLength(0);
      } finally {
        view.unmount();
      }
    }
  );
});
