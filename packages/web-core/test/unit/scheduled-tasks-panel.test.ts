import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reactive } from 'vue';
import { scheduledTaskClient } from '../../src/service/scheduled-task-client.js';
import type {
  ScheduleCard,
  ScheduleInvalidation,
  ScheduleTaskLink
} from '../../src/service/scheduled-task-client.js';
import { i18n } from '../../src/service/locale-preference-service.js';
import ScheduledTasksPanel from '../../src/view/schedule/ScheduledTasksPanel.vue?unit-render';
import {
  parseTriggerDraft,
  pickerDate,
  triggerDraft
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
const taskPage = (items: ScheduleCard[], page = 1, total = items.length, pageSize = 20) => ({
  items,
  nodes: [node],
  page,
  pageSize,
  total,
  hasMore: page * pageSize < total,
  unavailableNodeIds: []
});
const sessionContext = { scope: { ...scope, sessionId: 'session' }, title: 'Build checks' };
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
  it('enables creation only after the target catalog includes an online supported node', async () => {
    const first = deferred<ReturnType<typeof taskPage>>();
    const second = deferred<ReturnType<typeof taskPage>>();
    const request = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const view = renderComponent(ScheduledTasksPanel, { request, section: 'mine' });
    try {
      expect(button(view, 'New schedule').props.disabled).toBe(true);
      first.resolve({
        ...taskPage([]),
        nodes: [
          { ...node, connected: false },
          { ...node, id: 'b', supported: false }
        ]
      });
      await flushComponent();
      expect(button(view, 'New schedule').props.disabled).toBe(true);
      const refresh = trigger(button(view, 'Refresh'), 'onClick');
      second.resolve(taskPage([]));
      await refresh;
      expect(button(view, 'New schedule').props.disabled).toBe(false);
    } finally {
      view.unmount();
    }
  });

  it.each([
    ['mine', false, 'My schedules', 'View and manage your scheduled tasks.'],
    ['all', false, 'All schedules', 'View all scheduled tasks you have access to.'],
    ['all', true, 'Session schedules', 'Current session: Build checks'],
    ['history', true, 'Execution records', 'See when scheduled tasks ran and how they ended.']
  ] as const)(
    'identifies the %s section with a title and summary (session context: %s)',
    async (section, sessionScoped, title, summary) => {
      const request = vi.fn().mockResolvedValue(taskPage([]));
      const onBackToAll = vi.fn();
      const view = renderComponent(ScheduledTasksPanel, {
        request,
        section,
        session: sessionScoped ? sessionContext : undefined,
        onBackToAll
      });
      try {
        await flushComponent();
        const [header] = view.findAll('header');
        const [heading, description] = header!.children;
        expect(heading?.type).toBe('h2');
        expect(textContent(heading!)).toBe(title);
        expect(description?.type).toBe('p');
        expect(textContent(description!)).toBe(summary);
        expect(header!.parent?.props['aria-labelledby']).toBe(heading?.props.id);
        if (section === 'all' && sessionScoped) {
          const back = view
            .findAll('button')
            .find((node) => textContent(node) === 'Back to all schedules');
          expect(back).toBeDefined();
          await trigger(back!, 'onClick');
          expect(onBackToAll).toHaveBeenCalledOnce();
          expect(textContent(view.root)).toContain('No scheduled tasks for this session.');
        }
      } finally {
        view.unmount();
      }
    }
  );

  it('keeps each run time independent and validates an unfinished selection', () => {
    const a = triggerDraft(1);
    a.kind = 'weekly';
    a.weekdays = [1, 3, 5];
    a.time = '10:00';
    const b = triggerDraft(2);
    b.date = new Date(2028, 1, 29);
    b.time = '14:30';
    expect(parseTriggerDraft(a)).toEqual({
      success: true,
      data: { kind: 'weekly', weekdays: [1, 3, 5], time: '10:00' }
    });
    expect(parseTriggerDraft(b)).toEqual({
      success: true,
      data: { kind: 'once', date: '2028-02-29', time: '14:30' }
    });
    a.time = null;
    b.date = null;
    expect(parseTriggerDraft(a).success).toBe(false);
    expect(parseTriggerDraft(b).success).toBe(false);
  });

  it('round-trips a civil date, using a node suggestion until the user picks a date', () => {
    const saved = { kind: 'once' as const, date: '2028-02-29', time: '00:00' };
    const draft = triggerDraft(1, saved);
    draft.suggestedDate = pickerDate('2028-02-28');
    expect(draft.date?.getDate()).toBe(29);
    expect(parseTriggerDraft(draft)).toEqual({ success: true, data: saved });
    draft.date = null;
    expect(parseTriggerDraft(draft)).toEqual({
      success: true,
      data: { ...saved, date: '2028-02-28' }
    });
    draft.kind = 'daily';
    expect(parseTriggerDraft(draft)).toEqual({
      success: true,
      data: { kind: 'daily', time: '00:00' }
    });
  });

  it('restores selected month days without mutating the saved trigger', () => {
    const saved = { kind: 'monthly' as const, time: '23:59', monthDays: [15, 31] };
    const draft = triggerDraft(1, saved);
    expect(parseTriggerDraft(draft)).toEqual({ success: true, data: saved });
    draft.monthDays.splice(0);
    expect(parseTriggerDraft(draft).success).toBe(false);
    expect(saved.monthDays).toEqual([15, 31]);
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
      .mockResolvedValueOnce(taskPage([task]))
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
      const pager = () => view.findAll('MarPagination').at(-1)!;
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

  it('replaces desktop cards and drops an obsolete page when the task scope changes', async () => {
    const second = { ...task, id: 'second', name: 'Task B' };
    const stale = deferred<ReturnType<typeof taskPage>>();
    const request = vi
      .fn()
      .mockResolvedValueOnce(taskPage([task], 1, 2, 1))
      .mockResolvedValueOnce(taskPage([second], 2, 2, 1))
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce(taskPage([task]));
    const props = reactive<{ request: typeof request; section: 'mine' | 'all' }>({
      request,
      section: 'mine'
    });
    const view = renderComponent(ScheduledTasksPanel, props);
    try {
      await flushComponent();
      const pager = () => view.findAll('MarPagination')[0]!;
      const cards = () => view.findAll('h3').map(textContent);
      expect(cards()).toEqual([task.name]);
      await trigger(pager(), 'onCurrentChange', 2);
      expect(cards()).toEqual([second.name]);
      expect(pager().props.currentPage).toBe(2);
      await trigger(pager(), 'onCurrentChange', 1);
      props.section = 'all';
      await flushComponent();
      stale.resolve(taskPage([{ ...task, name: 'Stale' }]));
      await flushComponent();
      expect(request.mock.calls[2]?.[1].signal.aborted).toBe(true);
      expect(request.mock.calls.map(([path]) => path)).toEqual([
        '/api/scheduled-tasks?mine=true&page=1',
        '/api/scheduled-tasks?mine=true&page=2',
        '/api/scheduled-tasks?mine=true&page=1',
        '/api/scheduled-tasks?mine=false&page=1'
      ]);
      expect(cards()).toEqual([task.name]);
      expect(pager().props).toMatchObject({ currentPage: 1, total: 1 });
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
      read.resolve(taskPage([task]));
      await flushComponent();
      expect(textContent(second.root)).toContain('Forbidden');
      expect(textContent(second.root)).not.toContain(task.name);
      expect(button(second, 'New schedule').props.disabled).toBe(true);
    } finally {
      second.unmount();
    }
  });

  it('restarts mobile cards from the first page when the server clamps an append', async () => {
    const second = { ...task, id: 'second', name: 'Second task' };
    const current = { ...task, id: 'current', name: 'Current task' };
    const request = vi
      .fn()
      .mockResolvedValueOnce(taskPage([task], 1, 3, 1))
      .mockResolvedValueOnce(taskPage([second], 2, 3, 1))
      .mockResolvedValueOnce(taskPage([second], 2, 2, 1))
      .mockResolvedValueOnce(taskPage([current], 1, 2, 1));
    let notify: IntersectionObserverCallback | undefined;
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: IntersectionObserverCallback) {
          notify = callback;
        }
        observe() {}
        disconnect() {}
      }
    );
    const intersect = (isIntersecting: boolean) =>
      notify?.([{ isIntersecting } as IntersectionObserverEntry], {} as IntersectionObserver);
    const view = renderComponent(ScheduledTasksPanel, { request, section: 'mine', mobile: true });
    try {
      await flushComponent();
      intersect(true);
      await flushComponent();
      const cards = () => view.findAll('h3').map(textContent);
      expect(cards()).toEqual([task.name, second.name]);
      intersect(false);
      intersect(true);
      await flushComponent();
      expect(
        request.mock.calls.map(([path]) =>
          new URL(path, 'https://test.invalid').searchParams.get('page')
        )
      ).toEqual(['1', '2', '3', '1']);
      expect(cards()).toEqual([current.name]);
    } finally {
      view.unmount();
      vi.unstubAllGlobals();
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

  it('shows a neutral task empty state without listing unavailable nodes', async () => {
    const request = vi.fn().mockResolvedValue({ ...taskPage([]), unavailableNodeIds: ['b'] });
    const view = renderComponent(ScheduledTasksPanel, { request, section: 'mine' });
    try {
      await flushComponent();
      expect(textContent(view.root)).toContain('No scheduled tasks to show.');
      expect(textContent(view.root)).not.toContain('Unavailable nodes');
    } finally {
      view.unmount();
    }
  });

  it('only reports an empty history list after a complete read', async () => {
    const empty = 'No execution records in this scope.';
    const result = historyPage([]);
    const request = vi
      .fn()
      .mockResolvedValueOnce({ ...result, unavailableNodeIds: ['b'] })
      .mockResolvedValueOnce({ ...result, unavailableNodeIds: [] });
    const view = renderComponent(ScheduledTasksPanel, { request, section: 'history' });
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

  it('opens online card details separately from editing and linked session navigation', async () => {
    const request = vi.fn(async (path: string) =>
      path.includes('/same-id?')
        ? { task: { ...task, triggers: [] }, mine: true, proposals: [] }
        : taskPage([
            task,
            { ...task, nodeId: 'b', name: 'Offline', offline: true },
            {
              ...task,
              id: 'new-session',
              name: 'New session',
              sessionId: null,
              targetKind: 'newSession'
            }
          ])
    );
    const onOpenTarget = vi.fn();
    const view = renderComponent(ScheduledTasksPanel, { request, onOpenTarget, section: 'all' });
    try {
      await flushComponent();
      const controls = (label: string) =>
        view.findAll('MarButton').filter((item) => textContent(item).trim() === label);
      expect(controls('project')).toHaveLength(0);
      expect(controls('Offline')).toHaveLength(0);
      expect(controls('New session')).toHaveLength(1);
      expect(controls('session')).toHaveLength(1);
      expect(controls('Task A')).toHaveLength(1);
      await trigger(controls('session')[0]!, 'onClick');
      expect(onOpenTarget).toHaveBeenCalledExactlyOnceWith({ ...scope, sessionId: 'session' });
      expect(request).toHaveBeenCalledTimes(1);
      await trigger(controls('Task A')[0]!, 'onClick');
      expect(request.mock.calls.map(([path]) => path)).toContain(
        '/api/scheduled-tasks/same-id?nodeId=a&workspaceId=work'
      );
      expect(onOpenTarget).toHaveBeenCalledTimes(1);
      expect(controls('Save')).toHaveLength(0);
    } finally {
      view.unmount();
    }
  });

  it.each([
    { sessionId: 'session', label: 'Build checks' },
    { sessionId: 'replacement', label: 'replacement' }
  ])(
    'labels the detail binding $sessionId without looking beyond the first session page',
    async ({ sessionId, label }) => {
      const request = vi.fn(async (path: string) => {
        if (path.startsWith('/api/agent-sessions?')) return { sessions: [], nextCursor: 'next' };
        if (path.startsWith('/api/workspaces?')) return { workspaces: [] };
        if (path.includes('/same-id?'))
          return { task: { ...task, sessionId, triggers: [] }, mine: true, proposals: [] };
        return taskPage([{ ...task, sessionTitle: 'Build checks' }]);
      });
      const view = renderComponent(ScheduledTasksPanel, { request, section: 'all' });
      try {
        await flushComponent();
        await trigger(button(view, 'Task A'), 'onClick');
        expect(
          view.findAll('MarOption').find((option) => option.props.value === sessionId)?.props.label
        ).toBe(label);
        expect(
          request.mock.calls.filter(([path]) => path.startsWith('/api/agent-sessions?'))
        ).toHaveLength(1);
      } finally {
        view.unmount();
      }
    }
  );

  it('keeps a scheduled refresh when a different Workspace changes and releases it on unmount', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const request = vi.fn(async (path: string) =>
      path.startsWith('/api/scheduled-tasks') ? taskPage([task]) : historyPage([])
    );
    const props = reactive({
      request,
      section: 'mine' as const,
      session: sessionContext,
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

  it('closes a locked creation form only when its Workspace authority needs revalidation', async () => {
    const request = vi.fn(async (path: string) =>
      path.startsWith('/api/workspaces?')
        ? { workspaces: [{ id: scope.workspaceId, path: '/project', kind: 'DIRECTORY' }] }
        : taskPage([])
    );
    const props = reactive({
      request,
      section: 'all' as const,
      session: sessionContext,
      invalidation: undefined as ScheduleInvalidation | undefined
    });
    const view = renderComponent(ScheduledTasksPanel, props);
    try {
      await flushComponent();
      await trigger(button(view, 'New schedule'), 'onClick');
      expect(view.findAll('MarDialog')).toHaveLength(1);
      props.invalidation = { ...scope, workspaceId: 'other', verify: true };
      await flushComponent();
      expect(view.findAll('MarDialog')).toHaveLength(1);
      props.invalidation = scope;
      await flushComponent();
      expect(view.findAll('MarDialog')).toHaveLength(1);
      props.invalidation = { ...scope, verify: true };
      await flushComponent();
      expect(view.findAll('MarDialog')).toHaveLength(0);
    } finally {
      view.unmount();
    }
  });

  it('invalidates a linked task outside the Workspace filter without reloading the filtered list', async () => {
    const linked = { nodeId: 'b', workspaceId: 'other', id: 'linked' };
    const detail = deferred<unknown>();
    const request = vi.fn((path: string, _init?: RequestInit) =>
      path.startsWith('/api/scheduled-tasks?')
        ? Promise.resolve({ ...taskPage([task]), workspaces: [task] })
        : detail.promise
    );
    const props = reactive({
      request,
      section: 'mine' as const,
      linkedTask: undefined as ScheduleTaskLink | undefined,
      invalidation: undefined as ScheduleInvalidation | undefined
    });
    const view = renderComponent(ScheduledTasksPanel, props);
    try {
      await flushComponent();
      await trigger(view.findAll('MarSelect')[0]!, 'onUpdate:modelValue', '["a","work"]');
      expect(request.mock.calls[1]?.[0]).toContain('workspaceId=work');
      props.linkedTask = { ...linked, reference: { kind: 'proposal', id: 'proposal' } };
      await flushComponent();
      expect(request.mock.calls[2]?.[0]).toBe(
        '/api/scheduled-tasks/linked?nodeId=b&workspaceId=other'
      );
      expect(view.findAll('MarDialog')).toHaveLength(1);
      props.invalidation = { ...linked, verify: true };
      await flushComponent();
      expect(view.findAll('MarDialog')).toHaveLength(0);
      expect(request.mock.calls[2]?.[1]?.signal?.aborted).toBe(true);
      detail.reject(new Error('Stale result'));
      await flushComponent();
      expect(request).toHaveBeenCalledTimes(3);
      expect(textContent(view.root)).not.toContain('Stale result');
    } finally {
      view.unmount();
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
    const onOpenTarget = vi.fn();
    const view = renderComponent(ScheduledTasksPanel, {
      request,
      onOpenTarget,
      section: 'history',
      session: sessionContext
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
      expect(onOpenTarget).toHaveBeenCalledExactlyOnceWith({ ...scope, nodeId: 'b', ...run });
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
      if (path.startsWith('/api/scheduled-tasks?')) return taskPage([task]);
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
