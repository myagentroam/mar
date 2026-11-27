import { EventEmitter } from 'node:events';
import { MarctlError } from './errors.mjs';
import { TerminalRelaySender } from './terminal-relay-sender.mjs';
import { parseFrame } from './terminal-frame.mjs';
import { encodeTerminalMessage } from '@myagentroam/protocol/byte-frame';

export async function attachTerminalSocket({
  socket,
  terminalId,
  translate,
  connectionTimeoutMs,
  signal
}) {
  const transport = new BufferedTerminalEndpoint({
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

async function waitForAttachment(transport, signal) {
  if (!signal) return transport.waitForAttachment();
  if (signal.aborted) throw signal.reason;
  let cancel;
  const cancelled = new Promise((_, reject) => {
    cancel = () => {
      transport.close();
      reject(signal.reason);
    };
    signal.addEventListener('abort', cancel, { once: true });
  });
  try {
    return await Promise.race([transport.waitForAttachment(), cancelled]);
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

/** Buffers task records across the local IPC attachment handoff, not across Node reconnects. */
class BufferedTerminalEndpoint extends EventEmitter {
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
            throw new MarctlError(this.#translate('errors.terminalRemoteError'), {
              code: frame.code
            });
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

  send(frame) {
    if (this.#closed) throw new Error('TERMINAL_CONNECTION_LOST');
    const value = encodeTerminalMessage(frame);
    if (frame.type === 'input' || frame.type === 'eof') return this.#sender.send(value);
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
