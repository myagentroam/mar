import { afterEach, expect, it, vi } from 'vitest';
import {
  decodeNodeStreamFrame,
  encodeNodeRelayHandshake,
  encodeNodeStreamFrame
} from '@myagentroam/protocol/node-stream-wire';
import { NodeStream } from '@myagentroam/protocol/node-stream';
import { createActiveNodeTransportService } from '../../src/service/active-node-transport-service.js';
import { createWorkbenchNodeConnectionService } from '../../src/service/workbench-node-connection-service.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fixture(options?: Partial<Parameters<typeof createWorkbenchNodeConnectionService>[0]>) {
  const sockets: RelaySocket[] = [];
  class RelaySocket extends EventTarget {
    static readonly OPEN = 1;
    readyState = RelaySocket.OPEN;
    readonly opened: string[] = [];

    constructor(readonly url: URL) {
      super();
      sockets.push(this);
    }

    inbound(bytes: Uint8Array) {
      this.dispatchEvent(new MessageEvent('message', { data: bytes }));
    }

    send(bytes: Uint8Array) {
      const frame = decodeNodeStreamFrame(bytes);
      if (frame.type !== 'OPEN') return;
      this.opened.push(frame.grant);
      this.inbound(encodeNodeStreamFrame({ type: 'OPENED', streamId: frame.streamId }));
    }

    close(code = 1000) {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.dispatchEvent(Object.assign(new Event('close'), { code }));
    }
  }
  vi.stubGlobal('window', { location: { origin: 'http://localhost' } });
  vi.stubGlobal('WebSocket', RelaySocket);
  const service = createWorkbenchNodeConnectionService({
    http: {
      async request<T>(path: string): Promise<T> {
        if (path.includes('/revoked/')) throw new Error('RESOURCE_DENIED');
        return { ticket: 'allowed-ticket' } as T;
      }
    },
    ...options
  });
  const open = (conversationId: string, signal = new AbortController().signal) =>
    service.openStream(
      'node',
      {
        kind: 'hosted-file-upload',
        conversationId,
        uploadId: 'upload'
      },
      signal
    );

  return { sockets, service, open };
}

it('reclaims a Relay-only connection after it goes idle, not while a stream is active', async () => {
  vi.useFakeTimers();
  const { sockets, service, open } = fixture();
  const ttl = 30 * 60_000;
  try {
    const pending = open('allowed');
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]!.inbound(encodeNodeRelayHandshake({ type: 'RELAY_READY' }));
    const stream = await pending;
    await vi.advanceTimersByTimeAsync(ttl);
    expect(sockets[0]!.readyState).toBe(1);
    stream.close();
    await vi.advanceTimersByTimeAsync(ttl - 1);
    expect(sockets[0]!.readyState).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets[0]!.readyState).toBe(3);
    const replacement = open('allowed');
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    sockets[1]!.inbound(encodeNodeRelayHandshake({ type: 'RELAY_READY' }));
    (await replacement).close();
  } finally {
    service.reset();
  }
});

it('releases both paths after a Workspace lease expires and the last stream ends', async () => {
  vi.useFakeTimers();
  const direct = new NodeStream(
    1,
    async () => {},
    () => {}
  );
  const path = { closed: false, close: vi.fn(), openStream: vi.fn(async () => direct) };
  const lease = createActiveNodeTransportService({
    activate: () => {},
    release: (id) => service.expireNode(id)
  });
  const { sockets, service } = fixture({
    isNodeActive: lease.isActive,
    connectDirect: async () => path
  });
  try {
    lease.select('node');
    const pending = service.openStream(
      'node',
      { kind: 'browser-file-upload', ticket: 'ticket' },
      new AbortController().signal
    );
    const stream = await pending;
    expect(stream).toBe(direct);
    expect(sockets).toHaveLength(1);
    sockets[0]!.inbound(encodeNodeRelayHandshake({ type: 'RELAY_READY' }));
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(sockets[0]!.readyState).toBe(1);
    lease.select('another-node');
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(sockets[0]!.readyState).toBe(1);
    expect(path.close).not.toHaveBeenCalled();
    stream.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets[0]!.readyState).toBe(3);
    expect(path.close).toHaveBeenCalledOnce();
  } finally {
    lease.clear();
    service.reset();
  }
});

it('keeps a pending open through lease expiry when another caller cancels', async () => {
  vi.useFakeTimers();
  const lease = createActiveNodeTransportService({
    activate: () => {},
    release: (id) => service.expireNode(id),
    activeTtlMs: 100
  });
  const { sockets, service, open } = fixture({ isNodeActive: lease.isActive });
  try {
    lease.select('node');
    const abort = new AbortController();
    const cancelled = expect(open('allowed', abort.signal)).rejects.toMatchObject({
      name: 'AbortError'
    });
    const pending = open('allowed');
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    lease.select(undefined);
    await vi.advanceTimersByTimeAsync(100);
    abort.abort();
    await cancelled;
    expect(sockets[0]!.readyState).toBe(1);
    sockets[0]!.inbound(encodeNodeRelayHandshake({ type: 'RELAY_READY' }));
    (await pending).close();
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets[0]!.opened).toEqual(['allowed-ticket']);
    expect(sockets[0]!.readyState).toBe(3);
  } finally {
    lease.clear();
    service.reset();
  }
});

it('uses recovered Direct only for new streams and does not start another probe on warm Relay', async () => {
  const direct = new NodeStream(
    1,
    async () => {},
    () => {}
  );
  const path = { closed: false, close: vi.fn(), openStream: vi.fn(async () => direct) };
  const connectDirect = vi
    .fn(async () => path)
    .mockRejectedValueOnce(new Error('DIRECT_UNAVAILABLE'));
  const { sockets, service } = fixture({ connectDirect });
  const open = (ticket: string) =>
    service.openRoutedStream(
      'node',
      { kind: 'browser-file-download', ticket },
      new AbortController().signal
    );
  try {
    await service.directReady('node');
    expect(connectDirect).not.toHaveBeenCalled();
    const pending = open('one');
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]!.inbound(encodeNodeRelayHandshake({ type: 'RELAY_READY' }));
    const existing = await pending;
    expect(existing.transport).toBe('relay');
    (await open('two')).close();
    expect(connectDirect).toHaveBeenCalledOnce();

    await service.directReady('node');
    expect(path.openStream).not.toHaveBeenCalled();
    expect(await open('three')).toMatchObject({ stream: direct, transport: 'ice' });
    expect(connectDirect).toHaveBeenCalledTimes(2);
    expect(path.openStream).toHaveBeenCalledExactlyOnceWith(
      { kind: 'browser-file-download', ticket: 'three' },
      expect.any(AbortSignal)
    );
    expect(sockets[0]!.opened).toEqual(['one', 'two']);
    expect(existing.transport).toBe('relay');
    await existing.stream.write(Uint8Array.of(42));
    existing.close();
    direct.close();
  } finally {
    service.reset();
  }
});

it('reports Relay for a file stream when Direct declines before OPEN', async () => {
  const openStream = vi.fn(async () => undefined);
  const { sockets, service } = fixture({
    connectDirect: async () => ({ closed: false, close() {}, openStream })
  });
  try {
    const pending = service.openRoutedStream(
      'node',
      {
        kind: 'file-upload',
        descriptor: {
          direction: 'UPLOAD',
          resource: { kind: 'WORKSPACE_FILE', workspaceId: 'workspace', path: 'file.txt' },
          fileName: 'file.txt',
          uploadId: 'upload',
          size: 1,
          sha256: 'a'.repeat(64),
          overwrite: false
        }
      },
      new AbortController().signal
    );
    await vi.waitFor(() => expect(openStream).toHaveBeenCalledOnce());
    expect(sockets).toHaveLength(1);
    sockets[0]!.inbound(encodeNodeRelayHandshake({ type: 'RELAY_READY' }));
    const opened = await pending;
    expect(opened.transport).toBe('relay');
    expect(sockets[0]!.opened).toEqual(['allowed-ticket']);
    opened.close();
  } finally {
    service.reset();
  }
});

it('keeps separate cold admission scopes and reuses the admitted Node carrier', async () => {
  const { sockets, service, open } = fixture();
  try {
    const rejected = expect(open('revoked')).rejects.toThrow('RESOURCE_DENIED');
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    expect(sockets[0]!.url.searchParams.get('hostedConversationId')).toBe('revoked');
    const accepted = open('allowed');
    sockets[0]!.close(1008);

    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    expect(sockets[1]!.url.searchParams.get('hostedConversationId')).toBe('allowed');
    sockets[1]!.inbound(encodeNodeRelayHandshake({ type: 'RELAY_READY' }));
    await rejected;
    (await accepted).close();
    (await open('allowed')).close();
    expect(sockets[0]!.opened).toEqual([]);
    expect(sockets[1]!.opened).toEqual(['allowed-ticket', 'allowed-ticket']);
    expect(sockets).toHaveLength(2);
  } finally {
    service.reset();
  }
});

it('bounds cold admission across scopes with a single handshake timeout', async () => {
  const { sockets, service, open } = fixture();
  const deadline = new AbortController();
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
  try {
    const waiting = ['one', 'two', 'three'].map((scope) => open(scope));
    const finished = Promise.allSettled(waiting);
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    deadline.abort(new DOMException('Handshake timed out', 'TimeoutError'));
    expect((await finished).map(({ status }) => status)).toEqual([
      'rejected',
      'rejected',
      'rejected'
    ]);
    expect(timeout).toHaveBeenCalledExactlyOnceWith(15_000);
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.readyState).toBe(3);
    expect(sockets[0]!.opened).toEqual([]);
  } finally {
    service.reset();
  }
});

it('does not repeat a Node-wide Relay readiness failure for each conversation', async () => {
  vi.useFakeTimers();
  const { sockets, service, open } = fixture();
  try {
    const settled = Promise.allSettled(['one', 'two', 'three'].map((scope) => open(scope)));
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]!.close(4004);
    // The handshake is still within its overall budget, but no other scope can fix the Node.
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(1);
    expect(await settled).toMatchObject(
      Array.from({ length: 3 }, () => ({
        status: 'rejected',
        reason: { errors: [{ code: 'NODE_OFFLINE' }] }
      }))
    );
    const afterRecovery = open('two');
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    sockets[1]!.inbound(encodeNodeRelayHandshake({ type: 'RELAY_READY' }));
    (await afterRecovery).close();
    expect(sockets[1]!.opened).toEqual(['allowed-ticket']);
  } finally {
    service.reset();
  }
});
