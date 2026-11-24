import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { BrowserTabSnapshot, BrowserUpload } from '@myagentroam/protocol';
import type { BrowserContext, CDPSession, Frame, Page, Request } from 'playwright';
import { BrowserDownloads } from './browser-downloads.js';
import { BrowserDialogs } from './browser-dialogs.js';
import { BrowserFileChooser } from './browser-file-chooser.js';
import { BrowserPageView } from './browser-page-view.js';
import { BROWSER_VIEWPORT, type BrowserSize } from './browser-video-config.js';
import { openBrowserWorkspaceHtml } from './browser-workspace-html.js';

type Tab = {
  id: string;
  page: Page;
  view: BrowserPageView;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  navigation: Request | undefined;
  errorUrl: string;
  revision: number;
};

const ERROR_PAGE = 'chrome-error://chromewebdata/';

/** Owns tab identities and active selection for one owned browsing context.
 * Playwright remains the source of URLs, history and popup behavior; the
 * session owns context shutdown and the attachment owns calls and snapshots.
 * A live context whose last page closes gets a single replacement blank tab.
 */
export class BrowserTabs {
  private readonly tabs = new Map<string, Tab>();
  private activeId: string | undefined;
  private viewVersion = 1;
  private agentActivity: ReturnType<typeof setTimeout> | undefined;

  get agentActive(): boolean {
    return this.agentActivity !== undefined;
  }

  markAgentActivity(): void {
    const previous = this.agentActivity;
    if (previous) {
      previous.refresh();
      return;
    }
    this.agentActivity = setTimeout(() => {
      this.agentActivity = undefined;
      this.events.emit('changed');
    }, 3_000);
    this.agentActivity.unref();
    this.events.emit('changed');
  }

  agentTabs() {
    const pages = this.context.pages();
    const { activeId, tabs } = this.snapshot();
    return {
      activeTabId: activeId ?? null,
      tabs: tabs.map(({ id, title, url }) => ({
        id,
        title,
        url,
        pageIndex: pages.indexOf(this.get(id).page)
      }))
    };
  }
  private navigationVersion = 1;
  private size: BrowserSize = BROWSER_VIEWPORT;
  private readonly events = new EventEmitter<{ changed: [] }>();
  private replacing: Promise<void> | undefined;
  private readonly endpoints = new Map<object, BrowserSize | undefined>();
  private pendingInput: Promise<void> = Promise.resolve();
  private dialogUpdate: Promise<void> = Promise.resolve();
  private presenting = false;
  private readonly dialogs: BrowserDialogs;
  private readonly downloads: BrowserDownloads;
  private readonly files: BrowserFileChooser;

  constructor(
    private readonly context: BrowserContext,
    private readonly options: {
      limit: number;
      failed: (error: unknown) => void;
      directory?: string | undefined;
      downloads?: { session: CDPSession; directory: string } | undefined;
      workspacePath?: () => string | undefined;
      favicon?: ((url: string) => Promise<string | undefined>) | undefined;
    }
  ) {
    context.once('close', () => {
      clearTimeout(this.agentActivity);
      this.agentActivity = undefined;
    });
    this.dialogs = new BrowserDialogs(context, () => this.events.emit('changed'), options.failed);
    this.files = new BrowserFileChooser(
      () => this.events.emit('changed'),
      options.failed,
      options.directory
    );
    this.downloads = new BrowserDownloads(() => this.events.emit('changed'), options.failed);
    if (options.downloads)
      this.downloads.observe(options.downloads.session, options.downloads.directory);
    context.once('close', () => this.downloads.dispose());
    for (const page of context.pages()) this.add(page, false);
    context.on('page', (page) => this.add(page, true));
  }

  get activeView(): BrowserPageView | undefined {
    return this.activeId ? this.tabs.get(this.activeId)?.view : undefined;
  }

  get viewport(): Readonly<BrowserSize> {
    return this.size;
  }

  navigationView(version: number): BrowserPageView | undefined {
    // Geometry-only versions share the same toolbar target.
    if (version >= this.navigationVersion && version <= this.viewVersion) return this.activeView;
  }

  resize(size: BrowserSize): void {
    if (size.width === this.size.width && size.height === this.size.height) return;
    this.size = size;
    this.viewVersion++;
    this.changed(false);
  }

  async stopLoading(version: number): Promise<void> {
    const tab = this.activeId ? this.tabs.get(this.activeId) : undefined;
    if (!tab || !this.navigationView(version)) return;
    const request = tab.navigation;
    await tab.view.stopLoading();
    // Chromium need not emit Playwright load/requestfailed after stopping a committed response.
    if (request && tab.navigation === request) {
      tab.navigation = undefined;
      this.changed(false);
    }
  }

  snapshot(): BrowserTabSnapshot {
    const dialog = this.dialogs.snapshot();
    const fileChooser = this.files.snapshot();
    return {
      activeId: this.activeId,
      viewVersion: this.viewVersion,
      downloadVersion: this.downloads.version,
      tabs: [...this.tabs.values()].map(
        ({ id, page, title, navigation, canGoBack, canGoForward, errorUrl }) => ({
          id,
          url: (page.url() === ERROR_PAGE ? errorUrl : page.url()).slice(
            0,
            id === this.activeId ? 8192 : 1024
          ),
          title,
          loading: navigation !== undefined,
          canGoBack,
          canGoForward
        })
      ),
      ...(dialog ? { dialog } : {}),
      ...(fileChooser ? { fileChooser } : {})
    };
  }

  observe(changed: () => void): () => void {
    this.events.on('changed', changed);
    return () => this.events.off('changed', changed);
  }

  favicon(url: string): Promise<string | undefined> | undefined {
    return this.options.favicon?.(url);
  }

  attach(endpoint: object): Promise<void> {
    this.endpoints.set(endpoint, undefined);
    return this.endpoints.size === 1 ? this.presentDialogs(true) : this.dialogUpdate;
  }

  detach(endpoint: object): Promise<void> {
    const wasFirst = this.endpoints.keys().next().value === endpoint;
    if (!this.endpoints.delete(endpoint)) return this.dialogUpdate;
    if (!this.endpoints.size) return this.presentDialogs(false);
    if (wasFirst) {
      const size = this.endpoints.values().next().value;
      if (size) this.resize(size);
    }
    return this.dialogUpdate;
  }

  resizeFor(endpoint: object, size: BrowserSize): void {
    if (!this.endpoints.has(endpoint)) return;
    this.endpoints.set(endpoint, size);
    if (this.endpoints.keys().next().value === endpoint) this.resize(size);
  }

  orderInput(action: () => Promise<void>): Promise<void> {
    const operation = this.pendingInput.then(action);
    this.pendingInput = operation.catch(() => undefined);
    return operation;
  }

  private presentDialogs(enabled: boolean): Promise<void> {
    this.presenting = enabled;
    const page = enabled && this.activeId ? this.tabs.get(this.activeId)?.page : undefined;
    const operation = this.dialogUpdate.then(async () => {
      await Promise.all([this.files.show(page), this.dialogs.show(page)]);
    });
    this.dialogUpdate = operation.catch(() => undefined);
    return operation;
  }

  upload(request: BrowserUpload): Promise<void> {
    return this.files.receive(request);
  }

  download(command: Parameters<BrowserDownloads['execute']>[0]): Promise<unknown> {
    return this.downloads.execute(command);
  }

  get activeDownloadCount(): number {
    return this.downloads.activeCount;
  }

  get startedDownloadCount(): number {
    return this.downloads.startedCount;
  }

  cancelDownloads(): Promise<void> {
    return this.downloads.cancelActive();
  }

  respondToDialog(id: string, accept: boolean, text?: string): Promise<void> {
    return this.dialogs.respond(id, accept, text);
  }

  async open(address?: string): Promise<void> {
    return this.openTab(address === undefined ? undefined : (tab) => tab.view.navigate(address));
  }

  async openHtml(path: string): Promise<void> {
    return this.openTab(({ page }) =>
      openBrowserWorkspaceHtml(
        page,
        () => (this.presenting ? this.options.workspacePath?.() : undefined),
        path
      )
    );
  }

  private async openTab(navigate?: (tab: Tab) => Promise<void>): Promise<void> {
    if (this.replacing) await this.replacing;
    if (this.tabs.size >= this.options.limit) throw new Error('BROWSER_TAB_LIMIT');
    const previous = this.activeId;
    const page = await this.context.newPage();
    if (!navigate) return;
    const opened = [...this.tabs.values()].find((tab) => tab.page === page);
    try {
      if (!opened) throw new Error('BROWSER_TAB_ENDED');
      await navigate(opened);
    } catch (error) {
      const restore = this.activeId === opened?.id;
      await page.close().catch(this.options.failed);
      if (restore && page.isClosed() && previous && this.tabs.has(previous)) this.select(previous);
      throw error;
    }
  }

  select(id: string): void {
    this.get(id);
    if (id === this.activeId) return;
    this.activeId = id;
    this.changed(true);
  }

  async close(id: string): Promise<void> {
    await this.get(id).page.close();
    await this.replacing;
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
    const tab: Tab = {
      id,
      page,
      view: new BrowserPageView(page),
      title: '',
      canGoBack: false,
      canGoForward: false,
      navigation: undefined,
      errorUrl: '',
      revision: 0
    };
    this.tabs.set(id, tab);
    this.files.listen(page);
    if (!this.options.downloads) this.downloads.listen(page);
    this.activeId = id;
    page.on('request', (request) => {
      if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) return;
      tab.navigation = request;
      this.changed(false);
    });
    page.on('requestfailed', (request) => {
      if (tab.navigation !== request) return;
      tab.navigation = undefined;
      this.changed(false);
    });
    page.on('domcontentloaded', () => this.updatePresentation(tab));
    page.on('load', () => {
      tab.navigation = undefined;
      this.changed(false);
      this.updatePresentation(tab);
    });
    page.on('framenavigated', (frame: Frame) => {
      if (frame !== page.mainFrame()) return;
      tab.errorUrl = '';
      this.changed(this.activeId === id);
      this.updatePresentation(tab);
    });
    page.once('close', () => {
      this.tabs.delete(id);
      const wasActive = this.activeId === id;
      if (wasActive) this.activeId = [...this.tabs.keys()].at(-1);
      if (this.tabs.size === 0 && !this.context.isClosed() && !this.replacing) {
        this.replacing = this.context
          .newPage()
          .then(() => undefined)
          .catch((error: unknown) => {
            if (!this.context.isClosed()) this.options.failed(error);
          })
          .finally(() => {
            this.replacing = undefined;
          });
      }
      this.changed(wasActive);
    });
    if (notify) this.changed(true);
    this.updatePresentation(tab);
  }

  private updatePresentation(tab: Tab): void {
    const revision = ++tab.revision;
    void Promise.all([tab.page.title(), tab.view.history()])
      .then(([title, history]) => {
        if (!history || tab.revision !== revision || this.tabs.get(tab.id) !== tab) return;
        const nextTitle = title.slice(0, 256);
        // Chromium's committed history entry retains the actual URL, including a failed redirect.
        const currentUrl = history.currentUrl ?? '';
        const errorUrl =
          tab.page.url() === ERROR_PAGE && /^https?:\/\//iu.test(currentUrl) ? currentUrl : '';
        if (
          tab.title === nextTitle &&
          tab.errorUrl === errorUrl &&
          tab.canGoBack === history.canGoBack &&
          tab.canGoForward === history.canGoForward
        )
          return;
        tab.title = nextTitle;
        tab.errorUrl = errorUrl;
        tab.canGoBack = history.canGoBack;
        tab.canGoForward = history.canGoForward;
        this.changed(false);
      })
      .catch((error: unknown) => {
        if (
          !this.context.isClosed() &&
          !tab.page.isClosed() &&
          tab.revision === revision &&
          this.tabs.get(tab.id) === tab
        )
          this.options.failed(error);
      });
  }

  private changed(viewChanged: boolean): void {
    if (viewChanged) {
      this.navigationVersion = ++this.viewVersion;
      if (this.presenting) void this.presentDialogs(true).catch(this.options.failed);
    }
    this.events.emit('changed');
  }
}
