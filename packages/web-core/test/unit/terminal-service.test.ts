import { decodeTerminalMessage, encodeTerminalMessage } from '@myagentroam/protocol';
import {
  decodeNodeStreamFrame,
  encodeNodeRelayHandshake,
  encodeNodeStreamFrame,
  type NodeStreamFrame
} from '@myagentroam/protocol/node-stream-wire';
import { readTerminalRecords, writeTerminalRecord } from '@myagentroam/protocol/terminal-stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeStreamError } from '@myagentroam/protocol/node-stream';
import { bindNodeDirectPath } from '@myagentroam/protocol/node-stream-path';
import type { WorkbenchNodePath } from '../../src/service/workbench-node-connection-service.js';
import { createTerminalService } from '../../src/service/terminal-service.js';
import { translate } from '../../src/service/locale-preference-service.js';
import { createWorkbenchNodeConnectionService } from '../../src/service/workbench-node-connection-service.js';

class Socket extends EventTarget {
  static readonly OPEN = 1;
  static instances: Socket[] = [];
  static holdReady = false;
  readyState = 1;
  readonly sent: NodeStreamFrame[] = [];
  constructor(
    readonly url: URL,
    direct = false
  ) {
    super();
    if (direct) return;
    Socket.instances.push(this);
    if (!Socket.holdReady) queueMicrotask(() => this.ready());
  }
  ready() {
    this.inbound(encodeNodeRelayHandshake({ type: 'RELAY_READY' }));
  }
  send(data: Uint8Array) {
    const frame = decodeNodeStreamFrame(data);
    this.sent.push(frame);
    if (frame.type === 'OPEN') this.control({ type: 'OPENED', streamId: frame.streamId });
  }
  close() {
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
  }
  frame(frame: object, streamId = 1) {
    this.control({
      type: 'DATA',
      streamId,
      bytes: writeTerminalRecord(encodeTerminalMessage(frame))
    });
  }
  control(frame: NodeStreamFrame) {
    this.inbound(encodeNodeStreamFrame(frame));
  }
  inbound(bytes: Uint8Array<ArrayBuffer>) {
    this.dispatchEvent(new MessageEvent('message', { data: bytes.buffer }));
  }
}

function fixture(
  shared?: ReturnType<typeof createWorkbenchNodeConnectionService>,
  terminalId = 'terminal-a',
  useDirect = false
) {
  const request = vi.fn().mockResolvedValue({ ticket: 'relay-ticket' });
  const directWire = new Socket(new URL('http://direct.test'), true);
  const base = bindNodeDirectPath({
    carrier: {
      async send(bytes) {
        directWire.send(bytes);
      },
      close: () => directWire.close(),
      onMessage: (fn) =>
        directWire.addEventListener('message', (event) => fn((event as MessageEvent).data)),
      onClose: (fn) => directWire.addEventListener('close', fn)
    },
    maxStreams: 4
  });
  const direct = vi.fn<WorkbenchNodePath['openStream']>((_, signal) =>
    base.openStream({ kind: 'terminal', grant: 'direct' }, signal)
  );
  if (useDirect) Socket.holdReady = true;
  const connections =
    shared ??
    createWorkbenchNodeConnectionService({
      http: { request },
      ...(useDirect
        ? {
            connectDirect: async () => ({
              get closed() {
                return base.closed;
              },
              close: base.close,
              openStream: direct
            })
          }
        : {})
    });
  const callbacks = {
    onAttached: vi.fn(),
    onOutput: vi.fn(),
    onExited: vi.fn(),
    onTerminalUnavailable: vi.fn(),
    onErrorFrame: vi.fn(),
    onReconnectStatus: vi.fn()
  };
  const service = createTerminalService({
    terminalId,
    nodeId: 'node-a',
    workspaceId: 'workspace-a',
    openStream: connections.openStream,
    ...callbacks
  });
  return { service, direct, directWire, request, connections, terminalId, ...callbacks };
}

async function relayTerminalFrames(socket: Socket) {
  const chunks = (async function* () {
    for (const frame of socket.sent) if (frame.type === 'DATA') yield frame.bytes;
  })();
  const frames = [];
  for await (const record of readTerminalRecords(chunks))
    frames.push(decodeTerminalMessage(record));
  return frames;
}

describe('Unified Terminal entry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Socket.instances = [];
    Socket.holdReady = false;
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
      const f = fixture(undefined, 'terminal-a', path === 'direct');
      await f.service.attach();
      const terminalId = 'terminal-a';
      const wire = path === 'direct' ? f.directWire : Socket.instances[0]!;
      wire.frame({ type: 'attach', terminalId, afterSequence: 0 });
      await vi.advanceTimersByTimeAsync(0);
      const data = '\u001b[200~' + '😀中'.repeat(14_000) + '\u001b[201~';
      f.service.send({ type: 'input', terminalId, data });
      await vi.advanceTimersByTimeAsync(0);
      const frames = await relayTerminalFrames(wire);
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
      const chunks = frames.map((frame) => {
        if (!(frame.data instanceof Uint8Array)) throw new Error('Expected a binary input frame');
        return Buffer.from(frame.data);
      });
      expect(Buffer.concat(chunks).toString('utf8')).toBe(data);
      f.service.dispose();
      f.connections.reset();
    }
  );

  it('reattaches on Relay after losing Direct, preserving the cursor without replay', async () => {
    const f = fixture(undefined, 'terminal-a', true);
    await f.service.attach();
    f.directWire.frame({ type: 'attach', terminalId: f.terminalId, afterSequence: 0 });
    f.directWire.frame({
      type: 'output',
      terminalId: f.terminalId,
      data: Uint8Array.of(7),
      sequence: 7
    });
    f.directWire.frame({
      type: 'output',
      terminalId: f.terminalId,
      data: Uint8Array.of(70),
      sequence: 7
    });
    await vi.advanceTimersByTimeAsync(0);
    f.service.send({ type: 'input', terminalId: f.terminalId, data: 'hello' });
    await vi.advanceTimersByTimeAsync(0);
    expect(await relayTerminalFrames(f.directWire)).toHaveLength(1);
    const [relay] = Socket.instances;
    relay!.ready();
    f.directWire.close();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.request).toHaveBeenCalledOnce();
    expect(JSON.parse(f.request.mock.calls[0]![1].body).afterSequence).toBe(7);
    relay!.frame({ type: 'attach', terminalId: f.terminalId, afterSequence: 7 });
    relay!.frame({
      type: 'output',
      terminalId: f.terminalId,
      data: Uint8Array.of(70),
      sequence: 7
    });
    relay!.frame({ type: 'output', terminalId: f.terminalId, data: Uint8Array.of(8), sequence: 8 });
    f.directWire.frame({
      type: 'output',
      terminalId: f.terminalId,
      data: Uint8Array.of(9),
      sequence: 9
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.onOutput.mock.calls).toEqual([[Uint8Array.of(7)], [Uint8Array.of(8)]]);
    expect(await relayTerminalFrames(relay!)).toEqual([]);
    f.service.dispose();
    f.connections.reset();
  });

  it('does not fall back or retry after authorization denial', async () => {
    const f = fixture(undefined, 'terminal-a', true);
    f.direct.mockRejectedValue(new NodeStreamError('TERMINAL_NOT_AUTHORIZED'));
    await f.service.attach();
    Socket.instances[0]!.ready();
    expect(f.onErrorFrame).toHaveBeenCalledWith('TERMINAL_NOT_AUTHORIZED');
    expect(f.request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.direct).toHaveBeenCalledOnce();
    f.service.dispose();
    f.connections.reset();
  });

  it('starts a new attachment after backoff rather than falling back on an uncertain OPEN', async () => {
    const f = fixture(undefined, 'terminal-a', true);
    f.direct.mockRejectedValueOnce(new Error('NODE_STREAM_DISCONNECTED'));
    await f.service.attach();
    Socket.instances[0]!.ready();
    expect(f.request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(999);
    expect(f.direct).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.direct).toHaveBeenCalledTimes(2);
    expect(f.request).not.toHaveBeenCalled();
    f.service.dispose();
    f.connections.reset();
  });

  it('uses one admitted carrier for two terminals, gating input until attach and closing one stream at a time', async () => {
    const a = fixture();
    const b = fixture(a.connections, 'terminal-b');
    await Promise.all([a.service.attach(), a.service.attach(), b.service.attach()]);
    expect(a.request).toHaveBeenCalledTimes(2);
    expect(a.request.mock.calls[0]?.[0]).toBe('/api/terminals/terminal-a/attach-ticket');
    expect(JSON.parse(a.request.mock.calls[0]?.[1].body)).toEqual({
      nodeId: 'node-a',
      workspaceId: 'workspace-a',
      afterSequence: 0
    });
    const [socket] = Socket.instances;
    expect(Socket.instances).toHaveLength(1);
    expect(socket!.url.href).toBe('wss://console.example/api/relay/node-a');
    expect(socket!.sent).toEqual(
      [1, 2].map((streamId) => ({
        type: 'OPEN',
        streamId,
        kind: 'terminal',
        grant: 'relay-ticket'
      }))
    );
    a.service.send({ type: 'input', terminalId: a.terminalId, data: 'ignored' });
    expect(await relayTerminalFrames(socket!)).toEqual([]);
    socket!.frame({ type: 'attach', terminalId: a.terminalId, afterSequence: 0 });
    socket!.frame({ type: 'attach', terminalId: b.terminalId, afterSequence: 0 }, 2);
    await vi.advanceTimersByTimeAsync(0);
    expect(a.onAttached).toHaveBeenCalledOnce();
    expect(b.onAttached).toHaveBeenCalledOnce();
    a.service.dispose();
    expect(socket!.sent).toContainEqual({
      type: 'RESET',
      streamId: 1,
      code: 'NODE_STREAM_CANCELLED'
    });
    expect(socket!.readyState).toBe(Socket.OPEN);
    socket!.frame(
      { type: 'output', terminalId: b.terminalId, sequence: 1, data: Uint8Array.of(42) },
      2
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(b.onOutput).toHaveBeenCalledWith(Uint8Array.of(42));
    b.service.dispose();
    a.connections.reset();
    expect(socket!.readyState).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reattaches after a malformed carrier frame and does not replay any input', async () => {
    const f = fixture();
    await f.service.attach();
    const socket = Socket.instances[0]!;
    socket.frame({ type: 'attach', terminalId: f.terminalId, afterSequence: 0 });
    socket.frame({
      type: 'output',
      terminalId: f.terminalId,
      sequence: 8,
      data: Uint8Array.of(42)
    });
    await vi.advanceTimersByTimeAsync(0);
    f.service.send({ type: 'input', terminalId: f.terminalId, data: 'not replayed' });
    await vi.advanceTimersByTimeAsync(0);
    socket.dispatchEvent(new MessageEvent('message', { data: '{}' }));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(JSON.parse(f.request.mock.calls[1]?.[1].body).afterSequence).toBe(8);
    expect(Socket.instances).toHaveLength(2);
    expect(await relayTerminalFrames(Socket.instances[1]!)).toEqual([]);
    f.service.dispose();
    f.connections.reset();
  });

  it('retries after stream attach timeout and stops on the Node terminal-closed reset', async () => {
    const f = fixture();
    await f.service.attach();
    await vi.advanceTimersByTimeAsync(21_000);
    const socket = Socket.instances[0]!;
    expect(Socket.instances).toHaveLength(1);
    expect(f.request).toHaveBeenCalledTimes(2);
    socket.control({ type: 'RESET', streamId: 2, code: 'TERMINAL_CLOSED' });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.onTerminalUnavailable).toHaveBeenCalledWith('TERMINAL_CLOSED');
    expect(f.request).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    f.service.dispose();
    f.connections.reset();
  });

  it('aborts a timed-out HTTP ticket request and does not dispatch after disposal', async () => {
    const f = fixture();
    const late = Promise.withResolvers<{ ticket: string }>();
    f.request.mockImplementationOnce(() => late.promise);
    const attaching = f.service.attach();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.request.mock.calls[0]?.[1].signal.aborted).toBe(true);
    f.service.dispose();
    late.resolve({ ticket: 'late' });
    await attaching;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.request).toHaveBeenCalledOnce();
    expect(Socket.instances).toHaveLength(1);
    expect(Socket.instances[0]!.sent).toEqual([]);
    f.connections.reset();
  });

  it('keeps retrying an occupied terminal without taking the writer and resumes after release', async () => {
    const f = fixture(undefined, 'terminal-a', true);
    f.direct
      .mockRejectedValueOnce(new NodeStreamError('TERMINAL_ATTACH_CONFLICT'))
      .mockRejectedValueOnce(new NodeStreamError('TERMINAL_ATTACH_CONFLICT'))
      .mockRejectedValueOnce(new NodeStreamError('TERMINAL_ATTACH_CONFLICT'))
      .mockRejectedValueOnce(new NodeStreamError('TERMINAL_ATTACH_CONFLICT'));
    await f.service.attach();
    expect(f.onErrorFrame).not.toHaveBeenCalled();
    expect(f.onReconnectStatus).toHaveBeenCalledWith(
      translate('generated.terminalRelayService.terminalConnectionLostReconnectingInSeconds', {
        value0: 1
      })
    );
    await vi.advanceTimersByTimeAsync(7_000);
    expect(f.direct).toHaveBeenCalledTimes(4);
    expect(f.onReconnectStatus).toHaveBeenCalledWith(
      translate('generated.terminalRelayService.terminalOccupiedRetrying')
    );
    await vi.advanceTimersByTimeAsync(8_000);
    expect(f.direct).toHaveBeenCalledTimes(5);
    f.directWire.frame({ type: 'attach', terminalId: f.terminalId, afterSequence: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.onReconnectStatus).toHaveBeenLastCalledWith(undefined);
    expect(f.onErrorFrame).not.toHaveBeenCalled();
    f.service.dispose();
    f.connections.reset();
  });
});
