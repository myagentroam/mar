import { WebSocket, type RawData } from 'ws';

type Frame = Readonly<{ data: RawData; binary: boolean }>;
type End = 'browser' | 'node';

/**
 * Owns exactly one already-authenticated, already-paused socket pair. The
 * authorization/pairing owner must remove its readers before this handoff;
 * this class only forwards opaque ordered frames and never settles admission.
 */
export class RemoteDesktopRelayPair {
  readonly #pending = { browser: 0, node: 0 };
  #closed = false;

  constructor(
    private readonly browser: WebSocket,
    private readonly node: WebSocket,
    private readonly options: {
      readonly maxFrameBytes: number;
      readonly maxInFlightBytes: number;
      readonly browserPreRead: readonly Frame[];
      readonly nodePreRead: readonly Frame[];
      readonly onClosed: () => void;
    }
  ) {
    if (
      browser === node ||
      browser.readyState !== WebSocket.OPEN ||
      node.readyState !== WebSocket.OPEN ||
      !Number.isSafeInteger(options.maxFrameBytes) ||
      options.maxFrameBytes < 1 ||
      !Number.isSafeInteger(options.maxInFlightBytes) ||
      options.maxInFlightBytes < options.maxFrameBytes
    )
      throw new Error('Invalid desktop relay pair.');
    browser.on('message', this.#fromBrowser);
    node.on('message', this.#fromNode);
    browser.on('close', this.#closedByPeer);
    node.on('close', this.#closedByPeer);
    browser.on('error', this.#failed);
    node.on('error', this.#failed);
    for (const frame of options.browserPreRead) this.#forward('node', frame.data, frame.binary);
    for (const frame of options.nodePreRead) this.#forward('browser', frame.data, frame.binary);
    if (!this.#closed) {
      browser.resume();
      node.resume();
    }
  }

  close(): void {
    this.#finish();
  }

  readonly #fromBrowser = (data: RawData, binary: boolean): void =>
    this.#forward('node', data, binary);
  readonly #fromNode = (data: RawData, binary: boolean): void =>
    this.#forward('browser', data, binary);
  readonly #closedByPeer = (): void => this.#finish();
  readonly #failed = (): void => this.#finish();

  #forward(target: End, data: RawData, binary: boolean): void {
    if (this.#closed) return;
    const socket = target === 'node' ? this.node : this.browser;
    const size = Array.isArray(data)
      ? data.reduce((total, chunk) => total + chunk.byteLength, 0)
      : data.byteLength;
    const charge = Math.max(size, Math.min(256, this.options.maxFrameBytes));
    if (
      size > this.options.maxFrameBytes ||
      this.#pending[target] + charge > this.options.maxInFlightBytes ||
      socket.readyState !== WebSocket.OPEN
    )
      return this.#finish();
    // The sender may reuse a view as soon as this callback returns.
    const bytes = Array.isArray(data)
      ? Buffer.concat(data, size)
      : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
    this.#pending[target] += charge;
    try {
      socket.send(bytes, { binary }, (error) => {
        this.#pending[target] -= charge;
        if (error) this.#finish();
      });
    } catch {
      this.#pending[target] -= charge;
      this.#finish();
    }
  }

  #finish(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.browser.off('message', this.#fromBrowser);
    this.node.off('message', this.#fromNode);
    for (const socket of [this.browser, this.node]) {
      socket.off('close', this.#closedByPeer);
      socket.off('error', this.#failed);
      if (socket.readyState !== WebSocket.CLOSED) {
        const ignoreError = () => {};
        socket.on('error', ignoreError);
        socket.once('close', () => socket.off('error', ignoreError));
        socket.terminate();
      }
    }
    this.options.onClosed();
  }
}
