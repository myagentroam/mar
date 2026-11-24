import { expect, it, vi } from 'vitest';
import type { BrowserPageInput } from '@myagentroam/protocol';
import { BrowserAttachment } from '../../src/browser/browser-attachment.js';
import type { BrowserPageView } from '../../src/browser/browser-page-view.js';
import type { BrowserTabs } from '../../src/browser/browser-tabs.js';

const size = { width: 800, height: 600 };
const key = (edge: 'down' | 'up'): BrowserPageInput => ({
  type: 'key',
  edge,
  key: 'Shift',
  viewVersion: 1
});

async function fixture() {
  const blocked = Promise.withResolvers<void>();
  let ready = Promise.withResolvers<void>();
  let viewVersion = 1;
  let refresh: () => void;
  const failed = vi.fn();
  const releaseInput = vi.fn(async () => {});
  const input = vi.fn(async (action: BrowserPageInput) => {
    if (action.type === 'key' && action.edge === 'down') await blocked.promise;
  });
  const page = {
    resize: async () => false,
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
    viewport: size,
    snapshot: () => ({ viewVersion, tabs: [] }),
    observe: (callback: () => void) => {
      refresh = callback;
      return () => {};
    },
    presentDialogs: async () => {}
  } as unknown as BrowserTabs;
  const attachment = new BrowserAttachment(
    { resource: tabs, release: vi.fn() },
    {
      quality: 85,
      encoder: { encode: async (data, key) => ({ data, key }), close: async () => {} },
      sendFrame: async () => ready.resolve(),
      sendControl: vi.fn(),
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
    blocked,
    releaseInput,
    nextView: async () => {
      ready = Promise.withResolvers<void>();
      viewVersion++;
      refresh();
      await ready.promise;
      attachment.receive({ type: 'ack', sequence: viewVersion });
    }
  };
}

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
