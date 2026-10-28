import { DirectFallbackError, directControlError } from './direct-errors.mjs';

export class LiveControl {
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
        if (
          ((waiter.request?.type === 'terminal.direct.prepare' &&
            message.type === 'terminal.direct.error') ||
            (waiter.request?.type === 'direct.prepare' && message.type === 'direct.error')) &&
          message.requestId === waiter.request.requestId
        ) {
          this.#waiters.delete(waiter);
          clearTimeout(waiter.timer);
          waiter.reject(directControlError(message.code));
          continue;
        }
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

export async function cancelSession(live, type, directSessionId) {
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

export function withTimeout(promise, timeoutMs, code, signal) {
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

export function rawToString(raw) {
  if (typeof raw === 'string') return raw;
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
  if (ArrayBuffer.isView(raw))
    return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8');
  return String(raw);
}

export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
