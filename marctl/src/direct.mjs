import {
  DirectFallbackError,
  DirectUnsafeError,
  DirectRejectedError,
  directControlError
} from './direct-errors.mjs';
import { randomUUID } from 'node:crypto';
import { LiveControl, cancelSession, withTimeout, isRecord } from './direct-control.mjs';
import { DirectTerminalTransport } from './direct-transport.mjs';

export const DIRECT_PREPARE_TIMEOUT_MS = 5000;
export const DIRECT_SETUP_TIMEOUT_MS = 15000;
export const DIRECT_ICE_TIMEOUT_MS = 3000;
export const DIRECT_HEARTBEAT_MS = 10000;

export async function openDirectTerminal(options) {
  if (
    options.peerConnectionFactory === undefined &&
    typeof options.client.openDirectTerminal === 'function'
  )
    return options.client.openDirectTerminal(options);
  const connection = await openDirectConnection(options);
  try {
    return await connection.attach({ ...options, closeConnection: connection.close });
  } catch (error) {
    connection.close();
    throw error;
  }
}

/** Owns one ICE peer and control socket; each attach owns only its DataChannel and grant. */
export async function openDirectConnection(options) {
  const {
    client,
    WebSocketClass,
    nodeId,
    timeoutMs = DIRECT_SETUP_TIMEOUT_MS,
    heartbeatMs = DIRECT_HEARTBEAT_MS,
    peerConnectionFactory,
    onPrepared,
    onIceConnected,
    onTransportReady,
    onRejected,
    cleanupNative: cleanupNativeImpl,
    signal
  } = options;
  let { manifest } = options;
  if (manifest === undefined && typeof client.getTerminalManifest !== 'function')
    throw new DirectFallbackError('DIRECT_MANIFEST_UNAVAILABLE');

  let live;
  let peer;
  let bootstrapChannel;
  let transportSessionId;
  let closeConnection;
  let transportControlCleanup;
  let transportDisconnectCleanup;
  let transportNegotiationActive = true;
  let preparationError;
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
    await withTimeout(live.openAndResume(), timeoutMs, 'DIRECT_CONTROL_TIMEOUT', signal);

    let dispatchControl;
    let rejectPreparation;
    const earlyTransportErrors = new Map();
    const preparationFailure = new Promise((_, reject) => {
      rejectPreparation = reject;
    });
    void preparationFailure.catch(() => undefined);
    const failPreparation = (error) => {
      preparationError ??= error;
      rejectPreparation(preparationError);
    };
    transportDisconnectCleanup = live.onDisconnect(() =>
      failPreparation(new DirectFallbackError('DIRECT_CONTROL_CLOSED'))
    );
    // Node errors carry a session ID, not necessarily the browser's request ID.
    // Listen before prepare and native initialization, then correlate with prepared.
    transportControlCleanup = live.onControl((message) => {
      if (dispatchControl && transportNegotiationActive) dispatchControl(message);
      else if (
        (message.type === 'direct.error' || message.type === 'direct.closed') &&
        typeof message.directSessionId === 'string'
      ) {
        const error = directControlError(message.code);
        if (transportSessionId === undefined) {
          if (earlyTransportErrors.size >= 16 && !earlyTransportErrors.has(message.directSessionId))
            failPreparation(new DirectRejectedError('DIRECT_CONTROL_MESSAGE_LIMIT'));
          else if (!earlyTransportErrors.has(message.directSessionId))
            earlyTransportErrors.set(message.directSessionId, error);
        } else if (message.directSessionId === transportSessionId) failPreparation(error);
      }
    });
    const transportPrepared = await withTimeout(
      Promise.race([
        live.request(
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
        ),
        preparationFailure
      ]),
      timeoutMs,
      'DIRECT_TRANSPORT_PREPARE_FAILED',
      signal
    );
    transportSessionId = transportPrepared.directSessionId;
    const earlyError = earlyTransportErrors.get(transportSessionId);
    earlyTransportErrors.clear();
    if (earlyError) throw earlyError;

    const native =
      peerConnectionFactory === undefined ? await import('node-datachannel') : undefined;
    cleanupNative ??= native?.cleanup;
    if (preparationError) throw preparationError;
    const createPeer =
      peerConnectionFactory ?? ((name, options) => new native.PeerConnection(name, options));
    peer = createPeer(`marctl-${transportSessionId}`, { iceServers: [] });
    if (preparationError) throw preparationError;

    // Start negotiation only after both paths finish their control-plane preparation.
    await withTimeout(
      Promise.race([preparationFailure, onPrepared?.()]),
      timeoutMs,
      'DIRECT_SETUP_TIMEOUT',
      signal
    );
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
      dispatchControl = (message) => {
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
          finish(directControlError(message.code));
      };
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
        const normalizedState = String(state).toLowerCase();
        if (!transportNegotiationActive || settled) {
          if (normalizedState === 'failed' || normalizedState === 'closed') {
            if (closeConnection) closeConnection();
            else failPreparation(new DirectFallbackError('DIRECT_CONNECTION_FAILED'));
          }
          return;
        }
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
        Promise.race([transportReady, preparationFailure]),
        Math.min(timeoutMs, DIRECT_ICE_TIMEOUT_MS),
        'DIRECT_SETUP_TIMEOUT',
        signal
      );
    } finally {
      transportNegotiationActive = false;
    }
    bootstrapChannel?.close?.();
    // Keep observing the peer and control socket until ownership passes to the caller.
    if (onTransportReady)
      await withTimeout(
        Promise.race([preparationFailure, onTransportReady()]),
        timeoutMs,
        'DIRECT_SETUP_TIMEOUT',
        signal
      );
    if (preparationError) throw preparationError;
    transportControlCleanup();
    transportDisconnectCleanup();

    let closed = false;
    const close = (reason = 'CLI_CLOSED') => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      disconnect();
      live.send({ type: 'direct.cancel', directSessionId: transportSessionId, reason });
      live.close();
      peer.close?.();
      cleanupNative?.();
    };
    const unsubscribe = live.onControl((message) => {
      if (
        message.directSessionId === transportSessionId &&
        (message.type === 'direct.error' || message.type === 'direct.closed')
      )
        close();
    });
    const disconnect = live.onDisconnect(() => close());
    const heartbeat = setInterval(() => {
      if (!live.send({ type: 'direct.heartbeat', directSessionId: transportSessionId })) close();
    }, heartbeatMs);
    heartbeat.unref?.();
    closeConnection = close;
    return {
      get closed() {
        return closed;
      },
      close,
      attach: ({
        terminalId,
        computer,
        afterSequence,
        signal,
        beforeOpen,
        closeConnection,
        onRejected
      }) => {
        if (closed) throw new DirectFallbackError('DIRECT_CONTROL_UNAVAILABLE');
        return attachDirect({
          nodeId,
          manifest,
          transportSessionId,
          live,
          peer,
          heartbeatMs,
          timeoutMs,
          terminalId,
          computer,
          afterSequence,
          signal,
          beforeOpen,
          closeConnection,
          onRejected
        });
      }
    };
  } catch (caughtError) {
    transportNegotiationActive = false;
    const error = preparationError ?? caughtError;
    transportControlCleanup?.();
    transportDisconnectCleanup?.();
    if (error instanceof DirectRejectedError) onRejected?.(error);
    bootstrapChannel?.close?.();
    if (transportSessionId !== undefined)
      await cancelSession(live, 'direct.cancel', transportSessionId);
    live?.close();
    peer?.close?.();
    cleanupNative?.();
    if (
      error instanceof DirectRejectedError ||
      error instanceof DirectFallbackError ||
      error instanceof DirectUnsafeError
    )
      throw error;
    throw new DirectFallbackError(errorCode(error));
  }
}

async function attachDirect({
  nodeId,
  manifest,
  transportSessionId,
  live,
  peer,
  heartbeatMs,
  timeoutMs,
  terminalId,
  computer,
  afterSequence = 0,
  signal,
  beforeOpen,
  closeConnection,
  onRejected
}) {
  if (signal?.aborted) throw new DirectFallbackError('DIRECT_RACE_CANCELLED');
  let preparation;
  let terminalSessionId;
  let transport;
  try {
    preparation = live.request(
      {
        type: 'terminal.direct.prepare',
        requestId: requestId(),
        nodeId,
        nodeGeneration: manifest.nodeGeneration,
        transportSessionId,
        terminalId,
        ...(computer ? { computer: true } : {}),
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
    const terminalPrepared = await withTimeout(
      preparation,
      timeoutMs,
      'TERMINAL_DIRECT_PREPARE_FAILED',
      signal
    );
    terminalSessionId = terminalPrepared.directSessionId;
    const channel = peer.createDataChannel(`mar-terminal-${terminalSessionId}`, {
      unordered: false
    });
    transport = new DirectTerminalTransport({
      channel,
      live,
      transportSessionId,
      terminalSessionId,
      terminalId,
      heartbeatMs,
      closeConnection
    });
    if (beforeOpen) await beforeOpen();
    if (signal?.aborted) throw new DirectFallbackError('DIRECT_RACE_CANCELLED');
    await withTimeout(
      transport.waitForAttachment(terminalPrepared.grant),
      timeoutMs,
      'TERMINAL_DIRECT_TIMEOUT',
      signal
    );
    return transport;
  } catch (error) {
    const unsafeFallback = transport?.openSent === true;
    if (error instanceof DirectRejectedError) onRejected?.(error);
    if (transport !== undefined) await transport.cancelAndDispose();
    else if (terminalSessionId !== undefined)
      await cancelSession(live, 'terminal.direct.cancel', terminalSessionId);
    else {
      // Abort only this attach. Its bounded prepare wait can still receive a grant on the warm peer.
      void preparation?.then(
        ({ directSessionId }) => live.send({ type: 'terminal.direct.cancel', directSessionId }),
        () => undefined
      );
    }
    if (error instanceof DirectRejectedError) throw error;
    if (unsafeFallback) throw new DirectUnsafeError('DIRECT_OPEN_CANCEL_UNCONFIRMED');
    if (error instanceof DirectFallbackError || error instanceof DirectUnsafeError) throw error;
    throw new DirectFallbackError(errorCode(error));
  }
}

function requestId() {
  return randomUUID().replaceAll('-', '');
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
