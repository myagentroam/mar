import {
  BROWSER_FRAME_MAX_BYTES,
  encodeBrowserFrame,
  type BrowserFrame
} from '@myagentroam/protocol';

type Capture = Omit<BrowserFrame, 'sequence' | 'data' | 'key'> & { jpeg: Buffer };
type CloseReason =
  'BROWSER_FRAME_TIMEOUT' | 'BROWSER_FRAME_ENCODE_FAILED' | 'BROWSER_FRAME_TRANSPORT_FAILED';
type Flight = {
  sequence: number;
  finalChunkStarted: boolean;
  sent: boolean;
  acknowledged: boolean;
};

/** Owns frame credit and one latest pending capture for a single Node attachment.
 * The attachment owner closes the encoder on failure or detach. The sink owns
 * socket backpressure and must stop a blocked send on abort. This stream does
 * not start Playwright, own the encoder, or choose or reconnect a transport.
 */
export class BrowserFrameStream {
  private sequence = 0;
  private viewVersion = 0;
  private encodedView: number | undefined;
  private pending: Capture | undefined;
  private flight: Flight | undefined;
  private timeout: ReturnType<typeof setTimeout> | undefined;
  private readonly abort = new AbortController();

  constructor(
    private readonly options: {
      send: (chunk: Uint8Array, signal: AbortSignal) => Promise<void>;
      encode: (jpeg: Buffer, key: boolean) => Promise<Pick<BrowserFrame, 'data' | 'key'>>;
      failed: (reason: CloseReason) => void;
      deadlineMs: number;
    }
  ) {}

  setView(viewVersion: number): void {
    if (viewVersion === this.viewVersion) return;
    this.viewVersion = viewVersion;
    this.pending = undefined;
  }

  offer(capture: Capture): void {
    if (
      this.abort.signal.aborted ||
      capture.viewVersion !== this.viewVersion ||
      !capture.jpeg.byteLength
    )
      return;
    this.pending = capture;
    this.flush();
  }

  acknowledge(sequence: number): boolean {
    const flight = this.flight;
    if (!flight?.finalChunkStarted || flight.sequence !== sequence || flight.acknowledged)
      return false;
    flight.acknowledged = true;
    if (flight.sent) this.finish();
    return true;
  }

  close(): void {
    this.abort.abort();
    clearTimeout(this.timeout);
    this.pending = undefined;
    this.flight = undefined;
  }

  private flush(): void {
    if (this.flight !== undefined || this.pending === undefined || this.abort.signal.aborted)
      return;
    const capture = this.pending;
    this.pending = undefined;
    const flight = {
      sequence: ++this.sequence,
      finalChunkStarted: false,
      sent: false,
      acknowledged: false
    };
    this.flight = flight;
    this.timeout = setTimeout(() => this.fail('BROWSER_FRAME_TIMEOUT'), this.options.deadlineMs);
    this.timeout.unref();
    void this.encodeAndSend(capture, flight).then(
      () => {
        if (this.flight !== flight) return;
        flight.sent = true;
        if (flight.acknowledged) this.finish();
      },
      () => this.fail('BROWSER_FRAME_TRANSPORT_FAILED')
    );
  }

  private async encodeAndSend(capture: Capture, flight: Flight): Promise<void> {
    const { jpeg, ...view } = capture;
    const key = view.viewVersion !== this.encodedView;
    let encoded: Pick<BrowserFrame, 'data' | 'key'>;
    try {
      encoded = await this.options.encode(jpeg, key);
    } catch {
      this.fail('BROWSER_FRAME_ENCODE_FAILED');
      return;
    }
    if (this.flight !== flight) return;
    if (
      !encoded.data.byteLength ||
      encoded.data.byteLength > BROWSER_FRAME_MAX_BYTES ||
      (key && !encoded.key)
    ) {
      this.fail('BROWSER_FRAME_ENCODE_FAILED');
      return;
    }
    if (view.viewVersion !== this.viewVersion) {
      this.encodedView = undefined;
      this.finish();
      return;
    }
    this.encodedView = view.viewVersion;
    for (const { bytes, final } of encodeBrowserFrame({
      ...view,
      ...encoded,
      sequence: flight.sequence
    })) {
      this.abort.signal.throwIfAborted();
      flight.finalChunkStarted = final;
      await this.options.send(bytes, this.abort.signal);
    }
  }

  private finish(): void {
    clearTimeout(this.timeout);
    this.flight = undefined;
    this.flush();
  }

  private fail(reason: CloseReason): void {
    if (this.abort.signal.aborted) return;
    this.close();
    this.options.failed(reason);
  }
}
