import type {
  DirectBrowserMessage,
  DirectPrepareRequest,
  DirectServerMessage,
  DirectSignal,
  DirectTransferDescriptor
} from '@myagentroam/protocol';

const TRANSPORT_TIMEOUT_MS = 3_000;
const PREPARE_TIMEOUT_MS = 3_000;
const RETRY_DELAYS_MS = [30_000, 60_000, 120_000, 300_000] as const;
const MAX_HOST_CANDIDATES = 32;
const HEARTBEAT_MS = 10_000;

type TransportResult = 'DIRECT_AVAILABLE' | 'RELAY_ONLY' | 'STALE';

export interface DirectTransportNetworkInfo {
  readonly scope: 'LOOPBACK' | 'PRIVATE' | 'PUBLIC' | 'VPN_TUN' | 'UNKNOWN';
  readonly ipVersion: 'IPV4' | 'IPV6' | 'UNKNOWN';
  readonly protocol: 'UDP' | 'TCP' | 'UNKNOWN';
  readonly interfaceType: 'ETHERNET' | 'WIFI' | 'CELLULAR' | 'VPN' | 'LOOPBACK' | 'UNKNOWN';
}

interface TransportRequest {
  requestId: string;
  readonly nodeId: string;
  readonly nodeGeneration: string;
  readonly resolve: (result: Exclude<TransportResult, 'STALE'>) => void;
  readonly promise: Promise<Exclude<TransportResult, 'STALE'>>;
  timer: ReturnType<typeof setTimeout>;
  attempt: number;
}

interface TransportSession {
  readonly request: TransportRequest;
  readonly directSessionId: string;
  readonly peer: RTCPeerConnection;
  readonly bootstrapChannel: RTCDataChannel;
  readonly sentCandidateKeys: Set<string>;
  serverOpened: boolean;
  peerConnected: boolean;
  heartbeat?: ReturnType<typeof setInterval>;
}

interface TransferRequestBase {
  readonly requestId: string;
  readonly nodeId: string;
  readonly nodeGeneration: string;
  readonly transportSessionId: string;
  readonly descriptor: DirectTransferDescriptor;
  readonly onProgress?: (offset: number) => void;
  readonly signal?: AbortSignal;
  timer: ReturnType<typeof setTimeout>;
}

interface UploadRequest extends TransferRequestBase {
  readonly descriptor: Extract<DirectTransferDescriptor, { direction: 'UPLOAD' }>;
  readonly file: File;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

interface DownloadRequest extends TransferRequestBase {
  readonly descriptor: Extract<DirectTransferDescriptor, { direction: 'DOWNLOAD' }>;
  readonly sink: {
    write(bytes: Uint8Array): Promise<void>;
    close(): Promise<void>;
    abort(): Promise<void>;
  };
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

type TransferRequest = UploadRequest | DownloadRequest;

interface TransferSessionBase {
  readonly directSessionId: string;
  readonly channel: RTCDataChannel;
  heartbeat?: ReturnType<typeof setInterval>;
  grant?: string;
  opened: boolean;
}

interface UploadSession extends TransferSessionBase {
  readonly request: UploadRequest;
  sending: boolean;
  completeSent: boolean;
}

interface DownloadSession extends TransferSessionBase {
  readonly request: DownloadRequest;
  processing: Promise<void>;
  received: number;
  dataComplete: boolean;
  serverComplete: boolean;
}

type TransferSession = UploadSession | DownloadSession;

export interface WorkspaceDirectTransferServiceOptions {
  readonly send: (message: DirectBrowserMessage) => boolean;
  readonly createPeerConnection?: () => RTCPeerConnection;
  readonly randomId?: () => string;
  readonly probeTimeoutMs?: number;
  readonly onProbeResultChange?: () => void;
  readonly shouldRetryProbe?: (nodeId: string, nodeGeneration: string) => boolean;
  readonly probeRetryDelaysMs?: readonly number[];
}

export function createWorkspaceDirectTransferService(
  options: WorkspaceDirectTransferServiceOptions
) {
  const transportRequests = new Map<string, TransportRequest>();
  const transportsBySession = new Map<string, TransportSession>();
  const transportsByNode = new Map<string, TransportSession>();
  const transferRequests = new Map<string, TransferRequest>();
  const transfers = new Map<string, TransferSession>();
  const networkInfoByNode = new Map<string, DirectTransportNetworkInfo>();
  const deferredReleaseNodes = new Set<string>();
  const terminalReferences = new Map<string, number>();
  const retries = new Map<
    string,
    { generation: string; attempt: number; timer: ReturnType<typeof setTimeout> | undefined }
  >();
  const createPeerConnection =
    options.createPeerConnection ?? (() => new RTCPeerConnection({ iceServers: [] }));
  const randomId = options.randomId ?? (() => crypto.randomUUID().replaceAll('-', ''));
  const transportTimeoutMs = options.probeTimeoutMs ?? TRANSPORT_TIMEOUT_MS;
  const retryDelaysMs = options.probeRetryDelaysMs ?? RETRY_DELAYS_MS;

  function result(nodeId: string, nodeGeneration: string): TransportResult {
    const transport = transportsByNode.get(nodeId);
    if (transport === undefined || transport.request.nodeGeneration !== nodeGeneration)
      return 'STALE';
    return transportReady(transport) ? 'DIRECT_AVAILABLE' : 'RELAY_ONLY';
  }

  function isConnected(nodeId: string, nodeGeneration: string): boolean {
    return result(nodeId, nodeGeneration) === 'DIRECT_AVAILABLE';
  }

  function acquireTerminalTransport(
    nodeId: string,
    nodeGeneration: string
  ):
    | {
        readonly transportSessionId: string;
        readonly nodeGeneration: string;
        createChannel(label: string): RTCDataChannel;
        release(): void;
      }
    | undefined {
    const transport = transportsByNode.get(nodeId);
    if (
      transport === undefined ||
      transport.request.nodeGeneration !== nodeGeneration ||
      !transportReady(transport)
    )
      return undefined;
    terminalReferences.set(nodeId, (terminalReferences.get(nodeId) ?? 0) + 1);
    let released = false;
    return {
      transportSessionId: transport.directSessionId,
      nodeGeneration: transport.request.nodeGeneration,
      createChannel: (label) => {
        if (!transportReady(transport) || transportsByNode.get(nodeId) !== transport)
          throw new Error('TERMINAL_DIRECT_UNAVAILABLE');
        return transport.peer.createDataChannel(label, { ordered: true });
      },
      release: () => {
        if (released) return;
        released = true;
        const remaining = (terminalReferences.get(nodeId) ?? 1) - 1;
        if (remaining > 0) terminalReferences.set(nodeId, remaining);
        else terminalReferences.delete(nodeId);
        releaseDeferredTransport(nodeId);
      }
    };
  }

  function networkInfo(
    nodeId: string,
    nodeGeneration: string
  ): DirectTransportNetworkInfo | undefined {
    return isConnected(nodeId, nodeGeneration) ? networkInfoByNode.get(nodeId) : undefined;
  }

  function probe(
    nodeId: string,
    nodeGeneration: string
  ): Promise<'DIRECT_AVAILABLE' | 'RELAY_ONLY'> {
    return ensureTransport(nodeId, nodeGeneration);
  }

  function ensureTransport(
    nodeId: string,
    nodeGeneration: string
  ): Promise<'DIRECT_AVAILABLE' | 'RELAY_ONLY'> {
    clearRetry(nodeId);
    deferredReleaseNodes.delete(nodeId);
    const current = transportsByNode.get(nodeId);
    if (current !== undefined && current.request.nodeGeneration === nodeGeneration) {
      if (transportReady(current)) return Promise.resolve('DIRECT_AVAILABLE');
      return current.request.promise;
    }
    if (current !== undefined) closeTransport(current, 'DIRECT_NODE_GENERATION_MISMATCH', false);
    for (const request of transportRequests.values())
      if (request.nodeId === nodeId && request.nodeGeneration === nodeGeneration)
        return request.promise;
    let resolve!: (result: 'DIRECT_AVAILABLE' | 'RELAY_ONLY') => void;
    const promise = new Promise<'DIRECT_AVAILABLE' | 'RELAY_ONLY'>(
      (complete) => (resolve = complete)
    );
    const request: TransportRequest = {
      requestId: randomId(),
      nodeId,
      nodeGeneration,
      resolve,
      promise,
      timer: undefined as unknown as ReturnType<typeof setTimeout>,
      attempt: 1
    };
    beginTransport(request);
    return promise;
  }

  function beginTransport(request: TransportRequest): void {
    request.timer = setTimeout(
      () => failTransportRequest(request.requestId, 'DIRECT_CONNECTION_TIMEOUT'),
      transportTimeoutMs
    );
    transportRequests.set(request.requestId, request);
    const prepare: DirectPrepareRequest = {
      type: 'direct.prepare',
      requestId: request.requestId,
      nodeId: request.nodeId,
      nodeGeneration: request.nodeGeneration,
      purpose: 'TRANSPORT'
    };
    if (!options.send(prepare))
      failTransportRequest(request.requestId, 'DIRECT_TRANSFER_UNAVAILABLE');
  }

  function upload(input: {
    readonly nodeId: string;
    readonly nodeGeneration: string;
    readonly descriptor: DirectTransferDescriptor;
    readonly file: File;
    readonly onProgress?: (offset: number) => void;
    readonly signal?: AbortSignal;
  }): Promise<void> {
    if (input.descriptor.direction !== 'UPLOAD')
      return Promise.reject(new Error('DIRECT_TRANSFER_INVALID'));
    const transport = connectedTransport(input.nodeId, input.nodeGeneration);
    if (transport === undefined) return Promise.reject(new Error('DIRECT_UNAVAILABLE'));
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((complete, fail) => {
      resolve = complete;
      reject = fail;
    });
    const requestId = randomId();
    const request: UploadRequest = {
      requestId,
      nodeId: input.nodeId,
      nodeGeneration: input.nodeGeneration,
      transportSessionId: transport.directSessionId,
      descriptor: input.descriptor,
      file: input.file,
      ...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      resolve,
      reject,
      timer: setTimeout(
        () => failTransferRequest(requestId, 'DIRECT_PREPARE_TIMEOUT'),
        PREPARE_TIMEOUT_MS
      )
    };
    transferRequests.set(requestId, request);
    bindAbort(request);
    if (!sendTransferPrepare(request))
      failTransferRequest(requestId, 'DIRECT_TRANSFER_UNAVAILABLE');
    return promise;
  }

  function download(input: {
    readonly nodeId: string;
    readonly nodeGeneration: string;
    readonly descriptor: DirectTransferDescriptor;
    readonly sink: DownloadRequest['sink'];
    readonly onProgress?: (offset: number) => void;
    readonly signal?: AbortSignal;
  }): Promise<void> {
    if (input.descriptor.direction !== 'DOWNLOAD')
      return Promise.reject(new Error('DIRECT_TRANSFER_INVALID'));
    const transport = connectedTransport(input.nodeId, input.nodeGeneration);
    if (transport === undefined) return Promise.reject(new Error('DIRECT_UNAVAILABLE'));
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((complete, fail) => {
      resolve = complete;
      reject = fail;
    });
    const requestId = randomId();
    const request: DownloadRequest = {
      requestId,
      nodeId: input.nodeId,
      nodeGeneration: input.nodeGeneration,
      transportSessionId: transport.directSessionId,
      descriptor: input.descriptor,
      sink: input.sink,
      ...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      resolve,
      reject,
      timer: setTimeout(
        () => failTransferRequest(requestId, 'DIRECT_PREPARE_TIMEOUT'),
        PREPARE_TIMEOUT_MS
      )
    };
    transferRequests.set(requestId, request);
    bindAbort(request);
    if (!sendTransferPrepare(request))
      failTransferRequest(requestId, 'DIRECT_TRANSFER_UNAVAILABLE');
    return promise;
  }

  function sendTransferPrepare(request: TransferRequest): boolean {
    return options.send({
      type: 'direct.prepare',
      requestId: request.requestId,
      nodeId: request.nodeId,
      nodeGeneration: request.nodeGeneration,
      purpose: 'TRANSFER',
      transportSessionId: request.transportSessionId,
      transfer: request.descriptor
    });
  }

  function bindAbort(request: TransferRequest): void {
    request.signal?.addEventListener(
      'abort',
      () => {
        const session = [...transfers.values()].find((item) => item.request === request);
        if (session !== undefined) {
          options.send({ type: 'direct.cancel', directSessionId: session.directSessionId });
          void finishTransfer(session, new Error('DIRECT_TRANSFER_CANCELLED'));
        } else failTransferRequest(request.requestId, 'DIRECT_TRANSFER_CANCELLED');
      },
      { once: true }
    );
  }

  function handle(message: DirectServerMessage): void {
    if (message.type === 'direct.error' && message.requestId !== undefined) {
      if (transportRequests.has(message.requestId))
        failTransportRequest(message.requestId, message.code);
      else if (transferRequests.has(message.requestId))
        failTransferRequest(message.requestId, message.code);
      return;
    }
    if (message.type === 'direct.prepared') {
      if (message.purpose === 'TRANSPORT')
        void startTransport(message.requestId, message.directSessionId);
      else startTransfer(message.requestId, message.directSessionId, message.transportSessionId);
      return;
    }
    const transport = transportsBySession.get(message.directSessionId ?? '');
    if (transport !== undefined) {
      handleTransportMessage(transport, message);
      return;
    }
    const transfer = transfers.get(message.directSessionId ?? '');
    if (transfer !== undefined) handleTransferMessage(transfer, message);
  }

  async function startTransport(requestId: string, directSessionId: string): Promise<void> {
    const request = transportRequests.get(requestId);
    if (request === undefined) return;
    try {
      const peer = createPeerConnection();
      const bootstrapChannel = peer.createDataChannel('mar-direct-transport', { ordered: true });
      const transport: TransportSession = {
        request,
        directSessionId,
        peer,
        bootstrapChannel,
        sentCandidateKeys: new Set(),
        serverOpened: false,
        peerConnected: false
      };
      transportsBySession.set(directSessionId, transport);
      transportsByNode.set(request.nodeId, transport);
      configureTransport(transport);
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      const localSdp = peer.localDescription?.sdp;
      const sdp = stripIceCandidates(localSdp, transport.sentCandidateKeys);
      const localFingerprint = fingerprint(localSdp);
      if (sdp === undefined || localFingerprint === undefined)
        throw new Error('DIRECT_FINGERPRINT_INVALID');
      options.send({
        type: 'direct.signal',
        directSessionId,
        signal: { kind: 'OFFER', sdp, fingerprint: localFingerprint }
      });
    } catch (error) {
      const transport = transportsBySession.get(directSessionId);
      if (transport !== undefined) closeTransport(transport, errorCode(error));
      else failTransportRequest(requestId, errorCode(error));
    }
  }

  function configureTransport(transport: TransportSession): void {
    const { peer, directSessionId } = transport;
    peer.onicecandidate = (event) => {
      const candidate = event.candidate;
      if (candidate === null) {
        options.send({
          type: 'direct.signal',
          directSessionId,
          signal: { kind: 'END_OF_CANDIDATES' }
        });
        return;
      }
      const json = candidate.toJSON();
      if (
        typeof json.candidate !== 'string' ||
        !acceptHostCandidate(json.candidate, transport.sentCandidateKeys)
      )
        return;
      options.send({
        type: 'direct.signal',
        directSessionId,
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
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === 'connected') {
        transport.peerConnected = true;
        options.send({ type: 'direct.connected', directSessionId });
        finishTransportIfReady(transport);
      }
      if (peer.connectionState === 'failed' || peer.connectionState === 'closed')
        closeTransport(transport, 'DIRECT_CONNECTION_FAILED');
    };
  }

  function handleTransportMessage(transport: TransportSession, message: DirectServerMessage): void {
    if (message.type === 'direct.signal') {
      void applySignal(transport.peer, message.signal).catch(() =>
        closeTransport(transport, 'DIRECT_SIGNAL_INVALID')
      );
      return;
    }
    if (message.type === 'direct.opened') {
      transport.serverOpened = true;
      finishTransportIfReady(transport);
      return;
    }
    if (message.type === 'direct.error' || message.type === 'direct.closed')
      closeTransport(transport, message.code);
  }

  function finishTransportIfReady(transport: TransportSession): void {
    if (!transportReady(transport)) return;
    clearTimeout(transport.request.timer);
    transportRequests.delete(transport.request.requestId);
    clearRetry(transport.request.nodeId);
    transport.bootstrapChannel.close();
    transport.heartbeat ??= setInterval(() => {
      if (!options.send({ type: 'direct.heartbeat', directSessionId: transport.directSessionId }))
        closeTransport(transport, 'DIRECT_TRANSFER_CONTROL_UNAVAILABLE');
    }, HEARTBEAT_MS);
    transport.request.resolve('DIRECT_AVAILABLE');
    options.onProbeResultChange?.();
    void captureTransportNetworkInfo(transport);
  }

  async function captureTransportNetworkInfo(transport: TransportSession): Promise<void> {
    if (typeof transport.peer.getStats !== 'function') return;
    try {
      const info = classifySelectedCandidatePair(await transport.peer.getStats());
      if (
        info === undefined ||
        transportsByNode.get(transport.request.nodeId) !== transport ||
        !transportReady(transport)
      )
        return;
      networkInfoByNode.set(transport.request.nodeId, info);
      options.onProbeResultChange?.();
    } catch {
      // Network details are optional diagnostics and never affect transfer availability.
    }
  }

  function startTransfer(
    requestId: string,
    directSessionId: string,
    transportSessionId?: string
  ): void {
    const request = transferRequests.get(requestId);
    const transport = transportsBySession.get(transportSessionId ?? '');
    if (
      request === undefined ||
      transport === undefined ||
      request.transportSessionId !== transport.directSessionId ||
      !transportReady(transport)
    ) {
      if (request !== undefined) failTransferRequest(requestId, 'DIRECT_TRANSFER_UNAVAILABLE');
      return;
    }
    clearTimeout(request.timer);
    const channel = transport.peer.createDataChannel(`mar-direct-${directSessionId}`, {
      ordered: true
    });
    channel.binaryType = 'arraybuffer';
    const session: TransferSession =
      'file' in request
        ? {
            request,
            directSessionId,
            channel,
            opened: false,
            sending: false,
            completeSent: false
          }
        : {
            request,
            directSessionId,
            channel,
            opened: false,
            processing: Promise.resolve(),
            received: 0,
            dataComplete: false,
            serverComplete: false
          };
    transfers.set(directSessionId, session);
    channel.addEventListener('open', () => openTransferIfReady(session), { once: true });
    channel.addEventListener(
      'close',
      () => {
        if (transfers.get(directSessionId) !== session || transferPayloadComplete(session)) return;
        void finishTransfer(session, new Error('DIRECT_CHANNEL_CLOSED'));
      },
      { once: true }
    );
    channel.addEventListener('message', (event) => {
      if (session.request.descriptor.direction === 'UPLOAD')
        void handleUploadChannel(session as UploadSession, event.data);
      else handleDownloadChannel(session as DownloadSession, event.data);
    });
  }

  function handleTransferMessage(session: TransferSession, message: DirectServerMessage): void {
    if (message.type === 'direct.grant') {
      session.grant = message.grant;
      openTransferIfReady(session);
      return;
    }
    if (message.type === 'direct.complete') {
      if (session.request.descriptor.direction === 'UPLOAD') {
        if (message.size !== session.request.descriptor.size)
          void finishTransfer(session, new Error('DIRECT_INTEGRITY_FAILED'));
        else void finishTransfer(session);
      } else {
        const download = session as DownloadSession;
        download.serverComplete = true;
        if (download.dataComplete) void finishTransfer(download);
      }
      return;
    }
    if (message.type === 'direct.error' || message.type === 'direct.closed')
      void finishTransfer(session, new Error(message.code));
  }

  function transferPayloadComplete(session: TransferSession): boolean {
    return session.request.descriptor.direction === 'UPLOAD'
      ? (session as UploadSession).completeSent
      : (session as DownloadSession).dataComplete;
  }

  function openTransferIfReady(session: TransferSession): void {
    if (session.opened || session.grant === undefined || session.channel.readyState !== 'open')
      return;
    session.opened = true;
    session.channel.send(
      JSON.stringify({
        type: 'OPEN',
        directSessionId: session.directSessionId,
        grant: session.grant
      })
    );
    session.heartbeat = setInterval(
      () => options.send({ type: 'direct.heartbeat', directSessionId: session.directSessionId }),
      HEARTBEAT_MS
    );
  }

  async function handleUploadChannel(session: UploadSession, data: unknown): Promise<void> {
    if (typeof data !== 'string') return;
    try {
      const frame = JSON.parse(data) as { type?: unknown; offset?: unknown };
      if (frame.type !== 'ACK' || !Number.isSafeInteger(frame.offset))
        throw new Error('DIRECT_FRAME_INVALID');
      const offset = frame.offset as number;
      if (offset < 0 || offset > session.request.file.size)
        throw new Error('DIRECT_OFFSET_INVALID');
      session.request.onProgress?.(offset);
      if (session.sending || session.completeSent) return;
      if (offset === session.request.file.size) {
        session.completeSent = true;
        session.channel.send(
          JSON.stringify({
            type: 'COMPLETE',
            size: session.request.descriptor.size
          })
        );
        return;
      }
      session.sending = true;
      try {
        const chunk = await session.request.file
          .slice(offset, Math.min(session.request.file.size, offset + 256 * 1024))
          .arrayBuffer();
        if (session.request.signal?.aborted === true) throw new Error('DIRECT_TRANSFER_CANCELLED');
        session.channel.send(chunk);
      } finally {
        session.sending = false;
      }
    } catch (error) {
      await finishTransfer(
        session,
        error instanceof Error ? error : new Error('DIRECT_TRANSFER_FAILED')
      );
    }
  }

  function handleDownloadChannel(session: DownloadSession, data: unknown): void {
    session.processing = session.processing
      .then(async () => {
        const expectedSize = transferredSize(session.request.descriptor);
        if (typeof data !== 'string') {
          const bytes = toBytes(data);
          if (bytes.byteLength === 0 || session.received + bytes.byteLength > expectedSize)
            throw new Error('DIRECT_INTEGRITY_FAILED');
          await session.request.sink.write(bytes);
          session.received += bytes.byteLength;
          session.request.onProgress?.(session.received);
          return;
        }
        const frame = JSON.parse(data) as { type?: unknown; size?: unknown };
        if (frame.type === 'ACK') return;
        if (
          frame.type !== 'COMPLETE' ||
          frame.size !== expectedSize ||
          session.received !== expectedSize
        )
          throw new Error('DIRECT_INTEGRITY_FAILED');
        await session.request.sink.close();
        session.dataComplete = true;
        session.channel.send(JSON.stringify({ type: 'ACK', offset: session.received }));
        if (session.serverComplete) await finishTransfer(session);
      })
      .catch(
        (error: unknown) =>
          void finishTransfer(
            session,
            error instanceof Error ? error : new Error('DIRECT_TRANSFER_FAILED')
          )
      );
  }

  function failTransportRequest(requestId: string, code: string): void {
    const request = transportRequests.get(requestId);
    if (request === undefined) return;
    transportRequests.delete(requestId);
    clearTimeout(request.timer);
    const transport = [...transportsBySession.values()].find((item) => item.request === request);
    if (transport !== undefined) removeTransport(transport, code, true);
    if (request.attempt === 1) {
      request.attempt = 2;
      request.requestId = randomId();
      beginTransport(request);
      return;
    }
    request.resolve('RELAY_ONLY');
    scheduleRetry(request.nodeId, request.nodeGeneration);
    options.onProbeResultChange?.();
  }

  function closeTransport(transport: TransportSession, code: string, notifyServer = true): void {
    if (!removeTransport(transport, code, notifyServer)) return;
    transport.request.resolve('RELAY_ONLY');
    scheduleRetry(transport.request.nodeId, transport.request.nodeGeneration);
    options.onProbeResultChange?.();
  }

  function removeTransport(
    transport: TransportSession,
    code: string,
    notifyServer: boolean
  ): boolean {
    if (!transportsBySession.delete(transport.directSessionId)) return false;
    if (transportsByNode.get(transport.request.nodeId) === transport)
      transportsByNode.delete(transport.request.nodeId);
    networkInfoByNode.delete(transport.request.nodeId);
    transportRequests.delete(transport.request.requestId);
    clearTimeout(transport.request.timer);
    if (transport.heartbeat !== undefined) clearInterval(transport.heartbeat);
    for (const transfer of [...transfers.values()])
      if (transfer.request.transportSessionId === transport.directSessionId)
        void finishTransfer(transfer, new Error(code));
    if (notifyServer)
      options.send({ type: 'direct.cancel', directSessionId: transport.directSessionId });
    transport.bootstrapChannel.close();
    transport.peer.close();
    return true;
  }

  function failTransferRequest(requestId: string, code: string): void {
    const request = transferRequests.get(requestId);
    if (request === undefined) return;
    transferRequests.delete(requestId);
    clearTimeout(request.timer);
    if ('sink' in request)
      void request.sink.abort().finally(() => {
        request.reject(new Error(code));
        releaseDeferredTransport(request.nodeId);
      });
    else {
      request.reject(new Error(code));
      releaseDeferredTransport(request.nodeId);
    }
  }

  async function finishTransfer(session: TransferSession, error?: Error): Promise<void> {
    if (!transfers.delete(session.directSessionId)) return;
    transferRequests.delete(session.request.requestId);
    clearTimeout(session.request.timer);
    if (session.heartbeat !== undefined) clearInterval(session.heartbeat);
    session.channel.close();
    if (session.request.descriptor.direction === 'DOWNLOAD') {
      const download = session as DownloadSession;
      if (error !== undefined) {
        await download.request.sink.abort().catch(() => undefined);
        download.request.reject(error);
      } else download.request.resolve();
    } else if (error === undefined) (session.request as UploadRequest).resolve();
    else (session.request as UploadRequest).reject(error);
    releaseDeferredTransport(session.request.nodeId);
  }

  function connectedTransport(nodeId: string, generation: string): TransportSession | undefined {
    const transport = transportsByNode.get(nodeId);
    return transport !== undefined &&
      transport.request.nodeGeneration === generation &&
      transportReady(transport)
      ? transport
      : undefined;
  }

  function scheduleRetry(nodeId: string, generation: string): void {
    if (options.shouldRetryProbe?.(nodeId, generation) !== true || retryDelaysMs.length === 0)
      return;
    const previous = retries.get(nodeId);
    const attempt = previous?.generation === generation ? previous.attempt + 1 : 0;
    const delay = retryDelaysMs[Math.min(attempt, retryDelaysMs.length - 1)];
    if (delay === undefined) return;
    if (previous?.timer !== undefined) clearTimeout(previous.timer);
    const entry = {
      generation,
      attempt,
      timer: undefined as ReturnType<typeof setTimeout> | undefined
    };
    entry.timer = setTimeout(() => {
      retries.delete(nodeId);
      void ensureTransport(nodeId, generation);
    }, delay);
    retries.set(nodeId, entry);
  }

  function clearRetry(nodeId: string): void {
    const retry = retries.get(nodeId);
    if (retry?.timer !== undefined) clearTimeout(retry.timer);
    retries.delete(nodeId);
  }

  function releaseTransport(nodeId: string): void {
    clearRetry(nodeId);
    if (
      [...transferRequests.values()].some((request) => request.nodeId === nodeId) ||
      (terminalReferences.get(nodeId) ?? 0) > 0
    ) {
      deferredReleaseNodes.add(nodeId);
      return;
    }
    releaseTransportNow(nodeId);
  }

  function releaseDeferredTransport(nodeId: string): void {
    if (
      !deferredReleaseNodes.has(nodeId) ||
      [...transferRequests.values()].some((request) => request.nodeId === nodeId) ||
      (terminalReferences.get(nodeId) ?? 0) > 0
    )
      return;
    releaseTransportNow(nodeId);
  }

  function releaseTransportNow(nodeId: string): void {
    deferredReleaseNodes.delete(nodeId);
    clearRetry(nodeId);
    const transport = transportsByNode.get(nodeId);
    if (transport !== undefined) {
      removeTransport(transport, 'DIRECT_TRANSPORT_RELEASED', true);
      transport.request.resolve('RELAY_ONLY');
    }
    for (const request of [...transportRequests.values()]) {
      if (request.nodeId !== nodeId) continue;
      transportRequests.delete(request.requestId);
      clearTimeout(request.timer);
      request.resolve('RELAY_ONLY');
    }
    options.onProbeResultChange?.();
  }

  function invalidateNode(nodeId: string): void {
    deferredReleaseNodes.delete(nodeId);
    clearRetry(nodeId);
    const transport = transportsByNode.get(nodeId);
    if (transport !== undefined) closeTransport(transport, 'DIRECT_NODE_INVALIDATED');
    for (const request of [...transportRequests.values()])
      if (request.nodeId === nodeId)
        failTransportRequest(request.requestId, 'DIRECT_NODE_INVALIDATED');
  }

  function invalidateNetwork(): void {
    for (const retry of retries.values()) if (retry.timer !== undefined) clearTimeout(retry.timer);
    retries.clear();
    for (const transport of [...transportsBySession.values()])
      closeTransport(transport, 'DIRECT_NETWORK_CHANGED');
    for (const request of [...transportRequests.values()])
      failTransportRequest(request.requestId, 'DIRECT_NETWORK_CHANGED');
  }

  function invalidateControlConnection(): void {
    invalidateNetwork();
  }
  function close(): void {
    deferredReleaseNodes.clear();
    invalidateNetwork();
    for (const request of [...transferRequests.values()])
      failTransferRequest(request.requestId, 'DIRECT_CONNECTION_FAILED');
  }

  return {
    result,
    transportNodeIds: (): string[] => [...transportsByNode.keys()],
    isConnected,
    acquireTerminalTransport,
    networkInfo,
    probe,
    ensureTransport,
    upload,
    download,
    handle,
    invalidateControlConnection,
    invalidateNetwork,
    invalidateNode,
    releaseTransport,
    close
  };
}

interface CandidateStat {
  readonly id?: string;
  readonly type?: string;
  readonly selectedCandidatePairId?: string;
  readonly localCandidateId?: string;
  readonly remoteCandidateId?: string;
  readonly state?: string;
  readonly nominated?: boolean;
  readonly address?: string;
  readonly ip?: string;
  readonly protocol?: string;
  readonly networkType?: string;
}

export function classifySelectedCandidatePair(
  report: Pick<RTCStatsReport, 'forEach'>
): DirectTransportNetworkInfo | undefined {
  const stats = new Map<string, CandidateStat>();
  report.forEach((raw) => {
    const stat = raw as CandidateStat;
    if (typeof stat.id === 'string') stats.set(stat.id, stat);
  });
  const transport = [...stats.values()].find(
    (stat) => stat.type === 'transport' && typeof stat.selectedCandidatePairId === 'string'
  );
  const pair =
    (transport?.selectedCandidatePairId === undefined
      ? undefined
      : stats.get(transport.selectedCandidatePairId)) ??
    [...stats.values()].find(
      (stat) =>
        stat.type === 'candidate-pair' && stat.state === 'succeeded' && stat.nominated === true
    );
  if (pair?.localCandidateId === undefined || pair.remoteCandidateId === undefined)
    return undefined;
  const local = stats.get(pair.localCandidateId);
  const remote = stats.get(pair.remoteCandidateId);
  if (local === undefined || remote === undefined) return undefined;
  const localAddress = local.address ?? local.ip;
  const remoteAddress = remote.address ?? remote.ip;
  const localScope = classifyCandidateAddress(localAddress);
  const remoteScope = classifyCandidateAddress(remoteAddress);
  const interfaceType = classifyInterfaceType(local.networkType);
  const scope =
    remoteScope.scope === 'LOOPBACK'
      ? 'LOOPBACK'
      : interfaceType === 'VPN' || localScope.scope === 'VPN_TUN' || remoteScope.scope === 'VPN_TUN'
        ? 'VPN_TUN'
        : localScope.scope === 'PUBLIC' || remoteScope.scope === 'PUBLIC'
          ? 'PUBLIC'
          : localScope.scope === 'PRIVATE' || remoteScope.scope === 'PRIVATE'
            ? 'PRIVATE'
            : 'UNKNOWN';
  const ipVersion =
    localScope.ipVersion === remoteScope.ipVersion
      ? localScope.ipVersion
      : remoteScope.ipVersion !== 'UNKNOWN'
        ? remoteScope.ipVersion
        : localScope.ipVersion;
  const protocol = (local.protocol ?? remote.protocol)?.toUpperCase();
  return {
    scope,
    ipVersion,
    protocol: protocol === 'UDP' || protocol === 'TCP' ? protocol : 'UNKNOWN',
    interfaceType: scope === 'LOOPBACK' ? 'LOOPBACK' : interfaceType
  };
}

function classifyCandidateAddress(address: string | undefined): {
  readonly scope: DirectTransportNetworkInfo['scope'];
  readonly ipVersion: DirectTransportNetworkInfo['ipVersion'];
} {
  if (address === undefined || address.endsWith('.local'))
    return { scope: 'UNKNOWN', ipVersion: 'UNKNOWN' };
  const ipv4 = address.split('.').map(Number);
  if (
    ipv4.length === 4 &&
    ipv4.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
  ) {
    const [a, b] = ipv4 as [number, number, number, number];
    if (a === 127) return { scope: 'LOOPBACK', ipVersion: 'IPV4' };
    if (a === 198 && (b === 18 || b === 19)) return { scope: 'VPN_TUN', ipVersion: 'IPV4' };
    if (
      a === 10 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    )
      return { scope: 'PRIVATE', ipVersion: 'IPV4' };
    return { scope: 'PUBLIC', ipVersion: 'IPV4' };
  }
  const normalized = address.toLowerCase().split('%')[0] ?? '';
  if (!normalized.includes(':')) return { scope: 'UNKNOWN', ipVersion: 'UNKNOWN' };
  if (normalized === '::1') return { scope: 'LOOPBACK', ipVersion: 'IPV6' };
  if (/^f[cd]/u.test(normalized) || /^fe[89ab]/u.test(normalized))
    return { scope: 'PRIVATE', ipVersion: 'IPV6' };
  return { scope: 'PUBLIC', ipVersion: 'IPV6' };
}

function classifyInterfaceType(
  value: string | undefined
): DirectTransportNetworkInfo['interfaceType'] {
  if (value === 'ethernet') return 'ETHERNET';
  if (value === 'wifi') return 'WIFI';
  if (value === 'cellular') return 'CELLULAR';
  if (value === 'vpn') return 'VPN';
  if (value === 'loopback') return 'LOOPBACK';
  return 'UNKNOWN';
}

function transportReady(transport: TransportSession): boolean {
  return (
    transport.peerConnected &&
    transport.serverOpened &&
    transport.peer.connectionState === 'connected'
  );
}

async function applySignal(peer: RTCPeerConnection, signal: DirectSignal): Promise<void> {
  if (signal.kind === 'CANDIDATE') {
    if (!safeHostCandidate(signal.candidate.candidate))
      throw new Error('DIRECT_CANDIDATE_REJECTED');
    await peer.addIceCandidate(signal.candidate);
  } else if (signal.kind === 'END_OF_CANDIDATES') await peer.addIceCandidate(null);
  else {
    if (!hostOnlySdp(signal.sdp)) throw new Error('DIRECT_CANDIDATE_REJECTED');
    await peer.setRemoteDescription({
      type: signal.kind === 'ANSWER' ? 'answer' : 'offer',
      sdp: signal.sdp
    });
  }
}

function transferredSize(
  descriptor: Extract<DirectTransferDescriptor, { direction: 'DOWNLOAD' }>
): number {
  return descriptor.range?.length ?? descriptor.size;
}
function toBytes(value: unknown): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new Error('DIRECT_FRAME_INVALID');
}
function fingerprint(sdp: string | undefined): string | undefined {
  return sdp?.match(/^a=fingerprint:(sha-256 [A-F0-9:]+)\r?$/imu)?.[1];
}
function safeHostCandidate(candidate: string): boolean {
  return (
    /\styp host(?:\s|$)/u.test(candidate) && (candidate.trim().split(/\s+/u)[4]?.length ?? 0) > 0
  );
}
function hostOnlySdp(sdp: string): boolean {
  return sdp
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('a=candidate:'))
    .every((line) => safeHostCandidate(line.slice(2)));
}
function candidateKey(candidate: string): string | undefined {
  const fields = candidate.trim().split(/\s+/u);
  return fields[1] !== undefined && fields[2] !== undefined && fields[4] !== undefined
    ? `${fields[1]}:${fields[2].toLowerCase()}:${fields[4].toLowerCase()}`
    : undefined;
}
function acceptHostCandidate(candidate: string, accepted: Set<string>): boolean {
  if (!safeHostCandidate(candidate)) return false;
  const key = candidateKey(candidate);
  if (key === undefined || accepted.has(key) || accepted.size >= MAX_HOST_CANDIDATES) return false;
  accepted.add(key);
  return true;
}
function stripIceCandidates(sdp: string | undefined, accepted: Set<string>): string | undefined {
  if (sdp === undefined) return undefined;
  const included = new Set<string>();
  return sdp
    .split(/\r?\n/u)
    .filter((line) => {
      if (!line.startsWith('a=candidate:')) return true;
      const candidate = line.slice(2);
      if (!safeHostCandidate(candidate)) return false;
      const key = candidateKey(candidate);
      if (key === undefined || included.has(key)) return false;
      if (!accepted.has(key) && accepted.size >= MAX_HOST_CANDIDATES) return false;
      accepted.add(key);
      included.add(key);
      return true;
    })
    .join('\r\n');
}
function errorCode(error: unknown): string {
  return error instanceof Error && /^[A-Z][A-Z0-9_]{0,127}$/u.test(error.message)
    ? error.message
    : 'DIRECT_CONNECTION_FAILED';
}
