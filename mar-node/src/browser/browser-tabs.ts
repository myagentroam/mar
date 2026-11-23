import { randomUUID } from 'node:crypto';
import type { BrowserContext, Frame, Page } from 'playwright';
import { BrowserPageView } from './browser-page-view.js';

type Tab = { id: string; page: Page; view: BrowserPageView };

/** Owns tab identities and active selection for one owned browsing context.
 * Playwright remains the source of URLs, history and popup behavior; the
 * session owns context shutdown and the attachment owns calls and snapshots.
 */
export class BrowserTabs {
  private readonly tabs = new Map<string, Tab>();
  private activeId: string | undefined;

  constructor(
    private readonly context: BrowserContext,
    private readonly options: {
      limit: number;
      changed: () => void;
      failed: (error: unknown) => void;
    }
  ) {
    for (const page of context.pages()) this.add(page, false);
    context.on('page', (page) => this.add(page, true));
  }

  get activeView(): BrowserPageView | undefined {
    return this.activeId ? this.tabs.get(this.activeId)?.view : undefined;
  }

  snapshot() {
    return {
      activeId: this.activeId,
      tabs: [...this.tabs.values()].map(({ id, page }) => ({ id, url: page.url() }))
    };
  }

  async open(): Promise<void> {
    if (this.tabs.size >= this.options.limit) throw new Error('BROWSER_TAB_LIMIT');
    await this.context.newPage();
  }

  select(id: string): void {
    this.get(id);
    if (id === this.activeId) return;
    this.activeId = id;
    this.options.changed();
  }

  async close(id: string): Promise<void> {
    await this.get(id).page.close();
    if (this.tabs.size === 0) await this.open();
  }

  private get(id: string): Tab {
    const tab = this.tabs.get(id);
    if (!tab) throw new Error('BROWSER_TAB_ENDED');
    return tab;
  }

  private add(page: Page, notify: boolean): void {
    if (this.tabs.size >= this.options.limit) {
      void page.close().catch(this.options.failed);
      return;
    }
    const id = randomUUID();
    this.tabs.set(id, { id, page, view: new BrowserPageView(page) });
    this.activeId = id;
    page.on('framenavigated', (frame: Frame) => {
      if (frame === page.mainFrame()) this.options.changed();
    });
    page.once('close', () => {
      this.tabs.delete(id);
      if (this.activeId === id) this.activeId = [...this.tabs.keys()].at(-1);
      this.options.changed();
    });
    if (notify) this.options.changed();
  }
}
