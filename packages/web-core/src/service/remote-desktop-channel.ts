/**
 * Owns one already-authorized desktop data channel after its handshake owner
 * transfers it. noVNC is the only reader and closer; the shared peer connection
 * and authorization lifecycle remain with their respective owners.
 */
export class RemoteDesktopChannel {
  readonly protocol = '';
  readonly binaryType = 'arraybuffer';
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  #onmessage: ((event: MessageEvent<ArrayBuffer>) => void) | null = null;
  #incoming: ArrayBuffer[] = [];
  #incomingBytes = 0;
  #outgoing: Uint8Array<ArrayBuffer>[] = [];
  #outgoingBytes = 0;
  #closed = false;
  #drainTimer: ReturnType<typeof setTimeout> | undefined;
  #incomingScheduled = false;
  #receivedBytes = 0;
  #sentBytes = 0;

  constructor(
    private readonly channel: WebSocket | RTCDataChannel,
    private readonly options: {
      readonly preRead: readonly (ArrayBuffer | ArrayBufferView<ArrayBuffer>)[];
      readonly maxMessageBytes: number;
      readonly maxQueuedBytes: number;
      readonly highWaterBytes: number;
      readonly onFailure: (code: 'DESKTOP_BACKPRESSURE' | 'DESKTOP_TRANSPORT_ERROR') => void;
    }
  ) {
    if (
      !Number.isSafeInteger(options.maxMessageBytes) ||
      options.maxMessageBytes < 1 ||
      !Number.isSafeInteger(options.maxQueuedBytes) ||
      options.maxQueuedBytes < 1 ||
      !Number.isSafeInteger(options.highWaterBytes) ||
      options.highWaterBytes < options.maxMessageBytes ||
      (channel.readyState !== 'open' && channel.readyState !== 1)
    )
      throw new Error('Invalid or closed desktop channel.');
    channel.binaryType = 'arraybuffer';
    channel.addEventListener('message', this.#receive);
    channel.addEventListener('close', this.#remoteClose);
    channel.addEventListener('error', this.#error);
    for (const data of options.preRead) {
      if (!this.#enqueueIncoming(data)) break;
    }
  }

  get readyState(): 'open' | 'closed' {
    return this.#closed ? 'closed' : 'open';
  }

  getStatistics(): { receivedBytes: number; sentBytes: number } {
    return { receivedBytes: this.#receivedBytes, sentBytes: this.#sentBytes };
  }

  get onmessage(): ((event: MessageEvent<ArrayBuffer>) => void) | null {
    return this.#onmessage;
  }

  set onmessage(handler: ((event: MessageEvent<ArrayBuffer>) => void) | null) {
    this.#onmessage = handler;
    this.#scheduleIncoming();
  }

  send(data: ArrayBuffer | ArrayBufferView<ArrayBuffer>): void {
    if (this.#closed) throw new Error('Desktop channel is closed.');
    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (bytes.byteLength === 0) return;
    if (
      this.#outgoing.length === 0 &&
      bytes.byteLength <= this.options.maxMessageBytes &&
      this.channel.bufferedAmount + bytes.byteLength <= this.options.highWaterBytes
    ) {
      try {
        this.channel.send(bytes);
        this.#sentBytes += bytes.byteLength;
      } catch {
        this.#finish('DESKTOP_TRANSPORT_ERROR', true);
      }
      return;
    }
    if (this.#outgoingBytes + bytes.byteLength > this.options.maxQueuedBytes) {
      this.#finish('DESKTOP_BACKPRESSURE', true);
      return;
    }
    // noVNC reuses its send buffer as soon as this method returns. Copy each
    // retained chunk, including only the supplied view's effective range.
    for (let offset = 0; offset < bytes.byteLength; offset += this.options.maxMessageBytes) {
      const chunk = bytes.slice(offset, offset + this.options.maxMessageBytes);
      this.#outgoing.push(chunk);
      this.#outgoingBytes += chunk.byteLength;
    }
    this.#drain();
  }

  close(): void {
    this.#finish(undefined, true);
  }

  #receive = (event: Event): void => {
    const data = (event as MessageEvent<unknown>).data;
    if (!(data instanceof ArrayBuffer)) {
      this.#finish('DESKTOP_TRANSPORT_ERROR', true);
      return;
    }
    if (this.#enqueueIncoming(data)) this.#scheduleIncoming();
  };

  #enqueueIncoming(data: ArrayBuffer | ArrayBufferView<ArrayBuffer>): boolean {
    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (this.#incomingBytes + bytes.byteLength > this.options.maxQueuedBytes) {
      this.#finish('DESKTOP_BACKPRESSURE', true);
      return false;
    }
    // The previous owner may reuse a preread buffer; ownership must not alias it.
    this.#incoming.push(bytes.slice().buffer);
    this.#receivedBytes += bytes.byteLength;
    this.#incomingBytes += bytes.byteLength;
    return true;
  }

  #scheduleIncoming(): void {
    if (this.#incomingScheduled || this.#onmessage === null || this.#closed) return;
    this.#incomingScheduled = true;
    // noVNC sets onmessage before completing its already-open-channel setup.
    queueMicrotask(() => {
      this.#incomingScheduled = false;
      while (!this.#closed && this.#onmessage !== null && this.#incoming.length > 0) {
        const data = this.#incoming.shift()!;
        this.#incomingBytes -= data.byteLength;
        try {
          this.#onmessage(new MessageEvent('message', { data }));
        } catch (error) {
          const code =
            error instanceof Error && 'code' in error && error.code === 'DESKTOP_BACKPRESSURE'
              ? 'DESKTOP_BACKPRESSURE'
              : 'DESKTOP_TRANSPORT_ERROR';
          this.#finish(code, true);
        }
      }
    });
  }

  #drain(): void {
    while (!this.#closed && this.#outgoing.length > 0) {
      const chunk = this.#outgoing[0]!;
      if (this.channel.bufferedAmount + chunk.byteLength > this.options.highWaterBytes) break;
      try {
        this.channel.send(chunk);
        this.#sentBytes += chunk.byteLength;
      } catch {
        this.#finish('DESKTOP_TRANSPORT_ERROR', true);
        return;
      }
      this.#outgoing.shift();
      this.#outgoingBytes -= chunk.byteLength;
    }
    if (!this.#closed && this.#outgoing.length > 0 && this.#drainTimer === undefined) {
      this.#drainTimer = setTimeout(() => {
        this.#drainTimer = undefined;
        this.#drain();
      }, 20);
    }
  }

  #remoteClose = (): void => this.#finish('DESKTOP_TRANSPORT_ERROR', false);
  #error = (): void => this.#finish('DESKTOP_TRANSPORT_ERROR', true);

  #finish(
    code: 'DESKTOP_BACKPRESSURE' | 'DESKTOP_TRANSPORT_ERROR' | undefined,
    close: boolean
  ): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#drainTimer !== undefined) clearTimeout(this.#drainTimer);
    this.#incoming = [];
    this.#outgoing = [];
    this.#incomingBytes = this.#outgoingBytes = 0;
    this.channel.removeEventListener('message', this.#receive);
    this.channel.removeEventListener('close', this.#remoteClose);
    this.channel.removeEventListener('error', this.#error);
    if (close) this.channel.close();
    if (code !== undefined) this.options.onFailure(code);
    queueMicrotask(() => this.onclose?.({ wasClean: code === undefined } as CloseEvent));
  }
}
