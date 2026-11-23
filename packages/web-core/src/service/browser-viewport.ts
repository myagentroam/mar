import { BROWSER_VIDEO_CODEC, BrowserFrameReceiver } from '@myagentroam/protocol';

export interface BrowserDrawResult {
  sequence: number;
  viewport?: { viewVersion: number; width: number; height: number };
}

/** Owns reassembly and local drawing for one attachment. The caller owns the
 * connection, view snapshots and ACK; a result without a viewport was discarded.
 */
export class BrowserViewport {
  private readonly receiver = new BrowserFrameReceiver();
  private readonly context: CanvasRenderingContext2D;
  private readonly decoder: VideoDecoder;
  private viewVersion: number | undefined;
  private decodingView: number | undefined;
  private pending: ReturnType<typeof Promise.withResolvers<VideoFrame | undefined>> | undefined;
  private closed = false;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Browser canvas is unavailable.');
    this.context = context;
    if (!globalThis.VideoDecoder) throw new Error('BROWSER_H264_DECODER_UNAVAILABLE');
    this.decoder = new VideoDecoder({
      output: (image) => {
        if (this.pending) this.pending.resolve(image);
        else image.close();
      },
      error: (error) => this.pending?.reject(error)
    });
  }

  setView(viewVersion: number): void {
    if (this.closed || this.viewVersion === viewVersion) return;
    this.viewVersion = viewVersion;
    this.clear();
  }

  async receive(bytes: Uint8Array): Promise<BrowserDrawResult | undefined> {
    if (this.closed) return undefined;
    if (this.pending) throw new Error('Browser frame exceeded credit.');
    const frame = this.receiver.push(bytes);
    if (!frame) return undefined;
    const { sequence, viewVersion, width, height } = frame;
    if (viewVersion !== this.viewVersion) return { sequence };

    if (this.decodingView !== viewVersion) {
      if (!frame.key) throw new Error('Expected a key frame.');
      this.decoder.reset();
      this.decoder.configure({ codec: BROWSER_VIDEO_CODEC, optimizeForLatency: true });
      this.decodingView = viewVersion;
    }
    const pending = Promise.withResolvers<VideoFrame | undefined>();
    this.pending = pending;
    try {
      this.decoder.decode(
        new EncodedVideoChunk({
          type: frame.key ? 'key' : 'delta',
          timestamp: sequence,
          data: frame.data
        })
      );
      const image = await pending.promise;
      if (!image) return undefined;
      try {
        if (this.closed) return undefined;
        if (viewVersion !== this.viewVersion) return { sequence };
        if (this.canvas.width !== image.displayWidth) this.canvas.width = image.displayWidth;
        if (this.canvas.height !== image.displayHeight) this.canvas.height = image.displayHeight;
        this.context.drawImage(image, 0, 0);
        return { sequence, viewport: { viewVersion, width, height } };
      } finally {
        image.close();
      }
    } finally {
      this.pending = undefined;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pending?.resolve(undefined);
    this.pending = undefined;
    if (this.decoder.state !== 'closed') this.decoder.close();
    this.clear();
  }

  private clear(): void {
    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }
}
