import type { BrowserPageInput } from '@myagentroam/protocol';
import type { CDPSession, Page } from 'playwright';

type Frame = { jpeg: Buffer; width: number; height: number };
type Cast = { stop: () => Promise<void> };

/** Adapts a single owned Playwright page. The session owns the page and selects
 * the active view, while the attachment owns input ordering and frame transport.
 * Construct only for a browser launched within the Node's execution boundary.
 */
export class BrowserPageView {
  private active: Cast | undefined;
  private navigationSession: Promise<CDPSession> | undefined;

  constructor(private readonly page: Page) {}

  async history(): Promise<{ canGoBack: boolean; canGoForward: boolean }> {
    const { currentIndex, entries } = await (
      await this.navigation()
    ).send('Page.getNavigationHistory');
    return { canGoBack: currentIndex > 0, canGoForward: currentIndex + 1 < entries.length };
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

  async reload(): Promise<void> {
    await this.page.reload({ waitUntil: 'commit' });
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
    await this.page.goto(url.href, { waitUntil: 'commit' });
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
      case 'key':
        return keyboard[action.edge](action.key);
      case 'text':
        return keyboard.insertText(action.text);
    }
  }

  async startCapture(
    render: { width: number; height: number; quality: number },
    offer: (frame: Frame) => void
  ): Promise<Cast> {
    if (this.active) throw new Error('BROWSER_CAPTURE_BUSY');
    let stopped = false;
    let stopping: Promise<void> | undefined;
    const capture = {
      stop: () => {
        stopped = true;
        return (stopping ??= this.page.screencast.stop().finally(() => {
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
          if (!stopped) offer({ jpeg: data, width: viewportWidth, height: viewportHeight });
        }
      });
      return capture;
    } catch (error) {
      stopped = true;
      this.active = undefined;
      throw error;
    }
  }
}
