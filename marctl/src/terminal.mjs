import { EventEmitter } from 'node:events';
import { MarctlError } from './config.mjs';
import { createTranslator } from './i18n/index.mjs';
import { TerminalRelaySender } from './terminal-relay-sender.mjs';

const MAX_INPUT_BYTES = 65536;
const DEFAULT_ROWS = 24;
const DEFAULT_COLS = 80;
const DEFAULT_CONNECTION_TIMEOUT_MS = 15000;

export async function runTerminalSession({
  client,
  WebSocketClass,
  nodeId,
  command,
  binary = false,
  attached,
  stdin = process.stdin,
  stdout = process.stdout,
  signals = process,
  translate = createTranslator(),
  connectionTimeoutMs = DEFAULT_CONNECTION_TIMEOUT_MS,
  openDirectTerminal: openDirectTerminalImpl,
  raceConnections = false
}) {
  const dimensions = getDimensions(stdout);
  let terminalId;
  let transport;
  let result;
  let primaryError;
  let manifest;

  try {
    if (binary) {
      if (command === undefined)
        throw new MarctlError(translate('errors.terminalBinaryUnavailable'));
      manifest = await client.getTerminalManifest(nodeId);
      if (manifest?.binaryTerminal !== true)
        throw new MarctlError(translate('errors.terminalBinaryUnavailable'));
    }
    const created = await client.createTerminal({
      nodeId,
      ...dimensions,
      ...(command === undefined ? {} : { command }),
      ...(binary ? { binary: true } : {})
    });
    terminalId = binary ? created?.terminalId : created;
    if (binary && created?.binary !== true)
      throw new MarctlError(translate('errors.terminalBinaryUnavailable'));
    try {
      const openDirectTerminal =
        openDirectTerminalImpl ?? (await import('./direct.mjs')).openDirectTerminal;
      if (raceConnections && manifest === undefined)
        manifest = await client.getTerminalManifest(nodeId).catch(() => undefined);
      const directOptions = {
        client,
        WebSocketClass,
        nodeId,
        terminalId,
        manifest,
        afterSequence: 0,
        timeoutMs: connectionTimeoutMs
      };
      const canRace = raceConnections && manifest?.deferredRelay === true;
      transport = canRace
        ? await raceTerminalConnections({
            openDirectTerminal,
            directOptions,
            client,
            WebSocketClass,
            nodeId,
            terminalId,
            translate,
            connectionTimeoutMs
          })
        : await openDirectTerminal(directOptions);
      result =
        attached === undefined
          ? await runAttachedTerminal({
              transport,
              terminalId,
              commandMode: command !== undefined,
              stdin,
              stdout,
              signals,
              translate
            })
          : await attached({ transport, terminalId, translate });
    } catch (error) {
      if (error?.name === 'DirectUnsafeError')
        throw new MarctlError(translate('errors.terminalDirectUnsafeFallback'));
      if (error?.name !== 'DirectFallbackError') throw error;
      transport = await openRelayTransport({
        client,
        WebSocketClass,
        nodeId,
        terminalId,
        translate,
        connectionTimeoutMs
      });
      result =
        attached === undefined
          ? await runAttachedTerminal({
              transport,
              terminalId,
              commandMode: command !== undefined,
              stdin,
              stdout,
              signals,
              translate
            })
          : await attached({ transport, terminalId, translate });
    }
  } catch (error) {
    primaryError = toMarctlError(error, translate);
  } finally {
    transport?.close?.();
    if (terminalId !== undefined) {
      try {
        await client.deleteTerminal({ nodeId, terminalId });
      } catch {
        if (primaryError === undefined && result === undefined)
          primaryError = new MarctlError(translate('errors.terminalCloseFailed'));
      }
    }
  }

  if (primaryError !== undefined) throw primaryError;
  return result;
}

async function raceTerminalConnections({
  openDirectTerminal,
  directOptions,
  client,
  WebSocketClass,
  nodeId,
  terminalId,
  translate,
  connectionTimeoutMs
}) {
  const abort = new AbortController();
  const relayAbort = new AbortController();
  const preparing = new Set(['direct', 'relay']);
  let start;
  const preparation = new Promise((resolve) => {
    start = resolve;
  });
  const prepared = (candidate) => {
    preparing.delete(candidate);
    if (preparing.size === 0) start();
    return preparation;
  };
  let selected;
  let announce;
  const first = new Promise((resolve) => {
    announce = resolve;
  });
  const select = (candidate) => {
    if (selected) return false;
    selected = candidate;
    announce(candidate);
    if (candidate === 'relay') abort.abort();
    else relayAbort.abort();
    return true;
  };
  const direct = openDirectTerminal({
    ...directOptions,
    signal: abort.signal,
    onPrepared: () => prepared('direct'),
    onIceConnected: () => {
      if (!select('direct')) throw new Error('DIRECT_RACE_CANCELLED');
    },
    onTransportReady: () => {
      if (selected !== 'direct') throw new Error('DIRECT_RACE_CANCELLED');
    }
  }).then(
    (value) => ({ value }),
    (error) => {
      prepared('direct');
      return { error };
    }
  );
  const relay = prepareRelayTransport({
    client,
    WebSocketClass,
    nodeId,
    terminalId,
    translate,
    connectionTimeoutMs,
    signal: relayAbort.signal,
    onPrepared: () => prepared('relay')
  }).then(
    (value) => {
      if (!select('relay')) value.close();
      return { value };
    },
    (error) => {
      prepared('relay');
      return { error };
    }
  );
  const winner = await Promise.race([
    first,
    Promise.all([direct, relay]).then(() => selected ?? 'none')
  ]);
  if (winner === 'direct') {
    const result = await direct;
    if (result.error) throw result.error;
    return result.value;
  }
  if (winner === 'relay') {
    const result = await relay;
    if (result.error) throw result.error;
    return result.value.activate();
  }
  const [directResult, relayResult] = await Promise.all([direct, relay]);
  throw relayResult.error ?? directResult.error;
}

export function splitInput(text, maxBytes = MAX_INPUT_BYTES) {
  const value = Buffer.isBuffer(text) ? text.toString('utf8') : String(text);
  const chunks = [];
  let chunk = '';
  let chunkBytes = 0;

  for (const character of value) {
    const characterBytes = Buffer.byteLength(character);
    if (chunk !== '' && chunkBytes + characterBytes > maxBytes) {
      chunks.push(chunk);
      chunk = '';
      chunkBytes = 0;
    }
    if (characterBytes > maxBytes) continue;
    chunk += character;
    chunkBytes += characterBytes;
  }
  if (chunk !== '') chunks.push(chunk);
  return chunks;
}

function getDimensions(stdout) {
  const rows = Number.isSafeInteger(stdout.rows) && stdout.rows > 0 ? stdout.rows : DEFAULT_ROWS;
  const cols =
    Number.isSafeInteger(stdout.columns) && stdout.columns > 0 ? stdout.columns : DEFAULT_COLS;
  return { rows: Math.min(rows, 1000), cols: Math.min(cols, 1000) };
}

async function openRelayTransport({
  client,
  WebSocketClass,
  nodeId,
  terminalId,
  translate,
  connectionTimeoutMs
}) {
  const ticket = await client.createAttachTicket({ nodeId, terminalId });
  const socket = client.openTerminalWebSocket(WebSocketClass, { terminalId, ticket });
  const transport = new BufferedRelayTransport({
    socket,
    terminalId,
    translate,
    connectionTimeoutMs
  });
  try {
    await transport.waitForAttachment();
    return transport;
  } catch (error) {
    transport.close();
    throw error;
  }
}

async function prepareRelayTransport({
  client,
  WebSocketClass,
  nodeId,
  terminalId,
  translate,
  connectionTimeoutMs,
  signal,
  onPrepared
}) {
  const ticket = await client.createAttachTicket({ nodeId, terminalId });
  if (onPrepared) await onPrepared();
  if (signal?.aborted) throw new MarctlError(translate('errors.terminalAttachConnection'));
  const socket = client.openTerminalWebSocket(WebSocketClass, {
    terminalId,
    ticket,
    deferred: true
  });
  // Keep an error listener after readiness until the socket is discarded.
  socket.on('error', () => {});
  let activated = false;
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => fail(), connectionTimeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeListener?.('message', onMessage);
      socket.removeListener?.('error', fail);
      socket.removeListener?.('close', fail);
      signal?.removeEventListener('abort', fail);
    };
    const fail = () => {
      cleanup();
      try {
        socket.close();
      } catch {
        /* Connection not yet established. */
      }
      reject(new MarctlError(translate('errors.terminalAttachConnection')));
    };
    const onMessage = (raw) => {
      let frame;
      try {
        frame = JSON.parse(String(raw));
      } catch {
        return fail();
      }
      if (frame?.type !== 'ready' || frame.terminalId !== terminalId) return fail();
      cleanup();
      resolve();
    };
    socket.on('message', onMessage);
    socket.on('error', fail);
    socket.on('close', fail);
    signal?.addEventListener('abort', fail, { once: true });
    if (signal?.aborted) fail();
  });
  await ready;
  return {
    async activate() {
      if (activated || socket.readyState !== 1)
        throw new MarctlError(translate('errors.terminalAttachConnection'));
      activated = true;
      const transport = new BufferedRelayTransport({
        socket,
        terminalId,
        translate,
        connectionTimeoutMs
      });
      try {
        socket.send(JSON.stringify({ type: 'activate', terminalId }));
        await transport.waitForAttachment();
        return transport;
      } catch (error) {
        transport.close();
        throw error;
      }
    },
    close() {
      socket.close();
    }
  };
}

class BufferedRelayTransport extends EventEmitter {
  #socket;
  #sender;
  #terminalId;
  #translate;
  #attached = false;
  #active = false;
  #pendingEvents = [];
  #attachmentResolve;
  #attachmentReject;
  #openTimer;
  #attachTimer;
  #closed = false;
  #onOpen;
  #onMessage;
  #onError;
  #onClose;

  constructor({ socket, terminalId, translate, connectionTimeoutMs }) {
    super();
    this.#socket = socket;
    this.#sender = new TerminalRelaySender(socket);
    this.#terminalId = terminalId;
    this.#translate = translate;
    this.#onOpen = () => {
      clearTimeout(this.#openTimer);
      this.#armAttachTimer(connectionTimeoutMs);
    };
    this.#onMessage = (raw, isBinary) => {
      try {
        const frame = parseFrame(raw, isBinary, this.#terminalId, this.#translate);
        if (!this.#attached) {
          if (frame.type === 'attach') {
            this.#attached = true;
            clearTimeout(this.#attachTimer);
            this.#attachmentResolve?.();
            this.#attachmentResolve = undefined;
            this.#attachmentReject = undefined;
            return;
          }
          if (frame.type === 'error')
            throw new MarctlError(this.#translate('errors.terminalRemoteError'));
          this.#queueOrEmit('message', raw, isBinary);
          return;
        }
        this.#queueOrEmit('message', raw, isBinary);
      } catch (error) {
        this.#fail(
          error instanceof MarctlError
            ? error
            : new MarctlError(this.#translate('errors.terminalFrameInvalid'))
        );
      }
    };
    this.#onError = () => {
      const error = new MarctlError(
        this.#translate(
          this.#attached ? 'errors.terminalConnectionFailed' : 'errors.terminalAttachConnection'
        )
      );
      if (this.#attached) this.#queueOrEmit('error', error);
      else this.#fail(error);
    };
    this.#onClose = () => {
      this.#sender.close();
      const error = new MarctlError(
        this.#translate(
          this.#attached ? 'errors.terminalConnectionLost' : 'errors.terminalAttachLost'
        )
      );
      if (this.#attached) this.#queueOrEmit('close');
      else this.#fail(error);
    };

    socket.on?.('open', this.#onOpen);
    socket.on?.('message', this.#onMessage);
    socket.on?.('error', this.#onError);
    socket.on?.('close', this.#onClose);
    if (socket.readyState === 1) this.#onOpen();
    else
      this.#openTimer = setTimeout(
        () => this.#fail(new MarctlError(this.#translate('errors.terminalConnectionOpen'))),
        connectionTimeoutMs
      );
  }

  waitForAttachment() {
    return new Promise((resolve, reject) => {
      if (this.#closed) {
        reject(new MarctlError(this.#translate('errors.terminalAttachLost')));
        return;
      }
      this.#attachmentResolve = resolve;
      this.#attachmentReject = reject;
      if (this.#attached) {
        this.#attachmentResolve = undefined;
        this.#attachmentReject = undefined;
        resolve();
      }
    });
  }

  activate() {
    if (this.#active) return;
    this.#active = true;
    const pendingEvents = this.#pendingEvents;
    this.#pendingEvents = [];
    for (const { type, args } of pendingEvents) this.emit(type, ...args);
  }

  get readyState() {
    return this.#socket.readyState;
  }

  send(value) {
    if (this.#closed) throw new Error('TERMINAL_CONNECTION_LOST');
    if (JSON.parse(value).type === 'input') return this.#sender.send(value);
    this.#socket.send(value);
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#sender.close();
    clearTimeout(this.#openTimer);
    clearTimeout(this.#attachTimer);
    this.#socket.removeListener?.('open', this.#onOpen);
    this.#socket.removeListener?.('message', this.#onMessage);
    this.#socket.removeListener?.('error', this.#onError);
    this.#socket.removeListener?.('close', this.#onClose);
    try {
      this.#socket.close();
    } catch {
      // The connection is already unavailable.
    }
  }

  #armAttachTimer(connectionTimeoutMs) {
    if (this.#attached) return;
    this.#attachTimer = setTimeout(
      () => this.#fail(new MarctlError(this.#translate('errors.terminalAttachTimeout'))),
      connectionTimeoutMs
    );
  }

  #fail(error) {
    if (this.#closed) return;
    clearTimeout(this.#openTimer);
    clearTimeout(this.#attachTimer);
    this.#attachmentResolve = undefined;
    const reject = this.#attachmentReject;
    this.#attachmentReject = undefined;
    if (!this.#attached) reject?.(error);
    else this.#queueOrEmit('error', error);
  }

  #queueOrEmit(type, ...args) {
    if (this.#active) {
      if (type !== 'error' || this.listenerCount('error') > 0) this.emit(type, ...args);
      return;
    }
    this.#pendingEvents.push({ type, args });
  }
}

function runAttachedTerminal({
  transport,
  terminalId,
  commandMode,
  stdin,
  stdout,
  signals,
  translate
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let inputEnabled = false;
    let rawModeEnabled = false;
    let inputTasks = 0;

    const cleanup = () => {
      transport.removeListener?.('message', onMessage);
      transport.removeListener?.('error', onError);
      transport.removeListener?.('close', onClose);
      stdin.removeListener?.('data', onInput);
      stdout.removeListener?.('resize', onResize);
      signals.removeListener?.('SIGINT', onSigint);
      signals.removeListener?.('SIGTERM', onSigterm);
      if (rawModeEnabled) {
        try {
          stdin.setRawMode(false);
        } catch {
          // The terminal may already be gone.
        }
      }
      stdin.pause?.();
    };

    const finish = (error, exitCode) => {
      if (settled) return;
      settled = true;
      cleanup();
      sendCloseFrame(transport, terminalId);
      transport.close?.();
      if (error === undefined) resolve(exitCode);
      else reject(error);
    };
    const fail = (key) => finish(new MarctlError(translate(key)));
    const send = (frame) => {
      return transport.send(JSON.stringify(frame));
    };
    const onInput = async (data) => {
      inputTasks += 1;
      stdin.pause?.();
      try {
        for (const chunk of splitInput(data)) {
          if (settled) return;
          await send({ type: 'input', terminalId, data: chunk });
        }
      } catch {
        fail('errors.terminalInputFailed');
      } finally {
        inputTasks -= 1;
        if (!settled && inputTasks === 0) stdin.resume?.();
      }
    };
    const onResize = () => {
      try {
        const { rows, cols } = getDimensions(stdout);
        Promise.resolve(send({ type: 'resize', terminalId, rows, cols })).catch(() =>
          fail('errors.terminalResizeFailed')
        );
      } catch {
        fail('errors.terminalResizeFailed');
      }
    };
    const onMessage = (raw, isBinary) => {
      try {
        const frame = parseFrame(raw, isBinary, terminalId, translate);
        if (frame.type === 'output') stdout.write(frame.data);
        else if (frame.type === 'exit') {
          finish(undefined, frame.exitCode === null ? 1 : frame.exitCode);
        } else if (frame.type === 'error') fail('errors.terminalRemoteError');
        else fail('errors.terminalUnexpectedFrame');
      } catch (error) {
        finish(
          error instanceof MarctlError
            ? error
            : new MarctlError(translate('errors.terminalFrameInvalid'))
        );
      }
    };
    const onError = () => finish(new MarctlError(translate('errors.terminalConnectionFailed')));
    const onClose = () => finish(new MarctlError(translate('errors.terminalConnectionLost')));
    const onSigint = () => finish(undefined, 130);
    const onSigterm = () => finish(undefined, 143);
    const startInput = () => {
      if (settled || inputEnabled) return;
      inputEnabled = true;
      try {
        if (!commandMode) {
          if (typeof stdin.setRawMode !== 'function') {
            fail('errors.terminalInteractiveRequired');
            return;
          }
          stdin.setRawMode(true);
          rawModeEnabled = true;
        }
        stdin.resume?.();
        stdin.on?.('data', onInput);
        stdout.on?.('resize', onResize);
        onResize();
      } catch {
        fail(commandMode ? 'errors.terminalSessionFailed' : 'errors.terminalInteractiveInit');
      }
    };
    transport.on?.('message', onMessage);
    transport.on?.('error', onError);
    transport.on?.('close', onClose);
    signals.on?.('SIGINT', onSigint);
    signals.on?.('SIGTERM', onSigterm);
    transport.activate?.();
    startInput();
  });
}

export function parseFrame(raw, isBinary, terminalId, translate) {
  if (isBinary) throw new MarctlError(translate('errors.terminalBinaryFrame'));
  let frame;
  try {
    frame = JSON.parse(rawToString(raw));
  } catch {
    throw new MarctlError(translate('errors.terminalInvalidJson'));
  }
  if (frame === null || typeof frame !== 'object' || frame.terminalId !== terminalId)
    throw new MarctlError(translate('errors.terminalFrameInvalid'));

  if (frame.type === 'attach') {
    if (!Number.isSafeInteger(frame.afterSequence) || frame.afterSequence < 0)
      throw new MarctlError(translate('errors.terminalFrameInvalid'));
    return frame;
  }
  if (frame.type === 'output') {
    if (
      !Number.isSafeInteger(frame.sequence) ||
      frame.sequence < 1 ||
      typeof frame.data !== 'string' ||
      Buffer.byteLength(frame.data) > MAX_INPUT_BYTES
    )
      throw new MarctlError(translate('errors.terminalFrameInvalid'));
    return frame;
  }
  if (frame.type === 'exit') {
    if (frame.exitCode !== null && !Number.isSafeInteger(frame.exitCode))
      throw new MarctlError(translate('errors.terminalFrameInvalid'));
    return frame;
  }
  if (frame.type === 'error' && typeof frame.code === 'string' && frame.code.length > 0)
    return frame;
  throw new MarctlError(translate('errors.terminalFrameInvalid'));
}

function rawToString(raw) {
  if (typeof raw === 'string') return raw;
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
  if (ArrayBuffer.isView(raw))
    return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8');
  return String(raw);
}

function sendCloseFrame(socket, terminalId) {
  if (!terminalId || !isSocketOpen(socket)) return;
  try {
    Promise.resolve(socket.send(JSON.stringify({ type: 'close', terminalId }))).catch(() => {});
  } catch {
    // The DELETE request below remains the authoritative cleanup path.
  }
}

function isSocketOpen(socket) {
  return socket.readyState === undefined || socket.readyState === 1;
}

function toMarctlError(error, translate) {
  return error instanceof MarctlError
    ? error
    : new MarctlError(translate('errors.terminalSessionFailed'));
}
