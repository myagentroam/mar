import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTerminalDirectClient } from '../../src/service/TerminalDirectClient.js';

class Channel extends EventTarget {
  readyState = 'open';
  bufferedAmount = 0;
  readonly sent: string[] = [];
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.dispatchEvent(new Event('close'));
  }
  receive(data: object) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) }));
  }
}

const input = (signal: AbortSignal) => ({
  nodeId: 'node-a',
  terminalId: 'terminal-a',
  workspaceId: 'workspace-a',
  afterSequence: 5,
  readonly: false,
  takeover: true,
  onFrame: vi.fn(),
  onAttached: vi.fn(),
  onDisconnected: vi.fn(),
  signal
});

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

  it('waits for Node acknowledgement, gates writes, and releases the channel on control revocation', async () => {
    const channel = new Channel();
    const release = vi.fn();
    const send = vi.fn((_message: unknown) => true);
    const client = createTerminalDirectClient({
      send,
      acquire: () => ({
        nodeGeneration: 'generation-a',
        transportSessionId: 'transport-a',
        createChannel: () => channel as unknown as RTCDataChannel,
        release
      })
    });
    const options = input(new AbortController().signal);
    const connecting = client.attach(options);
    const prepare = send.mock.calls[0]![0] as { requestId: string };
    expect(prepare).toMatchObject({
      type: 'terminal.direct.prepare',
      afterSequence: 5,
      readonly: false
    });
    client.handle({
      type: 'terminal.direct.prepared',
      requestId: prepare.requestId,
      directSessionId: 'session-1234',
      grant: 'a'.repeat(32),
      openExpiresAt: Date.now() + 15_000,
      expiresAt: Date.now() + 30_000
    });
    const connection = await connecting;
    connection!.send({ type: 'input', terminalId: 'terminal-a', data: 'before' });
    expect(channel.sent).toEqual([]);
    channel.dispatchEvent(new Event('open'));
    expect(JSON.parse(channel.sent[0]!)).toMatchObject({
      type: 'OPEN',
      directSessionId: 'session-1234',
      grant: 'a'.repeat(32)
    });
    channel.receive({ type: 'ATTACHED', terminalId: 'terminal-a', afterSequence: 5 });
    expect(options.onAttached).toHaveBeenCalledOnce();
    connection!.send({ type: 'input', terminalId: 'terminal-a', data: 'after' });
    expect(JSON.parse(channel.sent[1]!)).toMatchObject({ data: 'after' });
    client.handle({
      type: 'terminal.direct.closed',
      directSessionId: 'session-1234',
      code: 'NODE_OFFLINE'
    });
    expect(options.onDisconnected).toHaveBeenCalledWith('NODE_OFFLINE');
    expect(release).toHaveBeenCalledOnce();
    expect(channel.readyState).toBe('closed');
  });

  it('cancels an orphaned grant after preparation times out', async () => {
    const release = vi.fn();
    const send = vi.fn((_message: unknown) => true);
    const client = createTerminalDirectClient({
      send,
      acquire: () => ({
        nodeGeneration: 'generation-a',
        transportSessionId: 'transport-a',
        createChannel: () => {
          throw new Error('unexpected channel');
        },
        release
      })
    });
    const connecting = client.attach(input(new AbortController().signal));
    const rejection = expect(connecting).rejects.toMatchObject({ code: 'TERMINAL_DIRECT_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(5_000);
    await rejection;
    expect(release).toHaveBeenCalledOnce();
    client.handle({
      type: 'terminal.direct.prepared',
      requestId: '12345678123412341234123456789abc',
      directSessionId: 'orphan-1234',
      grant: 'a'.repeat(32),
      openExpiresAt: Date.now() + 15_000,
      expiresAt: Date.now() + 30_000
    });
    expect(send).toHaveBeenLastCalledWith({
      type: 'terminal.direct.cancel',
      directSessionId: 'orphan-1234'
    });
  });

  it('cancels a delivered grant when the DataChannel cannot be created', async () => {
    const release = vi.fn();
    const send = vi.fn((_message: unknown) => true);
    const client = createTerminalDirectClient({
      send,
      acquire: () => ({
        nodeGeneration: 'generation-a',
        transportSessionId: 'transport-a',
        createChannel: () => {
          throw new Error('transport closed');
        },
        release
      })
    });
    const connecting = client.attach(input(new AbortController().signal));
    const rejected = expect(connecting).rejects.toMatchObject({
      code: 'TERMINAL_DIRECT_UNAVAILABLE'
    });
    client.handle({
      type: 'terminal.direct.prepared',
      requestId: '12345678123412341234123456789abc',
      directSessionId: 'orphan-1234',
      grant: 'a'.repeat(32),
      openExpiresAt: Date.now() + 15_000,
      expiresAt: Date.now() + 30_000
    });
    await rejected;
    expect(send).toHaveBeenLastCalledWith({
      type: 'terminal.direct.cancel',
      directSessionId: 'orphan-1234'
    });
    expect(release).toHaveBeenCalledOnce();
  });
});
