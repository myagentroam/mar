import sharp from 'sharp';
import {
  BrowserRfbPeer,
  BrowserVncRate,
  encodeBrowserVncUpdate,
  RFB_COPY_RECT,
  RFB_TIGHT,
  type BrowserVncQuality,
  type Raster
} from '@myagentroam/browser-vnc';
import {
  BROWSER_FRAME_MAX_BYTES,
  encodeBrowserFrame,
  type BrowserFrame
} from '@myagentroam/protocol';

type Capture = Pick<BrowserFrame, 'viewVersion' | 'width' | 'height'> & {
  png: Buffer;
  scrollY?: number;
};
type Flight = { sequence: number; view: number; final: boolean; acknowledged: () => void };
const TRANSFER_DEADLINE_MULTIPLIER = 4;

/** One attachment owns one RFB peer, one confirmed framebuffer and a single latest capture. */
export class BrowserVncStream {
  private readonly controller = new AbortController();
  private readonly peer: BrowserRfbPeer;
  private readonly rate: BrowserVncRate;
  private version = 0;
  private rasterGeneration = 0;
  private sequence = 0;
  private pending: Capture | undefined;
  private current: Flight | undefined;
  private busy = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private deadline: ReturnType<typeof setTimeout> | undefined;
  private captureAt = -Infinity;
  private lastOfferAt = -Infinity;
  private movingUntil = -Infinity;
  private sentRaster: Raster | undefined;
  private sentVersion = 0;
  private sentScroll: number | undefined;
  private dimensions = { width: 1, height: 1 };
  private wheel = 0;
  private readonly lossyTiles = new Map<number, number>();
  private motionReadyAt = -Infinity;
  private motionResize = false;
  private repairAt = Infinity;
  private repair: ReturnType<typeof setTimeout> | undefined;
  private latest: Capture | undefined;

  constructor(
    private readonly options: {
      relay: boolean;
      send: (chunk: Uint8Array, signal: AbortSignal) => Promise<void>;
      handshake: (data: string) => void;
      failed: (code: string) => void;
      changed: (quality: BrowserVncQuality) => void;
      deadlineMs: number;
    }
  ) {
    this.rate = new BrowserVncRate(options.relay);
    this.peer = new BrowserRfbPeer(
      (bytes) => options.handshake(Buffer.from(bytes).toString('base64')),
      () => this.flush()
    );
  }

  get scale() {
    return this.rate.profile.scale;
  }
  get fps() {
    return this.rate.profile.fps;
  }
  get quality() {
    return this.rate.profile.quality;
  }

  start() {
    this.peer.start();
  }

  receive(bytes: Buffer) {
    try {
      this.peer.receive(bytes);
    } catch {
      this.fail('BROWSER_INVALID_MESSAGE');
    }
  }

  select(quality: BrowserVncQuality | 'auto') {
    if (this.rate.limit(quality)) this.options.changed(this.quality);
  }

  scroll(dy: number) {
    this.wheel += dy;
  }

  setView(version: number) {
    if (version === this.version) return;
    this.version = version;
    this.resetRaster();
  }

  resetRaster(downscale = false) {
    // Only a confirmed broad-motion update can arm lossy encoding during an
    // adaptive downscale. New tabs, CSS resize and static starts stay lossless.
    this.motionResize =
      downscale && this.motionReadyAt !== -Infinity && performance.now() < this.movingUntil;
    this.rasterGeneration++;
    this.wheel = 0;
    if (!this.motionResize) {
      this.lastOfferAt = this.movingUntil = this.motionReadyAt = -Infinity;
    }
    this.pending = this.latest = undefined;
    this.lossyTiles.clear();
    this.repairAt = Infinity;
    this.sentRaster = undefined;
    this.sentScroll = undefined;
    clearTimeout(this.timer);
    clearTimeout(this.repair);
    this.timer = undefined;
    this.repair = undefined;
  }

  offer(capture: Capture) {
    if (this.controller.signal.aborted || capture.viewVersion !== this.version) return;
    if (capture !== this.latest) {
      const now = performance.now();
      // Motion classification depends on captures, not encode/send latency.
      // A busy encoder can take longer than a frame interval at 1080p.
      if (now - this.lastOfferAt < 500) this.movingUntil = now + 500;
      this.lastOfferAt = now;
    }
    this.latest = this.pending = capture;
    this.flush();
  }

  acknowledge(sequence: number): number | undefined {
    const flight = this.current;
    if (!flight || !flight.final || flight.sequence !== sequence) return;
    flight.final = false;
    flight.acknowledged();
    return flight.view;
  }

  close() {
    this.controller.abort();
    clearTimeout(this.deadline);
    this.resetRaster();
  }

  private flush() {
    if (
      this.controller.signal.aborted ||
      this.busy ||
      this.timer ||
      !this.pending ||
      !this.peer.requested
    )
      return;
    const now = performance.now();
    const nextMotion =
      now >= this.repairAt || now >= this.movingUntil ? -Infinity : this.motionReadyAt;
    const wait = Math.max(this.captureAt + 1000 / this.rate.profile.fps, nextMotion) - now;
    if (wait > 0 && this.version === this.sentVersion) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.flush();
      }, wait);
      this.timer.unref();
      return;
    }
    const capture = this.pending;
    this.pending = undefined;
    this.busy = true;
    const motion = performance.now() < this.movingUntil;
    this.captureAt = performance.now();
    this.deadline = setTimeout(
      () => this.fail('BROWSER_FRAME_TIMEOUT'),
      this.options.deadlineMs
    ).unref();
    void this.sendUpdate(capture, motion)
      .catch(() => this.fail('BROWSER_FRAME_TRANSPORT_FAILED'))
      .finally(() => {
        clearTimeout(this.deadline);
        this.busy = false;
        this.flush();
      });
  }

  private async encodeCapture(capture: Capture, motion: boolean, currentRaster: () => boolean) {
    const { data: rgb, info } = await sharp(capture.png, { limitInputPixels: 1920 * 1080 })
      .toColourspace('srgb')
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (!currentRaster()) return;
    const { width, height } = info;
    const frame = { width, height, rgb };
    const resize = width !== this.dimensions.width || height !== this.dimensions.height;
    const displacement =
      capture.scrollY !== undefined && this.sentScroll !== undefined
        ? capture.scrollY - this.sentScroll || this.wheel
        : this.wheel;
    const scroll = Math.round((displacement * height) / capture.height);
    this.wheel = 0;
    const previous =
      !resize && this.sentVersion === capture.viewVersion ? this.sentRaster : undefined;
    const quality = this.quality;
    const update = await encodeBrowserVncUpdate(frame, previous, {
      resize,
      tight: this.peer.supports(RFB_TIGHT),
      copyRect: this.peer.supports(RFB_COPY_RECT),
      scroll,
      motion,
      motionResize: this.motionResize && this.sentVersion === capture.viewVersion,
      ...(previous &&
        this.lossyTiles.size && {
          lossyTiles: this.lossyTiles,
          repairThrough: performance.now()
        }),
      quality,
      ...(this.peer.supportsJpeg && {
        jpeg: (data, size, quality) =>
          sharp(data, { raw: { ...size, channels: 3 } })
            .jpeg({ quality, chromaSubsampling: quality >= 90 ? '4:4:4' : '4:2:0' })
            .toBuffer()
      })
    });
    if (!update) return;
    if (!update.data.length || update.data.length > BROWSER_FRAME_MAX_BYTES)
      throw new Error('Invalid encoded Browser frame size.');
    return { frame, resize, previous, update };
  }

  private async sendUpdate(capture: Capture, motion: boolean) {
    const signal = this.controller.signal;
    const generation = this.rasterGeneration;
    const currentRaster = () => !signal.aborted && generation === this.rasterGeneration;
    const processingStarted = performance.now();
    const encoded = await this.encodeCapture(capture, motion, currentRaster).catch(() => {
      if (currentRaster()) this.fail('BROWSER_FRAME_ENCODE_FAILED');
    });
    if (!encoded || !currentRaster()) return;
    const { frame, resize, previous, update } = encoded;
    this.peer.consume();
    const ack = Promise.withResolvers<void>();
    const current: Flight = (this.current = {
      sequence: ++this.sequence,
      view: capture.viewVersion,
      final: false,
      acknowledged: ack.resolve
    });
    const started = performance.now();
    // Keep the short stall timeout, but let a large lossless frame make
    // progress on a slow link. One frame can never hold credit indefinitely.
    this.deadline?.refresh();
    const transferDeadline = setTimeout(
      () => this.fail('BROWSER_FRAME_TIMEOUT'),
      this.options.deadlineMs * TRANSFER_DEADLINE_MULTIPLIER
    ).unref();
    const aborted = () => {
      clearTimeout(transferDeadline);
      ack.resolve();
    };
    signal.addEventListener('abort', aborted, { once: true });
    try {
      for (const { bytes, final } of encodeBrowserFrame({
        ...capture,
        data: update.data,
        sequence: current.sequence,
        key: resize
      })) {
        signal.throwIfAborted();
        current.final = final;
        await this.options.send(bytes, signal);
        if (!signal.aborted) this.deadline?.refresh();
      }
      const written = performance.now();
      await ack.promise;
      const confirmed = performance.now();
      if (signal.aborted) return;
      this.dimensions = { width: frame.width, height: frame.height };
      this.sentVersion = capture.viewVersion;
      if (!currentRaster()) return;
      this.sentRaster = frame;
      this.sentScroll = capture.scrollY;
      this.motionResize = false;
      const motionBytes = update.motion ? update.data.length - update.repairBytes : 0;
      // Pace broad motion by actual encoded bytes. Bounded debt allows a
      // large still/resize/repair to remain responsive and never queues frames.
      this.motionReadyAt = update.motion
        ? started + Math.min(450, (motionBytes * 8_000) / this.rate.motionBudget)
        : -Infinity;
      if (!previous) this.lossyTiles.clear();
      for (const tile of update.restoredTiles) this.lossyTiles.delete(tile);
      const repairAt = Math.max(
        confirmed + 350,
        confirmed + 2_000 / this.fps,
        this.motionReadyAt + 250
      );
      for (const tile of update.lossyTiles) this.lossyTiles.set(tile, repairAt);
      this.scheduleRepair();
      // A repair timer can queue this very capture while it awaits draw credit.
      const superseded = this.pending !== undefined && this.pending !== capture;
      if (
        this.rate.observe(
          written - started,
          confirmed - started,
          superseded,
          motionBytes,
          update.motion && !update.repairBytes ? written - processingStarted : undefined
        )
      )
        this.options.changed(this.quality);
    } finally {
      clearTimeout(transferDeadline);
      signal.removeEventListener('abort', aborted);
      this.current = undefined;
    }
  }

  private scheduleRepair() {
    let earliest = Infinity;
    for (const due of this.lossyTiles.values()) earliest = Math.min(earliest, due);
    if (this.repair && this.repairAt === earliest) return;
    clearTimeout(this.repair);
    this.repair = undefined;
    this.repairAt = earliest;
    if (!this.lossyTiles.size) return;
    this.repair = setTimeout(
      () => {
        this.repair = undefined;
        if (!this.latest) return;
        if (performance.now() < this.repairAt) {
          this.scheduleRepair();
          return;
        }
        clearTimeout(this.timer);
        this.timer = undefined;
        this.offer(this.latest);
      },
      Math.max(1, Math.ceil(this.repairAt - performance.now()))
    ).unref();
  }

  private fail(code: string) {
    if (this.controller.signal.aborted) return;
    this.close();
    this.options.failed(code);
  }
}
