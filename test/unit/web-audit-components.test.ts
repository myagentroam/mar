import { afterEach, describe, expect, it, vi } from 'vitest';
import { showMessage } from '../../packages/web-core/src/service/message-feedback-service.js';
import Audit from '../../ee/web/src/view/settings/AuditManagementPage.vue?unit-render';
import { i18n } from '../../ee/web/src/service/locale-preference-service.js';
import {
  renderComponent,
  flushComponent,
  trigger,
  textContent
} from '../../packages/web-core/test/unit/support/component-renderer.js';

const initialLocale = i18n.global.locale.value;
vi.mock('../../packages/web-core/src/service/message-feedback-service.js', () => ({
  showMessage: vi.fn()
}));
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  i18n.global.locale.value = initialLocale;
});
const modes = [
  ['NEW_SESSION', 'inputModeNewSession'],
  ['SEND', 'inputModeSend'],
  ['CONTINUE', 'inputModeContinue'],
  ['STEER', 'inputModeSteer'],
  ['QUEUE', 'inputModeQueue'],
  ['REPLACE_CURRENT', 'inputModeReplaceCurrent'],
  ['RUN_NOW', 'inputModeRunNow'],
  ['USER_INPUT_RESPONSE', 'inputModeUserInputResponse'],
  ['EDIT_QUEUE', 'inputModeEditQueue'],
  ['DELETE_QUEUE', 'inputModeDeleteQueue'],
  ['REORDER_QUEUE', 'inputModeReorderQueue'],
  ['EXECUTE_QUEUE', 'inputModeExecuteQueue'],
  ['PAUSE_QUEUE', 'inputModePauseQueue'],
  ['RESUME_QUEUE', 'inputModeResumeQueue']
] as const;
const events = modes.map(([inputMode], index) => ({
  id: `event/${index}`,
  inputMode,
  eventType: 'conversation_input_recorded',
  occurredAt: 1_700_000_000_000,
  result: 'SUCCESS',
  errorCode: 'MUST_NOT_DISPLAY',
  actorUserId: 1,
  actorUsername: 'Reviewer',
  authenticationMethod: 'PASSWORD',
  requestId: null,
  hasConversationPayload: true
}));

let intersection: ((entries: { isIntersecting: boolean }[]) => void) | undefined;
function browser(mobile: boolean) {
  const location = new URL('https://fixture.test/console');
  vi.stubGlobal('window', {
    location,
    history: { state: null, replaceState() {} },
    matchMedia: () => ({ matches: mobile, addEventListener() {}, removeEventListener() {} }),
    addEventListener() {},
    removeEventListener() {}
  });
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
        intersection = callback;
      }
      observe() {}
      disconnect() {}
    }
  );
}

function detailFixture() {
  browser(false);
  const pending: { resolve: (value: unknown) => void; reject: (error: Error) => void }[] = [];
  const request = vi.fn((path: string) => {
    if (path.includes('?'))
      return Promise.resolve({
        events,
        total: events.length,
        page: 1,
        pageSize: 20,
        hasMore: false
      });
    return new Promise((resolve, reject) => pending.push({ resolve, reject }));
  });
  const view = renderComponent(Audit, { request });
  return {
    view,
    pending,
    open(index: number) {
      const table = view.findAll('ElTable')[0]!;
      return (table.props['onRowClick'] as (event: unknown) => Promise<void>)(events[index]);
    },
    text: () => textContent(view.findAll('ElDialog')[0]!)
  };
}

function detail(index: number, message: string) {
  return {
    ...events[index],
    conversationPayload: { conversationTitle: 'Audit detail', userMessage: message }
  };
}

describe('Audit management behavior', () => {
  it('keeps B when detail requests succeed in reverse order', async () => {
    const fixture = detailFixture();
    try {
      await flushComponent();
      const a = fixture.open(0);
      const b = fixture.open(1);
      fixture.pending[1]!.resolve(detail(1, 'Current B payload'));
      await b;
      await flushComponent();
      expect(fixture.text()).toContain('Current B payload');
      fixture.pending[0]!.resolve(detail(0, 'Obsolete A payload'));
      await a;
      await flushComponent();
      expect(fixture.text()).toContain('Current B payload');
      expect(fixture.text()).not.toContain('Obsolete A payload');
    } finally {
      fixture.view.unmount();
    }
  });

  it('suppresses an old failure while B is pending and reports only the current failure', async () => {
    const fixture = detailFixture();
    try {
      await flushComponent();
      const a = fixture.open(0);
      const b = fixture.open(1);
      fixture.pending[0]!.reject(new Error('Obsolete A failure'));
      await a;
      await flushComponent();
      expect(showMessage).not.toHaveBeenCalled();
      expect(fixture.text()).toContain(events[1]!.id);
      fixture.pending[1]!.reject(new Error('Current B failure'));
      await b;
      await flushComponent();
      expect(showMessage).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining('Current B failure'),
        'error',
        expect.any(Error)
      );
      expect(fixture.text()).toContain(events[1]!.id);
    } finally {
      fixture.view.unmount();
    }
  });

  it.each(['footer', 'close', 'model'] as const)(
    'invalidates pending detail on %s close, including reopening the same target',
    async (close) => {
      const fixture = detailFixture();
      try {
        await flushComponent();
        const a = fixture.open(0);
        await flushComponent();
        const dialog = fixture.view.findAll('ElDialog')[0]!;
        if (close === 'footer') {
          const button = fixture.view
            .findAll('ElButton')
            .find((entry) => textContent(entry) === i18n.global.t('common.close'))!;
          await trigger(button, 'onClick');
        } else {
          await trigger(dialog, close === 'close' ? 'onClose' : 'onUpdate:modelValue', false);
        }
        expect(fixture.view.findAll('ElDialog')).toHaveLength(0);
        const reopened = fixture.open(0);
        fixture.pending[0]!.resolve(detail(0, 'Closed payload'));
        await a;
        await flushComponent();
        expect(fixture.text()).not.toContain('Closed payload');
        fixture.pending[1]!.resolve(detail(0, 'Reopened payload'));
        await reopened;
        await flushComponent();
        expect(fixture.text()).toContain('Reopened payload');
      } finally {
        fixture.view.unmount();
      }
    }
  );

  it.each(['success', 'failure'] as const)(
    'does not restore closed details or report a late %s',
    async (outcome) => {
      const fixture = detailFixture();
      try {
        await flushComponent();
        const pending = fixture.open(0);
        await flushComponent();
        await trigger(fixture.view.findAll('ElDialog')[0]!, 'onClose');
        if (outcome === 'success') fixture.pending[0]!.resolve(detail(0, 'Closed payload'));
        else fixture.pending[0]!.reject(new Error('Closed failure'));
        await pending;
        await flushComponent();
        expect(fixture.view.findAll('ElDialog')).toHaveLength(0);
        expect(showMessage).not.toHaveBeenCalled();
      } finally {
        fixture.view.unmount();
      }
    }
  );

  it.each(['success', 'failure'] as const)(
    'ignores a detail %s after the page unmounts',
    async (outcome) => {
      const fixture = detailFixture();
      await flushComponent();
      const pending = fixture.open(0);
      fixture.view.unmount();
      if (outcome === 'success') fixture.pending[0]!.resolve(detail(0, 'Unmounted payload'));
      else fixture.pending[0]!.reject(new Error('Unmounted failure'));
      await pending;
      await flushComponent();
      expect(showMessage).not.toHaveBeenCalled();
      expect(fixture.view.findAll('ElDialog')).toHaveLength(0);
    }
  );

  it.each(['en-US', 'zh-CN'] as const)(
    'renders server pages, localized input modes and fetched detail payloads in %s',
    async (locale) => {
      browser(false);
      i18n.global.locale.value = locale;
      const request = vi.fn(async (path: string, _init?: RequestInit) => {
        if (path.startsWith('/api/audit-events?'))
          return { events, total: 47, page: 3, pageSize: 20, hasMore: false };
        const event = events.find((entry) => path.endsWith(encodeURIComponent(entry.id)))!;
        return {
          ...event,
          conversationPayload: {
            conversationTitle: 'Review result',
            userMessage: 'Original user content'
          }
        };
      });
      const view = renderComponent(Audit, { request });
      try {
        await flushComponent();
        const query = new URL(request.mock.calls[0]![0], 'https://fixture.test').searchParams;
        expect(query.get('limit')).toBe('20');
        expect(query.get('page')).toBe('1');
        expect(view.findAll('ElTable')[0]!.props.data).toEqual(events);
        const paginator = view.findAll('ElPagination')[0]!;
        expect(paginator.props.total).toBe(47);
        expect(paginator.props['current-page']).toBe(3);
        await trigger(paginator, 'onCurrentChange', 2);
        await flushComponent();
        expect(
          new URL(request.mock.calls[1]![0], 'https://fixture.test').searchParams.get('page')
        ).toBe('2');
        for (const [index, [, key]] of modes.entries()) {
          await trigger(view.findAll('ElTable')[0]!, 'onRowClick', events[index]);
          await flushComponent();
          expect(request).toHaveBeenLastCalledWith(
            `/api/audit-events/${encodeURIComponent(events[index]!.id)}`,
            { cache: 'no-store' }
          );
          const dialog = view.findAll('ElDialog')[0]!;
          const label = i18n.global.t(`generated.auditManagementPage.${key}`);
          expect(label).not.toContain('generated.');
          expect(textContent(dialog)).toContain(label);
          expect(textContent(dialog)).toContain('Original user content');
          expect(textContent(dialog)).not.toContain('MUST_NOT_DISPLAY');
          const labels = view.findAll('ElDescriptionsItem').map((item) => item.props.label);
          expect(labels).not.toContain(i18n.global.t('generated.auditManagementPage.requestID'));
          const close = view
            .findAll('ElButton')
            .find((button) => textContent(button) === i18n.global.t('common.close'))!;
          await trigger(close, 'onClick');
          expect(view.findAll('ElDialog')).toHaveLength(0);
        }
      } finally {
        view.unmount();
      }
    }
  );

  it('appends mobile pages at the visible boundary without duplicate events', async () => {
    browser(true);
    const firstPage = Array.from({ length: 20 }, (_, index) => ({
      ...events[0],
      id: `event-${index}`
    }));
    const request = vi.fn(async (path: string) =>
      path.includes('page=2')
        ? {
            events: [firstPage[0], { ...events[1], id: 'next-event' }],
            total: 21,
            page: 2,
            pageSize: 20,
            hasMore: false
          }
        : { events: firstPage, total: 21, page: 1, pageSize: 20, hasMore: true }
    );
    const view = renderComponent(Audit, { request });
    try {
      await flushComponent();
      expect(view.findAll('ElPagination')).toHaveLength(0);
      expect(intersection).toBeDefined();
      intersection!([{ isIntersecting: true }]);
      await flushComponent();
      expect(request.mock.calls.at(-1)![0]).toContain('page=2');
      expect(view.findAll('ElTable')[0]!.props.data).toEqual([
        ...firstPage,
        { ...events[1], id: 'next-event' }
      ]);
    } finally {
      view.unmount();
    }
  });
});
