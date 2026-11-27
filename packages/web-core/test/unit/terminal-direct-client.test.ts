import { bindNodeDirectPath, rtcNodeStreamCarrier } from '@myagentroam/protocol/node-stream-path';
import {
  decodeNodeStreamFrame,
  encodeNodeStreamFrame,
  type NodeStreamFrame
} from '@myagentroam/protocol/node-stream-wire';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTerminalDirectClient } from '../../src/service/terminal-direct-client.js';

class Channel extends EventTarget {
  readyState = 'open';
  bufferedAmount = 0;
  readonly sent: Uint8Array[] = [];
  send(data: Uint8Array) {
    this.sent.push(data);
  }
  close() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.dispatchEvent(new Event('close'));
  }
  receive(data: NodeStreamFrame) {
    this.dispatchEvent(new MessageEvent('message', { data: encodeNodeStreamFrame(data).buffer }));
  }
}

const input = { terminalId: 'terminal-a', workspaceId: 'workspace-a', afterSequence: 5 };
const binding = { nodeGeneration: 'generation-a', transportSessionId: 'transport-a' };
function carrier(channel = new Channel()) {
  return bindNodeDirectPath({
    carrier: rtcNodeStreamCarrier(channel as unknown as RTCDataChannel),
    maxStreams: 32
  });
}

describe('Terminal direct client handshake', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('crypto', { randomUUID: () => '12345678-1234-1234-1234-123456789abc' });
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('authorizes once and revokes the stream without closing its ICE carrier', async () => {
    const channel = new Channel();
    const path = carrier(channel);
    const send = vi.fn((_message: unknown) => true);
    const client = createTerminalDirectClient({ send });
    const connecting = client.openStream(
      'node-a',
      input,
      binding,
      path,
      new AbortController().signal
    );
    const prepare = send.mock.calls[0]![0] as { requestId: string };
    expect(prepare).toMatchObject({
      type: 'terminal.direct.prepare',
      ...binding,
      ...input,
      readonly: false
    });
    grant(client, prepare.requestId);
    await Promise.resolve();
    expect(channel.sent.map(decodeNodeStreamFrame)).toEqual([
      { type: 'OPEN', streamId: 1, kind: 'terminal', grant: 'a'.repeat(32) }
    ]);
    channel.receive({ type: 'OPENED', streamId: 1 });
    const stream = (await connecting)!;
    const reading = stream[Symbol.asyncIterator]().next();
    client.handle({
      type: 'terminal.direct.closed',
      directSessionId: 'session-1234',
      code: 'NODE_OFFLINE'
    });
    await expect(reading).rejects.toMatchObject({ code: 'NODE_OFFLINE' });
    expect(channel.readyState).toBe('open');
    expect(decodeNodeStreamFrame(channel.sent.at(-1)!)).toEqual({
      type: 'RESET',
      streamId: 1,
      code: 'NODE_OFFLINE'
    });
    expect(send).toHaveBeenLastCalledWith({
      type: 'terminal.direct.cancel',
      directSessionId: 'session-1234'
    });
    path.close();
  });

  it('cancels an orphaned grant after a pre-OPEN timeout', async () => {
    const path = carrier();
    const send = vi.fn((_message: unknown) => true);
    const client = createTerminalDirectClient({ send });
    const connecting = client.openStream(
      'node-a',
      input,
      binding,
      path,
      new AbortController().signal
    );
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(connecting).resolves.toBeUndefined();
    grant(client, '12345678123412341234123456789abc');
    expect(send).toHaveBeenLastCalledWith({
      type: 'terminal.direct.cancel',
      directSessionId: 'session-1234'
    });
    path.close();
  });

  it('does not turn an uncertain dispatched OPEN into a safe unavailable result', async () => {
    const send = vi.fn((_message: unknown) => true);
    const client = createTerminalDirectClient({ send });
    const connecting = client.openStream(
      'node-a',
      input,
      binding,
      {
        closed: false,
        close() {},
        async openStream() {
          throw new Error('NODE_STREAM_DISCONNECTED');
        }
      },
      new AbortController().signal
    );
    const rejected = expect(connecting).rejects.toThrow('NODE_STREAM_DISCONNECTED');
    grant(client, '12345678123412341234123456789abc');
    await rejected;
    expect(send).toHaveBeenLastCalledWith({
      type: 'terminal.direct.cancel',
      directSessionId: 'session-1234'
    });
  });
});

function grant(client: ReturnType<typeof createTerminalDirectClient>, requestId: string) {
  client.handle({
    type: 'terminal.direct.prepared',
    requestId,
    directSessionId: 'session-1234',
    grant: 'a'.repeat(32),
    openExpiresAt: Date.now() + 15_000,
    expiresAt: Date.now() + 30_000
  });
}
