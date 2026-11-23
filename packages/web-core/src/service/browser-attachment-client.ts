import {
  BROWSER_CONTROL_MAX_BYTES,
  BROWSER_VIDEO_CODEC,
  browserAttachmentEventSchema,
  type BrowserAttachmentMessage,
  type BrowserAttachmentOpen,
  type BrowserTabSnapshot
} from '@myagentroam/protocol';
import { BrowserViewport } from './browser-viewport.js';

type Link = WebSocket | RTCDataChannel;

export async function supportsBrowserVideo(): Promise<boolean> {
  return (
    typeof VideoDecoder !== 'undefined' &&
    (await VideoDecoder.isConfigSupported({ codec: BROWSER_VIDEO_CODEC, optimizeForLatency: true }))
      .supported === true
  );
}

/** Owns one already-selected data path and its decoder. Its caller owns
 * authorization, path selection and reconnection. It never queues input.
 */
export class BrowserAttachmentClient {
  private readonly viewport: BrowserViewport;
  private ready = false;
  private closed = false;
  private version: number | undefined;
  private drawn = false;

  constructor(
    private readonly link: Link,
    canvas: HTMLCanvasElement,
    private readonly open: BrowserAttachmentOpen,
    private readonly options: {
      snapshot(snapshot: BrowserTabSnapshot): void;
      selection?(id: string, text: string): void;
      attached?(): void;
      frame(frame: { viewVersion: number; width: number; height: number }): void;
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
    const frame = await this.viewport.receive(new Uint8Array(data));
    if (this.closed || !frame || !this.sendText({ type: 'ack', sequence: frame.sequence })) return;
    if (frame.viewport?.viewVersion === this.version && frame.viewport) {
      this.drawn = true;
      this.options.frame(frame.viewport);
    }
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
