import {
  BROWSER_FRAME_MAX_BYTES,
  encodeBrowserFrame,
  type BrowserFrame
} from '@myagentroam/protocol';
import { BrowserFrameRate } from './browser-frame-rate.js';

type Capture = Omit<BrowserFrame, 'sequence' | 'data' | 'key'> & { jpeg: Buffer };
type Profile = BrowserFrameRate['profile'];
type CloseReason =
  'BROWSER_FRAME_TIMEOUT' | 'BROWSER_FRAME_ENCODE_FAILED' | 'BROWSER_FRAME_TRANSPORT_FAILED';
type Flight = {
  sequence: number;
  viewVersion: number;
  finalChunkStarted: boolean;
  bytes: number;
  firstWriteAt?: number;
  sentAt?: number;
  acknowledgedAt?: number;
};

/** Owns frame credit, pacing and one latest pending capture for a Node attachment.
 * The attachment owner closes the encoder on failure or detach. The sink owns
 * socket backpressure and must stop a blocked send on abort. This stream does
 * not start Playwright, own the encoder, or choose or reconnect a transport.
 */
export class BrowserFrameStream {
  private sequence = 0;
  private viewVersion = 0;
  private encodedView: number | undefined;
  private encodedProfile: Profile | undefined;
  private pending: Capture | undefined;
  private flight: Flight | undefined;
  private lastStartedAt = 0;
  private pacing: ReturnType<typeof setTimeout> | undefined;
  private timeout: ReturnType<typeof setTimeout> | undefined;
  private readonly rate: BrowserFrameRate;
  private readonly abort = new AbortController();

  constructor(
    private readonly options: {
      send: (chunk: Uint8Array, signal: AbortSignal) => Promise<void>;
      encode: (
        jpeg: Buffer,
        key: boolean,
        viewport: Pick<BrowserFrame, 'width' | 'height'>,
        profile: Profile
      ) => Promise<Pick<BrowserFrame, 'data' | 'key'>>;
      failed: (reason: CloseReason) => void;
      deadlineMs: number;
      hd?: boolean;
      rasterChanged?: () => void;
    }
  ) {
    this.rate = new BrowserFrameRate(options.hd);
  }

  get hd(): boolean {
    return this.rate.profile.hd;
  }

  setView(viewVersion: number): void {
    if (viewVersion === this.viewVersion) return;
    this.viewVersion = viewVersion;
    this.resetRaster();
  }

  /** Raster transitions happen at returned credit, before another encode starts. */
  resetRaster(): void {
    this.encodedView = undefined;
    this.pending = undefined;
    clearTimeout(this.pacing);
    this.pacing = undefined;
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

  acknowledge(sequence: number): number | undefined {
    const flight = this.flight;
    if (
      !flight?.finalChunkStarted ||
      flight.sequence !== sequence ||
      flight.acknowledgedAt !== undefined
    )
      return undefined;
    flight.acknowledgedAt = performance.now();
    if (flight.sentAt !== undefined) this.finish();
    return flight.viewVersion;
  }

  close(): void {
    this.abort.abort();
    clearTimeout(this.timeout);
    clearTimeout(this.pacing);
    this.pending = undefined;
    this.flight = undefined;
  }

  private flush(): void {
    if (this.flight || !this.pending || this.pacing || this.abort.signal.aborted) return;
    const now = performance.now();
    const profile = this.rate.profile;
    const wait = this.lastStartedAt + 1000 / profile.fps - now;
    if (this.encodedView === this.pending.viewVersion && wait > 0) {
      this.pacing = setTimeout(() => {
        this.pacing = undefined;
        this.flush();
      }, Math.ceil(wait));
      this.pacing.unref();
      return;
    }
    const capture = this.pending;
    this.pending = undefined;
    const flight: Flight = {
      sequence: ++this.sequence,
      viewVersion: capture.viewVersion,
      finalChunkStarted: false,
      bytes: 0
    };
    this.flight = flight;
    this.lastStartedAt = now;
    this.timeout = setTimeout(() => this.fail('BROWSER_FRAME_TIMEOUT'), this.options.deadlineMs);
    this.timeout.unref();
    void this.encodeAndSend(capture, flight, profile).then(
      () => {
        if (this.flight !== flight) return;
        flight.sentAt = performance.now();
        if (flight.acknowledgedAt !== undefined) this.finish();
      },
      () => this.fail('BROWSER_FRAME_TRANSPORT_FAILED')
    );
  }

  private async encodeAndSend(capture: Capture, flight: Flight, profile: Profile): Promise<void> {
    const { jpeg, ...view } = capture;
    const key = view.viewVersion !== this.encodedView || profile !== this.encodedProfile;
    let encoded: Pick<BrowserFrame, 'data' | 'key'>;
    try {
      encoded = await this.options.encode(jpeg, key, view, profile);
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
    this.encodedProfile = profile;
    flight.bytes = encoded.data.byteLength;
    flight.firstWriteAt = performance.now();
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
    const flight = this.flight;
    if (
      flight?.viewVersion === this.viewVersion &&
      flight.firstWriteAt !== undefined &&
      flight.sentAt !== undefined &&
      flight.acknowledgedAt !== undefined
    ) {
      const completedAt = Math.max(flight.sentAt, flight.acknowledgedAt);
      const hd = this.hd;
      this.rate.record(
        {
          bytes: flight.bytes,
          writeMs: flight.sentAt - flight.firstWriteAt,
          confirmedMs: completedAt - flight.firstWriteAt
        },
        completedAt
      );
      if (hd !== this.hd) this.options.rasterChanged?.();
    }
    this.flight = undefined;
    this.flush();
  }

  private fail(reason: CloseReason): void {
    if (this.abort.signal.aborted) return;
    this.close();
    this.options.failed(reason);
  }
}
