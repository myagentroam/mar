const MAX_PENDING_BYTES = 2 * 1024 * 1024;
const MAX_SOCKET_BYTES = 256 * 1024;

/** Shared sender for CLI input and the Node's aggregate Terminal relay output. */
export class TerminalRelaySender {
  #socket;
  #onPendingChange;
  #pending = [];
  #pendingBytes = 0;
  #inFlight;
  #timer;
  #immediate;
  #closed = false;

  constructor(socket, { onPendingChange = () => {} } = {}) {
    this.#socket = socket;
    this.#onPendingChange = onPendingChange;
  }

  send(value, key = '') {
    if (this.#closed || this.#socket.readyState !== 1)
      return Promise.reject(new Error('TERMINAL_CONNECTION_LOST'));
    const bytes = Buffer.byteLength(value, 'utf8');
    if (this.#pendingBytes + bytes > MAX_PENDING_BYTES)
      return Promise.reject(
        Object.assign(new Error('TERMINAL_RELAY_BUFFER_EXCEEDED'), {
          code: 'TERMINAL_RELAY_BUFFER_EXCEEDED'
        })
      );
    const result = new Promise((resolve, reject) => {
      this.#pending.push({ value, key, bytes, resolve, reject });
      this.#pendingBytes += bytes;
    });
    this.#pump();
    this.#notify();
    return result;
  }

  cancel(key) {
    if (this.#inFlight?.key === key) {
      this.#inFlight.cancelled = true;
      this.#inFlight.reject(new Error('TERMINAL_ATTACH_INVALID'));
    }
    const kept = [];
    for (const item of this.#pending) {
      if (item.key !== key) kept.push(item);
      else {
        this.#pendingBytes -= item.bytes;
        item.reject(new Error('TERMINAL_ATTACH_INVALID'));
      }
    }
    this.#pending = kept;
    if (kept.length === 0) this.#clearScheduled();
    this.#notify();
  }

  close(error = new Error('TERMINAL_CONNECTION_LOST')) {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearScheduled();
    this.#inFlight?.reject(error);
    this.#inFlight = undefined;
    for (const item of this.#pending) item.reject(error);
    this.#pending = [];
    this.#pendingBytes = 0;
    this.#notify();
  }

  #pump() {
    if (
      this.#closed ||
      this.#inFlight !== undefined ||
      this.#timer !== undefined ||
      this.#immediate !== undefined ||
      this.#pending.length === 0
    )
      return;
    if (this.#socket.readyState !== 1) {
      this.close();
      return;
    }
    const buffered = this.#socket.bufferedAmount ?? 0;
    if (buffered > 0 && buffered + this.#pending[0].bytes > MAX_SOCKET_BYTES) {
      // Poll only while the transport is congested; there is no throughput timer.
      this.#timer = setTimeout(() => {
        this.#timer = undefined;
        this.#pump();
        this.#notify();
      }, 20);
      return;
    }
    const item = this.#pending.shift();
    this.#inFlight = item;
    try {
      this.#socket.send(item.value, (error) => {
        if (this.#inFlight !== item) return;
        if (error) {
          this.close(error);
          return;
        }
        this.#inFlight = undefined;
        this.#pendingBytes -= item.bytes;
        // Even a synchronous write callback must yield before the next frame.
        this.#immediate = setImmediate(() => {
          this.#immediate = undefined;
          this.#pump();
          this.#notify();
        });
        item.resolve();
        this.#notify();
      });
    } catch (error) {
      this.close(error);
    }
  }

  #notify() {
    const keys = new Set(this.#pending.map((item) => item.key));
    if (this.#inFlight !== undefined && !this.#inFlight.cancelled) keys.add(this.#inFlight.key);
    this.#onPendingChange(keys);
  }

  #clearScheduled() {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    clearImmediate(this.#immediate);
    this.#immediate = undefined;
  }
}
