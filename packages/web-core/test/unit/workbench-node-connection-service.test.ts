import { afterEach, expect, it, vi } from 'vitest';
import {
  decodeNodeStreamFrame,
  encodeNodeRelayHandshake,
  encodeNodeStreamFrame
} from '@myagentroam/protocol/node-stream-wire';
import { createWorkbenchNodeConnectionService } from '../../src/service/workbench-node-connection-service.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fixture() {
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

    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.dispatchEvent(new Event('close'));
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
    }
  });
  const open = (conversationId: string) =>
    service.openStream(
      'node',
      {
        kind: 'hosted-file-upload',
        conversationId,
        uploadId: 'upload'
      },
      new AbortController().signal
    );

  return { sockets, service, open };
}

it('keeps separate cold admission scopes and reuses the admitted Node carrier', async () => {
  const { sockets, service, open } = fixture();
  try {
    const rejected = expect(open('revoked')).rejects.toThrow('RESOURCE_DENIED');
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    expect(sockets[0]!.url.searchParams.get('hostedConversationId')).toBe('revoked');
    const accepted = open('allowed');
    sockets[0]!.close();

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
