import { EventEmitter } from 'node:events';
import { MarctlError } from './errors.mjs';
import { TerminalRelaySender } from './terminal-relay-sender.mjs';
import { parseFrame } from './terminal-frame.mjs';
import { DirectFallbackError } from './direct-errors.mjs';

export async function openRelayTransport({
  client,
  WebSocketClass,
  nodeId,
  terminalId,
  translate,
  connectionTimeoutMs,
  signal
}) {
  const ticket = await client.createAttachTicket({ nodeId, terminalId });
  if (signal?.aborted) throw new DirectFallbackError('DIRECT_RACE_CANCELLED');
  const socket = client.openTerminalWebSocket(WebSocketClass, { terminalId, ticket });
  const transport = new BufferedRelayTransport({
    socket,
    terminalId,
    translate,
    connectionTimeoutMs
  });
  try {
    await waitForAttachment(transport, signal);
    return transport;
  } catch (error) {
    transport.close();
    throw error;
  }
}

export async function prepareRelayTransport({
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
    async activate(signal) {
      if (signal?.aborted) {
        socket.close();
        throw new DirectFallbackError('DIRECT_RACE_CANCELLED');
      }
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
        await waitForAttachment(transport, signal);
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

async function waitForAttachment(transport, signal) {
  if (!signal) return transport.waitForAttachment();
  if (signal.aborted) throw new DirectFallbackError('DIRECT_RACE_CANCELLED');
  let cancel;
  const cancelled = new Promise((_, reject) => {
    cancel = () => {
      transport.close();
      reject(new DirectFallbackError('DIRECT_RACE_CANCELLED'));
    };
    signal.addEventListener('abort', cancel, { once: true });
  });
  try {
    return await Promise.race([transport.waitForAttachment(), cancelled]);
  } finally {
    signal.removeEventListener('abort', cancel);
  }
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
    this.#attachmentReject?.(new MarctlError(this.#translate('errors.terminalAttachLost')));
    this.#attachmentReject = undefined;
    this.#attachmentResolve = undefined;
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
