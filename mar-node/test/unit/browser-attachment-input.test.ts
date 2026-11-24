import sharp from 'sharp';
import { expect, it, vi } from 'vitest';
import {
  BrowserFrameReceiver,
  type BrowserFrame,
  type BrowserPageInput
} from '@myagentroam/protocol';
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
  const png = await sharp({ create: { width: 4, height: 3, channels: 3, background: 'white' } })
    .png()
    .toBuffer();
  const blocked = Promise.withResolvers<void>();
  const receiver = new BrowserFrameReceiver();
  const frames: BrowserFrame[] = [];
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
  const resize = vi.fn(navigation?.resize ?? (async (_viewport: typeof size) => {}));
  const startCapture = vi.fn<BrowserPageView['startCapture']>(async (_options, offer) => {
    offer({ ...size, png });
    return { stop: async () => {} };
  });
  const page = {
    resize: navigation?.resize ?? resize,
    navigate: navigation?.navigate,
    startCapture,
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
      relay: false,
      sendFrame: async (bytes) => {
        const frame = receiver.push(bytes);
        if (frame) frames.push(frame);
      },
      sendControl,
      failed,
      deadlineMs: 5000
    }
  );
  const requestFrame = (handshake = false) =>
    attachment.receive({
      type: 'rfb',
      data: Buffer.concat([
        ...(handshake
          ? [Buffer.from('RFB 003.008\n'), Buffer.of(1, 1, 2, 0, 0, 1, 255, 255, 255, 33)]
          : []),
        Buffer.of(3, 1, 0, 0, 0, 0, 0, 4, 0, 3)
      ]).toString('base64')
    });
  const acknowledgeView = async (version: number) => {
    let frame: BrowserFrame | undefined;
    await vi.waitFor(() => {
      frame = frames.find((value) => value.viewVersion === version);
      expect(frame).toBeDefined();
    });
    attachment.receive({ type: 'ack', sequence: frame!.sequence });
  };
  const switchView = () => {
    viewVersion++;
    refresh();
    requestFrame();
    return viewVersion;
  };
  requestFrame(true);
  await acknowledgeView(1);
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
    frames,
    resize,
    startCapture,
    switchView,
    acknowledgeView,
    setViewport: (next: typeof size) => {
      viewport = next;
    },
    nextView: () => acknowledgeView(switchView())
  };
}

it.each(['resize', 'startCapture'] as const)(
  'ignores a superseded capture %s failure but still reports an active one',
  async (stage) => {
    const f = await fixture();
    const obsolete = Promise.withResolvers<never>();
    const step = f[stage];
    const error = new Error('Fixture capture target was lost');
    try {
      f.blocked.resolve();
      step.mockImplementationOnce(() => obsolete.promise);
      f.switchView();
      await vi.waitFor(() => expect(step).toHaveBeenCalledTimes(2));
      const latest = f.switchView();
      obsolete.reject(error);
      await f.acknowledgeView(latest);
      expect(f.frames.map(({ viewVersion }) => viewVersion)).toEqual([1, latest]);
      expect(f.failed).not.toHaveBeenCalled();
      const input: BrowserPageInput = { type: 'text', viewVersion: latest, text: 'still live' };
      f.send(input);
      await vi.waitFor(() => expect(f.input).toHaveBeenCalledWith(input));

      step.mockImplementationOnce(async () => {
        throw error;
      });
      f.switchView();
      await vi.waitFor(() =>
        expect(f.failed).toHaveBeenCalledExactlyOnceWith('BROWSER_CAPTURE_FAILED')
      );
    } finally {
      await f.attachment.close();
    }
  }
);

it('stops a capture that finishes starting after its view was replaced', async () => {
  const f = await fixture();
  const late = Promise.withResolvers<Awaited<ReturnType<BrowserPageView['startCapture']>>>();
  const stop = vi.fn(async () => {});
  try {
    f.blocked.resolve();
    f.startCapture.mockImplementationOnce(() => late.promise);
    f.switchView();
    await vi.waitFor(() => expect(f.startCapture).toHaveBeenCalledTimes(2));
    const latest = f.switchView();
    late.resolve({ stop });
    await f.acknowledgeView(latest);
    expect(stop).toHaveBeenCalledOnce();
    expect(f.frames.map(({ viewVersion }) => viewVersion)).toEqual([1, latest]);
    expect(f.failed).not.toHaveBeenCalled();
  } finally {
    late.resolve({ stop });
    await f.attachment.close();
  }
});

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
