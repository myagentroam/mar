import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkspaceDirectDownloadStream } from '../../src/service/workspace-direct-download-stream-service.js';
import {
  directFileContentRevision,
  readWorkspaceDirectFileRange
} from '../../src/service/workspace-direct-file-read-service.js';
import {
  createWorkspaceDirectObjectUrlSink,
  revokeWorkspaceDirectObjectUrl
} from '../../src/service/workspace-direct-object-url-service.js';
import {
  classifySelectedCandidatePair,
  createWorkspaceDirectTransferService
} from '../../src/service/workspace-direct-transfer-service.js';

class FakeDataChannel extends EventTarget {
  readyState = 'open' as RTCDataChannelState;
  binaryType: BinaryType = 'arraybuffer';
  readonly sent: unknown[] = [];
  constructor(readonly label = '') {
    super();
  }
  send(value: unknown): void {
    this.sent.push(value);
  }
  close(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.dispatchEvent(new Event('close'));
  }
  receive(data: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
}

class FakePeerConnection extends EventTarget {
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescription | null = null;
  connectionState = 'new' as RTCPeerConnectionState;
  onicecandidate: RTCPeerConnection['onicecandidate'] = null;
  onconnectionstatechange: RTCPeerConnection['onconnectionstatechange'] = null;
  readonly channels: FakeDataChannel[] = [];
  stats = new Map<string, unknown>();
  constructor(
    private readonly offerSdp = `v=0\r\na=fingerprint:sha-256 ${'AA:'.repeat(31)}AA\r\n`
  ) {
    super();
  }
  createDataChannel(label: string): RTCDataChannel {
    const channel = new FakeDataChannel(label);
    this.channels.push(channel);
    return channel as unknown as RTCDataChannel;
  }
  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'offer', sdp: this.offerSdp };
  }
  async setLocalDescription(value: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = value as RTCSessionDescription;
  }
  async setRemoteDescription(value: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = value as RTCSessionDescription;
  }
  async addIceCandidate(): Promise<void> {}
  async getStats(): Promise<RTCStatsReport> {
    return this.stats as unknown as RTCStatsReport;
  }
  close(): void {
    this.connectionState = 'closed';
  }
  connected(): void {
    this.connectionState = 'connected';
    this.onconnectionstatechange?.call(
      this as unknown as RTCPeerConnection,
      new Event('connectionstatechange')
    );
  }
}

function fixture(ids: string[], overrides: Record<string, unknown> = {}) {
  const sent: unknown[] = [];
  const peers: FakePeerConnection[] = [];
  const service = createWorkspaceDirectTransferService({
    send: (message) => {
      sent.push(message);
      return true;
    },
    randomId: () => ids.shift() ?? 'fallback-request',
    createPeerConnection: () => {
      const peer = new FakePeerConnection();
      peers.push(peer);
      return peer as unknown as RTCPeerConnection;
    },
    ...overrides
  });
  return { service, sent, peers };
}

async function connect(f: ReturnType<typeof fixture>) {
  const pending = f.service.ensureTransport('node-1', 'generation-1');
  f.service.handle({
    type: 'direct.prepared',
    requestId: 'transport-request',
    directSessionId: 'transport-session',
    nodeId: 'node-1',
    nodeGeneration: 'generation-1',
    purpose: 'TRANSPORT',
    expiresAt: Date.now() + 60_000
  });
  await vi.waitFor(() => expect(f.peers).toHaveLength(1));
  f.peers[0]!.connected();
  f.service.handle({ type: 'direct.opened', directSessionId: 'transport-session', offset: 0 });
  await expect(pending).resolves.toBe('DIRECT_AVAILABLE');
}

describe('Workspace direct transfer browser service', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('keeps a connected transport and reuses it without another prepare', async () => {
    const f = fixture(['transport-request']);
    await connect(f);
    expect(f.service.isConnected('node-1', 'generation-1')).toBe(true);
    expect(f.peers[0]!.channels[0]?.label).toBe('mar-direct-transport');
    expect(f.peers[0]!.channels[0]?.readyState).toBe('closed');
    await expect(f.service.ensureTransport('node-1', 'generation-1')).resolves.toBe(
      'DIRECT_AVAILABLE'
    );
    expect(f.peers).toHaveLength(1);
    expect(
      f.sent.filter((value) => (value as { type?: string }).type === 'direct.prepare')
    ).toHaveLength(1);
    f.service.close();
  });

  it('exposes the selected candidate pair network category after connecting', async () => {
    const f = fixture(['transport-request']);
    const pending = f.service.ensureTransport('node-1', 'generation-1');
    f.service.handle({
      type: 'direct.prepared',
      requestId: 'transport-request',
      directSessionId: 'transport-session',
      nodeId: 'node-1',
      nodeGeneration: 'generation-1',
      purpose: 'TRANSPORT',
      expiresAt: Date.now() + 60_000
    });
    await vi.waitFor(() => expect(f.peers).toHaveLength(1));
    f.peers[0]!.stats = new Map([
      ['transport', { id: 'transport', type: 'transport', selectedCandidatePairId: 'pair' }],
      [
        'pair',
        {
          id: 'pair',
          type: 'candidate-pair',
          localCandidateId: 'local',
          remoteCandidateId: 'remote'
        }
      ],
      [
        'local',
        {
          id: 'local',
          address: '192.168.1.20',
          protocol: 'udp',
          networkType: 'ethernet'
        }
      ],
      ['remote', { id: 'remote', address: '192.168.1.30', protocol: 'udp' }]
    ]);
    f.peers[0]!.connected();
    f.service.handle({ type: 'direct.opened', directSessionId: 'transport-session', offset: 0 });
    await expect(pending).resolves.toBe('DIRECT_AVAILABLE');

    await vi.waitFor(() =>
      expect(f.service.networkInfo('node-1', 'generation-1')).toEqual({
        scope: 'PRIVATE',
        ipVersion: 'IPV4',
        protocol: 'UDP',
        interfaceType: 'ETHERNET'
      })
    );
    f.service.close();
  });

  it('releases an idle transport without scheduling a retry', async () => {
    vi.useFakeTimers();
    const f = fixture(['transport-request'], {
      shouldRetryProbe: () => true,
      probeRetryDelaysMs: [10]
    });
    await connect(f);

    f.service.releaseTransport('node-1');
    await vi.advanceTimersByTimeAsync(10);

    expect(f.peers[0]!.connectionState).toBe('closed');
    expect(f.service.result('node-1', 'generation-1')).toBe('STALE');
    expect(
      f.sent.filter((value) => (value as { type?: string }).type === 'direct.prepare')
    ).toHaveLength(1);
  });

  it('defers transport release until the active transfer finishes', async () => {
    const f = fixture(['transport-request', 'upload-request']);
    await connect(f);
    const upload = f.service.upload({
      nodeId: 'node-1',
      nodeGeneration: 'generation-1',
      file: new File(['x'], 'x.txt'),
      descriptor: {
        direction: 'UPLOAD',
        sha256: '0'.repeat(64),
        resource: { kind: 'WORKSPACE_FILE', workspaceId: 'workspace-1', path: 'x.txt' },
        fileName: 'x.txt',
        size: 1
      }
    });
    f.service.handle({
      type: 'direct.prepared',
      requestId: 'upload-request',
      directSessionId: 'upload-session',
      transportSessionId: 'transport-session',
      nodeId: 'node-1',
      nodeGeneration: 'generation-1',
      purpose: 'TRANSFER',
      expiresAt: Date.now() + 60_000
    });
    const channel = f.peers[0]!.channels[1]!;
    f.service.handle({
      type: 'direct.grant',
      directSessionId: 'upload-session',
      grant: 'g'.repeat(32),
      openExpiresAt: Date.now() + 30_000,
      expiresAt: Date.now() + 60_000
    });
    channel.receive(JSON.stringify({ type: 'ACK', offset: 0 }));
    await vi.waitFor(() =>
      expect(channel.sent.some((value) => value instanceof ArrayBuffer)).toBe(true)
    );

    f.service.releaseTransport('node-1');
    expect(f.peers[0]!.connectionState).toBe('connected');
    expect(f.service.transportNodeIds()).toEqual(['node-1']);

    channel.receive(JSON.stringify({ type: 'ACK', offset: 1 }));
    f.service.handle({ type: 'direct.complete', directSessionId: 'upload-session', size: 1 });
    await expect(upload).resolves.toBeUndefined();
    expect(f.peers[0]!.connectionState).toBe('closed');
    expect(f.service.transportNodeIds()).toEqual([]);
  });

  it('invalidates a transport retained by a Terminal reference after expiry', async () => {
    const f = fixture(['transport-request']);
    await connect(f);
    const terminal = f.service.acquireTerminalTransport('node-1', 'generation-1')!;
    f.service.releaseTransport('node-1');
    expect(f.peers[0]!.connectionState).toBe('connected');
    expect(f.service.transportNodeIds()).toEqual(['node-1']);

    f.service.invalidateNode('node-1');
    expect(f.peers[0]!.connectionState).toBe('closed');
    expect(f.service.transportNodeIds()).toEqual([]);
    expect(f.service.acquireTerminalTransport('node-1', 'generation-1')).toBeUndefined();
    terminal.release();
    f.service.close();
  });

  it('resumes an upload from the Node-provided contiguous offset', async () => {
    const f = fixture(['transport-request', 'upload-request']);
    await connect(f);
    const upload = f.service.upload({
      nodeId: 'node-1',
      nodeGeneration: 'generation-1',
      file: new File(['original'], 'x.txt'),
      descriptor: {
        direction: 'UPLOAD',
        sha256: '0'.repeat(64),
        resource: { kind: 'WORKSPACE_FILE', workspaceId: 'workspace-1', path: 'x.txt' },
        fileName: 'x.txt',
        size: 8
      }
    });
    f.service.handle({
      type: 'direct.prepared',
      requestId: 'upload-request',
      directSessionId: 'upload-session',
      transportSessionId: 'transport-session',
      nodeId: 'node-1',
      nodeGeneration: 'generation-1',
      purpose: 'TRANSFER',
      expiresAt: Date.now() + 60_000
    });
    const channel = f.peers[0]!.channels[1]!;
    f.service.handle({
      type: 'direct.grant',
      directSessionId: 'upload-session',
      grant: 'g'.repeat(32),
      openExpiresAt: Date.now() + 30_000,
      expiresAt: Date.now() + 60_000
    });
    channel.receive(JSON.stringify({ type: 'ACK', offset: 3 }));
    await vi.waitFor(() =>
      expect(channel.sent.some((value) => value instanceof ArrayBuffer)).toBe(true)
    );
    const chunk = channel.sent.find((value) => value instanceof ArrayBuffer) as ArrayBuffer;
    expect(new Uint8Array(chunk)).toEqual(new TextEncoder().encode('ginal'));
    channel.receive(JSON.stringify({ type: 'ACK', offset: 8 }));
    f.service.handle({ type: 'direct.complete', directSessionId: 'upload-session', size: 8 });
    await expect(upload).resolves.toBeUndefined();
  });

  it('keeps a deferred transport when the Node becomes active again', async () => {
    const f = fixture(['transport-request', 'upload-request']);
    await connect(f);
    const upload = f.service.upload({
      nodeId: 'node-1',
      nodeGeneration: 'generation-1',
      file: new File(['x'], 'x.txt'),
      descriptor: {
        direction: 'UPLOAD',
        sha256: '0'.repeat(64),
        resource: { kind: 'WORKSPACE_FILE', workspaceId: 'workspace-1', path: 'x.txt' },
        fileName: 'x.txt',
        size: 1
      }
    });
    f.service.handle({
      type: 'direct.prepared',
      requestId: 'upload-request',
      directSessionId: 'upload-session',
      transportSessionId: 'transport-session',
      nodeId: 'node-1',
      nodeGeneration: 'generation-1',
      purpose: 'TRANSFER',
      expiresAt: Date.now() + 60_000
    });
    const channel = f.peers[0]!.channels[1]!;
    f.service.handle({
      type: 'direct.grant',
      directSessionId: 'upload-session',
      grant: 'g'.repeat(32),
      openExpiresAt: Date.now() + 30_000,
      expiresAt: Date.now() + 60_000
    });
    channel.receive(JSON.stringify({ type: 'ACK', offset: 0 }));
    await vi.waitFor(() =>
      expect(channel.sent.some((value) => value instanceof ArrayBuffer)).toBe(true)
    );

    f.service.releaseTransport('node-1');
    await expect(f.service.ensureTransport('node-1', 'generation-1')).resolves.toBe(
      'DIRECT_AVAILABLE'
    );
    channel.receive(JSON.stringify({ type: 'ACK', offset: 1 }));
    f.service.handle({ type: 'direct.complete', directSessionId: 'upload-session', size: 1 });

    await expect(upload).resolves.toBeUndefined();
    expect(f.peers[0]!.connectionState).toBe('connected');
    f.service.close();
  });

  it('retries one failed transport immediately before falling back to the Server path', async () => {
    vi.useFakeTimers();
    const f = fixture(['transport-request-1', 'transport-request-2'], {
      probeTimeoutMs: 100,
      probeRetryDelaysMs: []
    });
    const pending = f.service.ensureTransport('node-1', 'generation-1');
    f.service.handle({
      type: 'direct.prepared',
      requestId: 'transport-request-1',
      directSessionId: 'transport-session-1',
      nodeId: 'node-1',
      nodeGeneration: 'generation-1',
      purpose: 'TRANSPORT',
      expiresAt: Date.now() + 60_000
    });

    await vi.advanceTimersByTimeAsync(100);

    expect(
      f.sent.filter((value) => (value as { type?: string }).type === 'direct.prepare')
    ).toEqual([
      expect.objectContaining({ requestId: 'transport-request-1' }),
      expect.objectContaining({ requestId: 'transport-request-2' })
    ]);
    expect(f.peers[0]?.connectionState).toBe('closed');

    await vi.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toBe('RELAY_ONLY');
    f.service.close();
  });

  it('opens independent upload channels over one transport', async () => {
    const f = fixture(['transport-request', 'upload-request-1', 'upload-request-2']);
    await connect(f);
    for (const [index, requestId] of ['upload-request-1', 'upload-request-2'].entries()) {
      const directSessionId = `upload-session-${index + 1}`;
      const upload = f.service.upload({
        nodeId: 'node-1',
        nodeGeneration: 'generation-1',
        file: new File(['x'], 'x.txt'),
        descriptor: {
          direction: 'UPLOAD',
          sha256: '0'.repeat(64),
          resource: { kind: 'WORKSPACE_FILE', workspaceId: 'workspace-1', path: `x-${index}.txt` },
          fileName: 'x.txt',
          size: 1
        }
      });
      f.service.handle({
        type: 'direct.prepared',
        requestId,
        directSessionId,
        transportSessionId: 'transport-session',
        nodeId: 'node-1',
        nodeGeneration: 'generation-1',
        purpose: 'TRANSFER',
        expiresAt: Date.now() + 60_000
      });
      const channel = f.peers[0]!.channels[index + 1]!;
      f.service.handle({
        type: 'direct.grant',
        directSessionId,
        grant: 'g'.repeat(32),
        openExpiresAt: Date.now() + 30_000,
        expiresAt: Date.now() + 60_000
      });
      expect(channel.sent[0]).toBe(
        JSON.stringify({ type: 'OPEN', directSessionId, grant: 'g'.repeat(32) })
      );
      channel.receive(JSON.stringify({ type: 'ACK', offset: 0 }));
      await vi.waitFor(() =>
        expect(channel.sent.some((value) => value instanceof ArrayBuffer)).toBe(true)
      );
      channel.receive(JSON.stringify({ type: 'ACK', offset: 1 }));
      f.service.handle({
        type: 'direct.complete',
        directSessionId,
        size: 1
      });
      await expect(upload).resolves.toBeUndefined();
    }
    expect(f.peers).toHaveLength(1);
    expect(f.peers[0]!.connectionState).toBe('connected');
    f.service.close();
  });

  it('verifies and acknowledges a bounded Range download without closing the transport', async () => {
    const sink = {
      write: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined)
    };
    const f = fixture(['transport-request', 'download-request']);
    await connect(f);
    const download = f.service.download({
      nodeId: 'node-1',
      nodeGeneration: 'generation-1',
      sink,
      descriptor: {
        direction: 'DOWNLOAD',
        resource: { kind: 'WORKSPACE_FILE', workspaceId: 'workspace-1', path: 'large.bin' },
        fileName: 'large.bin',
        revision: 'revision-1',
        size: 10,
        range: { offset: 4, length: 3 }
      }
    });
    f.service.handle({
      type: 'direct.prepared',
      requestId: 'download-request',
      directSessionId: 'download-session',
      transportSessionId: 'transport-session',
      nodeId: 'node-1',
      nodeGeneration: 'generation-1',
      purpose: 'TRANSFER',
      expiresAt: Date.now() + 60_000
    });
    const channel = f.peers[0]!.channels[1]!;
    f.service.handle({
      type: 'direct.grant',
      directSessionId: 'download-session',
      grant: 'g'.repeat(32),
      openExpiresAt: Date.now() + 30_000,
      expiresAt: Date.now() + 60_000
    });
    channel.receive(new Uint8Array([1, 2, 3]).buffer);
    channel.receive(JSON.stringify({ type: 'COMPLETE', size: 3 }));
    await vi.waitFor(() => expect(sink.close).toHaveBeenCalledOnce());
    expect(channel.sent).toContain(JSON.stringify({ type: 'ACK', offset: 3 }));
    channel.close();
    f.service.handle({
      type: 'direct.complete',
      directSessionId: 'download-session',
      size: 3
    });
    await expect(download).resolves.toBeUndefined();
    expect(f.peers[0]!.connectionState).toBe('connected');
    f.service.close();
  });

  it('closes all transports when the page control connection is invalidated', async () => {
    const f = fixture(['transport-request']);
    await connect(f);
    f.service.invalidateControlConnection();
    expect(f.peers[0]!.connectionState).toBe('closed');
    expect(f.service.result('node-1', 'generation-1')).toBe('STALE');
  });

  it('uses one metadata read and binds the requested Range to the direct transfer', async () => {
    const identity = { size: 8, revision: 'revision-1' };
    const range = { offset: 2, length: 3 };
    const metadata = vi.fn().mockResolvedValue(identity);
    const direct = {
      download: vi.fn(
        async (input: { readonly sink: { write(bytes: Uint8Array): Promise<void> } }) => {
          await input.sink.write(new Uint8Array([2, 3]));
          await input.sink.write(new Uint8Array([4]));
        }
      )
    } as unknown as ReturnType<typeof createWorkspaceDirectTransferService>;

    await expect(
      readWorkspaceDirectFileRange({
        direct,
        nodeId: 'node-1',
        nodeGeneration: 'generation-1',
        resource: {
          kind: 'WORKSPACE_FILE',
          workspaceId: 'workspace-1',
          path: 'payload.bin'
        },
        fileName: 'payload.bin',
        offset: 2,
        length: 3,
        metadata
      })
    ).resolves.toEqual({
      ...identity,
      offset: 2,
      bytes: new Uint8Array([2, 3, 4]),
      nextOffset: 5
    });
    expect(metadata).toHaveBeenCalledOnce();
    expect(metadata).toHaveBeenCalledWith();
    expect(direct.download).toHaveBeenCalledWith(
      expect.objectContaining({
        descriptor: expect.objectContaining({ range })
      })
    );
  });

  it('uses the transferred complete file bytes as the editor revision, not the transfer revision', async () => {
    const bytes = new TextEncoder().encode('first\r\nsecond\r\n');
    const metadata = vi.fn().mockResolvedValue({ size: bytes.length, revision: 'transport-token' });
    const direct = {
      download: vi.fn(
        async (input: { readonly sink: { write(bytes: Uint8Array): Promise<void> } }) => {
          await input.sink.write(bytes);
        }
      )
    } as unknown as ReturnType<typeof createWorkspaceDirectTransferService>;
    const file = await readWorkspaceDirectFileRange({
      direct,
      nodeId: 'node-1',
      nodeGeneration: 'generation-1',
      resource: { kind: 'WORKSPACE_FILE', workspaceId: 'workspace-1', path: 'editable.txt' },
      fileName: 'editable.txt',
      offset: 0,
      length: bytes.length,
      metadata
    });
    expect(file.revision).toBe('transport-token');
    expect(await directFileContentRevision(file)).toBe(
      createHash('sha256').update(bytes).digest('hex')
    );
    expect(await directFileContentRevision({ ...file, nextOffset: 1 })).toBeUndefined();
    expect(await directFileContentRevision({ ...file, offset: 1 })).toBeUndefined();
    expect(await directFileContentRevision({ ...file, size: file.size + 1 })).toBeUndefined();
    expect(
      await directFileContentRevision({
        ...file,
        size: 0,
        bytes: new Uint8Array(),
        nextOffset: null
      })
    ).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('removes a temporary OPFS entry even when creating its object URL fails', async () => {
    const removeEntry = vi.fn(async () => undefined);
    const writable = {
      write: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined)
    };
    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: async () => ({
          getDirectoryHandle: async () => ({
            getFileHandle: async () => ({
              createWritable: async () => writable,
              getFile: async () => {
                throw new Error('OPFS_READ_FAILED');
              }
            }),
            removeEntry
          })
        })
      }
    });

    const target = await createWorkspaceDirectObjectUrlSink('payload.bin');
    await target.sink.close();
    await expect(target.objectUrl()).rejects.toThrow('OPFS_READ_FAILED');
    expect(removeEntry).toHaveBeenCalledOnce();
  });

  it('keeps the OPFS entry until its object URL is revoked', async () => {
    const removeEntry = vi.fn(async () => undefined);
    const writable = {
      write: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined)
    };
    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: async () => ({
          getDirectoryHandle: async () => ({
            getFileHandle: async () => ({
              createWritable: async () => writable,
              getFile: async () => new File(['image'], 'logo.png')
            }),
            removeEntry
          })
        })
      }
    });
    const createObjectUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:logo');
    const revokeObjectUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);

    const target = await createWorkspaceDirectObjectUrlSink('logo.png');
    await target.sink.close();
    await expect(target.objectUrl()).resolves.toBe('blob:logo');
    await expect(target.objectUrl()).resolves.toBe('blob:logo');
    expect(createObjectUrl).toHaveBeenCalledOnce();
    expect(removeEntry).not.toHaveBeenCalled();

    revokeWorkspaceDirectObjectUrl('blob:logo');
    await vi.waitFor(() => expect(removeEntry).toHaveBeenCalledOnce());
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:logo');
  });
});

describe('Workspace direct download stream', () => {
  it('starts the browser download on the first chunk and honors Service Worker backpressure', async () => {
    const received: unknown[] = [];
    const click = vi.fn();
    const append = vi.fn();
    const remove = vi.fn();
    const worker = {
      postMessage: vi.fn((_value: unknown, ports: readonly MessagePort[]) => {
        const port = ports[0]!;
        port.onmessage = (event) => {
          received.push(event.data);
          if ((event.data as { readonly type?: unknown }).type === 'close')
            port.postMessage({ type: 'finished' });
        };
        port.postMessage({ type: 'created' });
        setTimeout(() => port.postMessage({ type: 'pull' }), 0);
      })
    };
    vi.stubGlobal('navigator', {
      serviceWorker: {
        controller: worker
      }
    });
    vi.stubGlobal('document', {
      body: { append },
      createElement: (tag: string) =>
        tag === 'iframe'
          ? { name: '', style: {}, remove: vi.fn() }
          : {
              href: '',
              target: '',
              style: {},
              click,
              remove
            }
    });

    const stream = await createWorkspaceDirectDownloadStream(
      'large.bin',
      3,
      async () => worker as unknown as ServiceWorker
    );
    await stream.sink.write(new Uint8Array([1, 2, 3]));
    await stream.sink.close();
    await vi.waitFor(() =>
      expect(received).toEqual([
        { type: 'chunk', bytes: expect.any(ArrayBuffer) },
        { type: 'close' }
      ])
    );
    expect(new Uint8Array((received[0] as { bytes: ArrayBuffer }).bytes)).toEqual(
      new Uint8Array([1, 2, 3])
    );
    expect(click).toHaveBeenCalledOnce();
    expect(append).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledOnce();
    expect(stream.started()).toBe(true);
  });

  it('aborts the direct transfer when the browser cancels the download', async () => {
    let workerPort: MessagePort | undefined;
    const worker = {
      postMessage: vi.fn((_value: unknown, ports: readonly MessagePort[]) => {
        workerPort = ports[0]!;
        workerPort.postMessage({ type: 'created' });
      })
    };
    vi.stubGlobal('navigator', {
      serviceWorker: {
        controller: worker
      }
    });
    vi.stubGlobal('document', {
      body: { append: vi.fn() },
      createElement: (tag: string) =>
        tag === 'iframe'
          ? { name: '', style: {}, remove: vi.fn() }
          : { href: '', target: '', style: {}, click: vi.fn(), remove: vi.fn() }
    });

    const stream = await createWorkspaceDirectDownloadStream(
      'cancel.bin',
      3,
      async () => worker as unknown as ServiceWorker
    );
    const write = stream.sink.write(new Uint8Array([1, 2, 3]));
    workerPort!.postMessage({
      type: 'cancel',
      reason: 'DIRECT_DOWNLOAD_CANCELLED'
    });
    await expect(write).rejects.toMatchObject({ name: 'AbortError' });
    expect(stream.signal.aborted).toBe(true);
    expect(stream.cancelled()).toBe(true);
  });
});

describe('Workspace direct transport network description', () => {
  it('classifies a public IPv6 UDP pair without exposing either address', () => {
    const stats = new Map<string, unknown>([
      ['transport', { id: 'transport', type: 'transport', selectedCandidatePairId: 'pair' }],
      [
        'pair',
        {
          id: 'pair',
          type: 'candidate-pair',
          localCandidateId: 'local',
          remoteCandidateId: 'remote'
        }
      ],
      [
        'local',
        {
          id: 'local',
          type: 'local-candidate',
          address: '2001:db8::1',
          protocol: 'udp',
          networkType: 'wifi'
        }
      ],
      [
        'remote',
        {
          id: 'remote',
          type: 'remote-candidate',
          address: '240e:37d::1',
          protocol: 'udp'
        }
      ]
    ]);

    expect(classifySelectedCandidatePair(stats as unknown as RTCStatsReport)).toEqual({
      scope: 'PUBLIC',
      ipVersion: 'IPV6',
      protocol: 'UDP',
      interfaceType: 'WIFI'
    });
    expect(
      JSON.stringify(classifySelectedCandidatePair(stats as unknown as RTCStatsReport))
    ).not.toMatch(/2001:|240e:/u);
  });

  it('recognizes benchmarking addresses and VPN interfaces as VPN/TUN', () => {
    const stats = new Map<string, unknown>([
      [
        'pair',
        {
          id: 'pair',
          type: 'candidate-pair',
          state: 'succeeded',
          nominated: true,
          localCandidateId: 'local',
          remoteCandidateId: 'remote'
        }
      ],
      [
        'local',
        {
          id: 'local',
          address: '198.18.0.1',
          protocol: 'udp',
          networkType: 'vpn'
        }
      ],
      ['remote', { id: 'remote', address: '198.19.1.2', protocol: 'udp' }]
    ]);

    expect(classifySelectedCandidatePair(stats as unknown as RTCStatsReport)).toEqual({
      scope: 'VPN_TUN',
      ipVersion: 'IPV4',
      protocol: 'UDP',
      interfaceType: 'VPN'
    });
  });

  it('recognizes a local Node from the remote loopback candidate when local IP is hidden', () => {
    const stats = new Map<string, unknown>([
      [
        'pair',
        {
          id: 'pair',
          type: 'candidate-pair',
          state: 'succeeded',
          nominated: true,
          localCandidateId: 'local',
          remoteCandidateId: 'remote'
        }
      ],
      [
        'local',
        {
          id: 'local',
          type: 'local-candidate',
          address: '',
          protocol: 'udp',
          networkType: 'vpn'
        }
      ],
      [
        'remote',
        {
          id: 'remote',
          type: 'remote-candidate',
          address: '127.0.0.1',
          protocol: 'udp'
        }
      ]
    ]);

    expect(classifySelectedCandidatePair(stats as unknown as RTCStatsReport)).toEqual({
      scope: 'LOOPBACK',
      ipVersion: 'IPV4',
      protocol: 'UDP',
      interfaceType: 'LOOPBACK'
    });
  });
});
