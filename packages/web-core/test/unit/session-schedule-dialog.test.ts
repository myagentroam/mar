import { createRenderer, h, nextTick, reactive, ssrContextKey } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ElMessage } from 'element-plus';
import SessionScheduleDialog from '../../src/view/workspace/SessionScheduleDialog.vue';
import RenderedScheduleDialog from '../../src/view/workspace/SessionScheduleDialog.vue?unit-render';
import { renderComponent, flushComponent, trigger } from './support/component-renderer.js';
import { i18n, localePreferenceService } from '../../src/service/locale-preference-service.js';

vi.mock('element-plus', () => ({ ElMessage: { error: vi.fn(), success: vi.fn() } }));
const originalLocale = localePreferenceService().locale.value;
afterEach(() => {
  localePreferenceService().setLocale(originalLocale);
  vi.clearAllMocks();
});

function page(number: number, total = 25) {
  return {
    task: {
      id: 'task',
      objective: 'Saved objective',
      cron: '0 9 * * *',
      timezone: 'UTC',
      enabled: true,
      notifyOnTerminal: false,
      revision: 1,
      ownerUserId: 1,
      nextRunAt: null
    },
    currentUserName: 'User',
    notifyUserName: 'User',
    nodeTimezone: 'UTC',
    proposals: [],
    canResolveProposals: true,
    occurrencePage: number,
    occurrenceTotal: total,
    occurrences: Array.from(
      { length: Math.max(0, Math.min(10, total - (number - 1) * 10)) },
      (_, index) => ({
        id: `${number}-${index}`,
        due_at: 1000 - index,
        status: 'SUCCEEDED',
        code: null
      })
    )
  };
}
async function settle() {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await nextTick();
}
function mount(request: ReturnType<typeof vi.fn>) {
  type Node = { type: string; props: Record<string, unknown> };
  const renderer = createRenderer<Node, Node>({
    patchProp() {},
    insert() {},
    remove() {},
    setText() {},
    setElementText() {},
    createElement: (type) => ({ type, props: {} }),
    createText: () => ({ type: '#text', props: {} }),
    createComment: () => ({ type: '#comment', props: {} }),
    parentNode: () => null,
    nextSibling: () => null
  });
  const props = reactive({
    modelValue: true,
    session: { id: 'one' } as never,
    nodeId: 'node',
    workspaceId: 'workspace',
    request: request as never
  });
  let state: Record<string, unknown>;
  const app = renderer.createApp({
    render: () =>
      h(SessionScheduleDialog, {
        ...props,
        onVnodeMounted: (vnode) => {
          state = (vnode.component as unknown as { setupState: Record<string, unknown> })
            .setupState;
        }
      })
  });
  app.use(i18n);
  app.provide(ssrContextKey, { modules: new Set<string>() });
  app.config.warnHandler = () => {};
  app.mount({ type: 'root', props: {} });
  return { app, props, state: () => state! };
}

describe('scheduled session configuration status', () => {
  it.each(['zh-CN', 'en-US'] as const)(
    'keeps an unconfigured task off and distinguishes unsaved defaults (%s)',
    async (locale) => {
      localePreferenceService().setLocale(locale);
      const result = { ...page(1, 0), task: null };
      let resolve!: (value: typeof result) => void;
      const request = vi.fn(() => new Promise((done) => (resolve = done)));
      const view = mount(request);
      const expected = locale === 'zh-CN' ? '未配置' : 'Not configured';
      try {
        expect(view.state()['enabled']).toBe(false);
        expect(view.state()['statusLabel']).toBe('');
        resolve(result);
        await settle();
        expect(view.state()['task']).toBeNull();
        expect(view.state()['enabled']).toBe(false);
        expect(view.state()['statusLabel']).toBe(expected);
        expect(view.state()['form']).toMatchObject({ objective: '', time: '09:00' });
        expect(view.state()['cadence']).toBe('DAILY');
        view.state()['enabled'] = true;
        expect(view.state()['statusLabel']).toBe(expected);
        expect(request).toHaveBeenCalledOnce();
      } finally {
        view.app.unmount();
      }
    }
  );

  it('does not mistake a failed initial read for an unconfigured task or allow saving', async () => {
    localePreferenceService().setLocale('en-US');
    const request = vi.fn().mockRejectedValue(new Error('offline'));
    const view = mount(request);
    try {
      await settle();
      expect(view.state()['enabled']).toBe(false);
      expect(view.state()['statusLabel']).toBe('');
      expect(ElMessage.error).toHaveBeenCalledOnce();
      (view.state()['form'] as { objective: string }).objective = 'New task';
      view.state()['formRef'] = { validate: vi.fn().mockResolvedValue(true) };
      await (view.state()['save'] as () => Promise<void>)();
      expect(request).toHaveBeenCalledOnce();
    } finally {
      view.app.unmount();
    }
  });

  it.each([false, true])(
    'shows the persisted status only after saving a new task (%s)',
    async (enabled) => {
      localePreferenceService().setLocale('en-US');
      const saved = page(1, 0);
      saved.task.enabled = enabled;
      const request = vi
        .fn()
        .mockResolvedValueOnce({ ...page(1, 0), task: null })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce(saved);
      const view = mount(request);
      try {
        await settle();
        (view.state()['form'] as { objective: string }).objective = 'New task';
        if (enabled) view.state()['enabled'] = true;
        view.state()['formRef'] = { validate: vi.fn().mockResolvedValue(true) };
        expect(view.state()['statusLabel']).toBe('Not configured');
        await (view.state()['save'] as () => Promise<void>)();
        expect(request.mock.calls[1]![1].method).toBe('PUT');
        expect(JSON.parse(request.mock.calls[1]![1].body)).toMatchObject({
          objective: 'New task',
          enabled
        });
        expect(view.state()['statusLabel']).toBe(enabled ? 'Enabled' : 'Paused');
      } finally {
        view.app.unmount();
      }
    }
  );

  it.each([true, false])('preserves the saved task enabled state (%s)', async (enabled) => {
    localePreferenceService().setLocale('en-US');
    const result = page(1, 0);
    result.task.enabled = enabled;
    const view = mount(vi.fn().mockResolvedValue(result));
    try {
      await settle();
      expect(view.state()['task']).toMatchObject({ id: 'task', enabled });
      expect(view.state()['enabled']).toBe(enabled);
      expect(view.state()['statusLabel']).toBe(enabled ? 'Enabled' : 'Paused');
    } finally {
      view.app.unmount();
    }
  });

  it.each(['session', 'nodeId', 'workspaceId'] as const)(
    'does not carry an enabled task into another %s while loading',
    async (field) => {
      const result = { ...page(1, 0), task: null };
      let resolve!: (value: typeof result) => void;
      const request = vi
        .fn()
        .mockResolvedValueOnce(page(1, 0))
        .mockImplementationOnce(() => new Promise((done) => (resolve = done)));
      const view = mount(request);
      try {
        await settle();
        expect(view.state()['enabled']).toBe(true);
        if (field === 'session') view.props.session = { id: 'two' } as never;
        else view.props[field] = 'other';
        await settle();
        expect(view.state()['loading']).toBe(true);
        expect(view.state()['task']).toBeNull();
        expect(view.state()['enabled']).toBe(false);
        expect(view.state()['statusLabel']).toBe('');
        resolve(result);
        await settle();
        expect(view.state()['enabled']).toBe(false);
      } finally {
        view.app.unmount();
      }
    }
  );
});

describe('scheduled session history pagination', () => {
  it('loads the selected ten-record history page and disables paging during its request', async () => {
    const request = vi.fn(async (_url: string) => page(1));
    const view = renderComponent(RenderedScheduleDialog, {
      modelValue: true,
      session: { id: 'one' },
      nodeId: 'node',
      workspaceId: 'workspace',
      request
    });
    try {
      await flushComponent();
      expect(view.findAll('ElPagination')[0]!.props).toMatchObject({
        'current-page': 1,
        'page-size': 10,
        total: 25,
        disabled: false
      });
      let release!: (value: ReturnType<typeof page>) => void;
      request.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          })
      );
      await trigger(view.findAll('ElPagination')[0]!, 'onCurrentChange', 2);
      expect(request.mock.calls.at(-1)?.[0]).toContain('occurrencePage=2');
      expect(view.findAll('ElPagination')[0]!.props.disabled).toBe(true);
      release(page(2));
      await flushComponent();
      expect(view.findAll('ElPagination')[0]!.props).toMatchObject({
        'current-page': 2,
        disabled: false
      });
    } finally {
      view.unmount();
    }
  });

  it.each(['zh-CN', 'en-US'] as const)(
    'loads ten records per page and preserves edited fields when paging (%s)',
    async (locale) => {
      localePreferenceService().setLocale(locale);
      const request = vi.fn(async (url: string) =>
        page(Number(new URL(url, 'http://fixture').searchParams.get('occurrencePage')))
      );
      const view = mount(request);
      try {
        await settle();
        expect(request.mock.calls[0]![0]).toContain('occurrencePage=1');
        expect(view.state()['occurrences']).toHaveLength(10);
        expect(view.state()['occurrenceTotal']).toBe(25);
        const change = view.state()['changeOccurrencePage'] as (value: number) => void;
        const form = view.state()['form'] as { objective: string; cronExpression: string };
        form.objective = 'Unsaved draft';
        form.cronExpression = '*/15 * * * *';
        change(2);
        await settle();
        expect(request.mock.calls[1]![0]).toContain('occurrencePage=2');
        expect(view.state()['occurrences']).toHaveLength(10);
        expect(form).toMatchObject({ objective: 'Unsaved draft', cronExpression: '*/15 * * * *' });
        change(3);
        await settle();
        expect(view.state()['occurrences']).toHaveLength(5);
        expect(view.state()['occurrencePage']).toBe(3);
        view.props.modelValue = false;
        await settle();
        view.props.modelValue = true;
        await settle();
        expect(request.mock.calls.at(-1)![0]).toContain('occurrencePage=1');
      } finally {
        view.app.unmount();
      }
    }
  );

  it('accepts clamped pages, preserves the current page on failure, and ignores a stale session response', async () => {
    let resolve!: (value: ReturnType<typeof page>) => void;
    const request = vi
      .fn()
      .mockResolvedValueOnce(page(1))
      .mockResolvedValueOnce(page(2, 12))
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          })
      )
      .mockResolvedValueOnce(page(1, 0));
    const view = mount(request);
    try {
      await settle();
      const change = view.state()['changeOccurrencePage'] as (value: number) => void;
      change(3);
      await settle();
      expect(view.state()['occurrencePage']).toBe(2);
      expect(view.state()['occurrences']).toHaveLength(2);
      change(1);
      await settle();
      expect(view.state()['occurrencePage']).toBe(2);
      expect(ElMessage.error).toHaveBeenCalledOnce();
      change(1);
      await settle();
      view.props.session = { id: 'two' } as never;
      await settle();
      expect(request.mock.calls.at(-1)![0]).toContain('/two/schedule?');
      resolve(page(3));
      await settle();
      expect(view.state()['occurrences']).toEqual([]);
      expect(view.state()['occurrencePage']).toBe(1);
      expect(view.state()['occurrenceTotal']).toBe(0);
    } finally {
      view.app.unmount();
    }
  });

  it('blocks paging during loads or saves and resets when the Node or Workspace changes', async () => {
    let resolve!: (value: ReturnType<typeof page>) => void;
    const request = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          })
      )
      .mockResolvedValue(page(1));
    const view = mount(request);
    try {
      await settle();
      const change = view.state()['changeOccurrencePage'] as (value: number) => void;
      change(2);
      expect(request).toHaveBeenCalledOnce();
      resolve(page(1));
      await settle();
      view.state()['pendingAction'] = 'save';
      change(2);
      expect(request).toHaveBeenCalledOnce();
      view.state()['pendingAction'] = undefined;
      change(2);
      await settle();
      view.props.nodeId = 'other-node';
      await settle();
      expect(request.mock.calls.at(-1)![0]).toContain('nodeId=other-node');
      expect(request.mock.calls.at(-1)![0]).toContain('occurrencePage=1');
      view.props.workspaceId = 'other-workspace';
      await settle();
      expect(request.mock.calls.at(-1)![0]).toContain('workspaceId=other-workspace');
      expect(request.mock.calls.at(-1)![0]).toContain('occurrencePage=1');
    } finally {
      view.app.unmount();
    }
  });

  it.each(['success', 'failure'] as const)(
    'ignores a pending page %s after the dialog is unmounted',
    async (outcome) => {
      let finish!: () => void;
      const request = vi
        .fn()
        .mockResolvedValueOnce(page(1))
        .mockImplementationOnce(
          () =>
            new Promise((resolve, reject) => {
              finish = () =>
                outcome === 'success' ? resolve(page(2, 12)) : reject(new Error('offline'));
            })
        );
      const view = mount(request);
      let unmounted = false;
      try {
        await settle();
        (view.state()['changeOccurrencePage'] as (value: number) => void)(2);
        await settle();
        view.app.unmount();
        unmounted = true;
        finish();
        await settle();
        expect(view.state()['occurrencePage']).toBe(1);
        expect(view.state()['occurrenceTotal']).toBe(25);
        expect(ElMessage.error).not.toHaveBeenCalled();
        await (view.state()['load'] as () => Promise<void>)();
        expect(request).toHaveBeenCalledTimes(2);
      } finally {
        if (!unmounted) view.app.unmount();
      }
    }
  );

  it('keeps older Node records visible without inventing pagination metadata', async () => {
    const { occurrencePage: _page, occurrenceTotal: _total, ...result } = page(1);
    const request = vi.fn().mockResolvedValue(result);
    const view = mount(request);
    try {
      await settle();
      expect(view.state()['occurrences']).toEqual(result.occurrences);
      expect(view.state()['occurrencePage']).toBe(1);
      expect(view.state()['occurrenceTotal']).toBe(0);
    } finally {
      view.app.unmount();
    }
  });
});
