import type { BrowserPageInput } from '@myagentroam/protocol';
import type { CDPSession, Page } from 'playwright';
import { BrowserContextMenu } from './browser-context-menu.js';
import { browserJpegSize } from './browser-jpeg.js';
import { BrowserPageFind } from './browser-page-find.js';

type Frame = { jpeg: Buffer; width: number; height: number };
export type BrowserPageCapture = { stop: () => Promise<void> };

/** Adapts a single owned Playwright page. The session owns the page and selects
 * the active view, while the attachment owns input ordering and frame transport.
 * Construct only for a browser launched within the Node's execution boundary.
 */
export class BrowserPageView {
  private pendingResize: Promise<void> = Promise.resolve();
  private inputOwner: object | undefined;
  private navigationSession: Promise<CDPSession> | undefined;
  private pendingSeed: Promise<void> = Promise.resolve();
  readonly contextMenu: BrowserContextMenu;
  readonly find: BrowserPageFind;

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

  resize(size: { width: number; height: number }): Promise<void> {
    const operation = this.pendingResize.then(async () => {
      const current = this.page.viewportSize();
      if (current?.width !== size.width || current.height !== size.height)
        await this.page.setViewportSize(size);
    });
    this.pendingResize = operation.catch(() => undefined);
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
  acceptsInput(owner: object): boolean {
    return !this.inputOwner || this.inputOwner === owner;
  }

  holdInput(owner: object): void {
    this.inputOwner = owner;
  }

  clearInputHold(owner: object): void {
    if (this.inputOwner === owner) this.inputOwner = undefined;
  }

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
    render: { width: number; height: number; quality: number },
    offer: (frame: Frame) => void
  ): Promise<BrowserPageCapture> {
    const viewport = this.page.viewportSize();
    // A separate CDP session gives each attachment its own size and frame credit.
    const session = await this.page.context().newCDPSession(this.page);
    let stopped = false;
    let receivedFrame = false;
    let stopping: Promise<void> | undefined;
    const publish = (jpeg: Buffer, width: number, height: number) => {
      const image = browserJpegSize(jpeg);
      // CDP can report the new CSS viewport with an old compositor surface.
      // Allow rounding at the raster edge, but do not present a cropped surface as the full page.
      if (
        !image ||
        image.width > render.width ||
        image.height > render.height ||
        Math.abs(image.width * height - image.height * width) > 2 * (width + height)
      )
        return;
      receivedFrame = true;
      offer({ jpeg, width, height });
    };
    const onFrame = (event: {
      data: string;
      metadata: { deviceWidth: number; deviceHeight: number };
      sessionId: number;
    }) => {
      const { data, metadata, sessionId } = event;
      const { deviceWidth: width, deviceHeight: height } = metadata;
      if (!stopped) {
        void session.send('Page.screencastFrameAck', { sessionId }).catch(() => undefined);
        // Chromium may queue a frame using the old viewport during resize.
        if (!viewport || (viewport.width === width && viewport.height === height)) {
          publish(Buffer.from(data, 'base64'), width, height);
        }
      }
    };
    const capture = {
      stop: () => {
        stopped = true;
        session.off('Page.screencastFrame', onFrame);
        return (stopping ??= session.detach().catch((error: unknown) => {
          if (!this.page.isClosed()) throw error;
        }));
      }
    };
    try {
      session.on('Page.screencastFrame', onFrame);
      await session.send('Page.startScreencast', {
        format: 'jpeg',
        maxWidth: render.width,
        maxHeight: render.height,
        quality: render.quality
      });
      // A new viewer can subscribe to a static page without triggering a
      // repaint. Serialize clip captures across viewers; Chromium may temporarily
      // change its capture viewport while a clipped screenshot is in flight.
      if (viewport && !stopped && !receivedFrame) {
        const waiting = () => {
          const current = this.page.viewportSize();
          return (
            !stopped &&
            !receivedFrame &&
            current?.width === viewport.width &&
            current.height === viewport.height
          );
        };
        this.pendingSeed = this.pendingSeed
          .then(async () => {
            if (!waiting()) return;
            const { visualViewport, contentSize, cssContentSize } =
              await session.send('Page.getLayoutMetrics');
            if (!waiting()) return;
            // CDP clip scale is relative to device pixels, not CSS pixels.
            const density = contentSize.width / cssContentSize.width || 1;
            const scale = Math.min(
              1,
              render.width / (viewport.width * density),
              render.height / (viewport.height * density)
            );
            const { data } = await session.send('Page.captureScreenshot', {
              format: 'jpeg',
              quality: render.quality,
              clip: {
                x: visualViewport.pageX,
                y: visualViewport.pageY,
                width: viewport.width / visualViewport.scale,
                height: viewport.height / visualViewport.scale,
                scale: scale * visualViewport.scale
              }
            });
            if (waiting()) publish(Buffer.from(data, 'base64'), viewport.width, viewport.height);
          })
          .catch(() => undefined);
      }
      return capture;
    } catch (error) {
      await capture.stop().catch(() => undefined);
      throw error;
    }
  }
}
