import { createSocket } from 'node:dgram';
import { isIP } from 'node:net';
import {
  type DirectNodeCommand,
  type DirectNodeEvent,
  type DirectTransferDescriptor,
  directNodeCommandSchema
} from '@myagentroam/protocol';
import {
  bindNodeDirectPath,
  NODE_STREAM_CHANNEL_LABEL,
  rtcNodeStreamCarrier
} from '@myagentroam/protocol/node-stream-path';
import type { NodeStreamHandler } from '@myagentroam/protocol/node-stream-mux';
import type { NodeStream } from '@myagentroam/protocol/node-stream';
import { sendFileDownload } from './file-download-stream.js';
import {
  receiveWorkspaceUpload,
  type WorkspaceUploadTarget
} from '../workspace/workspace-upload-stream.js';
import type { TerminalManager } from '../terminal.js';
import { TerminalDirectService } from '../service/terminal-direct-service.js';
import {
  DirectDesktopService,
  type DirectDesktopOptions
} from '../remote-desktop/direct-desktop-service.js';
import {
  IceUdpMuxListener as NativeIceUdpMuxListener,
  type IceUdpMuxListener
} from 'node-datachannel';
import { RTCPeerConnection } from 'node-datachannel/polyfill';

interface DownloadSource {
  readonly offset: number;
  readonly chunks: AsyncIterable<Uint8Array>;
}

export interface DirectTransferServiceOptions {
  readonly nodeGeneration: () => string;
  readonly send: (type: string, event: DirectNodeEvent) => void;
  readonly openUpload?: (descriptor: DirectTransferDescriptor) => Promise<WorkspaceUploadTarget>;
  readonly openDownload?: (descriptor: DirectTransferDescriptor) => Promise<DownloadSource>;
  readonly now?: () => number;
  readonly createPeerConnection?: (configuration: NodeRtcConfiguration) => RTCPeerConnection;
  readonly leaseGraceMs?: number;
  readonly leaseCheckMs?: number;
  readonly udpPortRange?: () => { readonly begin: number; readonly end: number };
  readonly createIceUdpMuxListener?: (port: number) => IceUdpMuxListener;
  readonly probeUdp4Port?: (port: number) => Promise<void>;
  readonly terminalManager?: TerminalManager;
  readonly sendTerminalReady?: (directSessionId: string, phase?: 'ATTACHED') => void;
  readonly desktop?: Omit<DirectDesktopOptions, 'peer' | 'now' | 'nodeGeneration'>;
  readonly acceptBrowserFile?: (
    kind: string,
    grant: string,
    transportId: string,
    signal: AbortSignal
  ) => NodeStreamHandler | undefined;
  readonly acceptBrowserPicture?: (
    grant: string,
    route: { type: 'ice'; transportId: string; fingerprint: string }
  ) => NodeStreamHandler | undefined;
}

interface NodeRtcConfiguration extends RTCConfiguration {
  readonly enableIceUdpMux: true;
  readonly portRangeBegin: number;
  readonly portRangeEnd: number;
}

type TransportCommand = Extract<
  DirectNodeCommand,
  { type: 'direct.prepare'; purpose: 'TRANSPORT' }
>;
type TransferCommand = Extract<DirectNodeCommand, { type: 'direct.prepare'; purpose: 'TRANSFER' }>;
type GrantCommand = Extract<DirectNodeCommand, { type: 'direct.grant' }>;

interface ActiveTransport {
  readonly command: TransportCommand;
  readonly peer: RTCPeerConnection;
  readonly sentCandidateKeys: Set<string>;
  nodeStreamPath?: ReturnType<typeof bindNodeDirectPath>;
  lastLeaseAliveAt: number;
  leaseExpiresAt: number;
  leaseTimer: ReturnType<typeof setInterval>;
}

interface ActiveTransfer {
  readonly command: TransferCommand;
  grant?: GrantCommand;
  stream?: NodeStream;
  upload?: WorkspaceUploadTarget;
  uploadCommitted: boolean;
  opened: boolean;
  readonly controller: AbortController;
  preserveUpload?: boolean;
  cleanup?: Promise<void>;
  lastLeaseAliveAt: number;
  leaseExpiresAt: number;
  leaseTimer: ReturnType<typeof setInterval>;
}

const MAX_HOST_CANDIDATES = 32;
const LOOPBACK_CANDIDATE_PRIORITY = '2130706431';
const MAX_ACTIVE_TRANSPORTS = 128;
const MAX_ACTIVE_TRANSFERS = 128;
const LEASE_GRACE_MS = 30_000;
const LEASE_CHECK_MS = 5_000;

export class DirectTransferService {
  private readonly transports = new Map<string, ActiveTransport>();
  private readonly transfers = new Map<string, ActiveTransfer>();
  private readonly now: () => number;
  private readonly createPeerConnection: (configuration: NodeRtcConfiguration) => RTCPeerConnection;
  private readonly iceUdpMuxListener: IceUdpMuxListener;
  private readonly peerConfiguration: NodeRtcConfiguration;
  private readonly leaseGraceMs: number;
  private readonly leaseCheckMs: number;
  private readonly terminalDirect?: TerminalDirectService;
  private readonly desktopDirect?: DirectDesktopService;
  private disposed = false;

  static async create(options: DirectTransferServiceOptions): Promise<DirectTransferService> {
    const range = options.udpPortRange?.() ?? { begin: 49_152, end: 49_215 };
    const createIceUdpMuxListener =
      options.createIceUdpMuxListener ??
      ((port) =>
        new NativeIceUdpMuxListener(
          port,
          process.platform === 'win32' && process.env['MAR_QUICK_START_OWNER'] === '1'
            ? '0.0.0.0'
            : undefined
        ));
    // Windows can accept an IPv6 mux bind while another IPv4 endpoint owns the port.
    const probe =
      options.probeUdp4Port ?? (process.platform === 'win32' ? probeUdp4Port : undefined);
    const listener = await bindIceUdpMuxListener(range, createIceUdpMuxListener, probe);
    return new DirectTransferService(options, listener);
  }

  private constructor(
    private readonly options: DirectTransferServiceOptions,
    iceUdpMuxListener: IceUdpMuxListener
  ) {
    this.now = options.now ?? Date.now;
    this.iceUdpMuxListener = iceUdpMuxListener;
    const udpPort = this.iceUdpMuxListener.port();
    this.peerConfiguration = {
      iceServers: [],
      enableIceUdpMux: true,
      portRangeBegin: udpPort,
      portRangeEnd: udpPort
    };
    this.createPeerConnection =
      options.createPeerConnection ??
      ((configuration) => new RTCPeerConnection(configuration as RTCConfiguration));
    this.leaseGraceMs = options.leaseGraceMs ?? LEASE_GRACE_MS;
    this.leaseCheckMs = options.leaseCheckMs ?? LEASE_CHECK_MS;
    if (options.terminalManager !== undefined)
      this.terminalDirect = new TerminalDirectService(
        options.terminalManager,
        (id, phase) => options.sendTerminalReady?.(id, phase),
        (command, peer) => {
          const transport = this.transports.get(command.transportSessionId);
          return (
            transport?.peer === peer &&
            transport.command.workbenchConnectionId === command.workbenchConnectionId &&
            transport.command.nodeGeneration === command.nodeGeneration &&
            command.nodeGeneration === options.nodeGeneration() &&
            peer.connectionState === 'connected' &&
            command.browserFingerprint === fingerprint(peer.remoteDescription?.sdp) &&
            command.nodeFingerprint === fingerprint(peer.localDescription?.sdp)
          );
        },
        this.now
      );
    if (options.desktop) {
      this.desktopDirect = new DirectDesktopService({
        ...options.desktop,
        nodeGeneration: options.nodeGeneration,
        peer: (command) => {
          const transport = this.transports.get(command.transportSessionId);
          const peer = transport?.peer;
          return peer &&
            transport.command.workbenchConnectionId === command.workbenchConnectionId &&
            transport.command.nodeGeneration === command.nodeGeneration &&
            command.nodeGeneration === options.nodeGeneration() &&
            peer.connectionState === 'connected' &&
            command.browserFingerprint === fingerprint(peer.remoteDescription?.sdp) &&
            command.nodeFingerprint === fingerprint(peer.localDescription?.sdp)
            ? peer
            : undefined;
        },
        ...(options.now ? { now: options.now } : {})
      });
    }
  }

  handle(value: unknown): boolean {
    const parsed = directNodeCommandSchema.safeParse(value);
    if (!parsed.success) return false;
    void this.dispatch(parsed.data).catch((error: unknown) => {
      const directSessionId =
        typeof value === 'object' &&
        value !== null &&
        'directSessionId' in value &&
        typeof value.directSessionId === 'string'
          ? value.directSessionId
          : undefined;
      if (directSessionId !== undefined)
        this.fail(directSessionId, errorCode(error), errorMessage(error));
    });
    return true;
  }

  handleTerminal(value: unknown): boolean {
    return this.terminalDirect?.handle(value, (id) => this.transports.get(id)?.peer) ?? false;
  }

  handleDesktop(value: unknown): boolean {
    return this.desktopDirect?.handle(value) ?? false;
  }

  invalidateDesktop(code: string): void {
    this.desktopDirect?.invalidate(code);
  }

  /** Pause only Remote Desktop; the RTC transport remains owned by Direct Transfer. */
  suspendDesktop(signal: AbortSignal): Promise<void> {
    return this.desktopDirect?.suspend(signal) ?? Promise.resolve();
  }

  canResumeDesktop(): boolean {
    return this.desktopDirect?.canResume() ?? true;
  }

  resumeDesktop(): boolean {
    return this.desktopDirect?.resume() ?? true;
  }

  close(code = 'DIRECT_NODE_STOPPED'): void {
    this.desktopDirect?.invalidate('DESKTOP_TRANSPORT_ERROR');
    this.terminalDirect?.close();
    for (const transfer of [...this.transfers.values()]) void this.removeTransfer(transfer, code);
    for (const transport of [...this.transports.values()]) this.removeTransport(transport, code);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // Preserve the shutdown reason before closing the shared RTC transport.
    this.desktopDirect?.dispose();
    this.close();
    this.terminalDirect?.dispose();
    this.iceUdpMuxListener.stop();
  }

  /** Stop transport admission immediately, then join Remote-owned native cleanup. */
  shutdown(signal: AbortSignal): Promise<void> {
    this.dispose();
    return this.desktopDirect?.shutdown(signal) ?? Promise.resolve();
  }

  private async dispatch(command: DirectNodeCommand): Promise<void> {
    if (command.type === 'direct.prepare') {
      if (command.purpose === 'TRANSPORT') this.prepareTransport(command);
      else this.prepareTransfer(command);
      return;
    }
    if (command.type === 'direct.signal') {
      const transport = this.transports.get(command.directSessionId);
      if (transport === undefined) throw new Error('DIRECT_TRANSFER_SESSION_NOT_FOUND');
      await this.signal(transport, command.signal);
      return;
    }
    if (command.type === 'direct.grant') {
      const transfer = this.transfers.get(command.directSessionId);
      const transport = this.transports.get(command.transportSessionId);
      if (
        transfer === undefined ||
        transport === undefined ||
        transfer.command.transportSessionId !== command.transportSessionId ||
        command.browserFingerprint !== fingerprint(transport.peer.remoteDescription?.sdp) ||
        command.nodeFingerprint !== fingerprint(transport.peer.localDescription?.sdp) ||
        command.openExpiresAt <= this.now() ||
        command.expiresAt > transfer.command.expiresAt
      )
        throw new Error('DIRECT_TRANSFER_GRANT_INVALID');
      transfer.grant = command;
      return;
    }
    const transport = this.transports.get(command.directSessionId);
    if (transport !== undefined) {
      if (command.type === 'direct.heartbeat') {
        transport.lastLeaseAliveAt = this.now();
        transport.leaseExpiresAt = command.expiresAt;
        return;
      }
      this.removeTransport(transport, command.code);
      return;
    }
    const transfer = this.transfers.get(command.directSessionId);
    if (transfer === undefined) throw new Error('DIRECT_TRANSFER_SESSION_NOT_FOUND');
    if (command.type === 'direct.heartbeat') {
      transfer.lastLeaseAliveAt = this.now();
      transfer.leaseExpiresAt = command.expiresAt;
    } else await this.removeTransfer(transfer, command.code);
  }

  private prepareTransport(command: TransportCommand): void {
    if (command.nodeGeneration !== this.options.nodeGeneration())
      throw new Error('DIRECT_NODE_GENERATION_MISMATCH');
    if (this.transports.has(command.directSessionId) || this.transfers.has(command.directSessionId))
      throw new Error('DIRECT_TRANSFER_SESSION_CONFLICT');
    if (this.transports.size >= MAX_ACTIVE_TRANSPORTS)
      throw new Error('DIRECT_SESSION_LIMIT_REACHED');
    const peer = this.createPeerConnection(this.peerConfiguration);
    const transport = {
      command,
      peer,
      sentCandidateKeys: new Set<string>(),
      lastLeaseAliveAt: this.now(),
      leaseExpiresAt: command.expiresAt,
      leaseTimer: undefined as unknown as ReturnType<typeof setInterval>
    } satisfies ActiveTransport;
    transport.leaseTimer = this.startLeaseWatch(
      () => transport.leaseExpiresAt,
      () => transport.lastLeaseAliveAt,
      () => this.removeTransport(transport, 'DIRECT_TRANSFER_CONTROL_UNAVAILABLE')
    );
    this.transports.set(command.directSessionId, transport);
    const sentLoopbackAddresses = new Set<string>();
    peer.onicecandidate = (event) => {
      const candidate = event.candidate;
      if (candidate === null) {
        this.emit(command.directSessionId, {
          type: 'direct.signal',
          directSessionId: command.directSessionId,
          signal: { kind: 'END_OF_CANDIDATES' }
        });
        return;
      }
      const json = candidate.toJSON();
      if (typeof json.candidate !== 'string') return;
      const loopback = loopbackHostCandidate(json.candidate);
      const loopbackAddress = loopback?.trim().split(/\s+/u)[4];
      if (
        loopback !== undefined &&
        loopbackAddress !== undefined &&
        !sentLoopbackAddresses.has(loopbackAddress)
      ) {
        sentLoopbackAddresses.add(loopbackAddress);
        if (acceptHostCandidate(loopback, transport.sentCandidateKeys))
          this.emit(command.directSessionId, {
            type: 'direct.signal',
            directSessionId: command.directSessionId,
            signal: {
              kind: 'CANDIDATE',
              candidate: {
                candidate: loopback,
                sdpMid: json.sdpMid ?? null,
                sdpMLineIndex: json.sdpMLineIndex ?? null
              }
            }
          });
      }
      if (!acceptHostCandidate(json.candidate, transport.sentCandidateKeys)) return;
      this.emit(command.directSessionId, {
        type: 'direct.signal',
        directSessionId: command.directSessionId,
        signal: {
          kind: 'CANDIDATE',
          candidate: {
            candidate: json.candidate,
            sdpMid: json.sdpMid ?? null,
            sdpMLineIndex: json.sdpMLineIndex ?? null
          }
        }
      });
    };
    peer.ondatachannel = (event) => this.attachPendingChannel(transport, event.channel);
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === 'connected')
        this.emit(command.directSessionId, {
          type: 'direct.connected',
          directSessionId: command.directSessionId
        });
      if (peer.connectionState === 'failed' || peer.connectionState === 'closed')
        this.removeTransport(transport, 'DIRECT_CONNECTION_FAILED');
    };
  }

  private prepareTransfer(command: TransferCommand): void {
    if (command.nodeGeneration !== this.options.nodeGeneration())
      throw new Error('DIRECT_NODE_GENERATION_MISMATCH');
    if (this.transfers.has(command.directSessionId) || this.transports.has(command.directSessionId))
      throw new Error('DIRECT_TRANSFER_SESSION_CONFLICT');
    const transport = this.transports.get(command.transportSessionId);
    if (
      transport === undefined ||
      transport.command.workbenchConnectionId !== command.workbenchConnectionId ||
      transport.command.nodeGeneration !== command.nodeGeneration ||
      transport.peer.connectionState !== 'connected'
    )
      throw new Error('DIRECT_TRANSFER_UNAVAILABLE');
    if (this.transfers.size >= MAX_ACTIVE_TRANSFERS)
      throw new Error('DIRECT_SESSION_LIMIT_REACHED');
    const transfer = {
      command,
      uploadCommitted: false,
      opened: false,
      controller: new AbortController(),
      lastLeaseAliveAt: this.now(),
      leaseExpiresAt: command.expiresAt,
      leaseTimer: undefined as unknown as ReturnType<typeof setInterval>
    } satisfies ActiveTransfer;
    transfer.leaseTimer = this.startLeaseWatch(
      () => transfer.leaseExpiresAt,
      () => transfer.lastLeaseAliveAt,
      () => void this.removeTransfer(transfer, 'DIRECT_TRANSFER_CONTROL_UNAVAILABLE')
    );
    this.transfers.set(command.directSessionId, transfer);
  }

  private async signal(
    transport: ActiveTransport,
    signal: Extract<DirectNodeCommand, { type: 'direct.signal' }>['signal']
  ): Promise<void> {
    if (signal.kind === 'CANDIDATE') {
      if (!safeHostCandidate(signal.candidate.candidate))
        throw new Error('DIRECT_TRANSFER_CANDIDATE_REJECTED');
      await transport.peer.addIceCandidate(signal.candidate);
      return;
    }
    if (signal.kind === 'END_OF_CANDIDATES') {
      await transport.peer.addIceCandidate(null);
      return;
    }
    if (!hostOnlySdp(signal.sdp)) throw new Error('DIRECT_TRANSFER_CANDIDATE_REJECTED');
    await transport.peer.setRemoteDescription({
      type: signal.kind === 'OFFER' ? 'offer' : 'answer',
      sdp: signal.sdp
    });
    if (signal.kind !== 'OFFER') return;
    const answer = await transport.peer.createAnswer();
    await transport.peer.setLocalDescription(answer);
    const localSdp = transport.peer.localDescription?.sdp;
    const sdp = filterIceCandidates(localSdp, transport.sentCandidateKeys).sdp;
    const localFingerprint = fingerprint(localSdp);
    if (sdp === undefined || localFingerprint === undefined)
      throw new Error('DIRECT_FINGERPRINT_MISSING');
    this.emit(transport.command.directSessionId, {
      type: 'direct.signal',
      directSessionId: transport.command.directSessionId,
      signal: { kind: 'ANSWER', sdp, fingerprint: localFingerprint }
    });
  }

  private attachPendingChannel(transport: ActiveTransport, channel: RTCDataChannel): void {
    if (this.transports.get(transport.command.directSessionId) !== transport) {
      channel.close();
      return;
    }
    if (channel.label === NODE_STREAM_CHANNEL_LABEL) {
      if (
        transport.nodeStreamPath !== undefined ||
        !channel.ordered ||
        channel.maxRetransmits !== null ||
        channel.maxPacketLifeTime !== null
      ) {
        channel.close();
        return;
      }
      // One generic carrier per admitted ICE peer. The domain consumes only its own bound grants.
      transport.nodeStreamPath = bindNodeDirectPath({
        carrier: rtcNodeStreamCarrier(channel),
        maxStreams: 32,
        accept: async ({ kind, grant }, signal) =>
          kind === 'terminal'
            ? this.terminalDirect?.consume(transport.command.directSessionId, grant, signal)
            : kind === 'file-download' || kind === 'file-upload'
              ? this.acceptFile(transport, kind, grant)
              : kind === 'browser-rfb'
                ? this.acceptBrowserPicture(transport, grant)
                : kind === 'browser-file-upload' || kind === 'browser-file-download'
                  ? this.options.acceptBrowserFile?.(
                      kind,
                      grant,
                      transport.command.directSessionId,
                      signal
                    )
                  : undefined
      });
      channel.addEventListener(
        'close',
        () => this.removeTransport(transport, 'DIRECT_CHANNEL_CLOSED'),
        { once: true }
      );
      return;
    }
    channel.close();
  }

  private acceptBrowserPicture(transport: ActiveTransport, grant: string) {
    const remoteFingerprint = fingerprint(transport.peer.remoteDescription?.sdp);
    if (transport.peer.connectionState !== 'connected' || !remoteFingerprint) return undefined;
    return this.options.acceptBrowserPicture?.(grant, {
      type: 'ice',
      transportId: transport.command.directSessionId,
      fingerprint: remoteFingerprint
    });
  }

  private acceptFile(
    transport: ActiveTransport,
    kind: 'file-download' | 'file-upload',
    token: string
  ) {
    const direction = kind === 'file-download' ? 'DOWNLOAD' : 'UPLOAD';
    const transfer = [...this.transfers.values()].find(
      (entry) =>
        entry.grant?.grant === token &&
        entry.command.transportSessionId === transport.command.directSessionId &&
        entry.command.transfer.direction === direction
    );
    const grant = transfer?.grant;
    const openUpload = this.options.openUpload;
    const openDownload = this.options.openDownload;
    if (
      transfer === undefined ||
      grant === undefined ||
      transfer.opened ||
      grant.openExpiresAt <= this.now() ||
      grant.expiresAt <= this.now() ||
      (direction === 'UPLOAD' ? openUpload === undefined : openDownload === undefined)
    )
      return undefined;
    transfer.opened = true;
    return async (stream: NodeStream, streamSignal: AbortSignal) => {
      transfer.stream = stream;
      const signal = AbortSignal.any([streamSignal, transfer.controller.signal]);
      const descriptor = transfer.command.transfer;
      const size = transferredSize(descriptor);
      try {
        signal.throwIfAborted();
        // Confirm the one-use grant was consumed; authoritative upload offsets stay in the stream.
        this.emit(transfer.command.directSessionId, {
          type: 'direct.opened',
          directSessionId: transfer.command.directSessionId,
          offset: 0
        });
        if (direction === 'UPLOAD' && openUpload !== undefined) {
          const upload = await openUpload(descriptor);
          transfer.upload = upload;
          if (!this.current(transfer)) {
            if (!transfer.preserveUpload) await this.cancelUpload(transfer);
            return;
          }
          await receiveWorkspaceUpload(stream, upload, size, signal);
          transfer.uploadCommitted = true;
          await stream.endWrite();
        } else if (openDownload !== undefined) {
          const source = await openDownload(descriptor);
          await sendFileDownload(stream, source.chunks, size, signal);
        }
        this.emit(transfer.command.directSessionId, {
          type: 'direct.complete',
          directSessionId: transfer.command.directSessionId,
          size
        });
        await this.removeTransfer(transfer);
      } catch (error) {
        if (!this.current(transfer)) return;
        if (errorCode(streamSignal.reason) === 'NODE_STREAM_DISCONNECTED') {
          await this.removeTransfer(transfer, 'DIRECT_CHANNEL_CLOSED');
          return;
        }
        stream.reset(errorCode(error));
        this.fail(transfer.command.directSessionId, errorCode(error), errorMessage(error));
      } finally {
        transfer.upload?.release?.();
      }
    };
  }

  private startLeaseWatch(
    expiresAt: () => number,
    lastAlive: () => number,
    expire: () => void
  ): ReturnType<typeof setInterval> {
    const timer = setInterval(() => {
      const now = this.now();
      if (expiresAt() <= now || now - lastAlive() > this.leaseGraceMs) expire();
    }, this.leaseCheckMs);
    return timer;
  }

  private emit(directSessionId: string, event: DirectNodeEvent): void {
    if (this.transports.has(directSessionId) || this.transfers.has(directSessionId))
      this.options.send(event.type, event);
  }

  private fail(directSessionId: string, code: string, message: string): void {
    this.options.send('direct.error', { type: 'direct.error', directSessionId, code, message });
    const transfer = this.transfers.get(directSessionId);
    if (transfer !== undefined) void this.removeTransfer(transfer);
    const transport = this.transports.get(directSessionId);
    if (transport !== undefined) this.removeTransport(transport);
  }

  private removeTransport(transport: ActiveTransport, code?: string): void {
    if (!this.transports.delete(transport.command.directSessionId)) return;
    clearInterval(transport.leaseTimer);
    this.terminalDirect?.removeTransport(transport.command.directSessionId);
    this.desktopDirect?.removeTransport(transport.command.directSessionId);
    for (const transfer of [...this.transfers.values()])
      if (transfer.command.transportSessionId === transport.command.directSessionId)
        void this.removeTransfer(transfer, code ?? 'DIRECT_CONNECTION_FAILED');
    transport.nodeStreamPath?.close();
    transport.peer.close();
    if (code !== undefined)
      this.options.send('direct.error', {
        type: 'direct.error',
        directSessionId: transport.command.directSessionId,
        code,
        message: directErrorMessage(code)
      });
  }

  private async removeTransfer(transfer: ActiveTransfer, code?: string): Promise<void> {
    if (!this.current(transfer)) return;
    this.transfers.delete(transfer.command.directSessionId);
    clearInterval(transfer.leaseTimer);
    const preserveWorkspaceUpload =
      transfer.command.transfer.direction === 'UPLOAD' &&
      transfer.command.transfer.composerAttachment === undefined &&
      (code === 'DIRECT_CHANNEL_CLOSED' ||
        code === 'DIRECT_CONNECTION_FAILED' ||
        code === 'DIRECT_TRANSFER_CONTROL_UNAVAILABLE');
    transfer.preserveUpload = preserveWorkspaceUpload;
    transfer.controller.abort();
    if (code === undefined) transfer.stream?.close();
    else transfer.stream?.reset(code);
    if (!transfer.uploadCommitted && !preserveWorkspaceUpload) await this.cancelUpload(transfer);
    if (code !== undefined)
      this.options.send('direct.error', {
        type: 'direct.error',
        directSessionId: transfer.command.directSessionId,
        code,
        message: directErrorMessage(code)
      });
  }
  private current(transfer: ActiveTransfer): boolean {
    return (
      this.transfers.get(transfer.command.directSessionId) === transfer &&
      !transfer.controller.signal.aborted
    );
  }
  private async cancelUpload(transfer: ActiveTransfer): Promise<void> {
    if (transfer.upload === undefined) return;
    transfer.cleanup ??= transfer.upload.cancel().catch(() => {
      this.options.send('direct.error', {
        type: 'direct.error',
        directSessionId: transfer.command.directSessionId,
        code: 'DIRECT_UPLOAD_CLEANUP_FAILED',
        message: 'Temporary upload cleanup could not be completed.'
      });
    });
    await transfer.cleanup;
  }
}

function transferredSize(descriptor: DirectTransferDescriptor): number {
  return descriptor.direction === 'DOWNLOAD' && descriptor.range !== undefined
    ? descriptor.range.length
    : descriptor.size;
}

async function bindIceUdpMuxListener(
  range: { readonly begin: number; readonly end: number },
  create: (port: number) => IceUdpMuxListener,
  probe?: (port: number) => Promise<void>
): Promise<IceUdpMuxListener> {
  let lastError: unknown;
  for (let port = range.begin; port <= range.end; port += 1) {
    try {
      if (probe !== undefined) await probe(port);
      return create(port);
    } catch (error: unknown) {
      lastError = error;
    }
  }
  throw new Error('DIRECT_UDP_PORT_UNAVAILABLE', { cause: lastError });
}

export function probeUdp4Port(port: number): Promise<void> {
  const socket = createSocket({ type: 'udp4', reuseAddr: false });
  return new Promise((resolve, reject) => {
    socket.once('error', (error) => socket.close(() => reject(error)));
    socket.bind({ port, address: '0.0.0.0', exclusive: true }, () => socket.close(() => resolve()));
  });
}

export function loopbackHostCandidate(candidate: string): string | undefined {
  if (!safeHostCandidate(candidate)) return undefined;
  const address = candidate.trim().split(/\s+/u)[4];
  const family = isIP(address ?? '');
  const loopback = family === 4 ? '127.0.0.1' : family === 6 ? '::1' : undefined;
  if (loopback === undefined || address === loopback) return undefined;
  const fields = candidate.trim().split(/\s+/u);
  fields[3] = LOOPBACK_CANDIDATE_PRIORITY;
  fields[4] = loopback;
  return fields.join(' ');
}

export function fingerprint(sdp: string | undefined): string | undefined {
  const match = sdp?.match(/^a=fingerprint:(sha-256 [A-F0-9:]+)\r?$/imu);
  return match?.[1];
}

function safeHostCandidate(candidate: string): boolean {
  if (!/\styp host(?:\s|$)/u.test(candidate)) return false;
  const address = candidate.trim().split(/\s+/u)[4];
  if (address === undefined) return false;
  return address.length > 0;
}

function hostOnlySdp(sdp: string): boolean {
  return sdp
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('a=candidate:'))
    .every((line) => safeHostCandidate(line.slice(2)));
}

function candidateKey(candidate: string): string | undefined {
  const fields = candidate.trim().split(/\s+/u);
  const component = fields[1];
  const protocol = fields[2]?.toLowerCase();
  const address = fields[4]?.toLowerCase();
  if (component === undefined || protocol === undefined || address === undefined) return undefined;
  return `${component}:${protocol}:${address}`;
}

function acceptHostCandidate(candidate: string, accepted: Set<string>): boolean {
  if (!safeHostCandidate(candidate)) return false;
  const key = candidateKey(candidate);
  if (key === undefined || accepted.has(key) || accepted.size >= MAX_HOST_CANDIDATES) return false;
  accepted.add(key);
  return true;
}

function filterIceCandidates(
  sdp: string | undefined,
  accepted: Set<string>
): {
  readonly sdp: string | undefined;
} {
  if (sdp === undefined) return { sdp: undefined };
  const included = new Set<string>();
  const lines = sdp.split(/\r?\n/u).flatMap((line) => {
    if (!line.startsWith('a=candidate:')) return [line];
    const candidate = line.slice(2);
    if (!safeHostCandidate(candidate)) return [];
    const loopback = loopbackHostCandidate(candidate);
    const candidates = loopback === undefined ? [candidate] : [loopback, candidate];
    const retained: string[] = [];
    for (const value of candidates) {
      const key = candidateKey(value);
      if (key === undefined || included.has(key)) continue;
      if (!accepted.has(key) && accepted.size >= MAX_HOST_CANDIDATES) continue;
      accepted.add(key);
      included.add(key);
      retained.push(`a=${value}`);
    }
    return retained;
  });
  return { sdp: lines.join('\r\n') };
}

function errorCode(error: unknown): string {
  return error instanceof Error && /^[A-Z][A-Z0-9_]{0,127}$/u.test(error.message)
    ? error.message
    : 'DIRECT_INTERNAL_ERROR';
}

function errorMessage(error: unknown): string {
  const code = errorCode(error);
  return code === 'DIRECT_INTERNAL_ERROR'
    ? 'The Node could not complete the direct transfer operation.'
    : directErrorMessage(code);
}

function directErrorMessage(code: string): string {
  const messages: Record<string, string> = {
    DIRECT_NODE_GENERATION_MISMATCH: 'The Node connection generation changed.',
    DIRECT_SESSION_INVALID: 'The direct transfer session is unavailable.',
    DIRECT_SESSION_CONFLICT: 'The direct transfer session already exists.',
    DIRECT_SESSION_LIMIT_REACHED: 'The direct transfer session limit has been reached.',
    DIRECT_CANDIDATE_REJECTED: 'The direct transfer candidate is not a host candidate.',
    DIRECT_GRANT_INVALID: 'The direct transfer grant is invalid or expired.',
    DIRECT_CONNECTION_FAILED: 'The direct connection failed.',
    DIRECT_CHANNEL_CLOSED: 'The direct data channel closed.',
    DIRECT_SESSION_EXPIRED: 'The direct transfer session expired.',
    DIRECT_LEASE_EXPIRED: 'The Server authorization lease expired.',
    DIRECT_NODE_STOPPED: 'The Node stopped the direct transfer service.'
  };
  return messages[code] ?? 'The direct transfer operation failed.';
}
