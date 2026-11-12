import { describe, expect, it, vi } from 'vitest';
import type { RTCPeerConnection as NodeRTCPeerConnection } from 'node-datachannel/polyfill';
import {
  DirectTransferService,
  loopbackHostCandidate,
  probeUdp4Port,
  type DirectTransferServiceOptions
} from '../../src/connection/direct-transfer-service.js';
import { createSocket } from 'node:dgram';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NodeWorkspace } from '../../src/database.js';
import { WorkspaceUploadService } from '../../src/workspace/workspace-upload-service.js';

const browserFingerprint = `sha-256 ${'AA:'.repeat(31)}AA`;
const nodeFingerprint = `sha-256 ${'BB:'.repeat(31)}BB`;
const createIceUdpMuxListener = (port: number) => ({
  port: () => port,
  address: () => '0.0.0.0',
  stop: vi.fn(),
  onUnhandledStunRequest: vi.fn()
});

class FakeDataChannel extends EventTarget {
  label = 'mar-file-transfer';
  binaryType: BinaryType = 'arraybuffer';
  readyState = 'open' as RTCDataChannelState;
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  readonly sent: unknown[] = [];
  send(value: unknown): void {
    this.sent.push(value);
  }
  close(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.onclose?.();
    this.dispatchEvent(new Event('close'));
  }
  receive(data: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data }));
  }
}

class FakePeerConnection extends EventTarget {
  sctp = { maxMessageSize: 16_384 };
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescription | null = null;
  connectionState = 'new' as RTCPeerConnectionState;
  onicecandidate: RTCPeerConnection['onicecandidate'] = null;
  ondatachannel: RTCPeerConnection['ondatachannel'] = null;
  onconnectionstatechange: RTCPeerConnection['onconnectionstatechange'] = null;
  readonly channels: FakeDataChannel[] = [];
  createDataChannel(label: string): RTCDataChannel {
    const channel = new FakeDataChannel();
    channel.label = label;
    this.channels.push(channel);
    return channel as unknown as RTCDataChannel;
  }
  constructor(public answerSdp = `v=0\r\na=fingerprint:${nodeFingerprint}\r\n`) {
    super();
  }
  async setRemoteDescription(value: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = value as RTCSessionDescription;
  }
  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'answer', sdp: this.answerSdp };
  }
  async setLocalDescription(value: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = value as RTCSessionDescription;
  }
  async addIceCandidate(): Promise<void> {}
  close(): void {
    this.connectionState = 'closed';
  }
  attach(channel: FakeDataChannel): void {
    this.ondatachannel?.call(
      this as unknown as RTCPeerConnection,
      { channel: channel as unknown as RTCDataChannel } as RTCDataChannelEvent
    );
  }
  connected(): void {
    this.connectionState = 'connected';
    this.onconnectionstatechange?.call(
      this as unknown as RTCPeerConnection,
      new Event('connectionstatechange')
    );
  }
  emitCandidate(candidate: string): void {
    this.onicecandidate?.call(
      this as unknown as RTCPeerConnection,
      {
        candidate: { candidate, toJSON: () => ({ candidate }) }
      } as unknown as RTCPeerConnectionIceEvent
    );
  }
}

async function createFixture(overrides: Partial<DirectTransferServiceOptions> = {}) {
  const peer = new FakePeerConnection();
  const events: unknown[] = [];
  let now = 100;
  const stop = vi.fn();
  const service = await DirectTransferService.create({
    nodeGeneration: () => 'generation-1',
    send: (_type, event) => events.push(event),
    now: () => now,
    leaseGraceMs: 100,
    leaseCheckMs: 5,
    createIceUdpMuxListener: (port) => ({ ...createIceUdpMuxListener(port), stop }),
    createPeerConnection: () => peer as unknown as NodeRTCPeerConnection,
    ...overrides
  });
  return { service, peer, events, stop, setNow: (value: number) => (now = value) };
}

async function connectTransport(f: Awaited<ReturnType<typeof createFixture>>) {
  expect(
    f.service.handle({
      type: 'direct.prepare',
      directSessionId: 'transport-0001',
      workbenchConnectionId: 'connection-0001',
      nodeGeneration: 'generation-1',
      purpose: 'TRANSPORT',
      expiresAt: 1_000,
      userAuthorization: {}
    })
  ).toBe(true);
  f.service.handle({
    type: 'direct.signal',
    directSessionId: 'transport-0001',
    signal: {
      kind: 'OFFER',
      sdp: `v=0\r\na=fingerprint:${browserFingerprint}\r\n`,
      fingerprint: browserFingerprint
    }
  });
  await vi.waitFor(() =>
    expect(f.events).toContainEqual(
      expect.objectContaining({
        type: 'direct.signal',
        signal: expect.objectContaining({ kind: 'ANSWER' })
      })
    )
  );
  f.peer.connected();
  await vi.waitFor(() =>
    expect(f.events).toContainEqual({ type: 'direct.connected', directSessionId: 'transport-0001' })
  );
}

function prepareTransfer(
  f: Awaited<ReturnType<typeof createFixture>>,
  transfer: Record<string, unknown>,
  id = 'transfer-0001'
) {
  expect(
    f.service.handle({
      type: 'direct.prepare',
      directSessionId: id,
      transportSessionId: 'transport-0001',
      workbenchConnectionId: 'connection-0001',
      nodeGeneration: 'generation-1',
      purpose: 'TRANSFER',
      expiresAt: 900,
      transfer,
      userAuthorization: {}
    })
  ).toBe(true);
  f.service.handle({
    type: 'direct.grant',
    directSessionId: id,
    transportSessionId: 'transport-0001',
    grant: 'g'.repeat(32),
    browserFingerprint,
    nodeFingerprint,
    openExpiresAt: 500,
    expiresAt: 900
  });
}

function uploadState(service: WorkspaceUploadService) {
  return service as unknown as {
    uploads: Map<
      string,
      import('../../src/workspace/workspace-upload-service.js').ActiveWorkspaceUpload
    >;
    composerAttachments: Map<
      string,
      import('../../src/workspace/workspace-upload-service.js').CompletedComposerAttachment
    >;
  };
}

describe('Node direct transfer service', () => {
  it('suspends only Remote Desktop and leaves the shared RTC transport running', async () => {
    let release!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      release = resolve;
    });
    const close = vi.fn(() => cleanup);
    const events = vi.fn(() => true);
    const f = await createFixture({
      desktop: {
        isCurrent: () => true,
        createAttachment: (_command, _stream, callbacks) => ({
          open: async () => callbacks.attached(),
          close
        }),
        emit: events
      }
    });
    try {
      await connectTransport(f);
      const prepare = {
        type: 'desktop.direct.prepare',
        attachmentId: 'attachment-1',
        transportSessionId: 'transport-0001',
        workbenchConnectionId: 'connection-0001',
        nodeGeneration: 'generation-1',
        desktopGeneration: 'desktop-1',
        topologyRevision: 1,
        mode: 'VIEW',
        grant: 'g'.repeat(32),
        browserFingerprint,
        nodeFingerprint,
        openExpiresAt: 500,
        expiresAt: 900
      };
      f.service.handleDesktop(prepare);
      f.peer.channels[0]!.receive(
        JSON.stringify({ type: 'OPEN', attachmentId: prepare.attachmentId, grant: prepare.grant })
      );
      const pending = f.service.suspendDesktop(AbortSignal.timeout(5_000));
      expect(close).toHaveBeenCalledOnce();
      expect(f.peer.connectionState).toBe('connected');
      expect(f.stop).not.toHaveBeenCalled();
      expect(f.service.resumeDesktop()).toBe(false);
      f.service.handleDesktop({ ...prepare, attachmentId: 'attachment-2' });
      expect(f.peer.channels).toHaveLength(1);
      release();
      await pending;
      expect(events).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'desktop.direct.closed', code: 'DESKTOP_UNAVAILABLE' })
      );
      expect(f.service.resumeDesktop()).toBe(true);
      f.service.handleDesktop({ ...prepare, attachmentId: 'attachment-3' });
      expect(f.peer.channels).toHaveLength(2);
      expect(f.peer.connectionState).toBe('connected');
    } finally {
      f.service.dispose();
    }
  });

  it('joins Remote native cleanup before completing transport shutdown', async () => {
    let release!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      release = resolve;
    });
    const close = vi.fn(() => cleanup);
    const desktopEvents = vi.fn(() => true);
    const f = await createFixture({
      desktop: {
        isCurrent: () => true,
        createAttachment: (_command, _stream, callbacks) => ({
          open: async () => callbacks.attached(),
          close
        }),
        emit: desktopEvents
      }
    });
    await connectTransport(f);
    const grant = 'g'.repeat(32);
    f.service.handleDesktop({
      type: 'desktop.direct.prepare',
      attachmentId: 'attachment-1',
      transportSessionId: 'transport-0001',
      workbenchConnectionId: 'connection-0001',
      nodeGeneration: 'generation-1',
      desktopGeneration: 'desktop-1',
      topologyRevision: 1,
      mode: 'VIEW',
      grant,
      browserFingerprint,
      nodeFingerprint,
      openExpiresAt: 500,
      expiresAt: 900
    });
    const channel = f.peer.channels[0]!;
    channel.receive(JSON.stringify({ type: 'OPEN', attachmentId: 'attachment-1', grant }));
    let finished = false;
    const shutdown = f.service.shutdown(AbortSignal.timeout(5_000)).then(() => {
      finished = true;
    });
    expect(close).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(finished).toBe(false);
    release();
    await shutdown;
    expect(finished).toBe(true);
    expect(desktopEvents).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'desktop.direct.closed', code: 'DESKTOP_SERVER_SHUTDOWN' })
    );
  });

  it('binds desktop channels to the authenticated transport and closes them when it ends', async () => {
    const events: unknown[] = [];
    const createAttachment = vi.fn();
    const f = await createFixture({
      desktop: {
        isCurrent: () => true,
        createAttachment,
        emit: (event) => {
          events.push(event);
          return true;
        }
      }
    });
    await connectTransport(f);
    const desktop = {
      type: 'desktop.direct.prepare',
      attachmentId: 'attachment-1',
      transportSessionId: 'transport-0001',
      workbenchConnectionId: 'connection-0001',
      nodeGeneration: 'generation-1',
      desktopGeneration: 'desktop-1',
      topologyRevision: 1,
      mode: 'VIEW',
      grant: 'g'.repeat(32),
      browserFingerprint,
      nodeFingerprint,
      openExpiresAt: 500,
      expiresAt: 900
    };
    expect(
      f.service.handleDesktop({
        ...desktop,
        attachmentId: 'attachment-2',
        nodeFingerprint: browserFingerprint
      })
    ).toBe(true);
    expect(f.peer.channels).toHaveLength(0);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'desktop.direct.closed', attachmentId: 'attachment-2' })
    );
    expect(f.service.handleDesktop(desktop)).toBe(true);
    expect(f.peer.channels).toHaveLength(1);
    expect(f.peer.channels[0]?.label).toBe('mar-desktop-attachment-1');
    expect(createAttachment).not.toHaveBeenCalled();
    f.service.handle({
      type: 'direct.cancel',
      directSessionId: 'transport-0001',
      code: 'DIRECT_CANCELLED'
    });
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'desktop.direct.closed', attachmentId: 'attachment-1' })
      )
    );
    expect(f.peer.channels[0]?.readyState).toBe('closed');
    f.service.dispose();
  });

  it('derives prioritized loopback candidates without replacing the LAN candidate', async () => {
    const source = 'candidate:1 1 UDP 2114977791 192.168.1.20 50000 typ host';
    expect(loopbackHostCandidate(source)).toBe(
      'candidate:1 1 UDP 2130706431 127.0.0.1 50000 typ host'
    );
    expect(loopbackHostCandidate(source.replace('192.168.1.20', '2001:db8::1'))).toBe(
      'candidate:1 1 UDP 2130706431 ::1 50000 typ host'
    );
    expect(loopbackHostCandidate('candidate:1 1 UDP 2114977791 host.local 50000 typ host')).toBe(
      undefined
    );

    const f = await createFixture();
    try {
      await connectTransport(f);
      f.peer.emitCandidate(source);
      expect(f.events).toContainEqual(
        expect.objectContaining({
          signal: {
            kind: 'CANDIDATE',
            candidate: expect.objectContaining({ candidate: loopbackHostCandidate(source) })
          }
        })
      );
      expect(f.events).toContainEqual(
        expect.objectContaining({
          signal: {
            kind: 'CANDIDATE',
            candidate: expect.objectContaining({ candidate: source })
          }
        })
      );
    } finally {
      f.service.dispose();
    }
  });

  it('includes loopback and LAN candidates in the answer SDP', async () => {
    const source = 'candidate:1 1 UDP 2114977791 192.168.1.20 50000 typ host';
    const f = await createFixture();
    try {
      f.peer.answerSdp = `v=0\r\na=fingerprint:${nodeFingerprint}\r\na=${source}\r\n`;
      await connectTransport(f);
      const answer = f.events.find(
        (event) =>
          typeof event === 'object' &&
          event !== null &&
          'signal' in event &&
          typeof event.signal === 'object' &&
          event.signal !== null &&
          'kind' in event.signal &&
          event.signal.kind === 'ANSWER'
      );
      expect(answer).toMatchObject({
        signal: {
          kind: 'ANSWER',
          sdp: expect.stringContaining(`a=${loopbackHostCandidate(source)}`)
        }
      });
      expect(answer).toMatchObject({
        signal: { kind: 'ANSWER', sdp: expect.stringContaining(`a=${source}`) }
      });
    } finally {
      f.service.dispose();
    }
  });

  it('drops queued upload work when its transfer has ended', async () => {
    let finishWrite!: (offset: number) => void;
    const write = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          finishWrite = resolve;
        })
    );
    const complete = vi.fn(async () => undefined);
    const cancel = vi.fn(async () => undefined);
    const f = await createFixture({
      openUpload: async () => ({ offset: 0, write, complete, cancel })
    });
    try {
      await connectTransport(f);
      prepareTransfer(f, {
        direction: 'UPLOAD',
        sha256: '0'.repeat(64),
        resource: { kind: 'WORKSPACE_FILE', workspaceId: 'workspace-1', path: 'x' },
        fileName: 'x',
        size: 1
      });
      const channel = new FakeDataChannel();
      f.peer.attach(channel);
      channel.receive(
        JSON.stringify({ type: 'OPEN', directSessionId: 'transfer-0001', grant: 'g'.repeat(32) })
      );
      await vi.waitFor(() =>
        expect(channel.sent).toContain(JSON.stringify({ type: 'ACK', offset: 0 }))
      );
      channel.receive(new Uint8Array([1]));
      await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
      channel.receive(JSON.stringify({ type: 'COMPLETE', size: 1 }));
      channel.close();
      finishWrite(1);
      await new Promise((resolve) => setImmediate(resolve));
      expect(complete).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
      expect(channel.sent).not.toContain(JSON.stringify({ type: 'ACK', offset: 1 }));
    } finally {
      f.service.dispose();
    }
  });

  it('cleans a late upload target after cancellation during opening', async () => {
    let finishOpen!: (target: {
      offset: number;
      write: () => Promise<number>;
      complete: () => Promise<void>;
      cancel: () => Promise<void>;
    }) => void;
    const openUpload = vi.fn(
      () =>
        new Promise<Parameters<typeof finishOpen>[0]>((resolve) => {
          finishOpen = resolve;
        })
    );
    const cancel = vi.fn(async () => undefined);
    const f = await createFixture({ openUpload });
    try {
      await connectTransport(f);
      prepareTransfer(f, {
        direction: 'UPLOAD',
        sha256: '0'.repeat(64),
        resource: { kind: 'WORKSPACE_FILE', workspaceId: 'workspace-1', path: 'x' },
        fileName: 'x',
        size: 1
      });
      const channel = new FakeDataChannel();
      f.peer.attach(channel);
      channel.receive(
        JSON.stringify({ type: 'OPEN', directSessionId: 'transfer-0001', grant: 'g'.repeat(32) })
      );
      await vi.waitFor(() => expect(openUpload).toHaveBeenCalledOnce());
      f.service.handle({
        type: 'direct.cancel',
        directSessionId: 'transfer-0001',
        code: 'DIRECT_TRANSFER_CANCELLED'
      });
      finishOpen({ offset: 0, write: async () => 0, complete: async () => undefined, cancel });
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
      expect(channel.readyState).toBe('closed');
      expect(channel.sent).toEqual([]);
      expect(f.events).not.toContainEqual(expect.objectContaining({ type: 'direct.opened' }));
    } finally {
      f.service.dispose();
    }
  });

  it('aborts the completion signal and reports cleanup failures when explicitly cancelled', async () => {
    let signal!: AbortSignal;
    let finish!: () => void;
    const complete = vi.fn(async (_size: number, input?: AbortSignal) => {
      signal = input!;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    const f = await createFixture({
      openUpload: async () => ({
        offset: 0,
        write: async () => 0,
        complete,
        cancel: async () => {
          throw new Error('temporary failure');
        }
      })
    });
    try {
      await connectTransport(f);
      prepareTransfer(f, {
        direction: 'UPLOAD',
        sha256: '0'.repeat(64),
        resource: { kind: 'WORKSPACE_FILE', workspaceId: 'workspace-1', path: 'x' },
        fileName: 'x',
        size: 0
      });
      const channel = new FakeDataChannel();
      f.peer.attach(channel);
      channel.receive(
        JSON.stringify({ type: 'OPEN', directSessionId: 'transfer-0001', grant: 'g'.repeat(32) })
      );
      await vi.waitFor(() =>
        expect(channel.sent).toContain(JSON.stringify({ type: 'ACK', offset: 0 }))
      );
      channel.receive(JSON.stringify({ type: 'COMPLETE', size: 0 }));
      await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
      f.service.handle({
        type: 'direct.cancel',
        directSessionId: 'transfer-0001',
        code: 'DIRECT_TRANSFER_CANCELLED'
      });
      await vi.waitFor(() => expect(signal.aborted).toBe(true));
      finish();
      await vi.waitFor(() =>
        expect(f.events).toContainEqual(
          expect.objectContaining({ type: 'direct.error', code: 'DIRECT_UPLOAD_CLEANUP_FAILED' })
        )
      );
      expect(f.events).not.toContainEqual(expect.objectContaining({ type: 'direct.complete' }));
    } finally {
      f.service.dispose();
    }
  });

  it.each(['channel', 'control'])(
    'reauthorizes after %s disconnect and commits from the Node offset, not the requested offset',
    async (connection) => {
      const root = await mkdtemp(join(tmpdir(), 'mar-direct-resume-'));
      const uploads = new WorkspaceUploadService(
        () => undefined,
        () => root
      );
      const workspace = { id: 'workspace-1', path: root } as NodeWorkspace;
      const payload = Buffer.from('original');
      const descriptor = {
        direction: 'UPLOAD',
        sha256: createHash('sha256').update(payload).digest('hex'),
        resource: { kind: 'WORKSPACE_FILE', workspaceId: workspace.id, path: 'file.bin' },
        fileName: 'file.bin',
        size: payload.length,
        overwrite: true,
        resumeOffset: 7
      };
      const f = await createFixture({
        openUpload: async (input) => {
          if (input.direction !== 'UPLOAD') throw new Error('Expected upload');
          const upload = await uploads.createDirect(workspace, {
            path: input.resource.path,
            size: input.size,
            sha256: input.sha256,
            overwrite: input.overwrite === true
          });
          return {
            offset: upload.receivedBytes,
            write: (bytes) => uploads.writeDirect(upload.uploadId, bytes),
            complete: (size) => uploads.completeDirect(upload.uploadId, size),
            cancel: () => uploads.cancel(upload.uploadId)
          };
        }
      });
      try {
        await writeFile(join(root, 'file.bin'), 'old target');
        await connectTransport(f);
        prepareTransfer(f, descriptor);
        const first = new FakeDataChannel();
        f.peer.attach(first);
        first.receive(
          JSON.stringify({ type: 'OPEN', directSessionId: 'transfer-0001', grant: 'g'.repeat(32) })
        );
        await vi.waitFor(() =>
          expect(first.sent).toContain(JSON.stringify({ type: 'ACK', offset: 0 }))
        );
        first.receive(payload.subarray(0, 3));
        await vi.waitFor(() =>
          expect(first.sent).toContain(JSON.stringify({ type: 'ACK', offset: 3 }))
        );
        if (connection === 'channel') first.close();
        else f.service.close('DIRECT_TRANSFER_CONTROL_UNAVAILABLE');
        expect(uploadState(uploads).uploads.size).toBe(1);
        expect(await readFile(join(root, 'file.bin'), 'utf8')).toBe('old target');

        if (connection === 'control') await connectTransport(f);

        prepareTransfer(f, descriptor, 'transfer-0002');
        const resumed = new FakeDataChannel();
        f.peer.attach(resumed);
        resumed.receive(
          JSON.stringify({ type: 'OPEN', directSessionId: 'transfer-0002', grant: 'g'.repeat(32) })
        );
        await vi.waitFor(() =>
          expect(resumed.sent).toContain(JSON.stringify({ type: 'ACK', offset: 3 }))
        );
        resumed.receive(payload.subarray(3));
        await vi.waitFor(() =>
          expect(resumed.sent).toContain(JSON.stringify({ type: 'ACK', offset: 8 }))
        );
        resumed.receive(JSON.stringify({ type: 'COMPLETE', size: payload.length }));
        await vi.waitFor(() =>
          expect(f.events).toContainEqual({
            type: 'direct.complete',
            directSessionId: 'transfer-0002',
            size: 8
          })
        );
        expect(await readFile(join(root, 'file.bin'), 'utf8')).toBe('original');
        expect(uploadState(uploads).uploads.size).toBe(0);
      } finally {
        f.service.dispose();
        await uploads.shutdown();
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it('skips IPv4-occupied ports even when the native UDP mux would accept them', async () => {
    const create = vi.fn(createIceUdpMuxListener);
    const probe = vi.fn(async (port: number) => {
      if (port === 50_000) throw new Error('IPv4 port already occupied');
    });
    const service = await DirectTransferService.create({
      nodeGeneration: () => 'generation-1',
      send: () => undefined,
      udpPortRange: () => ({ begin: 50_000, end: 50_001 }),
      createIceUdpMuxListener: create,
      probeUdp4Port: probe
    });
    try {
      expect(create.mock.calls.map(([port]) => port)).toEqual([50_001]);
      expect(probe.mock.calls.map(([port]) => port)).toEqual([50_000, 50_001]);
    } finally {
      service.dispose();
    }
  });

  it('rejects an occupied IPv4 socket and releases a successful probe before creating the mux', async () => {
    const occupied = createSocket('udp4');
    await new Promise<void>((resolve, reject) => {
      occupied.once('error', reject);
      occupied.bind(0, '0.0.0.0', resolve);
    });
    const port = occupied.address().port;
    const create = vi.fn(createIceUdpMuxListener);
    const options = {
      nodeGeneration: () => 'generation-1',
      send: () => undefined,
      udpPortRange: () => ({ begin: port, end: port }),
      createIceUdpMuxListener: create,
      probeUdp4Port
    };
    try {
      await expect(DirectTransferService.create(options)).rejects.toMatchObject({
        message: 'DIRECT_UDP_PORT_UNAVAILABLE'
      });
      expect(create).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
    const service = await DirectTransferService.create(options);
    try {
      expect(create).toHaveBeenCalledExactlyOnceWith(port);
      await expect(probeUdp4Port(port)).resolves.toBeUndefined();
    } finally {
      service.dispose();
    }
  });

  it('tries the next port when the native mux rejects a port after its IPv4 probe', async () => {
    const probe = vi.fn(async () => undefined);
    const create = vi.fn((port: number) => {
      if (port === 50_000) throw new Error('Native port already occupied');
      return createIceUdpMuxListener(port);
    });
    const service = await DirectTransferService.create({
      nodeGeneration: () => 'generation-1',
      send: () => undefined,
      udpPortRange: () => ({ begin: 50_000, end: 50_001 }),
      createIceUdpMuxListener: create,
      probeUdp4Port: probe
    });
    try {
      expect(probe.mock.calls).toHaveLength(2);
      expect(create.mock.calls.map(([port]) => port)).toEqual([50_000, 50_001]);
    } finally {
      service.dispose();
    }
  });

  it.each(['IPv4 probe', 'native mux'])(
    'reports UDP pool exhaustion from the %s',
    async (failure) => {
      const unavailable = new Error('Port unavailable');
      const probe = vi.fn(async () => {
        if (failure === 'IPv4 probe') throw unavailable;
      });
      const create = vi.fn(() => {
        throw unavailable;
      });
      await expect(
        DirectTransferService.create({
          nodeGeneration: () => 'generation-1',
          send: () => undefined,
          udpPortRange: () => ({ begin: 50_000, end: 50_001 }),
          createIceUdpMuxListener: create,
          probeUdp4Port: probe
        })
      ).rejects.toMatchObject({ message: 'DIRECT_UDP_PORT_UNAVAILABLE', cause: unavailable });
      expect(probe).toHaveBeenCalledTimes(2);
      expect(create).toHaveBeenCalledTimes(failure === 'IPv4 probe' ? 0 : 2);
    }
  );

  it('waits for an IPv4 probe before creating the native mux', async () => {
    let finishProbe!: () => void;
    const pendingProbe = new Promise<void>((resolve) => (finishProbe = resolve));
    const create = vi.fn(createIceUdpMuxListener);
    const pending = DirectTransferService.create({
      nodeGeneration: () => 'generation-1',
      send: () => undefined,
      udpPortRange: () => ({ begin: 50_000, end: 50_000 }),
      createIceUdpMuxListener: create,
      probeUdp4Port: () => pendingProbe
    });
    expect(create).not.toHaveBeenCalled();
    finishProbe();
    const service = await pending;
    expect(create).toHaveBeenCalledOnce();
    service.dispose();
  });

  it('keeps one UDP mux listener while separate transports reuse its fixed port', async () => {
    const configurations: unknown[] = [];
    const stop = vi.fn();
    const service = await DirectTransferService.create({
      nodeGeneration: () => 'generation-1',
      send: () => undefined,
      udpPortRange: () => ({ begin: 50_000, end: 50_031 }),
      createIceUdpMuxListener: (port) => ({ ...createIceUdpMuxListener(port), stop }),
      createPeerConnection: (configuration) => {
        configurations.push(configuration);
        return new FakePeerConnection() as unknown as NodeRTCPeerConnection;
      }
    });
    for (const id of ['transport-0001', 'transport-0002'])
      service.handle({
        type: 'direct.prepare',
        directSessionId: id,
        workbenchConnectionId: `connection-${id}`,
        nodeGeneration: 'generation-1',
        purpose: 'TRANSPORT',
        expiresAt: Date.now() + 60_000,
        userAuthorization: {}
      });
    expect(configurations).toHaveLength(2);
    expect(configurations[0]).toEqual(
      expect.objectContaining({ portRangeBegin: 50_000, portRangeEnd: 50_000 })
    );
    expect(configurations[1]).toEqual(configurations[0]);
    service.close();
    expect(stop).not.toHaveBeenCalled();
    service.dispose();
    expect(stop).toHaveBeenCalledOnce();
  });

  it('routes multiple task DataChannels over one connected transport without closing its peer', async () => {
    const openUpload = vi.fn(async () => ({
      offset: 0,
      write: vi.fn(async (bytes: Uint8Array) => bytes.length),
      complete: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined)
    }));
    const f = await createFixture({ openUpload });
    await connectTransport(f);
    for (const id of ['transfer-0001', 'transfer-0002']) {
      prepareTransfer(
        f,
        {
          direction: 'UPLOAD',
          sha256: '0'.repeat(64),
          resource: { kind: 'WORKSPACE_FILE', workspaceId: 'workspace-1', path: `${id}.bin` },
          fileName: `${id}.bin`,
          size: 1
        },
        id
      );
      const channel = new FakeDataChannel();
      f.peer.attach(channel);
      channel.receive(JSON.stringify({ type: 'OPEN', directSessionId: id, grant: 'g'.repeat(32) }));
      await vi.waitFor(() =>
        expect(channel.sent).toContain(JSON.stringify({ type: 'ACK', offset: 0 }))
      );
      channel.receive(new Uint8Array([1]).buffer);
      await vi.waitFor(() =>
        expect(channel.sent).toContain(JSON.stringify({ type: 'ACK', offset: 1 }))
      );
      channel.receive(JSON.stringify({ type: 'COMPLETE', size: 1 }));
      await vi.waitFor(() =>
        expect(f.events).toContainEqual({
          type: 'direct.complete',
          directSessionId: id,
          size: 1
        })
      );
    }
    expect(openUpload).toHaveBeenCalledTimes(2);
    expect(f.peer.connectionState).toBe('connected');
    f.service.dispose();
  });

  it('keeps an uncommitted upload when its DataChannel disconnects', async () => {
    const cancel = vi.fn(async () => undefined);
    const openUpload = vi.fn(async () => ({
      offset: 2,
      write: vi.fn(async (bytes: Uint8Array) => 2 + bytes.length),
      complete: vi.fn(async () => undefined),
      cancel
    }));
    const f = await createFixture({ openUpload });
    await connectTransport(f);
    prepareTransfer(f, {
      direction: 'UPLOAD',
      sha256: '0'.repeat(64),
      resource: { kind: 'WORKSPACE_FILE', workspaceId: 'workspace-1', path: 'file.bin' },
      fileName: 'file.bin',
      size: 4
    });
    const channel = new FakeDataChannel();
    f.peer.attach(channel);
    channel.receive(
      JSON.stringify({ type: 'OPEN', directSessionId: 'transfer-0001', grant: 'g'.repeat(32) })
    );
    await vi.waitFor(() =>
      expect(channel.sent).toContain(JSON.stringify({ type: 'ACK', offset: 2 }))
    );
    channel.close();
    await vi.waitFor(() =>
      expect(f.events).toContainEqual(
        expect.objectContaining({ type: 'direct.error', code: 'DIRECT_CHANNEL_CLOSED' })
      )
    );
    expect(cancel).not.toHaveBeenCalled();
    f.service.dispose();
  });

  it('streams only the requested Range and reports its transferred length', async () => {
    const f = await createFixture({
      openDownload: async () => ({
        offset: 4,
        chunks: (async function* () {
          yield new Uint8Array([4, 5, 6]);
        })()
      })
    });
    await connectTransport(f);
    prepareTransfer(f, {
      direction: 'DOWNLOAD',
      resource: { kind: 'WORKSPACE_FILE', workspaceId: 'workspace-1', path: 'file.bin' },
      fileName: 'file.bin',
      revision: 'revision-1',
      size: 10,
      range: { offset: 4, length: 3 }
    });
    const channel = new FakeDataChannel();
    f.peer.attach(channel);
    channel.receive(
      JSON.stringify({ type: 'OPEN', directSessionId: 'transfer-0001', grant: 'g'.repeat(32) })
    );
    await vi.waitFor(() =>
      expect(channel.sent.some((value) => value instanceof ArrayBuffer)).toBe(true)
    );
    expect(channel.sent.at(-1)).toBe(JSON.stringify({ type: 'COMPLETE', size: 3 }));
    channel.receive(JSON.stringify({ type: 'ACK', offset: 3 }));
    await vi.waitFor(() =>
      expect(f.events).toContainEqual({
        type: 'direct.complete',
        directSessionId: 'transfer-0001',
        size: 3
      })
    );
    expect(f.peer.connectionState).toBe('connected');
    f.service.dispose();
  });

  it('rejects a transfer grant bound to another transport fingerprint', async () => {
    const openUpload = vi.fn();
    const f = await createFixture({ openUpload });
    await connectTransport(f);
    f.service.handle({
      type: 'direct.prepare',
      directSessionId: 'transfer-0001',
      transportSessionId: 'transport-0001',
      workbenchConnectionId: 'connection-0001',
      nodeGeneration: 'generation-1',
      purpose: 'TRANSFER',
      expiresAt: 900,
      transfer: {
        direction: 'UPLOAD',
        sha256: '0'.repeat(64),
        resource: { kind: 'WORKSPACE_FILE', workspaceId: 'workspace-1', path: 'x' },
        fileName: 'x',
        size: 1
      },
      userAuthorization: {}
    });
    f.service.handle({
      type: 'direct.grant',
      directSessionId: 'transfer-0001',
      transportSessionId: 'transport-0001',
      grant: 'g'.repeat(32),
      browserFingerprint: `sha-256 ${'CC:'.repeat(31)}CC`,
      nodeFingerprint,
      openExpiresAt: 500,
      expiresAt: 900
    });
    await vi.waitFor(() =>
      expect(f.events).toContainEqual(
        expect.objectContaining({ type: 'direct.error', code: 'DIRECT_TRANSFER_GRANT_INVALID' })
      )
    );
    expect(openUpload).not.toHaveBeenCalled();
    f.service.dispose();
  });

  it('renews a transport lease and cascades its final cancellation to active tasks', async () => {
    const cancel = vi.fn(async () => undefined);
    const f = await createFixture({
      openUpload: async () => ({
        offset: 0,
        write: async () => 0,
        complete: async () => undefined,
        cancel
      })
    });
    await connectTransport(f);
    prepareTransfer(f, {
      direction: 'UPLOAD',
      sha256: '0'.repeat(64),
      resource: { kind: 'WORKSPACE_FILE', workspaceId: 'workspace-1', path: 'x' },
      fileName: 'x',
      size: 1
    });
    const channel = new FakeDataChannel();
    f.peer.attach(channel);
    channel.receive(
      JSON.stringify({ type: 'OPEN', directSessionId: 'transfer-0001', grant: 'g'.repeat(32) })
    );
    await vi.waitFor(() =>
      expect(channel.sent).toContain(JSON.stringify({ type: 'ACK', offset: 0 }))
    );
    f.setNow(180);
    f.service.handle({
      type: 'direct.heartbeat',
      directSessionId: 'transport-0001',
      expiresAt: 1_200
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(f.peer.connectionState).toBe('connected');
    f.service.handle({
      type: 'direct.cancel',
      directSessionId: 'transport-0001',
      code: 'DIRECT_ACCESS_REVOKED'
    });
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(channel.readyState).toBe('closed'));
    expect(f.peer.connectionState).toBe('closed');
    f.service.dispose();
  });
});
