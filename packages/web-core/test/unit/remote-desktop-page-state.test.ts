import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RemoteDesktopPage from '../../src/view/remote-desktop/RemoteDesktopPage.vue?unit-render';
import { flushComponent, renderComponent } from './support/component-renderer.js';

const mocks = vi.hoisted(() => ({
  discover: vi.fn(),
  select: vi.fn(),
  close: vi.fn(async () => true),
  clients: [] as EventTarget[],
  disconnect: vi.fn()
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
    capability: { supportsControl: true },
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

  it('offers control only on a ready view and uses the existing mode-switch authorization', async () => {
    mocks.select.mockResolvedValue({ channel, path: 'direct', ready() {}, close: mocks.close });
    const view = renderComponent(RemoteDesktopPage, { nodeId: 'node-a' });
    const prompt = () =>
      view
        .findAll('ElButton')
        .find((node) => node.props['data-testid'] === 'desktop-control-prompt');
    try {
      await flushComponent();
      expect(prompt()).toBeUndefined();
      expect(mocks.select.mock.calls[0]![0].mode).toBe('VIEW');
      mocks.clients[0]!.dispatchEvent(new Event('firstframe'));
      await flushComponent();
      expect(prompt()).toBeDefined();
      await (prompt()!.props['onClick'] as () => Promise<void>)();
      await flushComponent();
      expect(mocks.select.mock.calls[1]![0].mode).toBe('CONTROL');
      expect(prompt()).toBeUndefined();
      mocks.clients[1]!.dispatchEvent(new Event('firstframe'));
      await flushComponent();
      expect(prompt()).toBeUndefined();
    } finally {
      view.unmount();
    }
  });

  it('can return to VIEW while a CONTROL attachment is still opening', async () => {
    const late = { channel, path: 'direct' as const, ready() {}, close: vi.fn(async () => true) };
    const pending = Promise.withResolvers<typeof late>();
    const viewing = { channel, path: 'direct', ready() {}, close: mocks.close };
    mocks.select
      .mockResolvedValueOnce(viewing)
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValueOnce(viewing);
    const view = renderComponent(RemoteDesktopPage, { nodeId: 'node-a' });
    let opening: Promise<void> | undefined;
    try {
      await flushComponent();
      mocks.clients[0]!.dispatchEvent(new Event('firstframe'));
      await flushComponent();
      const control = view
        .findAll('ElButton')
        .find((node) => node.props['data-testid'] === 'desktop-control-prompt')!;
      opening = (control.props['onClick'] as () => Promise<void>)();
      await flushComponent();
      const button = view
        .findAll('ElButton')
        .find((node) => node.props['data-testid'] === 'desktop-view')!;
      expect(button.props['disabled']).not.toBe(true);
      await (button.props['onClick'] as () => Promise<void>)();
      expect(mocks.select.mock.calls[1]![0].signal.aborted).toBe(true);
      pending.resolve(late);
      await opening;
      expect(late.close).toHaveBeenCalledOnce();
      expect(mocks.select.mock.calls.map(([input]) => input.mode)).toEqual([
        'VIEW',
        'CONTROL',
        'VIEW'
      ]);
      expect(mocks.clients).toHaveLength(2);
      expect(mocks.clients[1]).toHaveProperty('viewOnly', true);
    } finally {
      pending.resolve(late);
      await opening;
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
