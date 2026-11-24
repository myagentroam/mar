import RFB from '@novnc/novnc';
import { BrowserFrameReceiver } from '@myagentroam/protocol';

export type BrowserDrawnView = {
  viewVersion: number;
  width: number;
  height: number;
  raster: { width: number; height: number };
};

/** Bridges only RFB display traffic. Browser input stays on the MAR control path. */
export class BrowserViewport {
  private readonly channel;
  private readonly decoder: RFB;
  private readonly target = document.createElement('div');
  private readonly assembler = new BrowserFrameReceiver();
  private readonly context: CanvasRenderingContext2D;
  private version: number | undefined;
  private activeId: string | undefined;
  private pending: { remaining: number; drawn: () => void; cancel: () => void } | undefined;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    send: (data: string) => void,
    ended: () => void
  ) {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Browser canvas unavailable');
    this.context = context;
    this.channel = {
      protocol: '',
      binaryType: 'arraybuffer',
      readyState: 'open',
      onopen: null as ((event: Event) => void) | null,
      onclose: null as ((event: Event) => void) | null,
      onerror: null as ((event: Event) => void) | null,
      onmessage: null as ((event: MessageEvent) => void) | null,
      send: (bytes: Uint8Array) => send(btoa(String.fromCharCode(...bytes))),
      close() {
        this.readyState = 'closed';
        this.onclose?.(new Event('close'));
      }
    };
    this.decoder = new RFB(this.target, this.channel, {
      manualClipboard: true,
      requestDrivenUpdates: true,
      allowedEncodings: [0, 1, 7, -223, -26]
    });
    this.decoder.viewOnly = true;
    this.decoder.addEventListener('frame', () => {
      const pending = this.pending;
      if (pending && --pending.remaining === 0) pending.drawn();
    });
    this.decoder.addEventListener('disconnect', ended);
  }

  handshake(data: string): void {
    this.channel.onmessage?.(
      new MessageEvent('message', {
        data: Uint8Array.from(atob(data), (c) => c.charCodeAt(0)).buffer
      })
    );
  }

  setView(version: number, activeId?: string): void {
    if (this.activeId !== activeId)
      this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.activeId = activeId;
    this.version = version;
  }

  async receive(
    bytes: Uint8Array
  ): Promise<{ sequence: number; viewport?: BrowserDrawnView } | undefined> {
    const frame = this.assembler.push(bytes);
    if (!frame) return;
    if (this.pending) throw new Error('Browser frame exceeded credit');
    const { promise, resolve } = Promise.withResolvers<boolean>();
    // A resize is encoded as a DesktopSize-only update followed by pixels.
    // Wait for both flips so size changes cannot acknowledge blank pixels.
    this.pending = {
      remaining: frame.key ? 2 : 1,
      drawn: () => resolve(true),
      cancel: () => resolve(false)
    };
    try {
      this.channel.onmessage?.(new MessageEvent('message', { data: frame.data.buffer }));
      if (!(await promise)) return;
      if (frame.viewVersion !== this.version) return { sequence: frame.sequence };
      const image = this.target.querySelector('canvas');
      if (!image?.width || !image.height) throw new Error('Browser framebuffer missing');
      if (this.canvas.width !== image.width || this.canvas.height !== image.height) {
        this.canvas.width = image.width;
        this.canvas.height = image.height;
      }
      this.context.drawImage(image, 0, 0);
      return {
        sequence: frame.sequence,
        viewport: {
          viewVersion: frame.viewVersion,
          width: frame.width,
          height: frame.height,
          raster: { width: image.width, height: image.height }
        }
      };
    } finally {
      this.pending = undefined;
    }
  }

  close(): void {
    this.pending?.cancel();
    this.decoder.disconnect();
    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }
}
