import { afterEach, describe, expect, it, vi } from 'vitest';
import Audit from '../../ee/web/src/view/settings/AuditManagementPage.vue?unit-render';
import { i18n } from '../../ee/web/src/service/locale-preference-service.js';
import {
  renderComponent,
  flushComponent,
  trigger,
  textContent
} from '../../packages/web-core/test/unit/support/component-renderer.js';

const initialLocale = i18n.global.locale.value;
afterEach(() => {
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
      observe() {}
      disconnect() {}
    }
  );
}

describe('Audit management behavior', () => {
  it.each(['en-US', 'zh-CN'] as const)(
    'renders server pages, localized input modes and fetched detail payloads in %s',
    async (locale) => {
      browser(false);
      i18n.global.locale.value = locale;
      const request = vi.fn(async (path: string, _init?: RequestInit) => {
        if (path.startsWith('/api/audit-events?')) return { events, total: 47, page: 3 };
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

  it('appends mobile cursor pages without duplicate events', async () => {
    browser(true);
    const firstPage = Array.from({ length: 20 }, (_, index) => ({
      ...events[0],
      id: `event-${index}`
    }));
    const request = vi.fn(async (path: string) =>
      path.includes('cursor=next')
        ? { events: [firstPage[0], { ...events[1], id: 'next-event' }] }
        : { events: firstPage, total: 21, page: 1, nextCursor: 'next' }
    );
    const view = renderComponent(Audit, { request });
    try {
      await flushComponent();
      expect(view.findAll('ElPagination')).toHaveLength(0);
      const loadMore = view
        .findAll('ElButton')
        .find((button) => textContent(button) === i18n.global.t('common.loadMore'))!;
      await trigger(loadMore, 'onClick');
      await flushComponent();
      expect(request.mock.calls.at(-1)![0]).toContain('cursor=next');
      expect(view.findAll('ElTable')[0]!.props.data).toEqual([
        ...firstPage,
        { ...events[1], id: 'next-event' }
      ]);
    } finally {
      view.unmount();
    }
  });
});
