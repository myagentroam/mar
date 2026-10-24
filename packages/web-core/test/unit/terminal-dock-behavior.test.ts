import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reactive } from 'vue';
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
  const promise = new Promise<T>((complete) => (resolve = complete));
  return { promise, resolve };
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
function fixture() {
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
  const view = renderComponent(Dock, props);
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
        f.view.findAll('button').find((b) => b.props['class'] === 'terminal-tab terminal-tab-add')!,
        'onClick'
      );
      expect(f.requests('POST')).toHaveLength(2);
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
