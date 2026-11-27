import {
  BROWSER_CONTROL_MAX_BYTES,
  BROWSER_VIEWPORT_MAX,
  BROWSER_VIEWPORT_MIN,
  browserAttachmentEventSchema,
  type BrowserAttachmentEvent,
  type BrowserAttachmentMessage,
  type BrowserPictureQuality,
  type BrowserTabSnapshot
} from '@myagentroam/protocol';
import { BrowserViewport, type BrowserDrawnView } from './browser-viewport.js';

import type { BrowserMessageLink } from './browser-record-link.js';
export type BrowserStreamSample = Readonly<{ bitsPerSecond: number; framesPerSecond: number }>;

/** Owns one already-selected data path, its decoder and local stream counters. Its caller owns
 * authorization, path selection and reconnection. It never queues input.
 */
export class BrowserAttachmentClient {
  private viewport?: BrowserViewport;
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
  private sentSize: { width: number; height: number } | undefined;

  constructor(
    private readonly link: BrowserMessageLink,
    private readonly canvas: HTMLCanvasElement,
    private readonly options: {
      snapshot(snapshot: BrowserTabSnapshot): void;
      selection?(id: string, text: string): void;
      find?(event: Extract<BrowserAttachmentEvent, { type: 'find.result' }>): void;
      contextMenu?(event: Extract<BrowserAttachmentEvent, { type: 'context.result' }>): void;
      attached?(): void;
      quality?(value: BrowserPictureQuality): void;
      viewportElement?: HTMLElement;
      downloadManagement?: boolean;
      agentActivity?: boolean;
      tabIcon?: (event: Extract<BrowserAttachmentEvent, { type: 'tab.icon' }>) => void;
      frame(frame: BrowserDrawnView): void;
      sample(value: BrowserStreamSample): void;
      downloadProgress?: boolean;
      tabControls?: boolean;
      failed(code: string): void;
      ended(code: string): void;
    }
  ) {
    link.subscribe(
      (data) => {
        void this.receive(data).catch(() => this.end('BROWSER_INVALID_MESSAGE'));
      },
      () => this.end('BROWSER_DISCONNECTED')
    );
  }

  send(command: Exclude<BrowserAttachmentMessage, { type: 'ack' }>): boolean {
    if (!this.ready || this.closed) return false;
    if (command.type === 'input' && (!this.drawn || command.action.viewVersion !== this.version))
      return false;
    if (
      (command.type === 'navigate' ||
        (command.type === 'navigation' && command.action !== 'stop') ||
        (command.type === 'tab.open' && command.address !== undefined) ||
        command.type === 'tab.openHtml' ||
        command.type === 'tab.reopen' ||
        command.type === 'tab.restore') &&
      !this.sendSize()
    )
      return false;
    return this.sendText(command);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.sampleTimer);
    clearTimeout(this.resizeTimer);
    this.resizeObserver?.disconnect();
    this.viewport?.close();
    this.link.close();
  }

  private async receive(data: unknown): Promise<void> {
    if (this.closed) return;
    if (typeof data === 'string') {
      if (new TextEncoder().encode(data).byteLength > BROWSER_CONTROL_MAX_BYTES)
        throw new Error('Browser control limit');
      const event = browserAttachmentEventSchema.parse(JSON.parse(data));
      if (event.type === 'ATTACHED' && !this.ready) {
        this.viewport = new BrowserViewport(
          this.canvas,
          (data) => {
            this.sendText({ type: 'rfb', data });
          },
          () => this.end('BROWSER_FRAME_TRANSPORT_FAILED')
        );
        this.ready = true;
        this.sampleStart = performance.now();
        this.sampleTimer = setInterval(this.publishSample, 1_000);
        const element = this.options.viewportElement;
        if (element) {
          if (!this.sendSize()) return;
          this.observeSize(element);
        }
        if (this.options.tabIcon) this.sendText({ type: 'tab.icons' });
        if (this.options.tabControls) this.sendText({ type: 'tab.controls.observe' });
        if (this.options.agentActivity) this.sendText({ type: 'agent.activity.observe' });
        if (this.options.downloadManagement)
          this.sendText({
            type: 'downloads.observe',
            ...(this.options.downloadProgress && { progress: true })
          });
        this.options.attached?.();
        return;
      }
      if (!this.viewport || !this.ready || event.type === 'ATTACHED')
        throw new Error('Browser attachment out of order');
      if (event.type === 'rfb') {
        this.viewport.handshake(event.data);
      } else if (event.type === 'quality') {
        this.options.quality?.(event.quality);
      } else if (event.type === 'snapshot') {
        const version = event.snapshot.viewVersion;
        if (version !== this.version) {
          this.drawn = false;
          this.viewport.setView(version, event.snapshot.activeId);
          this.version = version;
        }
        this.options.snapshot(event.snapshot);
      } else if (event.type === 'selection') {
        this.options.selection?.(event.id, event.text);
      } else if (event.type === 'find.result') {
        this.options.find?.(event);
      } else if (event.type === 'context.result') {
        this.options.contextMenu?.(event);
      } else if (event.type === 'tab.icon') {
        this.options.tabIcon?.(event);
      } else {
        this.options.failed(event.code);
      }
      return;
    }
    if (!this.viewport || !this.ready || !(data instanceof Uint8Array))
      throw new Error('Unexpected browser frame');
    this.receivedBytes += data.byteLength;
    const frame = await this.viewport.receive(data);
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

  private observeSize(element: HTMLElement): void {
    this.resizeObserver = new ResizeObserver(() => {
      clearTimeout(this.resizeTimer);
      if (this.closed) return;
      if (this.sentSize) this.resizeTimer = setTimeout(() => this.sendSize(), 120);
      else this.sendSize();
    });
    this.resizeObserver.observe(element);
  }

  private sendSize(): boolean {
    // The content area has layout even while the canvas waits for its first picture.
    const element = this.options.viewportElement;
    if (!element || this.closed) return !this.closed;
    const { clientWidth, clientHeight } = element;
    if (clientWidth < BROWSER_VIEWPORT_MIN || clientHeight < BROWSER_VIEWPORT_MIN) return true;
    const width = Math.min(clientWidth, BROWSER_VIEWPORT_MAX);
    const height = Math.min(clientHeight, BROWSER_VIEWPORT_MAX);
    if (width === this.sentSize?.width && height === this.sentSize.height) return true;
    if (!this.sendText({ type: 'viewport.resize', width, height })) return false;
    this.sentSize = { width, height };
    return true;
  }

  private sendText(value: BrowserAttachmentMessage): boolean {
    const text = JSON.stringify(value);
    if (this.closed) return false;
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
