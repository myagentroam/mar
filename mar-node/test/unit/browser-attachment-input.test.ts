import { expect, it, vi } from 'vitest';
import type { BrowserPageInput } from '@myagentroam/protocol';
import { BrowserAttachment } from '../../src/browser/browser-attachment.js';
import type { BrowserPageView } from '../../src/browser/browser-page-view.js';
import { BrowserTabs } from '../../src/browser/browser-tabs.js';

const size = { width: 800, height: 600 };
const key = (edge: 'down' | 'up'): Extract<BrowserPageInput, { type: 'key' }> => ({
  type: 'key',
  edge,
  key: 'Shift',
  viewVersion: 1
});

async function fixture(navigation?: {
  resize: (viewport: typeof size) => Promise<void>;
  navigate: (address: string) => Promise<void>;
}) {
  const blocked = Promise.withResolvers<void>();
  let ready = Promise.withResolvers<void>();
  let viewVersion = 1;
  let viewport = size;
  let refresh: () => void;
  const failed = vi.fn();
  const sendControl = vi.fn();
  const releaseInput = vi.fn(async () => {});
  const activity = vi.fn(() => true);
  const input = vi.fn(async (action: BrowserPageInput) => {
    if (action.type === 'key' && action.edge === 'down') await blocked.promise;
  });
  const page = {
    resize: navigation?.resize ?? (async () => {}),
    navigate: navigation?.navigate,
    startCapture: async (
      _options: unknown,
      offer: (frame: typeof size & { jpeg: Buffer }) => void
    ) => {
      offer({ ...size, jpeg: Buffer.from([1]) });
      return { stop: async () => {} };
    },
    input,
    releaseInput
  } as unknown as BrowserPageView;
  const tabs = {
    activeView: page,
    get viewport() {
      return viewport;
    },
    navigateWithViewport: BrowserTabs.prototype.navigateWithViewport,
    navigationView: (version: number) => (version === viewVersion ? page : undefined),
    snapshot: () => ({ viewVersion, tabs: [] }),
    observe: (callback: () => void) => {
      refresh = callback;
      return () => {};
    },
    attach: async () => {},
    detach: async () => {},
    orderInput: (action: () => Promise<void>) => action()
  } as unknown as BrowserTabs;
  const attachment = new BrowserAttachment(
    { resource: tabs, release: vi.fn(), activity },
    {
      quality: 85,
      encoder: { encode: async (data, key) => ({ data, key }), close: async () => {} },
      sendFrame: async () => ready.resolve(),
      sendControl,
      failed,
      deadlineMs: 5000
    }
  );
  await ready.promise;
  attachment.receive({ type: 'ack', sequence: 1 });
  const send = (action: BrowserPageInput) => attachment.receive({ type: 'input', action });
  send(key('down'));
  await vi.waitFor(() => expect(input).toHaveBeenCalledWith(key('down')));
  return {
    attachment,
    send,
    input,
    failed,
    sendControl,
    activity,
    blocked,
    releaseInput,
    setViewport: (next: typeof size) => {
      viewport = next;
    },
    nextView: async () => {
      ready = Promise.withResolvers<void>();
      viewVersion++;
      refresh();
      await ready.promise;
      attachment.receive({ type: 'ack', sequence: viewVersion });
    }
  };
}

it.each(['none', 'geometry', 'target', 'target closes', 'resize fails'])(
  'waits for the viewport and rechecks the navigation target (change: %s)',
  async (changed) => {
    const applied = Promise.withResolvers<void>();
    const latestApplied = Promise.withResolvers<void>();
    const resize = vi.fn(async () => {});
    const navigate = vi.fn(async () => {});
    const { attachment, blocked, nextView, setViewport, sendControl } = await fixture({
      resize,
      navigate
    });
    try {
      resize.mockClear();
      resize.mockImplementationOnce(() => applied.promise);
      attachment.receive({ type: 'navigate', address: 'https://example.test/', viewVersion: 1 });
      blocked.resolve();
      await vi.waitFor(() => expect(resize).toHaveBeenCalledExactlyOnceWith(size));
      expect(navigate).not.toHaveBeenCalled();
      const switched = changed === 'target' || changed === 'target closes';
      if (switched) {
        await nextView();
        attachment.receive({
          type: 'navigate',
          address: 'https://example.test/next',
          viewVersion: 2
        });
      }
      if (changed === 'geometry') {
        // Another attachment can change the shared size before capture catches up.
        const latestSize = { width: 721, height: 881 };
        setViewport(latestSize);
        resize.mockImplementationOnce(() => latestApplied.promise);
        applied.resolve();
        await vi.waitFor(() => expect(resize).toHaveBeenLastCalledWith(latestSize));
        expect(navigate).not.toHaveBeenCalled();
        latestApplied.resolve();
      }
      if (changed === 'target closes' || changed === 'resize fails')
        applied.reject(new Error('Viewport update failed'));
      else applied.resolve();
      const failure = { type: 'command.failed', code: 'BROWSER_COMMAND_FAILED' };
      if (changed === 'resize fails') {
        await vi.waitFor(() => expect(sendControl).toHaveBeenCalledWith(failure));
        expect(navigate).not.toHaveBeenCalled();
      } else {
        await vi.waitFor(() =>
          expect(navigate).toHaveBeenCalledExactlyOnceWith(
            switched ? 'https://example.test/next' : 'https://example.test/'
          )
        );
        expect(sendControl).not.toHaveBeenCalledWith(failure);
      }
    } finally {
      applied.resolve();
      latestApplied.resolve();
      blocked.resolve();
      await attachment.close();
    }
  }
);

it('keeps the attachment and wheel targets intact when alternating wheel input fills the queue', async () => {
  const { attachment, send, input, failed, blocked } = await fixture();
  try {
    for (let x = 1; x <= 100; x++) {
      send({ type: 'move', viewVersion: 1, x, y: 50 });
      send({ type: 'wheel', viewVersion: 1, x: 0, y: x % 2 ? x : -x });
    }
    send(key('up'));
    expect(failed).not.toHaveBeenCalled();
    blocked.resolve();
    await vi.waitFor(() => expect(input).toHaveBeenLastCalledWith(key('up')));
    expect(input.mock.calls.map(([action]) => action)).toEqual([
      key('down'),
      ...Array.from({ length: 100 }, (_, i) => i + 1).flatMap((x) => [
        { type: 'move', viewVersion: 1, x, y: 50 },
        { type: 'wheel', viewVersion: 1, x: 0, y: x % 2 ? x : -x }
      ]),
      key('up')
    ]);
  } finally {
    blocked.resolve();
    await attachment.close();
  }
});

it.each([
  { limit: 256, action: { type: 'wheel', viewVersion: 1, x: 0, y: 1 } as const },
  { limit: 64, action: { type: 'text', viewVersion: 1, text: 'a' } as const }
])('bounds the $action.type backlog to $limit commands', async ({ action, limit }) => {
  const { attachment, send, failed, blocked } = await fixture();
  try {
    for (let i = 0; i < limit; i++) send(action);
    expect(failed).not.toHaveBeenCalled();
    send(action);
    expect(failed).toHaveBeenCalledExactlyOnceWith('BROWSER_COMMAND_QUEUE_FULL');
  } finally {
    blocked.resolve();
    await attachment.close();
  }
});

it('reclaims stale input budget immediately on a view change while Chromium is still busy', async () => {
  const { attachment, send, input, failed, blocked, nextView, releaseInput } = await fixture();
  try {
    for (let i = 0; i < 256; i++) send({ type: 'wheel', viewVersion: 1, x: 0, y: 1 });
    await nextView();
    const current = { type: 'wheel', viewVersion: 2, x: 0, y: 2 } as const;
    send(current);
    expect(failed).not.toHaveBeenCalled();
    blocked.resolve();
    await vi.waitFor(() => expect(input).toHaveBeenLastCalledWith(current));
    expect(input.mock.calls).toEqual([[key('down')], [current]]);
    expect(releaseInput).toHaveBeenCalledWith(new Set(['Shift']), new Set(), false);
  } finally {
    blocked.resolve();
    await attachment.close();
  }
});

it('releases the input hold if a page operation fails while a key is down', async () => {
  const { attachment, send, input, blocked, failed, releaseInput, sendControl } = await fixture();
  try {
    input.mockRejectedValueOnce(new Error('Chromium input failed'));
    send({ type: 'move', viewVersion: 1, x: 20, y: 30 });
    blocked.resolve();
    await vi.waitFor(() => expect(releaseInput).toHaveBeenCalledOnce());
    expect(releaseInput).toHaveBeenCalledWith(new Set(['Shift']), new Set(), false);
    await vi.waitFor(() =>
      expect(sendControl).toHaveBeenCalledWith({
        type: 'command.failed',
        code: 'BROWSER_COMMAND_FAILED'
      })
    );
    expect(failed).not.toHaveBeenCalled();
  } finally {
    blocked.resolve();
    await attachment.close();
  }
});

it('does not renew the browser for acknowledgements or stale input', async () => {
  const { attachment, activity, blocked, send, input } = await fixture();
  try {
    activity.mockClear();
    attachment.receive({ type: 'ack', sequence: 1 });
    attachment.receive({ type: 'agent.activity.observe' });
    send({ type: 'wheel', viewVersion: 2, x: 0, y: 1 });
    const live = { type: 'wheel', viewVersion: 1, x: 0, y: 1 } as const;
    send(live);
    blocked.resolve();
    await vi.waitFor(() => expect(input).toHaveBeenLastCalledWith(live));
    expect(activity).toHaveBeenCalledOnce();
  } finally {
    blocked.resolve();
    await attachment.close();
  }
});
