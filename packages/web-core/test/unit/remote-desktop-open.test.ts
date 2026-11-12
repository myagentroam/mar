import { describe, expect, it, vi } from 'vitest';
import { openRemoteDesktopChannel } from '../../src/service/remote-desktop-open.js';

class Wire extends EventTarget {
  readyState = 1;
  binaryType = 'arraybuffer';
  bufferedAmount = 0;
  send = vi.fn((_data: string) => {});
  close = vi.fn();
}

describe('shared desktop OPEN handoff', () => {
  it('adopts a WebSocket synchronously and retains immediately following RFB bytes', async () => {
    const wire = new Wire();
    const adopted = vi.fn();
    const ready = openRemoteDesktopChannel({
      raw: wire as unknown as WebSocket,
      attachmentId: 'attachment-1',
      grant: 'grant',
      signal: new AbortController().signal,
      isStopped: () => false,
      maxMessageBytes: 16384,
      onFailure: vi.fn(),
      onAdopt: adopted
    });
    expect(JSON.parse(wire.send.mock.calls[0]![0])).toEqual({
      type: 'OPEN',
      attachmentId: 'attachment-1',
      grant: 'grant'
    });
    wire.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({ type: 'ATTACHED', attachmentId: 'attachment-1' })
      })
    );
    expect(adopted).toHaveBeenCalledOnce();
    wire.dispatchEvent(new MessageEvent('message', { data: Uint8Array.from([1, 2]).buffer }));
    const channel = await ready;
    const received = vi.fn();
    channel.onmessage = received;
    await Promise.resolve();
    expect([...new Uint8Array(received.mock.calls[0]![0].data)]).toEqual([1, 2]);
    channel.close();
  });

  it('does not adopt a late ATTACHED after cancellation', async () => {
    const wire = new Wire();
    const abort = new AbortController();
    const adopted = vi.fn();
    const ready = openRemoteDesktopChannel({
      raw: wire as unknown as WebSocket,
      attachmentId: 'attachment-1',
      grant: 'grant',
      signal: abort.signal,
      isStopped: () => false,
      maxMessageBytes: 16384,
      onFailure: vi.fn(),
      onAdopt: adopted
    });
    abort.abort();
    await expect(ready).rejects.toMatchObject({ code: 'DESKTOP_TRANSPORT_ERROR' });
    wire.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({ type: 'ATTACHED', attachmentId: 'attachment-1' })
      })
    );
    expect(adopted).not.toHaveBeenCalled();
  });
});
