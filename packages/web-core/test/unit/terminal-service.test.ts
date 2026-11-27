import { decodeTerminalMessage, encodeTerminalMessage } from '@myagentroam/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalDirectError } from '../../src/service/terminal-direct-client.js';
import { createTerminalService } from '../../src/service/terminal-service.js';
import { translate } from '../../src/service/locale-preference-service.js';

class Socket extends EventTarget {
  static readonly OPEN = 1;
  static instances: Socket[] = [];
  readyState = 1;
  readonly sent: Uint8Array[] = [];
  constructor(readonly url: string) {
    super();
    Socket.instances.push(this);
  }
  send(data: Uint8Array) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
  }
  frame(frame: object) {
    this.dispatchEvent(new MessageEvent('message', { data: encodeTerminalMessage(frame).buffer }));
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

  it.each(['direct', 'relay'])(
    'sends large UTF-8 pastes in ordered binary frames over %s',
    async (path) => {
      const f = fixture();
      if (path === 'direct') f.direct.attach.mockResolvedValue(f.directConnection);
      await f.service.attach();
      const terminalId = 'terminal-a';
      if (path === 'direct') f.direct.attach.mock.calls[0]![0].onAttached();
      else Socket.instances[0]!.frame({ type: 'attach', terminalId, afterSequence: 0 });
      const data = '\u001b[200~' + '😀中'.repeat(14_000) + '\u001b[201~';
      f.service.send({ type: 'input', terminalId, data });
      const frames =
        path === 'direct'
          ? f.directConnection.send.mock.calls.map(([frame]) => frame)
          : Socket.instances[0]!.sent.map(decodeTerminalMessage);
      expect(frames.length).toBeGreaterThan(1);
      expect(
        frames.every(
          (frame) =>
            frame.type === 'input' &&
            frame.terminalId === terminalId &&
            frame.data instanceof Uint8Array &&
            frame.data.length <= 32 * 1024
        )
      ).toBe(true);
      expect(Buffer.concat(frames.map(({ data }) => Buffer.from(data))).toString('utf8')).toBe(
        data
      );
      f.service.dispose();
    }
  );

  it('falls back to relay after direct disconnect, preserving replay and ignoring late direct frames', async () => {
    const f = fixture();
    f.direct.attach.mockResolvedValue(f.directConnection);
    await f.service.attach();
    const input = f.direct.attach.mock.calls[0]![0];
    input.onAttached();
    input.onFrame({
      type: 'output',
      terminalId: 'terminal-a',
      data: new TextEncoder().encode('direct'),
      sequence: 7
    });
    input.onFrame({
      type: 'output',
      terminalId: 'terminal-a',
      data: new TextEncoder().encode('duplicate'),
      sequence: 7
    });
    f.service.send({ type: 'input', terminalId: 'terminal-a', data: 'hello' });
    expect(f.directConnection.send).toHaveBeenCalledOnce();
    input.onDisconnected('TERMINAL_DIRECT_CLOSED');
    expect(f.request).toHaveBeenCalledOnce();
    expect(JSON.parse(f.request.mock.calls[0]![1].body).afterSequence).toBe(7);
    await Promise.resolve();
    Socket.instances[0]!.frame({
      type: 'output',
      terminalId: 'terminal-a',
      data: new TextEncoder().encode('replayed'),
      sequence: 7
    });
    Socket.instances[0]!.frame({
      type: 'output',
      terminalId: 'terminal-a',
      data: new TextEncoder().encode('relay'),
      sequence: 8
    });
    input.onFrame({
      type: 'output',
      terminalId: 'terminal-a',
      data: new TextEncoder().encode('late'),
      sequence: 9
    });
    expect(f.onOutput.mock.calls).toEqual([
      [new TextEncoder().encode('direct')],
      [new TextEncoder().encode('relay')]
    ]);
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
