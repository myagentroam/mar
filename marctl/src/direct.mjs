import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

export const DIRECT_PREPARE_TIMEOUT_MS = 5000;
export const DIRECT_SETUP_TIMEOUT_MS = 15000;
export const DIRECT_ICE_TIMEOUT_MS = 3000;
export const DIRECT_HEARTBEAT_MS = 10000;

export class DirectFallbackError extends Error {
  constructor(code = 'DIRECT_UNAVAILABLE') {
    super(code);
    this.name = 'DirectFallbackError';
    this.code = code;
  }
}

export class DirectUnsafeError extends Error {
  constructor(code = 'DIRECT_CANCEL_UNCONFIRMED') {
    super(code);
    this.name = 'DirectUnsafeError';
    this.code = code;
  }
}

export async function openDirectTerminal(options) {
  const {
    client,
    WebSocketClass,
    nodeId,
    terminalId,
    afterSequence = 0,
    timeoutMs = DIRECT_SETUP_TIMEOUT_MS,
    heartbeatMs = DIRECT_HEARTBEAT_MS,
    peerConnectionFactory,
    onPrepared,
    onIceConnected,
    onTransportReady,
    beforeOpen,
    cleanupNative: cleanupNativeImpl,
    signal
  } = options;
  let { manifest } = options;
  if (peerConnectionFactory === undefined && typeof client.openDirectTerminal === 'function')
    return client.openDirectTerminal(options);
  if (manifest === undefined && typeof client.getTerminalManifest !== 'function')
    throw new DirectFallbackError('DIRECT_MANIFEST_UNAVAILABLE');

  let live;
  let peer;
  let bootstrapChannel;
  let terminalChannel;
  let transportSessionId;
  let terminalSessionId;
  let transport;
  let unsafeFallback = false;
  let transportControlCleanup;
  let transportNegotiationActive = true;
  let cleanupNative = cleanupNativeImpl;
  try {
    manifest ??= await client.getTerminalManifest(nodeId);
    if (
      typeof manifest?.nodeGeneration !== 'string' ||
      manifest.nodeGeneration.length < 8 ||
      manifest.terminalDirect?.apiVersion !== 1 ||
      manifest.terminalDirect.transport !== true
    )
      throw new DirectFallbackError('DIRECT_UNSUPPORTED');

    live = new LiveControl(client.openWorkbenchWebSocket(WebSocketClass), timeoutMs);
    await live.openAndResume();

    const transportPrepared = await live.request(
      {
        type: 'direct.prepare',
        requestId: requestId(),
        nodeId,
        nodeGeneration: manifest.nodeGeneration,
        purpose: 'TRANSPORT'
      },
      (message, request) =>
        message.type === 'direct.prepared' &&
        message.requestId === request.requestId &&
        message.purpose === 'TRANSPORT',
      'DIRECT_TRANSPORT_PREPARE_FAILED'
    );
    transportSessionId = transportPrepared.directSessionId;

    const native =
      peerConnectionFactory === undefined ? await import('node-datachannel') : undefined;
    cleanupNative ??= native?.cleanup;
    const createPeer =
      peerConnectionFactory ?? ((name, options) => new native.PeerConnection(name, options));
    peer = createPeer(`marctl-${transportSessionId}`, { iceServers: [] });

    // Start negotiation only after both paths finish their control-plane preparation.
    if (onPrepared) await onPrepared();
    if (signal?.aborted) throw new DirectFallbackError('DIRECT_RACE_CANCELLED');

    const transportReady = new Promise((resolve, reject) => {
      let iceConnected = false;
      let connected = false;
      let serverOpened = false;
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        transportNegotiationActive = false;
        if (error === undefined) resolve();
        else reject(error);
      };
      const maybeReady = () => {
        if (connected && serverOpened) finish();
      };
      transportControlCleanup = live.onControl((message) => {
        if (!transportNegotiationActive || settled) return;
        if (message.type === 'direct.signal' && message.directSessionId === transportSessionId) {
          try {
            applyRemoteSignal(peer, message.signal);
          } catch (error) {
            finish(
              error instanceof DirectFallbackError
                ? error
                : new DirectFallbackError('DIRECT_SIGNAL_INVALID')
            );
          }
          return;
        }
        if (message.type === 'direct.opened' && message.directSessionId === transportSessionId) {
          serverOpened = true;
          maybeReady();
          return;
        }
        if (
          (message.type === 'direct.error' || message.type === 'direct.closed') &&
          message.directSessionId === transportSessionId
        )
          finish(new DirectFallbackError(message.code));
      });
      peer.onLocalDescription((sdp, type) => {
        if (!transportNegotiationActive || settled) return;
        if (String(type).toLowerCase() !== 'offer') return;
        let signal;
        try {
          signal = localOfferSignal(sdp);
        } catch (error) {
          finish(error instanceof DirectFallbackError ? error : new DirectFallbackError());
          return;
        }
        if (!live.send({ type: 'direct.signal', directSessionId: transportSessionId, signal }))
          finish(new DirectFallbackError('DIRECT_CONTROL_UNAVAILABLE'));
      });
      peer.onLocalCandidate((candidate, mid) => {
        if (!transportNegotiationActive || settled || typeof candidate !== 'string') return;
        if (candidate === '') {
          if (
            !live.send({
              type: 'direct.signal',
              directSessionId: transportSessionId,
              signal: { kind: 'END_OF_CANDIDATES' }
            })
          )
            finish(new DirectFallbackError('DIRECT_CONTROL_UNAVAILABLE'));
          return;
        }
        if (!safeHostCandidate(candidate)) return;
        if (
          !live.send({
            type: 'direct.signal',
            directSessionId: transportSessionId,
            signal: {
              kind: 'CANDIDATE',
              candidate: { candidate, sdpMid: mid || null, sdpMLineIndex: null }
            }
          })
        )
          finish(new DirectFallbackError('DIRECT_CONTROL_UNAVAILABLE'));
      });
      peer.onIceStateChange((state) => {
        if (!transportNegotiationActive || settled || iceConnected) return;
        const normalizedState = String(state).toLowerCase();
        if (normalizedState !== 'connected' && normalizedState !== 'completed') return;
        iceConnected = true;
        try {
          onIceConnected?.();
        } catch (error) {
          finish(error);
        }
      });
      peer.onStateChange((state) => {
        if (!transportNegotiationActive || settled) return;
        const normalizedState = String(state).toLowerCase();
        if (normalizedState === 'connected') {
          if (!connected) {
            connected = true;
            if (!live.send({ type: 'direct.connected', directSessionId: transportSessionId }))
              finish(new DirectFallbackError('DIRECT_CONTROL_UNAVAILABLE'));
          }
          maybeReady();
        } else if (normalizedState === 'failed' || normalizedState === 'closed') {
          finish(new DirectFallbackError('DIRECT_CONNECTION_FAILED'));
        }
      });
      try {
        bootstrapChannel = peer.createDataChannel('mar-direct-transport', {
          unordered: false
        });
        if (peer.localDescription?.() == null) peer.setLocalDescription('Offer');
      } catch {
        finish(new DirectFallbackError('DIRECT_OFFER_FAILED'));
      }
    });
    try {
      await withTimeout(
        transportReady,
        Math.min(timeoutMs, DIRECT_ICE_TIMEOUT_MS),
        'DIRECT_SETUP_TIMEOUT',
        signal
      );
    } finally {
      transportNegotiationActive = false;
      transportControlCleanup?.();
      transportControlCleanup = undefined;
    }
    bootstrapChannel?.close?.();
    if (onTransportReady) await onTransportReady();

    const terminalPrepared = await live.request(
      {
        type: 'terminal.direct.prepare',
        requestId: requestId(),
        nodeId,
        nodeGeneration: manifest.nodeGeneration,
        transportSessionId,
        terminalId,
        afterSequence,
        readonly: false
      },
      (message, request) =>
        message.type === 'terminal.direct.prepared' &&
        message.requestId === request.requestId &&
        typeof message.directSessionId === 'string' &&
        typeof message.grant === 'string',
      'TERMINAL_DIRECT_PREPARE_FAILED'
    );
    terminalSessionId = terminalPrepared.directSessionId;
    terminalChannel = peer.createDataChannel(`mar-terminal-${terminalSessionId}`, {
      unordered: false
    });

    transport = new DirectTerminalTransport({
      channel: terminalChannel,
      live,
      peer,
      transportSessionId,
      terminalSessionId,
      terminalId,
      heartbeatMs,
      cleanupNative
    });
    if (beforeOpen) await beforeOpen();
    await withTimeout(
      transport.waitForAttachment(terminalPrepared.grant),
      timeoutMs,
      'TERMINAL_DIRECT_TIMEOUT'
    );
    return transport;
  } catch (error) {
    transportControlCleanup?.();
    transportControlCleanup = undefined;
    unsafeFallback = transport?.openSent === true;
    if (transport !== undefined) {
      await transport.cancelAndDispose().catch(() => undefined);
      transport.dispose({ skipCancel: true });
    }
    bootstrapChannel?.close?.();
    terminalChannel?.close?.();
    try {
      if (transport === undefined && terminalSessionId !== undefined)
        await cancelSession(live, 'terminal.direct.cancel', terminalSessionId);
      if (transport === undefined && transportSessionId !== undefined)
        await cancelSession(live, 'direct.cancel', transportSessionId);
    } catch {
      // Direct setup cleanup is best effort before relay fallback.
    }
    live?.close();
    if (transport === undefined) peer?.close?.();
    if (transport === undefined) cleanupNative?.();
    if (unsafeFallback) throw new DirectUnsafeError('DIRECT_OPEN_CANCEL_UNCONFIRMED');
    if (error instanceof DirectFallbackError || error instanceof DirectUnsafeError) throw error;
    throw new DirectFallbackError(errorCode(error));
  }
}

class LiveControl {
  #socket;
  #timeoutMs;
  #ready = false;
  #closed = false;
  #waiters = new Set();
  #listeners = new Set();
  #onMessage;
  #onError;
  #onClose;

  constructor(socket, timeoutMs) {
    this.#socket = socket;
    this.#timeoutMs = timeoutMs;
    this.#onMessage = (raw, isBinary) => {
      if (isBinary) return;
      let message;
      try {
        message = JSON.parse(rawToString(raw));
      } catch {
        return;
      }
      if (!isRecord(message) || typeof message.type !== 'string') return;
      for (const listener of this.#listeners) listener(message);
      for (const waiter of [...this.#waiters]) {
        if (!waiter.predicate(message, waiter.request)) continue;
        this.#waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    };
    this.#onError = () => this.#fail(new DirectFallbackError('DIRECT_CONTROL_UNAVAILABLE'));
    this.#onClose = () => this.#fail(new DirectFallbackError('DIRECT_CONTROL_CLOSED'));
    socket.on?.('message', this.#onMessage);
    socket.on?.('error', this.#onError);
    socket.on?.('close', this.#onClose);
  }

  async openAndResume() {
    await this.#waitForSocket('open', 'DIRECT_CONTROL_TIMEOUT');
    const ready = this.waitFor(
      (message) =>
        message.type === 'workbench.ready' && typeof message.workbenchConnectionId === 'string',
      undefined,
      'DIRECT_RESUME_TIMEOUT'
    );
    if (!this.send({ type: 'resume' })) {
      ready.catch(() => undefined);
      throw new DirectFallbackError('DIRECT_CONTROL_UNAVAILABLE');
    }
    await ready;
    this.#ready = true;
  }

  request(message, predicate, fallbackCode) {
    if (!this.#ready) throw new DirectFallbackError('DIRECT_CONTROL_UNAVAILABLE');
    const response = this.waitFor(predicate, message, fallbackCode);
    if (!this.send(message)) {
      response.catch(() => undefined);
      throw new DirectFallbackError('DIRECT_CONTROL_UNAVAILABLE');
    }
    return response;
  }

  waitFor(predicate, request, fallbackCode, timeoutMs = this.#timeoutMs) {
    return new Promise((resolve, reject) => {
      if (this.#closed) {
        reject(new DirectFallbackError('DIRECT_CONTROL_CLOSED'));
        return;
      }
      const waiter = {
        predicate,
        request,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.#waiters.delete(waiter);
          reject(new DirectFallbackError(fallbackCode ?? 'DIRECT_SETUP_TIMEOUT'));
        }, timeoutMs)
      };
      this.#waiters.add(waiter);
    });
  }

  onControl(listener) {
    if (this.#closed) return () => {};
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  send(message) {
    if (this.#closed || (this.#socket.readyState !== undefined && this.#socket.readyState !== 1))
      return false;
    try {
      this.#socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#fail(new DirectFallbackError('DIRECT_CONTROL_CLOSED'));
    this.#listeners.clear();
    this.#socket.removeListener?.('message', this.#onMessage);
    this.#socket.removeListener?.('error', this.#onError);
    this.#socket.removeListener?.('close', this.#onClose);
    try {
      this.#socket.close();
    } catch {
      // The control socket is already closed.
    }
  }

  #waitForSocket(event, code) {
    if (this.#socket.readyState === 1) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const onEvent = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new DirectFallbackError(code));
      };
      const onClose = () => {
        cleanup();
        reject(new DirectFallbackError(code));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new DirectFallbackError(code));
      }, this.#timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.#socket.removeListener?.(event, onEvent);
        this.#socket.removeListener?.('error', onError);
        this.#socket.removeListener?.('close', onClose);
      };
      this.#socket.once?.(event, onEvent);
      this.#socket.once?.('error', onError);
      this.#socket.once?.('close', onClose);
    });
  }

  #fail(error) {
    if (this.#closed && this.#waiters.size === 0) return;
    for (const waiter of [...this.#waiters]) {
      this.#waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
}

class DirectTerminalTransport extends EventEmitter {
  #channel;
  #live;
  #peer;
  #transportSessionId;
  #terminalSessionId;
  #terminalId;
  #cleanupNative;
  #heartbeatTimer;
  #unsubscribeLive;
  #closed = false;
  #attached = false;
  #active = false;
  #pendingEvents = [];
  #attachmentResolve;
  #attachmentReject;
  #openSent = false;
  #cancelSent = false;

  constructor({
    channel,
    live,
    peer,
    transportSessionId,
    terminalSessionId,
    terminalId,
    heartbeatMs,
    cleanupNative
  }) {
    super();
    this.#channel = channel;
    this.#live = live;
    this.#peer = peer;
    this.#transportSessionId = transportSessionId;
    this.#terminalSessionId = terminalSessionId;
    this.#terminalId = terminalId;
    this.#cleanupNative = cleanupNative;
    this.#channel.onMessage?.((raw) => this.#handleMessage(raw));
    this.#channel.onClosed?.(() => this.#fail('TERMINAL_DIRECT_CLOSED'));
    this.#channel.onError?.(() => this.#fail('TERMINAL_CONNECTION_FAILED'));
    this.#unsubscribeLive = this.#live.onControl((message) => this.#handleControl(message));
    this.#heartbeatTimer = setInterval(() => {
      if (
        !this.#live.send({
          type: 'direct.heartbeat',
          directSessionId: this.#transportSessionId
        }) ||
        !this.#live.send({
          type: 'terminal.direct.heartbeat',
          directSessionId: this.#terminalSessionId
        })
      )
        this.#fail('TERMINAL_CONNECTION_LOST');
    }, heartbeatMs);
    this.#heartbeatTimer.unref?.();
  }

  get openSent() {
    return this.#openSent;
  }

  activate() {
    if (this.#active) return;
    this.#active = true;
    const pendingEvents = this.#pendingEvents;
    this.#pendingEvents = [];
    for (const { type, args } of pendingEvents) this.#emit(type, ...args);
  }

  waitForAttachment(grant) {
    return new Promise((resolve, reject) => {
      if (this.#closed) {
        reject(new DirectFallbackError('TERMINAL_DIRECT_CLOSED'));
        return;
      }
      this.#attachmentResolve = resolve;
      this.#attachmentReject = reject;
      let opened = false;
      const onOpen = () => {
        if (opened || this.#closed) return;
        opened = true;
        try {
          this.#openSent = true;
          if (
            !this.#channel.sendMessage(
              JSON.stringify({
                type: 'OPEN',
                directSessionId: this.#terminalSessionId,
                grant
              })
            )
          )
            throw new Error('TERMINAL_ATTACH_FAILED');
        } catch {
          this.#fail('TERMINAL_ATTACH_FAILED');
        }
      };
      this.#channel.onOpen?.(onOpen);
      if (this.#channel.isOpen?.() === true) onOpen();
    });
  }

  send(frame) {
    if (this.#closed || this.#channel.isOpen?.() !== true)
      throw new Error('TERMINAL_CONNECTION_LOST');
    const value = typeof frame === 'string' ? frame : JSON.stringify(frame);
    if (!this.#channel.sendMessage(value)) throw new Error('TERMINAL_INPUT_FAILED');
  }

  close() {
    this.dispose();
  }

  dispose({ skipCancel = false } = {}) {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#heartbeatTimer);
    if (!skipCancel) this.#sendCancel();
    this.#attachmentReject?.(new DirectFallbackError('TERMINAL_DIRECT_CLOSED'));
    this.#attachmentResolve = undefined;
    this.#attachmentReject = undefined;
    this.#unsubscribeLive?.();
    this.#unsubscribeLive = undefined;
    this.#channel.close?.();
    this.#peer.close?.();
    this.#live.close();
    this.#cleanupNative?.();
    this.#emit('close');
  }

  async cancelAndDispose() {
    const terminalClosed = this.#live.waitFor(
      (message) =>
        message.type === 'terminal.direct.closed' &&
        message.directSessionId === this.#terminalSessionId,
      undefined,
      'DIRECT_CANCEL_TIMEOUT',
      1000
    );
    const transportClosed = this.#live.waitFor(
      (message) =>
        message.type === 'direct.closed' && message.directSessionId === this.#transportSessionId,
      undefined,
      'DIRECT_CANCEL_TIMEOUT',
      1000
    );
    this.#sendCancel();
    await Promise.allSettled([terminalClosed, transportClosed]);
    this.dispose({ skipCancel: true });
  }

  #handleMessage(raw) {
    if (this.#closed) return;
    if (!this.#attached) {
      let frame;
      try {
        frame = JSON.parse(rawToString(raw));
      } catch {
        this.#fail('TERMINAL_FRAME_INVALID');
        return;
      }
      if (
        !isRecord(frame) ||
        frame.type !== 'ATTACHED' ||
        frame.terminalId !== this.#terminalId ||
        !Number.isSafeInteger(frame.afterSequence) ||
        frame.afterSequence < 0
      ) {
        this.#fail('TERMINAL_ATTACH_FAILED');
        return;
      }
      this.#attached = true;
      this.#attachmentResolve?.();
      this.#attachmentResolve = undefined;
      this.#attachmentReject = undefined;
      return;
    }
    this.#emit(
      'message',
      raw,
      typeof raw === 'string'
        ? false
        : Buffer.isBuffer(raw) || raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)
    );
  }

  #handleControl(message) {
    if (message.type === 'terminal.direct.error' || message.type === 'terminal.direct.closed') {
      if (!this.#attached) this.#fail(message.code);
      else this.#fail(message.code);
    }
    if (message.type === 'direct.closed' || message.type === 'direct.error')
      this.#fail(message.code);
  }

  #fail(code) {
    if (this.#closed) return;
    const error = new Error(code);
    if (!this.#attached) this.#attachmentReject?.(new DirectFallbackError(code));
    this.#attachmentResolve = undefined;
    this.#attachmentReject = undefined;
    this.#emit('error', error);
    this.dispose();
  }

  #emit(type, ...args) {
    if (!this.#active) {
      this.#pendingEvents.push({ type, args });
      return;
    }
    if (type !== 'error' || this.listenerCount('error') > 0) this.emit(type, ...args);
  }

  #sendCancel() {
    if (this.#cancelSent) return;
    this.#cancelSent = true;
    this.#live.send({
      type: 'terminal.direct.cancel',
      directSessionId: this.#terminalSessionId
    });
    this.#live.send({
      type: 'direct.cancel',
      directSessionId: this.#transportSessionId,
      reason: 'CLI_CLOSED'
    });
  }
}

async function cancelSession(live, type, directSessionId) {
  if (live === undefined) return;
  const closed = live.waitFor(
    (message) =>
      message.type === `${type.replace('.cancel', '.closed')}` &&
      message.directSessionId === directSessionId,
    undefined,
    'DIRECT_CANCEL_TIMEOUT',
    1000
  );
  live.send({
    type,
    directSessionId,
    ...(type === 'direct.cancel' ? { reason: 'CLI_FALLBACK' } : {})
  });
  await closed.catch(() => undefined);
}

function withTimeout(promise, timeoutMs, code, signal) {
  let timer;
  let onAbort;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new DirectFallbackError(code)), timeoutMs);
    }),
    ...(signal
      ? [
          new Promise((_, reject) => {
            onAbort = () => reject(new DirectFallbackError('DIRECT_RACE_CANCELLED'));
            if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort, { once: true });
          })
        ]
      : [])
  ]).finally(() => {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  });
}

function requestId() {
  return randomUUID().replaceAll('-', '');
}

function rawToString(raw) {
  if (typeof raw === 'string') return raw;
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
  if (ArrayBuffer.isView(raw))
    return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8');
  return String(raw);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function localOfferSignal(sdp) {
  const fingerprint = extractFingerprint(sdp);
  if (fingerprint === undefined) throw new DirectFallbackError('DIRECT_FINGERPRINT_INVALID');
  return { kind: 'OFFER', sdp: stripHostCandidates(sdp), fingerprint };
}

function applyRemoteSignal(peer, signal) {
  if (signal.kind === 'CANDIDATE') {
    if (
      !isRecord(signal.candidate) ||
      typeof signal.candidate.candidate !== 'string' ||
      !safeHostCandidate(signal.candidate.candidate)
    )
      throw new DirectFallbackError('DIRECT_CANDIDATE_REJECTED');
    peer.addRemoteCandidate(
      signal.candidate.candidate,
      signal.candidate.sdpMid ?? String(signal.candidate.sdpMLineIndex ?? 0)
    );
    return;
  }
  if (signal.kind === 'END_OF_CANDIDATES') return;
  if (
    !hostOnlySdp(signal.sdp) ||
    !fingerprintMatches(signal.sdp, signal.fingerprint) ||
    signal.kind !== 'ANSWER'
  )
    throw new DirectFallbackError('DIRECT_FINGERPRINT_INVALID');
  peer.setRemoteDescription(signal.sdp, 'Answer');
}

function extractFingerprint(sdp) {
  if (typeof sdp !== 'string') return undefined;
  const match = sdp.match(/^a=fingerprint:sha-256 ([A-F0-9:]+)\r?$/imu);
  if (match === null) return undefined;
  const value = match[1].toUpperCase();
  return /^([A-F0-9]{2}:){31}[A-F0-9]{2}$/u.test(value) ? `sha-256 ${value}` : undefined;
}

function safeHostCandidate(candidate) {
  return typeof candidate === 'string' && /\styp host(?:\s|$)/u.test(candidate);
}

function hostOnlySdp(sdp) {
  if (typeof sdp !== 'string') return false;
  return sdp
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('a=candidate:'))
    .every((line) => safeHostCandidate(line.slice(2)));
}

function stripHostCandidates(sdp) {
  if (typeof sdp !== 'string') throw new DirectFallbackError('DIRECT_SDP_INVALID');
  return sdp
    .split(/\r?\n/u)
    .filter((line) => !line.startsWith('a=candidate:') || safeHostCandidate(line.slice(2)))
    .join('\r\n');
}

function fingerprintMatches(sdp, fingerprint) {
  return extractFingerprint(sdp) === normalizeFingerprint(fingerprint);
}

function normalizeFingerprint(value) {
  if (typeof value !== 'string') return undefined;
  const match = /^sha-256 ([A-F0-9:]+)$/iu.exec(value);
  if (match === null) return undefined;
  const normalized = match[1].toUpperCase();
  return /^([A-F0-9]{2}:){31}[A-F0-9]{2}$/u.test(normalized) ? `sha-256 ${normalized}` : undefined;
}

function errorCode(error) {
  return error instanceof Error && /^[A-Z][A-Z0-9_]{0,127}$/u.test(error.message)
    ? error.message
    : 'DIRECT_CONNECTION_FAILED';
}
