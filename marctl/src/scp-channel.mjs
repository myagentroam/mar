import { MarctlError } from './errors.mjs';
import { CHUNK, WINDOW } from './scp-protocol.mjs';

const MAX_BUFFERED_BYTES = WINDOW * (CHUNK + 4) + 64;

export class ByteChannel {
  #buffer = Buffer.alloc(0);
  #waiting = [];
  #sending = new Map();
  #ended;
  #failure;
  #controller;

  constructor(send, controller) {
    this.#controller = controller;
    const signal = controller.signal;
    this.send = (bytes) => {
      if (this.#failure) throw this.#failure;
      if (this.#ended !== undefined) throw new MarctlError('Copy stream ended unexpectedly.');
      return new Promise((resolve, reject) => {
        this.#sending.set(reject, resolve);
        const settle = (complete, value) => {
          this.#sending.delete(reject);
          complete(value);
        };
        try {
          Promise.resolve(send(bytes)).then(
            (value) => settle(resolve, value),
            (error) => settle(reject, error)
          );
        } catch (error) {
          settle(reject, error);
        }
      });
    };
    if (signal) {
      if (signal.aborted) this.fail(signal.reason);
      else
        signal.addEventListener('abort', () => this.fail(signal.reason), {
          once: true
        });
    }
  }

  feed(bytes) {
    if (this.#failure) return;
    this.#buffer = Buffer.concat([this.#buffer, bytes]);
    if (this.#buffer.length > MAX_BUFFERED_BYTES)
      return this.fail(new MarctlError('Copy output exceeded the bounded window.'));
    this.#wake();
  }

  finish(code) {
    this.#ended = code;
    if (code !== 0) return this.fail(new MarctlError('Remote copy command failed.'));
    // A successful exit confirms the worker consumed its final protocol input.
    for (const resolve of this.#sending.values()) resolve();
    this.#sending.clear();
    this.#wake();
  }

  connectionEnded(error) {
    if (this.#ended === undefined) this.fail(error);
  }

  fail(error) {
    if (this.#failure !== undefined) return;
    this.#failure = error;
    for (const reject of this.#sending.keys()) reject(this.#failure);
    this.#sending.clear();
    this.#wake();
    // Any endpoint failure must wake reads and writes across the entire copy.
    this.#controller.abort(error);
  }

  #wake() {
    for (const resolve of this.#waiting.splice(0)) resolve();
  }

  async read(length) {
    if (this.#failure) throw this.#failure;
    while (this.#buffer.length < length) {
      if (this.#failure) throw this.#failure;
      if (this.#ended !== undefined) throw new MarctlError('Copy stream ended unexpectedly.');
      await new Promise((resolve) => this.#waiting.push(resolve));
    }
    const bytes = this.#buffer.subarray(0, length);
    this.#buffer = this.#buffer.subarray(length);
    return bytes;
  }

  async done() {
    if (this.#failure) throw this.#failure;
    while (this.#ended === undefined && this.#failure === undefined)
      await new Promise((resolve) => this.#waiting.push(resolve));
    if (this.#failure) throw this.#failure;
    if (this.#ended !== 0) throw new MarctlError('Remote copy command failed.');
  }
}
