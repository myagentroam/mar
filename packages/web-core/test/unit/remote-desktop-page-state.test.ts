import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RemoteDesktopPage from '../../src/view/remote-desktop/RemoteDesktopPage.vue?unit-render';
import { flushComponent, renderComponent } from './support/component-renderer.js';

const mocks = vi.hoisted(() => ({
  discover: vi.fn(),
  select: vi.fn(),
  close: vi.fn(async () => true),
  clients: [] as EventTarget[],
  disconnect: vi.fn(),
  paste: vi.fn()
}));
const channel = { getStatistics: () => ({ receivedBytes: 0, sentBytes: 0 }) };
vi.mock('../../src/service/standalone-remote-desktop-service.js', () => ({
  createStandaloneRemoteDesktopService: () => mocks
}));
vi.mock('@novnc/novnc', () => ({
  default: class extends EventTarget {
    constructor() {
      super();
      mocks.clients.push(this);
    }
    disconnect() {
      mocks.disconnect();
    }
    clipboardPasteFrom(text: string) {
      mocks.paste(text);
    }
  }
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.clients.length = 0;
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('document', Object.assign(new EventTarget(), { hidden: false }));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  );
  mocks.discover.mockResolvedValue({
    capability: { supportsControl: true, supportsUnicodePaste: true },
    description: {
      framebuffer: { width: 800, height: 600 },
      displays: [
        {
          displayId: 'primary-1',
          name: 'Display',
          primary: true,
          framebufferBounds: { x: 0, y: 0, width: 800, height: 600 }
        }
      ]
    }
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('Remote Desktop first-frame state', () => {
  it.each([
    ['\\\\.\\DISPLAY1', 'Display1'],
    ['\\\\.\\display2', 'Display2'],
    ['DELL U2723QE', 'DELL U2723QE']
  ])(
    'shows a readable display name for %s without changing its selector value',
    async (name, label) => {
      const discovery = await mocks.discover();
      discovery.description.displays[0].name = name;
      mocks.select.mockResolvedValue({ channel, path: 'direct', ready() {}, close: mocks.close });
      const view = renderComponent(RemoteDesktopPage, { nodeId: 'node-a' });
      try {
        await flushComponent();
        const options = view
          .findAll('ElOption')
          .filter((node) => typeof node.props['value'] === 'string');
        expect(options.map((node) => node.props['value'])).toEqual(['primary-1']);
        expect(options[0]!.props['label']).toContain(label);
        expect(options[0]!.props['label']).not.toContain('\\\\.\\');
      } finally {
        view.unmount();
      }
    }
  );

  it.each([false, true])('preserves synchronous readiness failure: %s', async (fails) => {
    const ready = vi.fn();
    mocks.select.mockImplementation(async (input: { onDisconnected(code: string): void }) => ({
      channel,
      path: 'direct',
      ready: () => {
        ready();
        if (fails) input.onDisconnected('DESKTOP_CONTROL_UNAVAILABLE');
      },
      close: mocks.close
    }));
    const view = renderComponent(RemoteDesktopPage, { nodeId: 'node-a' });
    try {
      await flushComponent();
      expect(mocks.clients).toHaveLength(1);
      mocks.clients[0]!.dispatchEvent(new Event('firstframe'));
      await flushComponent();
      expect(ready).toHaveBeenCalledOnce();
      const control = view
        .findAll('ElButton')
        .find((node) => node.props['data-testid'] === 'desktop-control')!;
      expect(control.props['disabled']).toBe(fails);
      expect(
        view
          .findAll('ElButton')
          .some((node) => node.props['data-testid'] === 'desktop-control-prompt')
      ).toBe(!fails);
      expect(view.findAll('div').some((node) => node.props['role'] === 'status')).toBe(fails);
      expect(mocks.disconnect).toHaveBeenCalledTimes(fails ? 1 : 0);
    } finally {
      view.unmount();
    }
  });

  it('toggles local input on the same authorized attachment without another first frame', async () => {
    mocks.select.mockResolvedValue({ channel, path: 'direct', ready() {}, close: mocks.close });
    const view = renderComponent(RemoteDesktopPage, { nodeId: 'node-a' });
    const prompt = () =>
      view
        .findAll('ElButton')
        .find((node) => node.props['data-testid'] === 'desktop-control-prompt');
    try {
      await flushComponent();
      expect(prompt()).toBeUndefined();
      expect(mocks.select.mock.calls[0]![0].mode).toBe('CONTROL');
      expect(mocks.clients[0]).toHaveProperty('viewOnly', true);
      mocks.clients[0]!.dispatchEvent(new Event('firstframe'));
      await flushComponent();
      expect(prompt()).toBeDefined();
      await (prompt()!.props['onClick'] as () => Promise<void>)();
      await flushComponent();
      expect(mocks.select).toHaveBeenCalledOnce();
      expect(mocks.clients).toHaveLength(1);
      expect(mocks.clients[0]).toHaveProperty('viewOnly', false);
      expect(prompt()).toBeUndefined();
      const button = view
        .findAll('ElButton')
        .find((node) => node.props['data-testid'] === 'desktop-view')!;
      await (button.props['onClick'] as () => void)();
      await flushComponent();
      expect(prompt()).toBeDefined();
      expect(mocks.clients[0]).toHaveProperty('viewOnly', true);
      expect(mocks.select).toHaveBeenCalledOnce();
      expect(mocks.close).not.toHaveBeenCalled();
      expect(mocks.disconnect).not.toHaveBeenCalled();
    } finally {
      view.unmount();
    }
  });

  it('returns to local viewing on blur without closing the picture', async () => {
    mocks.select.mockResolvedValue({ channel, path: 'direct', ready() {}, close: mocks.close });
    const view = renderComponent(RemoteDesktopPage, { nodeId: 'node-a' });
    try {
      await flushComponent();
      mocks.clients[0]!.dispatchEvent(new Event('firstframe'));
      await flushComponent();
      const control = view
        .findAll('ElButton')
        .find((node) => node.props['data-testid'] === 'desktop-control-prompt')!;
      await (control.props['onClick'] as () => void)();
      window.dispatchEvent(new Event('blur'));
      await flushComponent();
      expect(mocks.clients[0]).toHaveProperty('viewOnly', true);
      expect(mocks.select).toHaveBeenCalledOnce();
      expect(mocks.close).not.toHaveBeenCalled();
      expect(mocks.disconnect).not.toHaveBeenCalled();
      expect(view.findAll('div').some((node) => node.props['role'] === 'status')).toBe(false);
    } finally {
      view.unmount();
    }
  });

  it('discards a clipboard read spanning a VIEW/CONTROL round trip on the same client', async () => {
    const read = Promise.withResolvers<string>();
    const readText = vi.fn(() => read.promise);
    vi.stubGlobal('navigator', { clipboard: { readText } });
    Object.assign(document, { hasFocus: () => true });
    mocks.select.mockResolvedValue({ channel, path: 'direct', ready() {}, close: mocks.close });
    const view = renderComponent(RemoteDesktopPage, { nodeId: 'node-a' });
    const click = (id: string) =>
      (
        view.findAll('ElButton').find((node) => node.props['data-testid'] === id)!.props[
          'onClick'
        ] as () => Promise<void>
      )();
    let pasting: Promise<void> | undefined;
    try {
      await flushComponent();
      mocks.clients[0]!.dispatchEvent(new Event('firstframe'));
      await flushComponent();
      await click('desktop-control-prompt');
      await flushComponent();
      pasting = click('desktop-paste');
      await click('desktop-view');
      await flushComponent();
      await click('desktop-control-prompt');
      await flushComponent();
      read.resolve('stale clipboard');
      await pasting;
      expect(mocks.paste).not.toHaveBeenCalled();
      readText.mockResolvedValue('fresh clipboard');
      await click('desktop-paste');
      expect(mocks.paste).toHaveBeenCalledExactlyOnceWith('fresh clipboard');
      expect(mocks.select).toHaveBeenCalledOnce();
    } finally {
      read.resolve('stale clipboard');
      await pasting;
      view.unmount();
    }
  });

  it.each(['hidden', 'revoked'])('still closes or fences the picture when %s', async (reason) => {
    mocks.select.mockResolvedValue({ channel, path: 'direct', ready() {}, close: mocks.close });
    const view = renderComponent(RemoteDesktopPage, { nodeId: 'node-a' });
    try {
      await flushComponent();
      mocks.clients[0]!.dispatchEvent(new Event('firstframe'));
      await flushComponent();
      const control = view
        .findAll('ElButton')
        .find((node) => node.props['data-testid'] === 'desktop-control-prompt')!;
      await (control.props['onClick'] as () => void)();
      if (reason === 'hidden') {
        Object.assign(document, { hidden: true });
        document.dispatchEvent(new Event('visibilitychange'));
        expect(mocks.close).toHaveBeenCalledOnce();
      } else mocks.select.mock.calls[0]![0].onDisconnected('NODE_ACCESS_DENIED');
      await flushComponent();
      expect(mocks.disconnect).toHaveBeenCalledOnce();
      expect(mocks.clients[0]).toHaveProperty('viewOnly', true);
      expect(mocks.select).toHaveBeenCalledOnce();
      expect(view.findAll('div').some((node) => node.props['role'] === 'status')).toBe(true);
    } finally {
      view.unmount();
    }
  });

  it('does not offer control when the Node supports viewing only', async () => {
    mocks.discover.mockResolvedValueOnce({
      ...(await mocks.discover()),
      capability: { supportsControl: false }
    });
    mocks.select.mockResolvedValue({ channel, path: 'direct', ready() {}, close: mocks.close });
    const view = renderComponent(RemoteDesktopPage, { nodeId: 'node-a' });
    try {
      await flushComponent();
      expect(mocks.select.mock.calls[0]![0].mode).toBe('VIEW');
      mocks.clients[0]!.dispatchEvent(new Event('firstframe'));
      await flushComponent();
      expect(
        view
          .findAll('ElButton')
          .some((node) => node.props['data-testid'] === 'desktop-control-prompt')
      ).toBe(false);
    } finally {
      view.unmount();
    }
  });
});
