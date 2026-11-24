import { expect, it, vi } from 'vitest';
import type { BrowserPageInput, BrowserUpload } from '@myagentroam/protocol';
import { BrowserAttachment } from '../../src/browser/browser-attachment.js';
import type { BrowserPageView } from '../../src/browser/browser-page-view.js';
import type { BrowserTabs } from '../../src/browser/browser-tabs.js';

const size = { width: 800, height: 600 };
const key = (edge: 'down' | 'up'): Extract<BrowserPageInput, { type: 'key' }> => ({
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
  const sendControl = vi.fn();
  const setHumanControl = vi.fn<(take: boolean) => Promise<void>>().mockResolvedValue(undefined);
  const upload = vi.fn<(request: BrowserUpload) => Promise<void>>().mockResolvedValue(undefined);
  let agentControl: BrowserTabs['agentControl'] = 'agent';
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
    setHumanControl,
    upload,
    get agentControl() {
      return agentControl;
    },
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
    setHumanControl,
    upload,
    setAgentControl: (value: BrowserTabs['agentControl']) => {
      agentControl = value;
      refresh();
    },
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

it('keeps the Console attached so the user can retry a failed takeover', async () => {
  const { attachment, blocked, failed, sendControl, setHumanControl } = await fixture();
  try {
    setHumanControl.mockRejectedValueOnce(new Error('BROWSER_USE_REVOKE_FAILED'));
    attachment.receive({ type: 'agent.control', action: 'observe' });
    attachment.receive({ type: 'agent.control', action: 'take' });
    await vi.waitFor(() =>
      expect(sendControl).toHaveBeenCalledWith({
        type: 'command.failed',
        code: 'BROWSER_USE_REVOKE_FAILED'
      })
    );
    expect(failed).not.toHaveBeenCalled();
    attachment.receive({ type: 'agent.control', action: 'take' });
    expect(setHumanControl.mock.calls).toEqual([[true], [true]]);
  } finally {
    blocked.resolve();
    await attachment.close();
  }
});

it('releases a held gesture even if takeover finishes before the input operation returns', async () => {
  const { attachment, blocked, input, releaseInput, send, setAgentControl } = await fixture();
  try {
    send({ ...key('down'), key: 'Control' });
    setAgentControl('taking');
    send(key('up'));
    send({ ...key('up'), key: 'Control' });
    setAgentControl('user');
    blocked.resolve();
    await vi.waitFor(() =>
      expect(releaseInput).toHaveBeenCalledExactlyOnceWith(new Set(['Shift']), new Set(), false)
    );
    expect(input).toHaveBeenCalledExactlyOnceWith(key('down'));
  } finally {
    blocked.resolve();
    await attachment.close();
  }
});

it('does not release the first new key after another taking snapshot during release', async () => {
  const { attachment, blocked, input, releaseInput, send, setAgentControl } = await fixture();
  const releasing = Promise.withResolvers<void>();
  releaseInput.mockReturnValueOnce(releasing.promise);
  const controlDown = { ...key('down'), key: 'Control' };
  const controlUp = { ...key('up'), key: 'Control' };
  try {
    blocked.resolve();
    setAgentControl('taking');
    await vi.waitFor(() => expect(releaseInput).toHaveBeenCalledOnce());
    setAgentControl('taking');
    setAgentControl('user');
    send(controlDown);
    send(controlUp);
    releasing.resolve();
    await vi.waitFor(() => expect(input).toHaveBeenCalledWith(controlUp));
    expect(input.mock.calls.flat()).toEqual([key('down'), controlDown, controlUp]);
    expect(releaseInput).toHaveBeenCalledOnce();
  } finally {
    blocked.resolve();
    releasing.resolve();
    await attachment.close();
  }
});

it('reports an open request that races with starting takeover', async () => {
  const { attachment, blocked, sendControl, setAgentControl } = await fixture();
  try {
    attachment.receive({ type: 'tab.open', address: 'https://example.test/' });
    setAgentControl('taking');
    attachment.receive({ type: 'tab.openHtml', path: 'index.html' });
    blocked.resolve();
    await vi.waitFor(() =>
      expect(
        sendControl.mock.calls.filter(([event]) => event.type === 'command.failed').flat()
      ).toEqual([
        { type: 'command.failed', code: 'BROWSER_USE_TAKING' },
        { type: 'command.failed', code: 'BROWSER_USE_TAKING' }
      ])
    );
  } finally {
    blocked.resolve();
    await attachment.close();
  }
});

it('does not submit staged files while takeover is unconfirmed', async () => {
  const { attachment, blocked, upload, setAgentControl } = await fixture();
  const request = {
    chooserId: 'chooser',
    attachmentId: 'attachment',
    command: { action: 'finish', transferId: 'transfer' }
  } as const satisfies BrowserUpload;
  try {
    setAgentControl('taking');
    await expect(attachment.upload(request)).rejects.toThrow('BROWSER_UPLOAD_INVALID');
    expect(upload).not.toHaveBeenCalled();
    setAgentControl('user');
    await attachment.upload(request);
    expect(upload).toHaveBeenCalledExactlyOnceWith(request);
  } finally {
    blocked.resolve();
    await attachment.close();
  }
});

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
