import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, provide, reactive, ref } from 'vue';
import {
  AuthenticationContextChangedError,
  createWorkbenchHttpService,
  WORKBENCH_HTTP_KEY,
  type WorkbenchHttpService
} from '../../src/service/workbench-http-service.js';
import { ApiError } from '../../src/util/api-error.js';
import Dock from '../../src/view/terminal/TerminalDock.vue?unit-render';
import { i18n } from '../../src/service/locale-preference-service.js';
import { flushComponent, renderComponent, trigger } from './support/component-renderer.js';

const focus = vi.hoisted(() => vi.fn());
vi.mock('../../src/view/terminal/TerminalTabView.vue?unit-render', async () => {
  const { defineComponent, h } = await import('vue');
  return {
    __esModule: true,
    default: defineComponent({
      props: ['terminalId', 'nodeId', 'workspaceId', 'active', 'visible'],
      setup(props, { expose }) {
        expose({ focus: () => focus(props.terminalId) });
        return () => h('terminal-view', { ...props });
      }
    })
  };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const terminal = {
  id: 'terminal-a',
  workspaceId: 'workspace-a',
  profileId: 'shell',
  state: 'RUNNING',
  latestSequence: 0
};
const pending = () => deferred<Response>();
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
type Handle = { release(): Promise<void>; toggle(): Promise<void> };
function fixture(http?: WorkbenchHttpService) {
  const opening = pending();
  const fetch = vi.fn(async (_path: string, init?: RequestInit) => {
    if (init?.method === 'POST') return (await opening.promise).clone();
    return response({ terminals: [terminal] });
  });
  vi.stubGlobal('fetch', fetch);
  const notice = vi.fn();
  const props = reactive({
    nodeId: 'node-a',
    workspaceId: 'workspace-a',
    errorMessage: (error: unknown) => (error as Error).message,
    csrfToken: 'fixture-csrf',
    renewCsrfToken: async () => 'fixture-renewed',
    enabled: true,
    capability: {
      available: true,
      reasonCode: null,
      supportsReplay: true,
      supportsConPty: false,
      supportsTakeover: false,
      profiles: [{ id: 'shell', label: 'Shell', isDefault: true }]
    },
    nodeOsRelease: undefined,
    visible: true,
    mobileMode: false,
    active: true,
    onNotice: notice,
    ref: (value: unknown) => {
      if (value) handle = value as Handle;
    }
  });
  let handle!: Handle;
  const view = renderComponent(
    http === undefined
      ? Dock
      : defineComponent({
          setup() {
            provide(WORKBENCH_HTTP_KEY, http);
            return () => h(Dock, props);
          }
        }),
    http === undefined ? props : {}
  );
  const requests = (method: string) =>
    fetch.mock.calls.filter(([, init]) => init?.method === method);
  const expand = async () => {
    await flushComponent();
    await trigger(view.findAll('ElButton')[0]!, 'onClick');
    expect(requests('POST')).toHaveLength(1);
  };
  return { view, props, opening, fetch, notice, requests, expand, handle: () => handle };
}

const previousLocale = i18n.global.locale.value;
beforeEach(() => {
  i18n.global.locale.value = 'en-US';
  focus.mockClear();
});
afterEach(() => {
  i18n.global.locale.value = previousLocale;
  vi.unstubAllGlobals();
});

describe('Terminal Dock creation ownership', () => {
  it.each(['NETWORK_UNAVAILABLE', 'PERMISSION_DENIED'])(
    'keeps GET %s feedback in its proper place',
    async (code) => {
      const http = createWorkbenchHttpService({
        csrfToken: ref('fixture-csrf'),
        csrfStorageKey: 'fixture-csrf',
        onUnauthenticated: vi.fn()
      });
      const f = fixture(http);
      try {
        await flushComponent();
        f.props.active = false;
        await flushComponent();
        if (code === 'NETWORK_UNAVAILABLE')
          f.fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
        else f.fetch.mockResolvedValueOnce(response({ error: code }, 403));
        f.props.active = true;
        await flushComponent();
        expect(f.requests('POST')).toHaveLength(0);
        expect(f.fetch.mock.calls.at(-1)?.[1]?.method).toBeUndefined();
        expect(http.networkUnavailable.value).toBe(code === 'NETWORK_UNAVAILABLE');
        expect(f.notice).toHaveBeenCalledTimes(code === 'NETWORK_UNAVAILABLE' ? 0 : 1);
        if (code !== 'NETWORK_UNAVAILABLE')
          expect(f.notice.mock.calls[0]?.[2]).toMatchObject({ code });
        await http.request('/api/probe');
        expect(http.networkUnavailable.value).toBe(false);
      } finally {
        f.view.unmount();
        await flushComponent();
      }
    }
  );
  for (const method of ['POST', 'DELETE'] as const) {
    async function writeFixture() {
      const http = createWorkbenchHttpService({
        csrfToken: ref('fixture-csrf'),
        csrfStorageKey: 'fixture-csrf',
        onUnauthenticated: vi.fn()
      });
      const request = vi.spyOn(http, 'request');
      const f = fixture(http);
      await flushComponent();
      if (method === 'DELETE') {
        await f.expand();
        f.opening.resolve(response({ terminal }));
        await flushComponent();
      }
      const submit = () =>
        method === 'POST'
          ? f.handle().toggle()
          : trigger(
              f.view.findAll('button').find((b) => b.props['aria-label'] === 'Close terminal 1')!,
              'onClick'
            );
      return { ...f, http, request, submit };
    }

    it.each([false, true])(
      `warns once about an unknown ${method} result without replay or false success (already recovered=%s)`,
      async (alreadyRecovered) => {
        const f = await writeFixture();
        try {
          f.fetch.mockImplementationOnce(async () => {
            if (alreadyRecovered) await f.http.request('/api/probe');
            throw new TypeError('Failed to fetch');
          });
          await f.submit();
          await flushComponent();
          const writeIndex = f.request.mock.calls.findLastIndex(
            ([, init]) => init?.method === method
          );
          const rejection = await f.request.mock.results[writeIndex]!.value.catch(
            (error: unknown) => error
          );
          expect(rejection).toBeInstanceOf(ApiError);
          expect(f.http.networkUnavailable.value).toBe(!alreadyRecovered);
          expect(f.notice).toHaveBeenCalledExactlyOnceWith(
            expect.stringContaining('result is unknown'),
            'warning',
            rejection
          );
          expect(rejection).toMatchObject({ code: 'NETWORK_UNAVAILABLE' });
          expect(f.view.findAll('terminal-view')).toHaveLength(method === 'POST' ? 0 : 1);
          const writes = f.requests(method).length;
          await f.http.request('/api/probe');
          await flushComponent();
          expect(f.http.networkUnavailable.value).toBe(false);
          expect(f.requests(method)).toHaveLength(writes);
          expect(f.notice).toHaveBeenCalledTimes(1);
        } finally {
          f.view.unmount();
          await flushComponent();
        }
      }
    );

    it(`preserves a ${method} business rejection and its diagnostics without going offline`, async () => {
      const f = await writeFixture();
      try {
        f.fetch.mockResolvedValueOnce(
          response(
            {
              error: {
                code: 'PERMISSION_DENIED',
                message: 'Fixture permission denied',
                details: 'Fixture diagnostic',
                requestId: 'request-fixture',
                upstreamRequestId: 'node-fixture'
              }
            },
            403
          )
        );
        await f.submit();
        await flushComponent();
        expect(f.http.networkUnavailable.value).toBe(false);
        expect(f.notice).toHaveBeenCalledExactlyOnceWith(
          expect.stringContaining('Fixture permission denied'),
          'error',
          expect.objectContaining({
            code: 'PERMISSION_DENIED',
            details: 'Fixture diagnostic',
            requestId: 'request-fixture',
            upstreamRequestId: 'node-fixture'
          })
        );
      } finally {
        f.view.unmount();
        await flushComponent();
      }
    });

    it(`does not classify a confirmed cancelled ${method} as an unknown write`, async () => {
      const f = await writeFixture();
      const controller = new AbortController();
      const request = f.http.request.bind(f.http);
      f.http.request = (path, init) => request(path, { ...init, signal: controller.signal });
      try {
        f.fetch.mockImplementationOnce(async () => {
          controller.abort();
          throw new TypeError('Cancelled fetch');
        });
        await f.submit();
        await flushComponent();
        expect(f.http.networkUnavailable.value).toBe(false);
        expect(f.notice.mock.calls.every(([, type]) => type !== 'warning')).toBe(true);
      } finally {
        f.view.unmount();
        await flushComponent();
      }
    });

    if (method === 'DELETE') {
      it.each(['inactive', 'release', 'new-target', 'round-trip-target'])(
        'keeps a late DELETE warning with its owning target after %s',
        async (end) => {
          const f = await writeFixture();
          const closing = pending();
          try {
            f.fetch.mockImplementationOnce(() => closing.promise);
            const submitted = f.submit();
            await flushComponent();
            if (end === 'release') await f.handle().release();
            else {
              f.props.active = false;
              if (end !== 'inactive') {
                f.props.nodeId = 'node-b';
                f.props.workspaceId = 'workspace-b';
                await flushComponent();
                if (end === 'round-trip-target') {
                  f.props.nodeId = 'node-a';
                  f.props.workspaceId = 'workspace-a';
                }
              }
            }
            await flushComponent();
            closing.reject(new TypeError('Failed to fetch'));
            await submitted;
            await flushComponent();
            if (end === 'inactive')
              expect(f.notice).toHaveBeenCalledExactlyOnceWith(
                expect.stringContaining('result is unknown'),
                'warning',
                expect.objectContaining({ code: 'NETWORK_UNAVAILABLE' })
              );
            else expect(f.notice).not.toHaveBeenCalled();
            expect(f.requests('POST')).toHaveLength(1);
            expect(f.requests('DELETE')).toHaveLength(end === 'release' ? 2 : 1);
          } finally {
            f.view.unmount();
            await flushComponent();
          }
        }
      );
    }
  }

  it.each(['network', 'business', 'identity'])(
    'aggregates batch release once without losing %s failure semantics',
    async (first) => {
      const http = createWorkbenchHttpService({
        csrfToken: ref('fixture-csrf'),
        csrfStorageKey: 'fixture-csrf',
        onUnauthenticated: vi.fn()
      });
      const f = fixture(http);
      const closing = pending();
      try {
        await f.expand();
        f.opening.resolve(response({ terminal }));
        await flushComponent();
        f.fetch.mockResolvedValueOnce(response({ terminal: { ...terminal, id: 'terminal-b' } }));
        await trigger(
          f.view.findAll('button').find((b) => b.props['aria-label'] === 'New terminal')!,
          'onClick'
        );
        await flushComponent();
        expect(f.view.findAll('terminal-view')).toHaveLength(2);
        if (first === 'business')
          f.fetch.mockResolvedValueOnce(response({ error: 'PERMISSION_DENIED' }, 403));
        else if (first === 'identity') f.fetch.mockImplementationOnce(() => closing.promise);
        else f.fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
        f.fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
        const releasing = f.handle().release();
        if (first === 'identity') {
          await flushComponent();
          http.invalidateAuthentication();
          closing.resolve(response({}));
        }
        await releasing;
        await flushComponent();
        expect(f.requests('DELETE')).toHaveLength(2);
        expect(f.view.findAll('terminal-view')).toHaveLength(0);
        expect(f.notice).toHaveBeenCalledExactlyOnceWith(
          first === 'identity'
            ? expect.any(String)
            : expect.stringContaining('could not all be confirmed (2 affected)'),
          first === 'identity' ? 'error' : 'warning',
          first === 'identity'
            ? expect.any(AuthenticationContextChangedError)
            : expect.objectContaining({ code: 'NETWORK_UNAVAILABLE' })
        );
        await f.handle().release();
        expect(f.requests('DELETE')).toHaveLength(2);
        expect(f.notice).toHaveBeenCalledTimes(1);
      } finally {
        f.view.unmount();
        await flushComponent();
      }
    }
  );

  it.each(['inactive', 'new-target', 'round-trip-target', 'release', 'identity'])(
    'isolates a late POST transport failure after %s',
    async (end) => {
      const http = createWorkbenchHttpService({
        csrfToken: ref('fixture-csrf'),
        csrfStorageKey: 'fixture-csrf',
        onUnauthenticated: vi.fn()
      });
      const f = fixture(http);
      const opening = pending();
      try {
        await flushComponent();
        f.fetch.mockImplementationOnce(() => opening.promise);
        const toggling = f.handle().toggle();
        await flushComponent();
        if (end === 'identity') http.invalidateAuthentication();
        else if (end === 'release') await f.handle().release();
        else {
          f.props.active = false;
          if (end !== 'inactive') {
            f.props.nodeId = 'node-b';
            f.props.workspaceId = 'workspace-b';
            await flushComponent();
            if (end === 'round-trip-target') {
              f.props.nodeId = 'node-a';
              f.props.workspaceId = 'workspace-a';
              f.props.active = true;
            }
          }
        }
        await flushComponent();
        opening.reject(new TypeError('Failed to fetch'));
        await toggling;
        await flushComponent();
        if (end === 'identity') {
          expect(http.networkUnavailable.value).toBe(false);
          // Production notice suppresses this obsolete-identity cause, not arbitrary AbortErrors.
          expect(f.notice).toHaveBeenCalledExactlyOnceWith(
            expect.any(String),
            'error',
            expect.any(AuthenticationContextChangedError)
          );
        } else expect(f.notice).not.toHaveBeenCalled();
        // Reactivating the new target generation still owns its normal lazy creation.
        if (end === 'round-trip-target') {
          expect(f.requests('POST')).toHaveLength(2);
          f.opening.resolve(response({ terminal }));
          await flushComponent();
          expect(f.view.findAll('terminal-view')[0]?.props['terminalId']).toBe('terminal-a');
        } else {
          expect(f.requests('POST')).toHaveLength(1);
          expect(f.view.findAll('terminal-view')).toHaveLength(0);
        }
      } finally {
        f.view.unmount();
        await flushComponent();
      }
    }
  );

  it('warns once when cleanup of a late created terminal has an unknown DELETE result', async () => {
    const http = createWorkbenchHttpService({
      csrfToken: ref('fixture-csrf'),
      csrfStorageKey: 'fixture-csrf',
      onUnauthenticated: vi.fn()
    });
    const f = fixture(http);
    try {
      await f.expand();
      await f.handle().release();
      f.fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      f.opening.resolve(response({ terminal }));
      await flushComponent();
      expect(f.requests('DELETE')).toHaveLength(1);
      expect(JSON.parse(f.requests('DELETE')[0]![1]!.body as string)).toEqual({ nodeId: 'node-a' });
      expect(f.view.findAll('terminal-view')).toHaveLength(0);
      expect(f.notice).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining('could not all be confirmed (1 affected)'),
        'warning',
        expect.objectContaining({ code: 'NETWORK_UNAVAILABLE' })
      );
    } finally {
      f.view.unmount();
      await flushComponent();
    }
  });

  it('creates lazily, selects a normal result, and closes the owned terminal', async () => {
    const f = fixture();
    try {
      await flushComponent();
      expect(f.requests('POST')).toHaveLength(0);
      await f.expand();
      expect(JSON.parse(f.requests('POST')[0]![1]!.body as string)).toMatchObject({
        nodeId: 'node-a',
        workspaceId: 'workspace-a',
        profileId: 'shell'
      });
      f.opening.resolve(response({ terminal }));
      await flushComponent();
      expect(f.view.findAll('terminal-view')[0]?.props).toMatchObject({
        terminalId: 'terminal-a',
        nodeId: 'node-a',
        workspaceId: 'workspace-a',
        active: true
      });
      await trigger(
        f.view.findAll('button').find((b) => b.props['aria-label'] === 'Close terminal 1')!,
        'onClick'
      );
      expect(f.requests('DELETE')).toHaveLength(1);
      expect(f.view.findAll('terminal-view')).toHaveLength(0);
    } finally {
      f.view.unmount();
    }
  });

  it('registers an inactive cached Dock result without focus or closing it and restores it on return', async () => {
    const f = fixture();
    try {
      await flushComponent();
      const toggling = f.handle().toggle();
      await flushComponent();
      f.props.active = false;
      f.props.visible = false;
      f.props.enabled = false;
      await flushComponent();
      f.opening.resolve(response({ terminal }));
      await toggling;
      await flushComponent();
      expect(f.view.findAll('terminal-view')[0]?.props).toMatchObject({
        terminalId: 'terminal-a',
        nodeId: 'node-a',
        workspaceId: 'workspace-a',
        visible: false
      });
      expect(focus).not.toHaveBeenCalled();
      expect(f.requests('DELETE')).toHaveLength(0);
      f.props.active = true;
      f.props.visible = true;
      f.props.enabled = true;
      await flushComponent();
      expect(f.view.findAll('terminal-view')[0]?.props['visible']).toBe(true);
      expect(f.requests('POST')).toHaveLength(1);
      await trigger(
        f.view.findAll('button').find((b) => b.props['aria-label'] === 'Close terminal 1')!,
        'onClick'
      );
      expect(f.requests('DELETE')).toHaveLength(1);
    } finally {
      f.view.unmount();
    }
  });

  it('keeps a created terminal when an older list snapshot arrives after returning to its Dock', async () => {
    const f = fixture();
    const listing = pending();
    try {
      await f.expand();
      f.props.active = false;
      await flushComponent();
      f.fetch.mockImplementationOnce(async () => listing.promise);
      f.props.active = true;
      await flushComponent();
      f.opening.resolve(response({ terminal }));
      await flushComponent();
      expect(f.view.findAll('terminal-view')).toHaveLength(1);
      listing.resolve(response({ terminals: [] }));
      await flushComponent();
      expect(f.view.findAll('terminal-view')[0]?.props['terminalId']).toBe('terminal-a');
      expect(f.requests('POST')).toHaveLength(1);
      expect(f.requests('DELETE')).toHaveLength(0);
      await trigger(
        f.view.findAll('button').find((b) => b.props['aria-label'] === 'Close terminal 1')!,
        'onClick'
      );
      expect(f.requests('DELETE')).toHaveLength(1);
    } finally {
      listing.resolve(response({ terminals: [] }));
      f.view.unmount();
    }
  });

  for (const end of ['release', 'unmount', 'new-target', 'round-trip-target'] as const) {
    it(`closes a late result on its original Node after ${end}`, async () => {
      const f = fixture();
      try {
        await f.expand();
        if (end === 'release') await f.handle().release();
        else if (end === 'unmount') f.view.unmount();
        else {
          f.props.active = false;
          f.props.visible = false;
          f.props.nodeId = 'node-b';
          f.props.workspaceId = 'workspace-b';
          await flushComponent();
          if (end === 'round-trip-target') {
            f.props.nodeId = 'node-a';
            f.props.workspaceId = 'workspace-a';
            await flushComponent();
          }
        }
        f.opening.resolve(response({ terminal }));
        await flushComponent();
        expect(f.requests('DELETE')).toHaveLength(1);
        expect(f.requests('DELETE')[0]?.[0]).toBe('/api/terminals/terminal-a');
        expect(JSON.parse(f.requests('DELETE')[0]![1]!.body as string)).toEqual({
          nodeId: 'node-a'
        });
        expect(f.view.findAll('terminal-view')).toHaveLength(0);
        expect(focus).not.toHaveBeenCalled();
      } finally {
        if (end !== 'unmount') f.view.unmount();
      }
    });
  }

  it('reports an active creation failure and allows explicit retry without automatic spinning', async () => {
    const f = fixture();
    try {
      await f.expand();
      f.opening.resolve(
        response(
          { error: { code: 'TERMINAL_LIMIT_REACHED', message: 'Fixture capacity reached' } },
          409
        )
      );
      await flushComponent();
      expect(f.notice).toHaveBeenCalledWith(
        expect.stringContaining('Fixture capacity reached'),
        'error',
        expect.anything()
      );
      expect(f.requests('POST')).toHaveLength(1);
      expect(f.view.findAll('terminal-view')).toHaveLength(0);
      await trigger(
        f.view.findAll('button').find((b) => b.props['aria-label'] === 'New terminal')!,
        'onClick'
      );
      expect(f.requests('POST')).toHaveLength(2);
    } finally {
      f.view.unmount();
    }
  });

  it('does not automatically retry a failed manual creation after closing the last terminal', async () => {
    const f = fixture();
    try {
      await f.expand();
      f.opening.resolve(response({ terminal }));
      await flushComponent();
      await trigger(
        f.view
          .findAll('button')
          .find((button) => button.props['aria-label'] === 'Close terminal 1')!,
        'onClick'
      );
      expect(f.view.findAll('terminal-view')).toHaveLength(0);
      f.fetch.mockImplementation(async (_path, init) =>
        init?.method === 'POST'
          ? response(
              { error: { code: 'TERMINAL_LIMIT_REACHED', message: 'Fixture capacity reached' } },
              409
            )
          : response({ terminals: [] })
      );
      for (const attempt of [2, 3]) {
        await trigger(
          f.view.findAll('button').find((button) => button.props['aria-label'] === 'New terminal')!,
          'onClick'
        );
        await flushComponent();
        expect(f.requests('POST')).toHaveLength(attempt);
        expect(f.notice).toHaveBeenCalledTimes(attempt - 1);
      }
    } finally {
      f.view.unmount();
    }
  });

  it('does not recreate terminals after a released pending request fails', async () => {
    const f = fixture();
    try {
      await f.expand();
      await f.handle().release();
      f.opening.resolve(
        response(
          { error: { code: 'TERMINAL_LIMIT_REACHED', message: 'Fixture capacity reached' } },
          409
        )
      );
      await flushComponent();
      expect(f.requests('POST')).toHaveLength(1);
      expect(f.notice).not.toHaveBeenCalled();
      expect(f.view.findAll('terminal-view')).toHaveLength(0);
    } finally {
      f.view.unmount();
    }
  });
});
