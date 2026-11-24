import { setTimeout as delay } from 'node:timers/promises';
import type { BrowserPageInput } from '@myagentroam/protocol';
import type { CDPSession, Page } from 'playwright';
import { BrowserContextMenu } from './browser-context-menu.js';
import { BrowserPageFind } from './browser-page-find.js';
import { BrowserPageZoom } from './browser-page-zoom.js';
import { BROWSER_DEVICE_SCALE_FACTOR, type BrowserSize } from './browser-capture-config.js';

function pngSize(png: Buffer) {
  if (
    png.length < 24 ||
    png.readUInt32BE(0) !== 0x89504e47 ||
    png.toString('ascii', 12, 16) !== 'IHDR'
  )
    return;
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

type Frame = { png: Buffer; width: number; height: number; scrollY?: number };
type ScreencastFrame = {
  data: string;
  metadata: {
    deviceWidth: number;
    deviceHeight: number;
    scrollOffsetY?: number;
    timestamp?: number;
  };
  sessionId: number;
};
type ScreencastOptions = { format: 'png'; maxWidth: number; maxHeight: number };
export type BrowserPageCapture = { stop: () => Promise<void> };
const STATIC_FRAME_TIMEOUT_MS = 1_000;
const CAPTURE_SETTLE_MS = 250;

/** Adapts a single owned Playwright page. The session owns the page and selects
 * the active view, while the attachment owns input ordering and frame transport.
 * Construct only for a browser launched within the Node's execution boundary.
 */
export class BrowserPageView {
  private pendingViewport: Promise<void> = Promise.resolve();
  private navigationSession: Promise<CDPSession> | undefined;
  readonly contextMenu: BrowserContextMenu;
  readonly find: BrowserPageFind;
  private readonly layoutZoom = new BrowserPageZoom();

  constructor(private readonly page: Page) {
    this.contextMenu = new BrowserContextMenu(page);
    this.find = new BrowserPageFind(page);
  }

  async history(): Promise<
    { canGoBack: boolean; canGoForward: boolean; currentUrl: string | undefined } | undefined
  > {
    try {
      const { currentIndex, entries } = await (
        await this.navigation()
      ).send('Page.getNavigationHistory');
      return {
        canGoBack: currentIndex > 0,
        canGoForward: currentIndex + 1 < entries.length,
        currentUrl: entries[currentIndex]?.url
      };
    } catch (error) {
      // Chromium may detach a target before Playwright delivers the page-close event.
      if (
        error instanceof Error &&
        error.message.includes(
          'Protocol error (Page.getNavigationHistory): Not attached to an active page'
        )
      )
        return undefined;
      throw error;
    }
  }

  async travel(direction: -1 | 1): Promise<void> {
    const navigation = await this.navigation();
    const { currentIndex, entries } = await navigation.send('Page.getNavigationHistory');
    const entry = entries[currentIndex + direction];
    if (entry) await navigation.send('Page.navigateToHistoryEntry', { entryId: entry.id });
  }

  async stopLoading(): Promise<void> {
    await (await this.navigation()).send('Page.stopLoading');
  }

  get zoomPercent(): number {
    return this.layoutZoom.percent;
  }

  zoom(direction: 'in' | 'out' | 'reset'): Promise<void> {
    return this.layoutZoom.change(() => this.navigation(), direction);
  }

  resize(size: BrowserSize): Promise<void> {
    const operation = this.pendingViewport.then(async () => {
      const current = this.page.viewportSize();
      if (current?.width !== size.width || current.height !== size.height)
        await this.page.setViewportSize(size);
    });
    this.pendingViewport = operation.catch(() => undefined);
    return operation;
  }

  async reload(): Promise<void> {
    await this.load(() => this.page.reload({ waitUntil: 'commit' }));
  }

  private navigation(): Promise<CDPSession> {
    return (this.navigationSession ??= this.page.context().newCDPSession(this.page));
  }

  async navigate(value: string): Promise<void> {
    const url = URL.parse(value);
    if (
      !url ||
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username ||
      url.password
    ) {
      throw new Error('BROWSER_INVALID_ADDRESS');
    }
    await this.load(() => this.page.goto(url.href, { waitUntil: 'commit' }));
  }

  private async load(navigate: () => Promise<unknown>): Promise<void> {
    try {
      await navigate();
    } catch (cause) {
      // Chromium also uses ERR_ABORTED for Stop and download handoff. Neither is a failed page.
      if (cause instanceof Error && /\bnet::ERR_ABORTED\b/u.test(cause.message))
        throw new Error('BROWSER_NAVIGATION_ABORTED', { cause });
      throw new Error('BROWSER_NAVIGATION_FAILED', { cause });
    }
  }

  /** The attachment owns input ordering, view fencing and synthetic releases. */
  async input(action: BrowserPageInput): Promise<void> {
    const { mouse, keyboard } = this.page;
    switch (action.type) {
      case 'move':
        return mouse.move(action.x, action.y);
      case 'button':
        await mouse.move(action.x, action.y);
        return mouse[action.edge]({ button: action.button });
      case 'wheel':
        return mouse.wheel(action.x, action.y);
      case 'touch':
        return this.touch(action.phase, action.x, action.y);
      case 'key':
        return keyboard[action.edge](action.key);
      case 'text':
        return keyboard.insertText(action.text);
    }
  }

  private async touch(phase: 'start' | 'move' | 'end' | 'cancel', x = 0, y = 0): Promise<void> {
    const type = {
      start: 'touchStart',
      move: 'touchMove',
      end: 'touchEnd',
      cancel: 'touchCancel'
    } as const;
    await (
      await this.navigation()
    ).send('Input.dispatchTouchEvent', {
      type: type[phase],
      touchPoints: phase === 'start' || phase === 'move' ? [{ x, y }] : []
    });
  }

  async releaseInput(
    keys: ReadonlySet<string>,
    buttons: ReadonlySet<'left' | 'middle' | 'right'>,
    touch = false
  ) {
    if (this.page.isClosed()) return;
    let failure: unknown;
    const release = async (action: () => Promise<void>) => {
      try {
        await action();
      } catch (error) {
        failure ??= error;
      }
    };
    if (touch) await release(() => this.touch('cancel'));
    for (const key of keys) await release(() => this.page.keyboard.up(key));
    for (const button of buttons) await release(() => this.page.mouse.up({ button }));
    if (failure) throw failure;
  }

  async selectedText(): Promise<string> {
    for (const frame of this.page.frames()) {
      const text = await frame
        .evaluate(() => {
          if (!document.hasFocus()) return '';
          let field = document.activeElement;
          while (field?.shadowRoot?.activeElement) field = field.shadowRoot.activeElement;
          if (field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement) {
            if (field instanceof HTMLInputElement && field.type === 'password') return '';
            const { selectionStart, selectionEnd, value } = field;
            if (selectionStart !== null && selectionEnd !== null)
              return value.slice(selectionStart, Math.min(selectionEnd, selectionStart + 4096));
          }
          return (window.getSelection()?.toString() ?? '').slice(0, 4096);
        })
        .catch(() => '');
      if (text) return text.slice(0, 4096);
    }
    return '';
  }

  async startCapture(
    render: BrowserSize,
    offer: (frame: Frame) => void,
    fps?: () => number
  ): Promise<BrowserPageCapture> {
    // Cross-document navigation can replace the DevTools target between attach
    // and start. Rebind briefly instead of disconnecting the browser viewer.
    for (const wait of [40, 120, 250]) {
      try {
        return await this.attachCapture(render, offer, fps);
      } catch (error) {
        if (
          this.page.isClosed() ||
          !(error instanceof Error) ||
          !error.message.includes(
            'Protocol error (Page.startScreencast): Not attached to an active page'
          )
        )
          throw error;
        await delay(wait);
      }
    }
    return this.attachCapture(render, offer, fps);
  }

  private async attachCapture(
    render: BrowserSize,
    offer: (frame: Frame) => void,
    fps?: () => number
  ): Promise<BrowserPageCapture> {
    const viewport = this.page.viewportSize();
    const scale = viewport
      ? Math.min(
          BROWSER_DEVICE_SCALE_FACTOR,
          render.width / viewport.width,
          render.height / viewport.height
        )
      : undefined;
    const options: ScreencastOptions = {
      format: 'png',
      maxWidth: render.width,
      maxHeight: render.height
    };
    // A separate CDP session gives each attachment its own size and frame credit.
    const session = await this.page.context().newCDPSession(this.page);
    let stopped = false;
    let stopping: Promise<void> | undefined;
    let lastAck = -Infinity;
    let ackTimer: ReturnType<typeof setTimeout> | undefined;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    let lastFrameAt = -Infinity;
    let lastTimestamp = -Infinity;
    let liveFrames = 0;
    let recovering = false;
    let sample: AbortController | undefined;
    const credits: number[] = [];
    const ack = () => {
      ackTimer = undefined;
      const sessionId = credits.shift();
      if (stopped || sessionId === undefined) return;
      lastAck = performance.now();
      void session.send('Page.screencastFrameAck', { sessionId }).catch(() => undefined);
      if (credits.length) scheduleAck();
    };
    const scheduleAck = () => {
      if (ackTimer) return;
      const wait = fps ? lastAck + 1000 / fps() - performance.now() : 0;
      if (wait <= 0) ack();
      else ackTimer = setTimeout(ack, wait).unref();
    };
    const matchesViewport = (width: number, height: number) => {
      if (!viewport) return true;
      const current = this.page.viewportSize();
      return (
        width === viewport.width &&
        height === viewport.height &&
        current?.width === width &&
        current.height === height
      );
    };
    const readFrame = ({ data, metadata }: ScreencastFrame): Frame | undefined => {
      const { deviceWidth: width, deviceHeight: height, scrollOffsetY: scrollY } = metadata;
      if (!matchesViewport(width, height)) return;
      const png = Buffer.from(data, 'base64');
      const image = pngSize(png);
      // CDP can report the new CSS viewport with an old compositor surface.
      // A partial raster may have the right aspect ratio. Check both axes against
      // the target, allowing two pixels for Chromium's even-edge rounding.
      if (
        !image ||
        !image.width ||
        !image.height ||
        image.width > render.width ||
        image.height > render.height ||
        (scale !== undefined &&
          (Math.abs(image.width - width * scale) > 2 ||
            Math.abs(image.height - height * scale) > 2))
      )
        return;
      return { png, width, height, ...(scrollY !== undefined && { scrollY }) };
    };
    const isStale = (timestamp: number | undefined) =>
      timestamp !== undefined && timestamp < lastTimestamp;
    const scheduleSample = (wait: number) => {
      if (!viewport || stopped || settleTimer) return;
      settleTimer = setTimeout(() => {
        settleTimer = undefined;
        sample?.abort();
        const controller = (sample = new AbortController());
        // A clipped CDP screenshot temporarily changes the live compositor's
        // bounds. Sample from a second, short-lived screencast instead.
        void this.sampleFrame(
          options,
          (event) => (isStale(event.metadata.timestamp) ? undefined : readFrame(event)),
          controller.signal
        )
          .then((result) => {
            if (!result || controller.signal.aborted) return;
            const { frame, timestamp } = result;
            if (isStale(timestamp)) return;
            if (!matchesViewport(frame.width, frame.height)) return;
            if (timestamp !== undefined) lastTimestamp = timestamp;
            offer(frame);
          })
          .catch(() => undefined)
          .finally(() => {
            if (sample === controller) sample = undefined;
          });
      }, wait).unref();
    };
    const onFrame = (event: ScreencastFrame) => {
      if (stopped) return;
      // Return credit even for rejected frames, so recovery never starves the live stream.
      credits.push(event.sessionId);
      scheduleAck();
      const timestamp = event.metadata.timestamp;
      if (isStale(timestamp)) return;
      const frame = readFrame(event);
      if (!frame) {
        if (!recovering) {
          recovering = true;
          scheduleSample(CAPTURE_SETTLE_MS);
        }
        return;
      }
      if (timestamp !== undefined) lastTimestamp = timestamp;
      clearTimeout(settleTimer);
      settleTimer = undefined;
      sample?.abort();
      recovering = false;
      liveFrames++;
      const previous = lastFrameAt;
      const at = (lastFrameAt = performance.now());
      const quiet = fps ? Math.max(CAPTURE_SETTLE_MS, 2_000 / fps()) : CAPTURE_SETTLE_MS;
      // The first raster can fit but still contain pixels from a transient surface.
      // A paced burst can also exhaust capture credit before its final paint.
      if (liveFrames === 1 || (fps && at - previous < quiet)) scheduleSample(quiet);
      offer(frame);
    };
    const capture = {
      stop: () => {
        stopped = true;
        clearTimeout(ackTimer);
        clearTimeout(settleTimer);
        sample?.abort();
        credits.length = 0;
        session.off('Page.screencastFrame', onFrame);
        return (stopping ??= (async () => {
          await session.detach().catch((error: unknown) => {
            if (!this.page.isClosed()) throw error;
          });
        })());
      }
    };
    try {
      session.on('Page.screencastFrame', onFrame);
      await session.send('Page.startScreencast', options);
      if (!liveFrames) scheduleSample(CAPTURE_SETTLE_MS);
      return capture;
    } catch (error) {
      await capture.stop().catch(() => undefined);
      throw error;
    }
  }

  private async sampleFrame(
    options: ScreencastOptions,
    readFrame: (event: ScreencastFrame) => Frame | undefined,
    signal: AbortSignal
  ): Promise<{ frame: Frame; timestamp: number | undefined } | undefined> {
    const session = await this.page.context().newCDPSession(this.page);
    const result = Promise.withResolvers<
      { frame: Frame; timestamp: number | undefined } | undefined
    >();
    const finish = () => result.resolve(undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onFrame = (event: ScreencastFrame) => {
      if (signal.aborted) return;
      const frame = readFrame(event);
      if (frame) result.resolve({ frame, timestamp: event.metadata.timestamp });
      else
        void session.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(finish);
    };
    try {
      if (signal.aborted) return;
      session.on('Page.screencastFrame', onFrame);
      signal.addEventListener('abort', finish, { once: true });
      timer = setTimeout(finish, STATIC_FRAME_TIMEOUT_MS).unref();
      void session.send('Page.startScreencast', options).catch(finish);
      return await result.promise;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      session.off('Page.screencastFrame', onFrame);
      await session.detach().catch(() => undefined);
    }
  }
}
