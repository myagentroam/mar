import { setTimeout as delay } from 'node:timers/promises';
import type { BrowserPageInput } from '@myagentroam/protocol';
import type { CDPSession, Page } from 'playwright';
import { BrowserContextMenu } from './browser-context-menu.js';
import { BrowserPageFind } from './browser-page-find.js';
import { BrowserPageZoom } from './browser-page-zoom.js';

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

  resize(size: { width: number; height: number }): Promise<void> {
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
    render: { width: number; height: number },
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
    render: { width: number; height: number },
    offer: (frame: Frame) => void,
    fps?: () => number
  ): Promise<BrowserPageCapture> {
    const viewport = this.page.viewportSize();
    // A separate CDP session gives each attachment its own size and frame credit.
    const session = await this.page.context().newCDPSession(this.page);
    let stopped = false;
    let receivedFrame = false;
    let stopping: Promise<void> | undefined;
    let lastAck = -Infinity;
    let ackTimer: ReturnType<typeof setTimeout> | undefined;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    let lastFrameAt = -Infinity;
    let lastTimestamp = -Infinity;
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
    const publish = (png: Buffer, width: number, height: number, scrollY?: number) => {
      const image = pngSize(png);
      // CDP can report the new CSS viewport with an old compositor surface.
      // Allow rounding at the raster edge, but do not present a cropped surface as the full page.
      if (
        !image ||
        !image.width ||
        !image.height ||
        image.width > render.width ||
        image.height > render.height ||
        Math.abs(image.width * height - image.height * width) > 2 * (width + height)
      )
        return;
      receivedFrame = true;
      offer({ png, width, height, ...(scrollY !== undefined && { scrollY }) });
    };
    const queueSeed = (waiting: () => boolean) => {
      if (!viewport) return;
      const current = () => {
        const size = this.page.viewportSize();
        return (
          !stopped && size?.width === viewport.width && size.height === viewport.height && waiting()
        );
      };
      this.pendingViewport = this.pendingViewport
        .then(() =>
          this.seedFrame(viewport, render, current, (png) =>
            publish(png, viewport.width, viewport.height)
          )
        )
        .catch(() => undefined);
    };
    const onFrame = (event: {
      data: string;
      metadata: {
        deviceWidth: number;
        deviceHeight: number;
        scrollOffsetY?: number;
        timestamp?: number;
      };
      sessionId: number;
    }) => {
      const { data, metadata, sessionId } = event;
      const { deviceWidth: width, deviceHeight: height } = metadata;
      if (!stopped) {
        // Pace credit rather than sampling every Nth frame, which can lose a
        // single repaint when a page becomes static.
        credits.push(sessionId);
        scheduleAck();
        // Chromium may queue a frame using the old viewport during resize.
        if (!viewport || (viewport.width === width && viewport.height === height)) {
          const timestamp = metadata.timestamp;
          if (timestamp !== undefined && timestamp < lastTimestamp) return;
          if (timestamp !== undefined) lastTimestamp = timestamp;
          const previous = lastFrameAt;
          const at = (lastFrameAt = performance.now());
          // Chromium can drop the last repaint when all capture credits are
          // outstanding. Take one exact sample after a paced burst goes quiet.
          if (fps) {
            const quiet = Math.max(CAPTURE_SETTLE_MS, 2_000 / fps());
            if (at - previous < quiet) {
              clearTimeout(settleTimer);
              settleTimer = setTimeout(() => queueSeed(() => lastFrameAt === at), quiet).unref();
            }
          }
          publish(Buffer.from(data, 'base64'), width, height, metadata.scrollOffsetY);
        }
      }
    };
    const capture = {
      stop: () => {
        stopped = true;
        clearTimeout(ackTimer);
        clearTimeout(settleTimer);
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
      await session.send('Page.startScreencast', {
        format: 'png',
        maxWidth: render.width,
        maxHeight: render.height
      });
      // A new viewer can subscribe to a static page without triggering a
      // repaint. Serialize clip captures and resizes because Chromium saves the
      // old viewport before taking a clipped screenshot and restores it afterward.
      if (!receivedFrame) queueSeed(() => !receivedFrame);
      return capture;
    } catch (error) {
      await capture.stop().catch(() => undefined);
      throw error;
    }
  }

  private async seedFrame(
    viewport: { width: number; height: number },
    render: { width: number; height: number },
    waiting: () => boolean,
    publish: (png: Buffer) => void
  ): Promise<void> {
    if (!waiting()) return;
    // Navigation can leave the screenshot unanswered. Never make stopping a
    // screencast wait for its seed; only serialize viewport changes with it.
    const session = await this.page.context().newCDPSession(this.page);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let restoreViewport = false;
    let expired = false;
    try {
      const seed = async () => {
        const { visualViewport, contentSize, cssContentSize } =
          await session.send('Page.getLayoutMetrics');
        if (expired || !waiting()) return;
        // CDP clip scale is relative to device pixels, not CSS pixels.
        const density = contentSize.width / cssContentSize.width || 1;
        const scale = Math.min(
          1,
          render.width / (viewport.width * density),
          render.height / (viewport.height * density)
        );
        restoreViewport = true;
        const { data } = await session.send('Page.captureScreenshot', {
          format: 'png',
          clip: {
            x: visualViewport.pageX,
            y: visualViewport.pageY,
            width: viewport.width / visualViewport.scale,
            height: viewport.height / visualViewport.scale,
            scale: scale * visualViewport.scale
          }
        });
        restoreViewport = false;
        return data;
      };
      const data = await Promise.race([
        seed(),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => {
            expired = true;
            resolve(undefined);
          }, STATIC_FRAME_TIMEOUT_MS);
        })
      ]);
      if (data && waiting()) publish(Buffer.from(data, 'base64'));
    } finally {
      clearTimeout(timer);
      const restore = restoreViewport;
      await session.detach().catch(() => undefined);
      if (restore && !this.page.isClosed()) await this.page.setViewportSize(viewport);
    }
  }
}
