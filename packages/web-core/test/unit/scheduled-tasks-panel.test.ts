import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reactive } from 'vue';
import { scheduledTaskClient } from '../../src/service/scheduled-task-client.js';
import type { ScheduleInvalidation } from '../../src/service/scheduled-task-client.js';
import { i18n } from '../../src/service/locale-preference-service.js';
import ScheduledTasksPanel from '../../src/view/schedule/ScheduledTasksPanel.vue?unit-render';
import {
  addPickerRow,
  parseTimeDraft,
  timeDraft
} from '../../src/view/schedule/scheduled-time-draft.js';
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
  nodeName: task.nodeName,
  workspaceName: task.workspaceName,
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
const historyPage = (items: (typeof history)[], page = 1, total = items.length, pageSize = 20) => ({
  items,
  page,
  pageSize,
  total,
  hasMore: page * pageSize < total,
  unavailableNodeIds: []
});
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
    a.times[0]!.value = '10:00';
    addPickerRow(a.times);
    a.times[1]!.value = '20:30';
    const b = timeDraft(2);
    b.dayKind = 'dates';
    b.dates[0]!.value = new Date(2028, 1, 29);
    b.times[0]!.value = '14:30';
    expect(parseTimeDraft(a)).toMatchObject({
      success: true,
      data: { days: { weekdays: a.weekdays }, times: { times: ['10:00', '20:30'] } }
    });
    expect(parseTimeDraft(b)).toMatchObject({
      success: true,
      data: { days: { dates: ['2028-02-29'] }, times: { times: ['14:30'] } }
    });
    addPickerRow(a.times);
    expect(parseTimeDraft(a).success).toBe(false);
    b.dates[0]!.value = null;
    expect(parseTimeDraft(b).success).toBe(false);
  });

  it('round-trips specific dates and times as plain values across the picker boundary', () => {
    const saved = {
      days: { kind: 'dates' as const, dates: ['2028-02-29', '2028-03-01'] },
      times: { kind: 'times' as const, times: ['00:00', '23:59'] }
    };
    const draft = timeDraft(1, saved);
    expect(draft.dates[0]!.value?.getDate()).toBe(29);
    expect(parseTimeDraft(draft)).toEqual({ success: true, data: saved });
  });

  it('restores hour and minute selections without mutating the saved combination', () => {
    const saved = {
      days: { kind: 'anyDay' as const },
      times: { kind: 'grid' as const, hours: [0, 23], minutes: [0, 59] }
    };
    const draft = timeDraft(1, saved);
    expect(parseTimeDraft(draft)).toEqual({ success: true, data: saved });

    draft.minutes.splice(0);
    expect(parseTimeDraft(draft).success).toBe(false);
    expect(saved.times.minutes).toEqual([0, 59]);
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
        unavailableNodeIds: [],
        nextCursor: null
      })
      .mockResolvedValueOnce(historyPage([history], 1, 2, 1))
      .mockRejectedValueOnce(new Error('Second page unavailable'))
      .mockResolvedValueOnce(
        historyPage([{ ...history, occurrenceId: 'another', name: 'Older record' }], 2, 2, 1)
      )
      .mockResolvedValueOnce(historyPage([history], 1, 2, 1));
    const view = renderComponent(ScheduledTasksPanel, { request, section: 'mine' });
    try {
      await flushComponent();
      await trigger(button(view, 'Execution records'), 'onClick');
      expect(request.mock.calls[1]?.[0]).toContain('taskId=same-id');
      expect(request.mock.calls[1]?.[0]).toContain('mine=false');
      const pager = () => view.findAll('MarPagination')[0]!;
      expect(pager().props).toMatchObject({ currentPage: 1, total: 2, pageSize: 1 });
      await trigger(pager(), 'onCurrentChange', 2);
      expect(textContent(view.root)).toContain('Second page unavailable');
      expect(view.findAll('MarTable')[0]?.props.data).toMatchObject([history]);
      expect(pager().props.currentPage).toBe(1);
      await trigger(pager(), 'onCurrentChange', 2);
      expect(request.mock.calls[2]?.[0]).toEqual(request.mock.calls[3]?.[0]);
      expect(request.mock.calls[2]?.[0]).toContain('page=2');
      expect(view.findAll('MarTable')[0]?.props.data).toMatchObject([
        { occurrenceId: 'another', name: 'Older record' }
      ]);
      expect(pager().props).toMatchObject({ currentPage: 2, total: 2, pageSize: 1 });
      await trigger(pager(), 'onCurrentChange', 1);
      expect(request.mock.calls[4]?.[0]).toEqual(request.mock.calls[1]?.[0]);
      expect(view.findAll('MarTable')[0]?.props.data).toMatchObject([history]);
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

  it('does not reset global history for connection changes, but refreshes when records change', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const request = vi
      .fn()
      .mockResolvedValueOnce(historyPage([history], 1, 2, 1))
      .mockResolvedValueOnce(historyPage([{ ...history, occurrenceId: 'second' }], 2, 2, 1))
      .mockResolvedValueOnce(historyPage([history], 1, 2, 1));
    const props = reactive({
      request,
      section: 'history' as const,
      invalidation: undefined as ScheduleInvalidation | undefined
    });
    const view = renderComponent(ScheduledTasksPanel, props);
    try {
      await flushComponent();
      const pager = () => view.findAll('MarPagination')[0]!;
      await trigger(pager(), 'onCurrentChange', 2);
      props.invalidation = { nodeId: 'b', verify: true, connectionOnly: true };
      await flushComponent();
      await vi.runOnlyPendingTimersAsync();
      expect(request).toHaveBeenCalledTimes(2);
      expect(pager().props.currentPage).toBe(2);
      props.invalidation = { ...scope, nodeId: 'b' };
      await flushComponent();
      await vi.runOnlyPendingTimersAsync();
      await flushComponent();
      expect(request).toHaveBeenCalledTimes(3);
      expect(pager().props.currentPage).toBe(1);
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  it('does not lose a queued record refresh when the user changes page', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pageTwo = deferred<unknown>();
    const fresh = { ...history, occurrenceId: 'fresh' };
    const request = vi
      .fn()
      .mockResolvedValueOnce(historyPage([history], 1, 2, 1))
      .mockReturnValueOnce(pageTwo.promise)
      .mockResolvedValueOnce(historyPage([fresh], 1, 3, 1));
    const props = reactive({
      request,
      section: 'history' as const,
      invalidation: undefined as ScheduleInvalidation | undefined
    });
    const view = renderComponent(ScheduledTasksPanel, props);
    try {
      await flushComponent();
      props.invalidation = scope;
      await flushComponent();
      await trigger(view.findAll('MarPagination')[0]!, 'onCurrentChange', 2);
      await vi.runOnlyPendingTimersAsync();
      pageTwo.resolve(historyPage([{ ...history, occurrenceId: 'older' }], 2, 2, 1));
      await flushComponent();
      expect(view.findAll('MarTable')[0]?.props.data).toMatchObject([fresh]);
      expect(view.findAll('MarPagination')[0]?.props).toMatchObject({ currentPage: 1, total: 3 });
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  it('keeps mobile history when a clamped page needs a failed first-page reload', async () => {
    const older = { ...history, occurrenceId: 'older' };
    const request = vi
      .fn()
      .mockResolvedValueOnce(historyPage([history], 1, 3, 1))
      .mockResolvedValueOnce(historyPage([{ ...history, occurrenceId: 'second' }], 2, 3, 1))
      .mockResolvedValueOnce(historyPage([{ ...history, occurrenceId: 'second' }], 2, 2, 1))
      .mockRejectedValueOnce(new Error('Refresh unavailable'))
      .mockResolvedValueOnce(historyPage([older]));
    let intersect: IntersectionObserverCallback | undefined;
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: IntersectionObserverCallback) {
          intersect = callback;
        }
        observe() {}
        disconnect() {}
      }
    );
    const view = renderComponent(ScheduledTasksPanel, {
      request,
      section: 'history',
      mobile: true
    });
    try {
      await flushComponent();
      intersect?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver
      );
      await flushComponent();
      intersect?.(
        [{ isIntersecting: false } as IntersectionObserverEntry],
        {} as IntersectionObserver
      );
      intersect?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver
      );
      await flushComponent();
      const rows = () => view.findAll('MarTable')[0]?.props.data;
      expect(rows()).toMatchObject([history, { occurrenceId: 'second' }]);
      await trigger(button(view, 'Failed to load. Retry'), 'onClick');
      expect(
        request.mock.calls.map(([path]) =>
          new URL(path, 'https://test.invalid').searchParams.get('page')
        )
      ).toEqual(['1', '2', '3', '1', '1']);
      expect(rows()).toMatchObject([older]);
      expect(button(view, 'Failed to load. Retry')).toBeUndefined();
    } finally {
      view.unmount();
      vi.unstubAllGlobals();
    }
  });

  it.each([
    ['mine', 'No scheduled tasks in this scope.'],
    ['history', 'No execution records in this scope.']
  ] as const)('only reports an empty %s list after a complete read', async (section, empty) => {
    const result = { ...historyPage([]), nodes: [node], nextCursor: null };
    const request = vi
      .fn()
      .mockResolvedValueOnce({ ...result, unavailableNodeIds: ['b'] })
      .mockResolvedValueOnce({ ...result, unavailableNodeIds: [] });
    const view = renderComponent(ScheduledTasksPanel, { request, section });
    try {
      await flushComponent();
      expect(textContent(view.root)).toContain(
        'Some results may be missing. Unavailable nodes: 1.'
      );
      expect(textContent(view.root)).not.toContain(empty);
      await trigger(button(view, 'Refresh'), 'onClick');
      expect(textContent(view.root)).toContain(empty);
      expect(textContent(view.root)).not.toContain('Unavailable nodes');
    } finally {
      view.unmount();
    }
  });

  it('keeps a scheduled refresh when a different Workspace changes and releases it on unmount', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const request = vi.fn(async (path: string) =>
      path.startsWith('/api/scheduled-tasks')
        ? { items: [task], nodes: [node], unavailableNodeIds: [], nextCursor: null }
        : historyPage([])
    );
    const props = reactive({
      request,
      section: 'mine' as const,
      initial: { ...scope, sessionId: 'session' },
      invalidation: undefined as typeof scope | undefined
    });
    const view = renderComponent(ScheduledTasksPanel, props);
    let mounted = true;
    try {
      await flushComponent();
      await trigger(button(view, 'Execution records'), 'onClick');
      props.invalidation = scope;
      await flushComponent();
      props.invalidation = { ...scope, workspaceId: 'other' };
      await flushComponent();
      await vi.runOnlyPendingTimersAsync();
      expect(request).toHaveBeenCalledTimes(4);
      props.invalidation = scope;
      await flushComponent();
      view.unmount();
      mounted = false;
      await vi.runOnlyPendingTimersAsync();
      expect(request).toHaveBeenCalledTimes(4);
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
        return { ...historyPage([history]), items: [record] };
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
    const view = renderComponent(ScheduledTasksPanel, {
      request,
      onOpenRun,
      section: 'history',
      initial: { ...scope, sessionId: 'session' }
    });
    try {
      await flushComponent();
      expect(request.mock.calls[0]?.[0]).toBe('/api/scheduled-occurrences?mine=false&page=1');
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

  it('refreshes the history query when a record disappears without switching to task cards', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(historyPage([history]))
      .mockRejectedValueOnce(new Error('SCHEDULE_NOT_FOUND'))
      .mockResolvedValueOnce(historyPage([]));
    const view = renderComponent(ScheduledTasksPanel, { request, section: 'history' });
    try {
      await flushComponent();
      await trigger(button(view, task.name), 'onClick');
      expect(request.mock.calls.map(([path]) => path)).toEqual([
        '/api/scheduled-occurrences?mine=false&page=1',
        '/api/scheduled-occurrences/record?nodeId=a&workspaceId=work',
        '/api/scheduled-occurrences?mine=false&page=1'
      ]);
      expect(view.findAll('MarTable')[0]?.props.data).toEqual([]);
      expect(view.findAll('MarDialog')).toHaveLength(1);
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
        if (path.startsWith('/api/scheduled-occurrences?')) return historyPage([]);
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
