import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalDirectError } from '../../src/service/TerminalDirectClient.js';
import { createTerminalService } from '../../src/service/TerminalService.js';
import { translate } from '../../src/service/LocalePreferenceService.js';

class Socket extends EventTarget {
  static readonly OPEN = 1;
  static instances: Socket[] = [];
  readyState = 1;
  readonly sent: string[] = [];
  constructor(readonly url: string) {
    super();
    Socket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
  }
  frame(frame: object) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) }));
  }
}

function fixture() {
  const request = vi.fn().mockResolvedValue({ ticket: 'relay-ticket' });
  const directConnection = { send: vi.fn(), dispose: vi.fn() };
  const direct = { attach: vi.fn() };
  const callbacks = {
    onAttached: vi.fn(),
    onOutput: vi.fn(),
    onExited: vi.fn(),
    onTerminalUnavailable: vi.fn(),
    onErrorFrame: vi.fn(),
    onReconnectStatus: vi.fn()
  };
  const service = createTerminalService({
    terminalId: 'terminal-a',
    nodeId: 'node-a',
    workspaceId: 'workspace-a',
    http: { request },
    direct: direct as never,
    ...callbacks
  });
  return { service, direct, directConnection, request, ...callbacks };
}

describe('Unified Terminal entry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Socket.instances = [];
    vi.stubGlobal('WebSocket', Socket);
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

  it('falls back to relay after direct disconnect, preserving replay and ignoring late direct frames', async () => {
    const f = fixture();
    f.direct.attach.mockResolvedValue(f.directConnection);
    await f.service.attach();
    const input = f.direct.attach.mock.calls[0]![0];
    input.onAttached();
    input.onFrame({ type: 'output', terminalId: 'terminal-a', data: 'direct', sequence: 7 });
    input.onFrame({ type: 'output', terminalId: 'terminal-a', data: 'duplicate', sequence: 7 });
    f.service.send({ type: 'input', terminalId: 'terminal-a', data: 'hello' });
    expect(f.directConnection.send).toHaveBeenCalledOnce();
    input.onDisconnected('TERMINAL_DIRECT_CLOSED');
    expect(f.request).toHaveBeenCalledOnce();
    expect(JSON.parse(f.request.mock.calls[0]![1].body).afterSequence).toBe(7);
    await Promise.resolve();
    Socket.instances[0]!.frame({
      type: 'output',
      terminalId: 'terminal-a',
      data: 'replayed',
      sequence: 7
    });
    Socket.instances[0]!.frame({
      type: 'output',
      terminalId: 'terminal-a',
      data: 'relay',
      sequence: 8
    });
    input.onFrame({ type: 'output', terminalId: 'terminal-a', data: 'late', sequence: 9 });
    expect(f.onOutput.mock.calls).toEqual([['direct'], ['relay']]);
    f.service.dispose();
    expect(f.directConnection.dispose).toHaveBeenCalled();
  });

  it('does not fall back or retry after authorization denial', async () => {
    const f = fixture();
    f.direct.attach.mockRejectedValue(new TerminalDirectError('TERMINAL_NOT_AUTHORIZED'));
    await f.service.attach();
    expect(f.onErrorFrame).toHaveBeenCalledWith('TERMINAL_NOT_AUTHORIZED');
    expect(f.request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.direct.attach).toHaveBeenCalledOnce();
    f.service.dispose();
  });

  it('keeps retrying an occupied terminal without taking the writer and resumes after release', async () => {
    const f = fixture();
    f.direct.attach
      .mockRejectedValueOnce(new TerminalDirectError('TERMINAL_ATTACH_CONFLICT'))
      .mockRejectedValueOnce(new TerminalDirectError('TERMINAL_ATTACH_CONFLICT'))
      .mockRejectedValueOnce(new TerminalDirectError('TERMINAL_ATTACH_CONFLICT'))
      .mockRejectedValueOnce(new TerminalDirectError('TERMINAL_ATTACH_CONFLICT'))
      .mockResolvedValue(f.directConnection);
    await f.service.attach();
    expect(f.onErrorFrame).not.toHaveBeenCalled();
    expect(f.onReconnectStatus).toHaveBeenCalledWith(
      translate('generated.terminalRelayService.terminalConnectionLostReconnectingInSeconds', {
        value0: 1
      })
    );
    await vi.advanceTimersByTimeAsync(7_000);
    expect(f.direct.attach).toHaveBeenCalledTimes(4);
    expect(f.onReconnectStatus).toHaveBeenCalledWith(
      translate('generated.terminalRelayService.terminalOccupiedRetrying')
    );
    await vi.advanceTimersByTimeAsync(8_000);
    expect(f.direct.attach).toHaveBeenCalledTimes(5);
    f.direct.attach.mock.calls[4]![0].onAttached();
    expect(f.onReconnectStatus).toHaveBeenLastCalledWith(undefined);
    expect(f.onErrorFrame).not.toHaveBeenCalled();
    f.service.dispose();
  });
});
