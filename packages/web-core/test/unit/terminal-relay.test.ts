import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTerminalRelayService } from '../../src/service/terminal-relay-service.js';
import { translate } from '../../src/service/locale-preference-service.js';

class FakeSocket extends EventTarget {
  static readonly OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 1;
  sent: string[] = [];
  constructor(readonly url: string) {
    super();
    FakeSocket.instances.push(this);
  }
  send(value: string) {
    this.sent.push(value);
  }
  close(code = 1006, reason = '') {
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event('close'), { code, reason }));
  }
  frame(value: object) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }));
  }
}

function fixture(workspaceId?: string) {
  const request = vi.fn().mockResolvedValue({ ticket: 'ticket + secret' });
  const callbacks = {
    onAttached: vi.fn(),
    onOutput: vi.fn(),
    onExited: vi.fn(),
    onTerminalUnavailable: vi.fn(),
    onErrorFrame: vi.fn(),
    onReconnectStatus: vi.fn()
  };
  const service = createTerminalRelayService({
    terminalId: 'terminal/a',
    nodeId: 'node-a',
    ...(workspaceId === undefined ? {} : { workspaceId }),
    http: { request },
    ...callbacks
  });
  return { service, request, ...callbacks };
}

describe('Public Terminal Relay', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal('window', {
      location: { origin: 'https://console.example' },
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval
    });
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('Shares ticket and handshake requests, sends nothing before attach, and sends and dispatches frames after attach', async () => {
    const f = fixture('workspace-a');
    await Promise.all([f.service.attach(), f.service.attach()]);
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.request.mock.calls[0]?.[0]).toBe('/api/terminals/terminal%2Fa/attach-ticket');
    expect(JSON.parse(f.request.mock.calls[0]?.[1].body)).toEqual({
      nodeId: 'node-a',
      workspaceId: 'workspace-a',
      afterSequence: 0
    });
    const socket = FakeSocket.instances[0]!;
    expect(new URL(socket.url).protocol).toBe('wss:');
    expect(new URL(socket.url).searchParams.get('ticket')).toBe('ticket + secret');
    f.service.send({ type: 'input' });
    expect(socket.sent).toEqual([]);
    socket.frame({ type: 'attach', terminalId: 'other' });
    expect(f.onAttached).not.toHaveBeenCalled();
    socket.frame({ type: 'attach', terminalId: 'terminal/a' });
    f.service.send({ type: 'input', data: 'hello' });
    expect(socket.sent).toEqual([JSON.stringify({ type: 'input', data: 'hello' })]);
    socket.frame({ type: 'error', terminalId: 'terminal/a' });
    socket.frame({ type: 'exit', terminalId: 'terminal/a' });
    expect(f.onErrorFrame).toHaveBeenCalledWith('TERMINAL_ERROR');
    expect(f.onExited).toHaveBeenCalledOnce();
    f.service.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('Preserves the highest sequence on reconnect and ignores frames and close events from the old connection', async () => {
    const f = fixture();
    await f.service.attach();
    const old = FakeSocket.instances[0]!;
    old.frame({ type: 'output', terminalId: 'terminal/a', data: 'a', sequence: 8 });
    old.frame({ type: 'output', terminalId: 'terminal/a', data: 'b', sequence: 3 });
    f.service.reconnect();
    old.frame({ type: 'output', terminalId: 'terminal/a', data: 'late', sequence: 99 });
    old.close();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.request).toHaveBeenCalledTimes(2);
    expect(JSON.parse(f.request.mock.calls[1]?.[1].body)).toEqual({
      nodeId: 'node-a',
      afterSequence: 8
    });
    expect(f.onOutput.mock.calls).toEqual([['a'], ['b']]);
    f.service.dispose();
  });

  it('Uses exponential backoff up to ten seconds after ticket failure and retries after one second once attached', async () => {
    const f = fixture();
    f.request.mockRejectedValue(new Error('offline'));
    await f.service.attach();
    let calls = 1;
    for (const delay of [1000, 2000, 4000, 8000, 10000, 10000]) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(f.request).toHaveBeenCalledTimes(calls);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.request).toHaveBeenCalledTimes(++calls);
    }
    f.request.mockResolvedValue({ ticket: 'ok' });
    await vi.advanceTimersByTimeAsync(10000);
    const socket = FakeSocket.instances[0]!;
    socket.frame({ type: 'attach', terminalId: 'terminal/a' });
    socket.close();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.request).toHaveBeenCalledTimes(calls + 2);
    f.service.dispose();
  });

  it('Aborts a timed-out ticket request and retries after a handshake timeout', async () => {
    const f = fixture();
    f.request.mockImplementationOnce(
      (_path: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal!.addEventListener('abort', () => reject(new Error('aborted')));
        })
    );
    const attaching = f.service.attach();
    await vi.advanceTimersByTimeAsync(20000);
    await attaching;
    expect(f.request.mock.calls[0]?.[1].signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(20000);
    expect(FakeSocket.instances[0]!.readyState).toBe(3);
    await vi.advanceTimersByTimeAsync(2000);
    expect(FakeSocket.instances).toHaveLength(2);
    f.service.dispose();
  });

  it('reports malformed JSON and reconnects after a broken relay', async () => {
    const f = fixture();
    await f.service.attach();
    FakeSocket.instances[0]!.dispatchEvent(new MessageEvent('message', { data: '{' }));
    expect(f.onErrorFrame).not.toHaveBeenCalled();
    expect(f.onReconnectStatus).toHaveBeenCalledWith(
      translate('generated.terminalRelayService.terminalConnectionLostReconnectingInSeconds', {
        value0: 1
      })
    );
    await vi.advanceTimersByTimeAsync(1000);
    FakeSocket.instances[1]!.close();
    expect(f.onReconnectStatus).toHaveBeenCalledWith(
      translate('generated.terminalRelayService.terminalConnectionLostReconnectingInSeconds', {
        value0: 2
      })
    );
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.request).toHaveBeenCalledTimes(3);
    f.service.dispose();
  });

  it('removes a terminal that is closed or missing instead of retrying its stale relay', async () => {
    const f = fixture();
    await f.service.attach();
    const socket = FakeSocket.instances[0]!;
    socket.frame({ type: 'error', terminalId: 'terminal/a', code: 'TERMINAL_CLOSED' });
    expect(f.onTerminalUnavailable).toHaveBeenCalledWith('TERMINAL_CLOSED');
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    f.service.dispose();
  });

  it('Aborts an in-flight ticket on disposal so a late success cannot create a connection', async () => {
    const f = fixture();
    let resolve!: (value: { ticket: string }) => void;
    f.request.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    const attaching = f.service.attach();
    f.service.dispose();
    expect(f.request.mock.calls[0]?.[1].signal.aborted).toBe(true);
    resolve({ ticket: 'late' });
    await attaching;
    await f.service.attach();
    f.service.reconnect();
    expect(FakeSocket.instances).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
