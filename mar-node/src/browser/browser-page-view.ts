import type { BrowserPageInput } from '@myagentroam/protocol';
import type { CDPSession, Page } from 'playwright';
import { BrowserContextMenu } from './browser-context-menu.js';

type Frame = { jpeg: Buffer; width: number; height: number };
export type BrowserPageCapture = { stop: () => Promise<void> };

/** Adapts a single owned Playwright page. The session owns the page and selects
 * the active view, while the attachment owns input ordering and frame transport.
 * Construct only for a browser launched within the Node's execution boundary.
 */
export class BrowserPageView {
  private active: BrowserPageCapture | undefined;
  private navigationSession: Promise<CDPSession> | undefined;
  readonly contextMenu: BrowserContextMenu;

  constructor(private readonly page: Page) {
    this.contextMenu = new BrowserContextMenu(page);
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

  async resize(size: { width: number; height: number }): Promise<boolean> {
    const current = this.page.viewportSize();
    if (current?.width === size.width && current.height === size.height) return false;
    await this.page.setViewportSize(size);
    return true;
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
    if (touch) await this.touch('cancel');
    for (const key of keys) await this.page.keyboard.up(key);
    for (const button of buttons) await this.page.mouse.up({ button });
  }

  async selectedText(): Promise<string> {
    for (const frame of this.page.frames()) {
      const text = await frame
        .evaluate(() => {
          if (!document.hasFocus()) return '';
          const field = document.activeElement;
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
    offer: (frame: Frame) => void,
    resized = false
  ): Promise<BrowserPageCapture> {
    if (this.active) throw new Error('BROWSER_CAPTURE_BUSY');
    const viewport = this.page.viewportSize();
    let stopped = false;
    let receivedFrame = false;
    let stopping: Promise<void> | undefined;
    const capture = {
      stop: () => {
        stopped = true;
        return (stopping ??= (
          this.page.isClosed() ? Promise.resolve() : this.page.screencast.stop()
        )
          .catch((error: unknown) => {
            if (!this.page.isClosed()) throw error;
          })
          .finally(() => {
            this.active = undefined;
          }));
      }
    };
    this.active = capture;
    try {
      await this.page.screencast.start({
        size: { width: render.width, height: render.height },
        quality: render.quality,
        onFrame: ({ data, viewportWidth, viewportHeight }) => {
          // Chromium may deliver a queued frame from before setViewportSize to the new capture.
          if (
            !stopped &&
            (!viewport || (viewport.width === viewportWidth && viewport.height === viewportHeight))
          ) {
            receivedFrame = true;
            offer({ jpeg: data, width: viewportWidth, height: viewportHeight });
          }
        }
      });
      // A static page may repaint before the new screencast subscribes. Seed that
      // resized view once, without overwriting a newer compositor frame.
      if (resized && viewport && !stopped && !receivedFrame) {
        void this.page
          .screenshot({ type: 'jpeg', quality: render.quality, scale: 'css', timeout: 3_000 })
          .then(
            (jpeg) => {
              if (!stopped && !receivedFrame) offer({ jpeg, ...viewport });
            },
            () => undefined
          );
      }
      return capture;
    } catch (error) {
      stopped = true;
      this.active = undefined;
      throw error;
    }
  }
}
