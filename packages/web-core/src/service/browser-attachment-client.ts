import {
  BROWSER_CONTROL_MAX_BYTES,
  BROWSER_VIDEO_CODEC,
  BROWSER_VIEWPORT_MAX,
  BROWSER_VIEWPORT_MIN,
  browserAttachmentEventSchema,
  type BrowserAttachmentMessage,
  type BrowserAttachmentOpen,
  type BrowserTabSnapshot
} from '@myagentroam/protocol';
import { BrowserViewport } from './browser-viewport.js';

type Link = WebSocket | RTCDataChannel;
export type BrowserStreamSample = Readonly<{ bitsPerSecond: number; framesPerSecond: number }>;

export async function supportsBrowserVideo(): Promise<boolean> {
  return (
    typeof VideoDecoder !== 'undefined' &&
    (await VideoDecoder.isConfigSupported({ codec: BROWSER_VIDEO_CODEC, optimizeForLatency: true }))
      .supported === true
  );
}

/** Owns one already-selected data path, its decoder and local stream counters. Its caller owns
 * authorization, path selection and reconnection. It never queues input.
 */
export class BrowserAttachmentClient {
  private readonly viewport: BrowserViewport;
  private ready = false;
  private closed = false;
  private version: number | undefined;
  private drawn = false;
  private sampleTimer: ReturnType<typeof setInterval> | undefined;
  private sampleStart = 0;
  private receivedBytes = 0;
  private drawnFrames = 0;
  private resizeObserver: ResizeObserver | undefined;
  private resizeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly link: Link,
    private readonly canvas: HTMLCanvasElement,
    private readonly open: BrowserAttachmentOpen,
    private readonly options: {
      snapshot(snapshot: BrowserTabSnapshot): void;
      selection?(id: string, text: string): void;
      attached?(): void;
      resizeViewport?: boolean;
      frame(frame: { viewVersion: number; width: number; height: number }): void;
      sample(value: BrowserStreamSample): void;
      failed(code: string): void;
      ended(code: string): void;
    }
  ) {
    this.viewport = new BrowserViewport(canvas);
    link.binaryType = 'arraybuffer';
    link.addEventListener('open', this.sendOpen);
    link.addEventListener('message', this.onMessage);
    link.addEventListener('close', this.onClose);
    link.addEventListener('error', this.onClose);
    if (this.linkOpen()) this.sendOpen();
  }

  send(command: Exclude<BrowserAttachmentMessage, { type: 'ack' }>): boolean {
    if (!this.ready || this.closed) return false;
    if (command.type === 'input' && (!this.drawn || command.action.viewVersion !== this.version))
      return false;
    return this.sendText(command);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.sampleTimer);
    clearTimeout(this.resizeTimer);
    this.resizeObserver?.disconnect();
    this.link.removeEventListener('open', this.sendOpen);
    this.link.removeEventListener('message', this.onMessage);
    this.link.removeEventListener('close', this.onClose);
    this.link.removeEventListener('error', this.onClose);
    this.viewport.close();
    this.link.close();
  }

  private readonly sendOpen = (): void => {
    this.link.removeEventListener('open', this.sendOpen);
    this.sendText(this.open);
  };

  private readonly onClose = (): void => this.end('BROWSER_DISCONNECTED');

  private readonly onMessage = (event: Event): void => {
    void this.receive((event as MessageEvent<unknown>).data).catch(() =>
      this.end('BROWSER_INVALID_MESSAGE')
    );
  };

  private async receive(data: unknown): Promise<void> {
    if (this.closed) return;
    if (typeof data === 'string') {
      if (new TextEncoder().encode(data).byteLength > BROWSER_CONTROL_MAX_BYTES)
        throw new Error('Browser control limit');
      const event = browserAttachmentEventSchema.parse(JSON.parse(data));
      if (event.type === 'ATTACHED' && !this.ready) {
        this.ready = true;
        this.sampleStart = performance.now();
        this.sampleTimer = setInterval(this.publishSample, 1_000);
        if (this.options.resizeViewport) this.observeSize();
        this.options.attached?.();
        return;
      }
      if (!this.ready || event.type === 'ATTACHED')
        throw new Error('Browser attachment out of order');
      if (event.type === 'snapshot') {
        const version = event.snapshot.viewVersion;
        if (version !== this.version) {
          this.drawn = false;
          this.viewport.setView(version);
          this.version = version;
        }
        this.options.snapshot(event.snapshot);
      } else if (event.type === 'selection') {
        this.options.selection?.(event.id, event.text);
      } else {
        this.options.failed(event.code);
      }
      return;
    }
    if (!this.ready || !(data instanceof ArrayBuffer)) throw new Error('Unexpected browser frame');
    this.receivedBytes += data.byteLength;
    const frame = await this.viewport.receive(new Uint8Array(data));
    if (this.closed || !frame || !this.sendText({ type: 'ack', sequence: frame.sequence })) return;
    if (frame.viewport?.viewVersion === this.version && frame.viewport) {
      this.drawn = true;
      this.drawnFrames++;
      this.options.frame(frame.viewport);
    }
  }

  private readonly publishSample = (): void => {
    const now = performance.now();
    const seconds = (now - this.sampleStart) / 1_000;
    this.sampleStart = now;
    const value = {
      bitsPerSecond: (this.receivedBytes * 8) / seconds,
      framesPerSecond: this.drawnFrames / seconds
    };
    this.receivedBytes = this.drawnFrames = 0;
    this.options.sample(value);
  };

  private observeSize(): void {
    let sent: { width: number; height: number } | undefined;
    this.resizeObserver = new ResizeObserver(() => {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => {
        const { clientWidth, clientHeight } = this.canvas;
        if (
          this.closed ||
          clientWidth < BROWSER_VIEWPORT_MIN ||
          clientHeight < BROWSER_VIEWPORT_MIN
        )
          return;
        const width = Math.min(clientWidth, BROWSER_VIEWPORT_MAX);
        const height = Math.min(clientHeight, BROWSER_VIEWPORT_MAX);
        if (width === sent?.width && height === sent.height) return;
        if (this.send({ type: 'viewport.resize', width, height })) sent = { width, height };
      }, 120);
    });
    this.resizeObserver.observe(this.canvas);
  }

  private linkOpen(): boolean {
    const state: string | number = this.link.readyState;
    return state === 'open' || state === 1;
  }

  private sendText(value: BrowserAttachmentMessage | BrowserAttachmentOpen): boolean {
    const text = JSON.stringify(value);
    const bytes = new TextEncoder().encode(text).byteLength;
    if (
      !this.linkOpen() ||
      bytes > BROWSER_CONTROL_MAX_BYTES ||
      this.link.bufferedAmount + bytes > 2 * BROWSER_CONTROL_MAX_BYTES
    ) {
      this.end('BROWSER_LINK_UNAVAILABLE');
      return false;
    }
    try {
      this.link.send(text);
      return true;
    } catch {
      this.end('BROWSER_LINK_UNAVAILABLE');
      return false;
    }
  }

  private end(code: string): void {
    if (this.closed) return;
    this.close();
    this.options.ended(code);
  }
}
