import { EventEmitter } from 'node:events';
import { DirectFallbackError, DirectUnsafeError, directControlError } from './direct-errors.mjs';
import { cancelSession, withTimeout, rawToString, isRecord } from './direct-control.mjs';

export class DirectTerminalTransport extends EventEmitter {
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
    this.#live.send({
      type: 'direct.cancel',
      directSessionId: this.#transportSessionId,
      reason: 'CLI_CLOSED'
    });
  }
}
