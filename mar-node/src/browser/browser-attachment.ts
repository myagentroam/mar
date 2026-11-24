import type {
  BrowserAttachmentEvent,
  BrowserDownloadRequest,
  BrowserAttachmentMessage,
  BrowserPageInput,
  BrowserUpload
} from '@myagentroam/protocol';
import { setTimeout as delay } from 'node:timers/promises';
import { BrowserFrameStream } from './browser-frame-stream.js';
import type { BrowserPageCapture, BrowserPageView } from './browser-page-view.js';
import type { BrowserTabs } from './browser-tabs.js';
import { browserEncodeSize, type BrowserSize } from './browser-video-config.js';

type Encoder = ConstructorParameters<typeof BrowserFrameStream>[0]['encode'];
type Command = Exclude<BrowserAttachmentMessage, { type: 'ack' | 'dialog.respond' }>;
type Button = Extract<BrowserPageInput, { type: 'button' }>['button'];
export type BrowserAttachmentEncoder = { encode: Encoder; close: () => Promise<void> };
const COMMAND_LIMIT = 64;
const COMMAND_ERRORS = new Set([
  'BROWSER_TAB_LIMIT',
  'BROWSER_TAB_ENDED',
  'BROWSER_HTML_UNAVAILABLE',
  'BROWSER_NAVIGATION_FAILED',
  'BROWSER_TAB_NAVIGATION_FAILED',
  'BROWSER_INVALID_ADDRESS'
]);

/** One interactive borrower of a browser session. Owns in-flight commands,
 * pressed input, capture and encoder disposal; its caller owns channel lifetime
 * and authorization. The tabs remain owned by the browser session.
 */
export class BrowserAttachment {
  private readonly stream: BrowserFrameStream;
  private readonly unobserve: () => void;
  private readonly queue: Command[] = [];
  private capture: BrowserPageCapture | undefined;
  private capturing: Promise<void> | undefined;
  private running: Promise<void> | undefined;
  private stopping: Promise<void> | undefined;
  private answering: Promise<void> | undefined;
  private uploading: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private closed = false;
  private icons: Map<string, { url: string }> | undefined;
  private shown: number | undefined;
  private next:
    { version: number; page: BrowserPageView | undefined; size: Readonly<BrowserSize> } | undefined;
  private captureTarget: typeof this.next;
  private pressed:
    | {
        page: BrowserPageView;
        version: number;
        keys: Set<string>;
        buttons: Set<Button>;
        touch: boolean;
      }
    | undefined;

  constructor(
    private readonly borrow: { resource: BrowserTabs; release: () => void },
    private readonly options: {
      quality: number;
      encoder: BrowserAttachmentEncoder;
      sendFrame: ConstructorParameters<typeof BrowserFrameStream>[0]['send'];
      sendControl: (event: BrowserAttachmentEvent) => void;
      captured?: (bytes: number) => void;
      failed: (code: string) => void;
      deadlineMs: number;
    }
  ) {
    this.stream = new BrowserFrameStream({
      encode: options.encoder.encode,
      send: options.sendFrame,
      failed: (code) => this.fail(code),
      deadlineMs: options.deadlineMs
    });
    this.unobserve = borrow.resource.observe(() => this.refresh());
    void borrow.resource.presentDialogs(true).catch(() => this.fail('BROWSER_DIALOG_FAILED'));
    this.refresh();
  }

  receive(message: BrowserAttachmentMessage): void {
    if (this.closed) return;
    if (message.type === 'tab.icons') {
      if (!this.icons) {
        this.icons = new Map();
        this.refreshIcons(this.borrow.resource.snapshot());
      }
      return;
    }
    if (message.type === 'ack') {
      const version = this.stream.acknowledge(message.sequence);
      if (version !== undefined && version === this.next?.version) this.shown = version;
      return;
    }
    if (message.type === 'dialog.respond') {
      if (!this.answering) {
        this.answering = this.borrow.resource
          .respondToDialog(message.id, message.accept, message.text)
          .catch((error: unknown) => this.commandFailed(error))
          .finally(() => {
            this.answering = undefined;
          });
      }
      return;
    }
    if (message.type === 'navigation' && message.action === 'stop') {
      if (!this.stopping) {
        this.stopping = this.borrow.resource
          .stopLoading(message.viewVersion)
          .catch((error: unknown) => this.commandFailed(error))
          .finally(() => {
            this.stopping = undefined;
          });
      }
      return;
    }
    if (message.type === 'input' && this.shown !== message.action.viewVersion) return;
    const tail = this.queue.at(-1);
    if (
      (message.type === 'viewport.resize' && tail?.type === 'viewport.resize') ||
      (message.type === 'input' &&
        message.action.type === 'move' &&
        tail?.type === 'input' &&
        tail.action.type === 'move') ||
      (message.type === 'input' &&
        message.action.type === 'touch' &&
        message.action.phase === 'move' &&
        tail?.type === 'input' &&
        tail.action.type === 'touch' &&
        tail.action.phase === 'move' &&
        tail.action.viewVersion === message.action.viewVersion)
    ) {
      this.queue[this.queue.length - 1] = message;
    } else {
      if (this.queue.length >= COMMAND_LIMIT) return this.fail('BROWSER_COMMAND_QUEUE_FULL');
      this.queue.push(message);
    }
    this.drain();
  }

  download(request: BrowserDownloadRequest): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('BROWSER_LEASE_ENDED'));
    return this.borrow.resource.download(request.command);
  }

  upload(request: BrowserUpload): Promise<void> {
    if (this.closed || this.uploading) return Promise.reject(new Error('BROWSER_UPLOAD_INVALID'));
    if (request.command.action !== 'finish') return this.borrow.resource.upload(request);
    const operation = this.borrow.resource.upload(request).finally(() => {
      this.uploading = undefined;
    });
    this.uploading = operation;
    return operation;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.unobserve();
    this.stream.close();
    this.queue.length = 0;
    this.closing = this.dispose();
    return this.closing;
  }

  private async dispose(): Promise<void> {
    const operations = await Promise.allSettled([
      this.running,
      this.stopping,
      this.answering,
      this.uploading?.catch(() => undefined),
      this.capturing,
      this.options.encoder.close(),
      this.borrow.resource.presentDialogs(false)
    ]);
    const cleanup = await Promise.allSettled([this.capture?.stop(), this.releaseInput()]);
    this.borrow.release();
    const failure = [...operations, ...cleanup].find((value) => value.status === 'rejected');
    if (failure) throw failure.reason;
  }

  private refresh(): void {
    if (this.closed) return;
    const snapshot = this.borrow.resource.snapshot();
    try {
      this.options.sendControl({ type: 'snapshot', snapshot });
    } catch {
      this.fail('BROWSER_FRAME_TRANSPORT_FAILED');
      return;
    }
    this.refreshIcons(snapshot);
    if (snapshot.viewVersion === this.next?.version) return;
    this.next = {
      version: snapshot.viewVersion,
      page: this.borrow.resource.activeView,
      size: this.borrow.resource.viewport
    };
    this.shown = undefined;
    this.stream.setView(snapshot.viewVersion);
    this.updateCapture();
    this.drain();
  }

  private refreshIcons(snapshot: ReturnType<BrowserTabs['snapshot']>): void {
    const icons = this.icons;
    if (!icons) return;
    for (const id of icons.keys()) {
      if (!snapshot.tabs.some((tab) => tab.id === id)) icons.delete(id);
    }
    for (const { id, url, loading } of snapshot.tabs) {
      if (loading || !/^https?:\/\//iu.test(url)) {
        icons.delete(id);
        continue;
      }
      if (icons.get(id)?.url === url) continue;
      const lookup = { url };
      icons.set(id, lookup);
      void this.sendIcon(id, lookup).catch(() => undefined);
    }
  }

  private async sendIcon(id: string, lookup: { url: string }): Promise<void> {
    const current = () => !this.closed && this.icons?.get(id) === lookup;
    // The profile records favicons asynchronously, independently of page load.
    for (const wait of [0, 150, 400, 1_000]) {
      if (wait) await delay(wait, undefined, { ref: false });
      if (!current()) return;
      const read = this.borrow.resource.favicon(lookup.url);
      if (!read) return;
      const png = await read;
      if (png && current()) {
        this.options.sendControl({ type: 'tab.icon', tabId: id, url: lookup.url, png });
        return;
      }
    }
  }

  private updateCapture(): void {
    if (this.closed || this.capturing || this.captureTarget === this.next) return;
    this.capturing = this.captureLatest()
      .catch(() => this.fail('BROWSER_CAPTURE_FAILED'))
      .finally(() => {
        this.capturing = undefined;
        this.updateCapture();
      });
  }

  private async captureLatest(): Promise<void> {
    while (!this.closed && this.captureTarget !== this.next) {
      const target = this.next;
      this.captureTarget = target;
      const capture = this.capture;
      this.capture = undefined;
      await capture?.stop();
      if (this.closed || target !== this.next || !target?.page) continue;
      const resized = await target.page.resize(target.size);
      if (this.closed || target !== this.next) continue;
      const version = target.version;
      this.capture = await target.page.startCapture(
        { ...browserEncodeSize(target.size), quality: this.options.quality },
        (frame) => {
          this.options.captured?.(frame.jpeg.byteLength);
          this.stream.offer({ ...frame, viewVersion: version });
        },
        resized
      );
    }
  }

  private drain(): void {
    if (this.running || this.closed || (!this.queue.length && !this.pressed)) return;
    this.running = Promise.resolve()
      .then(async () => {
        while (!this.closed) {
          if (this.pressed && this.pressed.version !== this.next?.version)
            await this.releaseInput();
          if (this.closed) break;
          const command = this.queue.shift();
          if (!command) break;
          try {
            await this.dispatch(command);
          } catch (error) {
            this.commandFailed(
              command.type === 'tab.open' &&
                error instanceof Error &&
                error.message === 'BROWSER_NAVIGATION_FAILED'
                ? new Error('BROWSER_TAB_NAVIGATION_FAILED')
                : error
            );
          }
        }
      })
      .catch(() => this.fail('BROWSER_INPUT_RELEASE_FAILED'))
      .finally(() => {
        this.running = undefined;
        if (this.queue.length || (this.pressed && this.pressed.version !== this.next?.version))
          this.drain();
      });
  }

  private async dispatch(command: Command): Promise<void> {
    const tabs = this.borrow.resource;
    switch (command.type) {
      case 'viewport.resize':
        return tabs.resize({ width: command.width, height: command.height });
      case 'tab.open':
        return tabs.open(command.address);
      case 'tab.openHtml':
        return tabs.openHtml(command.path);
      case 'tab.select':
        return tabs.select(command.tabId);
      case 'tab.close':
        return tabs.close(command.tabId);
      case 'selection.copy': {
        const view = this.next;
        const text =
          view?.version === command.viewVersion && view.page ? await view.page.selectedText() : '';
        if (!this.closed)
          this.options.sendControl({
            type: 'selection',
            id: command.id,
            text: this.next === view ? text : ''
          });
        return;
      }
      case 'input': {
        const action = command.action;
        const page = this.next?.page;
        if (!page || action.viewVersion !== this.shown || action.viewVersion !== this.next?.version)
          return;
        if (action.type === 'touch' && (action.phase === 'start') === !!this.pressed?.touch) return;
        if (action.type === 'key' || action.type === 'button' || action.type === 'touch') {
          await page.input(action);
          const pressed = (this.pressed ??= {
            page,
            version: action.viewVersion,
            keys: new Set(),
            buttons: new Set(),
            touch: false
          });
          if (action.type === 'touch')
            pressed.touch = action.phase === 'start' || action.phase === 'move';
          else {
            const method = action.edge === 'down' ? 'add' : 'delete';
            if (action.type === 'key') pressed.keys[method](action.key);
            else pressed.buttons[method](action.button);
          }
          if (!pressed.keys.size && !pressed.buttons.size && !pressed.touch)
            this.pressed = undefined;
          return;
        }
        return page.input(action);
      }
      case 'navigate':
      case 'navigation': {
        const page = tabs.navigationView(command.viewVersion);
        if (!page) return;
        if (command.type === 'navigate') return page.navigate(command.address);
        if (command.action === 'reload') return page.reload();
        if (command.action === 'back' || command.action === 'forward')
          return page.travel(command.action === 'back' ? -1 : 1);
      }
    }
  }

  private async releaseInput(): Promise<void> {
    const pressed = this.pressed;
    this.pressed = undefined;
    if (pressed) await pressed.page.releaseInput(pressed.keys, pressed.buttons, pressed.touch);
  }

  private commandFailed(error: unknown): void {
    if (this.closed || (error instanceof Error && error.message === 'BROWSER_NAVIGATION_ABORTED'))
      return;
    const code =
      error instanceof Error && COMMAND_ERRORS.has(error.message)
        ? error.message
        : 'BROWSER_COMMAND_FAILED';
    try {
      this.options.sendControl({ type: 'command.failed', code });
    } catch {
      this.fail('BROWSER_FRAME_TRANSPORT_FAILED');
    }
  }

  private fail(code: string): void {
    if (this.closed) return;
    void this.close().catch(() => undefined);
    this.options.failed(code);
  }
}
