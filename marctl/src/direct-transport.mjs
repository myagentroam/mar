import { EventEmitter } from 'node:events';
import { DirectFallbackError, directControlError } from './direct-errors.mjs';
import { isRecord } from './direct-control.mjs';
import { decodeTerminalMessage, encodeTerminalMessage } from '@myagentroam/protocol/byte-frame';

const BUFFER_LOW_BYTES = 256 * 1024;
const BUFFER_HIGH_BYTES = 512 * 1024;

export class DirectTerminalTransport extends EventEmitter {
  #channel;
  #live;
  #transportSessionId;
  #terminalSessionId;
  #terminalId;
  #closeConnection;
  #unsubscribeDisconnect;
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
  #draining;

  constructor({
    channel,
    live,
    transportSessionId,
    terminalSessionId,
    terminalId,
    heartbeatMs,
    closeConnection
  }) {
    super();
    this.#channel = channel;
    this.#live = live;
    this.#transportSessionId = transportSessionId;
    this.#terminalSessionId = terminalSessionId;
    this.#terminalId = terminalId;
    this.#closeConnection = closeConnection;
    this.#channel.onMessage?.((raw) => this.#handleMessage(raw));
    this.#channel.onClosed?.(() => this.#fail('TERMINAL_DIRECT_CLOSED'));
    this.#channel.onError?.(() => this.#fail('TERMINAL_CONNECTION_FAILED'));
    this.#channel.setBufferedAmountLowThreshold?.(BUFFER_LOW_BYTES);
    this.#channel.onBufferedAmountLow?.(() => {
      if (!this.#draining || this.#channel.bufferedAmount() > BUFFER_LOW_BYTES) return;
      this.#draining.resolve();
      this.#draining = undefined;
    });
    this.#unsubscribeLive = this.#live.onControl((message) => this.#handleControl(message));
    this.#unsubscribeDisconnect = this.#live.onDisconnect(() =>
      this.#fail('TERMINAL_CONNECTION_LOST')
    );
    this.#heartbeatTimer = setInterval(() => {
      if (
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
          this.#channel.sendMessageBinary(
            Buffer.from(
              encodeTerminalMessage({
                type: 'OPEN',
                directSessionId: this.#terminalSessionId,
                grant
              })
            )
          );
        } catch {
          this.#fail('TERMINAL_ATTACH_FAILED');
        }
      };
      this.#channel.onOpen?.(onOpen);
      if (this.#channel.isOpen?.() === true) onOpen();
    });
  }

  send(frame) {
    return this.sendEncoded(encodeTerminalMessage(frame));
  }

  async sendEncoded(frame) {
    while (this.#draining) await this.#draining.promise;
    if (this.#closed || this.#channel.isOpen?.() !== true)
      throw new Error('TERMINAL_CONNECTION_LOST');
    // Native send can return false after queueing the frame: wait for drain, never resend it.
    this.#channel.sendMessageBinary(Buffer.from(frame));
    if (this.#channel.bufferedAmount?.() > BUFFER_HIGH_BYTES && this.#channel.onBufferedAmountLow) {
      let resolve;
      const promise = new Promise((done) => {
        resolve = done;
      });
      this.#draining = { promise, resolve };
      await promise;
      if (this.#closed) throw new Error('TERMINAL_CONNECTION_LOST');
    }
  }

  close() {
    this.dispose();
  }

  dispose({ skipCancel = false } = {}) {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#heartbeatTimer);
    this.#draining?.resolve();
    this.#draining = undefined;
    if (!skipCancel) this.#sendCancel();
    this.#attachmentReject?.(new DirectFallbackError('TERMINAL_DIRECT_CLOSED'));
    this.#attachmentResolve = undefined;
    this.#attachmentReject = undefined;
    this.#unsubscribeLive?.();
    this.#unsubscribeLive = undefined;
    this.#channel.close?.();
    this.#unsubscribeDisconnect();
    this.#closeConnection?.();
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
    this.#sendCancel();
    await terminalClosed.catch(() => undefined);
    this.dispose({ skipCancel: true });
  }

  #handleMessage(raw) {
    if (this.#closed) return;
    if (!this.#attached) {
      let frame;
      try {
        frame = decodeTerminalMessage(raw);
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
    if (
      (message.type === 'terminal.direct.error' || message.type === 'terminal.direct.closed') &&
      message.directSessionId === this.#terminalSessionId
    )
      this.#fail(message.code);
    if (
      (message.type === 'direct.closed' || message.type === 'direct.error') &&
      message.directSessionId === this.#transportSessionId
    )
      this.#fail(message.code);
  }

  #fail(code) {
    if (this.#closed) return;
    const error = directControlError(code);
    if (!this.#attached) this.#attachmentReject?.(error);
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
  }
}
