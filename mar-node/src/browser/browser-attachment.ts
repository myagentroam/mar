import type {
  BrowserAttachmentEvent,
  BrowserDownloadRequest,
  BrowserAttachmentMessage,
  BrowserPageInput,
  BrowserUpload,
  BrowserUploadStream
} from '@myagentroam/protocol';
import type { NodeStream } from '@myagentroam/protocol/node-stream';
import { setTimeout as delay } from 'node:timers/promises';
import { BrowserVncStream } from './browser-vnc-stream.js';
import type { BrowserPageCapture, BrowserPageView } from './browser-page-view.js';
import type { BrowserTabs } from './browser-tabs.js';
import { browserStreamSize, type BrowserSize } from './browser-capture-config.js';

type Command = Exclude<
  BrowserAttachmentMessage,
  { type: 'rfb' | 'quality' | 'ack' | 'presence' | 'dialog.respond' | 'agent.activity.observe' }
>;
type Button = Extract<BrowserPageInput, { type: 'button' }>['button'];
const COMMAND_LIMIT = 64;
// A wheel sample can carry its own pointer move. Budget that burst separately
// from ordered controls without changing the order in which any command runs.
const POINTER_COMMAND_LIMIT = 256;
const isPointerCommand = (command: Command) =>
  command.type === 'input' && (command.action.type === 'move' || command.action.type === 'wheel');
const COMMAND_ERRORS = new Set([
  'BROWSER_TAB_LIMIT',
  'BROWSER_TAB_ENDED',
  'BROWSER_HTML_UNAVAILABLE',
  'BROWSER_NAVIGATION_FAILED',
  'BROWSER_TAB_NAVIGATION_FAILED',
  'BROWSER_RESTORE_NOT_BLANK',
  'BROWSER_TAB_RESTORE_INCOMPLETE',
  'BROWSER_INVALID_ADDRESS'
]);

/** One interactive borrower of a browser session. Owns in-flight commands,
 * pressed input, capture and framebuffer disposal; its caller owns channel lifetime
 * and authorization. The tabs remain owned by the browser session.
 */
export class BrowserAttachment {
  private readonly stream: BrowserVncStream;
  private readonly unobserve: () => void;
  private readonly queue: Command[] = [];
  private queuedPointerCommands = 0;
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
  private contextPasteId: string | undefined;
  private findPage: BrowserPageView | undefined;
  private next:
    | {
        version: number;
        page: BrowserPageView | undefined;
        size: Readonly<BrowserSize>;
        raster: BrowserSize;
      }
    | undefined;
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
    private readonly borrow: {
      resource: BrowserTabs;
      release: () => void;
      activity: () => boolean;
    },
    private readonly options: {
      relay: boolean;
      sendFrame: ConstructorParameters<typeof BrowserVncStream>[0]['send'];
      sendControl: (event: BrowserAttachmentEvent) => void;
      failed: (code: string) => void;
      deadlineMs: number;
    }
  ) {
    this.stream = new BrowserVncStream({
      relay: options.relay,
      handshake: (data) => options.sendControl({ type: 'rfb', data }),
      changed: (quality) => {
        options.sendControl({ type: 'quality', quality });
        this.updateRaster();
      },
      send: options.sendFrame,
      failed: (code) => this.fail(code),
      deadlineMs: options.deadlineMs
    });
    this.unobserve = borrow.resource.observe(() => this.refresh());
    void borrow.resource.attach(this).catch(() => this.fail('BROWSER_DIALOG_FAILED'));
    this.refresh();
    this.stream.start();
    options.sendControl({ type: 'quality', quality: this.stream.quality });
  }

  receive(message: BrowserAttachmentMessage): void {
    if (this.closed) return;
    if (message.type === 'presence') {
      this.borrow.activity();
      return;
    }
    if (message.type === 'tab.controls.observe') {
      this.tabControlsSubscribed = true;
      this.refresh();
      return;
    }
    if (message.type === 'agent.activity.observe') {
      this.agentActivitySubscribed = true;
      this.refresh();
      return;
    }
    if (message.type === 'downloads.observe') {
      this.downloadsSubscribed = true;
      this.downloadProgressSubscribed = message.progress === true;
      this.refresh();
      return;
    }
    if (message.type === 'tab.icons') {
      if (!this.icons) {
        this.icons = new Map();
        this.refreshIcons(this.borrow.resource.snapshot());
      }
      return;
    }
    if (message.type === 'rfb') {
      this.stream.receive(Buffer.from(message.data, 'base64'));
      return;
    }
    if (message.type === 'quality') {
      this.stream.select(message.mode);
      return;
    }
    if (message.type === 'ack') {
      const version = this.stream.acknowledge(message.sequence);
      if (version !== undefined && version === this.next?.version) this.shown = version;
      return;
    }
    if (message.type === 'dialog.respond') {
      if (!this.answering && this.borrow.activity()) {
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
      if (!this.stopping && this.borrow.activity()) {
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
      const pointer = isPointerCommand(message);
      if (
        pointer
          ? this.queuedPointerCommands >= POINTER_COMMAND_LIMIT
          : this.queue.length - this.queuedPointerCommands >= COMMAND_LIMIT
      )
        return this.fail('BROWSER_COMMAND_QUEUE_FULL');
      this.queue.push(message);
      if (pointer) this.queuedPointerCommands++;
    }
    this.drain();
  }

  download(request: BrowserDownloadRequest): Promise<unknown> {
    if (this.closed || !this.borrow.activity())
      return Promise.reject(new Error('BROWSER_LEASE_ENDED'));
    return this.borrow.resource.download(request.command);
  }

  upload(request: BrowserUpload): Promise<void> {
    if (this.closed || this.uploading || !this.borrow.activity())
      return Promise.reject(new Error('BROWSER_UPLOAD_INVALID'));
    if (request.command.action !== 'finish') return this.borrow.resource.upload(request);
    const operation = this.borrow.resource.upload(request).finally(() => {
      this.uploading = undefined;
    });
    this.uploading = operation;
    return operation;
  }

  uploadStream(
    request: BrowserUploadStream,
    stream: NodeStream,
    signal: AbortSignal
  ): Promise<void> {
    if (this.closed || this.uploading || !this.borrow.activity())
      return Promise.reject(new Error('BROWSER_LEASE_ENDED'));
    return this.borrow.resource.uploadStream(request, stream, signal);
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.unobserve();
    this.stream.close();
    this.queue.length = 0;
    this.queuedPointerCommands = 0;
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
      this.clearFind()
    ]);
    const cleanup = await Promise.allSettled([this.capture?.stop(), this.releaseInput()]);
    const detached = await Promise.allSettled([this.borrow.resource.detach(this)]);
    this.borrow.release();
    const failure = [...operations, ...cleanup, ...detached].find(
      (value) => value.status === 'rejected'
    );
    if (failure) throw failure.reason;
  }

  private downloadsSubscribed = false;
  private downloadProgressSubscribed = false;
  private agentActivitySubscribed = false;
  private tabControlsSubscribed = false;

  private refresh(): void {
    if (this.closed) return;
    const snapshot = this.borrow.resource.snapshot();
    try {
      this.options.sendControl({
        type: 'snapshot',
        snapshot: {
          ...snapshot,
          ...(this.tabControlsSubscribed && { tabControls: this.borrow.resource.tabControls() }),
          ...(this.agentActivitySubscribed &&
            this.borrow.resource.agentActive && { agentActive: true }),
          ...(this.downloadsSubscribed && {
            activeDownloadCount: this.borrow.resource.activeDownloadCount
          }),
          ...(this.downloadProgressSubscribed && {
            startedDownloadCount: this.borrow.resource.startedDownloadCount
          })
        }
      });
    } catch {
      this.fail('BROWSER_FRAME_TRANSPORT_FAILED');
      return;
    }
    this.refreshIcons(snapshot);
    if (snapshot.viewVersion === this.next?.version) return;
    this.discardStaleInput(snapshot.viewVersion);
    void this.clearFind();
    const size = this.borrow.resource.viewport;
    this.contextPasteId = undefined;
    this.next = {
      version: snapshot.viewVersion,
      page: this.borrow.resource.activeView,
      size,
      raster: browserStreamSize(size, this.stream.scale)
    };
    this.shown = undefined;
    this.stream.setView(snapshot.viewVersion);
    this.updateCapture();
    this.drain();
  }

  private discardStaleInput(viewVersion: number): void {
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const command = this.queue[i];
      if (command?.type !== 'input' || command.action.viewVersion === viewVersion) continue;
      this.queue.splice(i, 1);
      if (isPointerCommand(command)) this.queuedPointerCommands--;
    }
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

  private updateRaster(): void {
    const target = this.next;
    if (!target) return;
    const raster = browserStreamSize(target.size, this.stream.scale);
    if (raster.width === target.raster.width && raster.height === target.raster.height) return;
    this.next = { ...target, raster };
    this.stream.resetRaster(
      raster.width < target.raster.width || raster.height < target.raster.height
    );
    this.updateCapture();
  }

  private async captureLatest(): Promise<void> {
    while (!this.closed && this.captureTarget !== this.next) {
      const target = this.next;
      this.captureTarget = target;
      const capture = this.capture;
      this.capture = undefined;
      await capture?.stop();
      if (this.closed || target !== this.next || !target?.page) continue;
      try {
        await target.page.resize(target.size);
        if (this.closed || target !== this.next) continue;
        this.capture = await target.page.startCapture(
          target.raster,
          (frame) => {
            if (this.closed || target !== this.next) return;
            this.stream.offer({ ...frame, viewVersion: target.version });
          },
          () => this.stream.fps
        );
      } catch (error) {
        // A tab or raster change can supersede a pending CDP setup. Only the
        // current target can fail the attachment; teardown errors still surface.
        if (!this.closed && target === this.next) throw error;
      }
    }
  }

  private drain(): void {
    if (this.running || this.closed || (!this.queue.length && !this.pressed)) return;
    this.running = Promise.resolve()
      .then(async () => {
        while (!this.closed) {
          if (this.pressed && this.pressed.version !== this.next?.version) {
            await this.releaseInput();
            continue;
          }
          if (this.closed) break;
          const command = this.queue.shift();
          if (!command) break;
          if (isPointerCommand(command)) this.queuedPointerCommands--;
          if (
            command.type !== 'viewport.resize' &&
            command.type !== 'input' &&
            command.type !== 'find.update' &&
            !this.borrow.activity()
          )
            continue;
          try {
            await this.dispatch(command);
          } catch (error) {
            if (command.type === 'input') await this.releaseInput();
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
        return tabs.resizeFor(this, { width: command.width, height: command.height });
      case 'tab.open':
        return tabs.open(command.address);
      case 'tab.openHtml':
        return tabs.openHtml(command.path);
      case 'tab.select':
        return tabs.select(command.tabId);
      case 'tab.close':
        return tabs.close(command.tabId);
      case 'tab.reopen':
        return tabs.reopen();
      case 'page.zoom':
        return tabs.zoom(command.viewVersion, command.direction);
      case 'tab.restore':
        return tabs.restore(command.addresses);
      case 'selection.copy': {
        const view = this.next;
        const text =
          view?.version === command.viewVersion && view.page ? await view.page.selectedText() : '';
        if (!this.closed)
          this.options.sendControl({
            type: 'selection',
            id: command.id,
            text: this.next?.version === command.viewVersion ? text : ''
          });
        return;
      }
      case 'find.update': {
        const version = command.viewVersion;
        const page = this.inputView(version);
        let result;
        if (command.operation.action === 'clear') {
          if (this.next?.version === version) await this.clearFind();
        } else if (page && this.borrow.activity()) {
          this.findPage = page;
          result = await page.find.update(this, command.operation);
        }
        if (!this.closed)
          this.options.sendControl({
            type: 'find.result',
            id: command.id,
            ...(this.next?.version === version && result ? { result } : {})
          });
        return;
      }
      case 'context.open': {
        this.contextPasteId = undefined;
        return tabs.orderInput(async () => {
          const options = await this.inputView(command.viewVersion)?.contextMenu.open(
            command.id,
            command.point
          );
          if (this.closed) return;
          const current = this.next?.version === command.viewVersion;
          if (current && options?.paste) this.contextPasteId = command.id;
          this.options.sendControl({
            type: 'context.result',
            id: command.id,
            ...(current && options ? { options } : {})
          });
        });
      }
      case 'context.paste': {
        if (this.contextPasteId !== command.id) return;
        this.contextPasteId = undefined;
        return tabs.orderInput(async () => {
          await this.inputView(command.viewVersion)?.contextMenu.paste(command.id, command.text);
        });
      }
      case 'input':
        return tabs.orderInput(() => this.dispatchInput(command.action));
      case 'navigate':
      case 'navigation': {
        const page = tabs.navigationView(command.viewVersion);
        if (!page) return;
        return tabs.navigateWithViewport(
          page,
          async () => {
            if (command.type === 'navigate') return page.navigate(command.address);
            if (command.action === 'reload') return page.reload();
            if (command.action === 'back' || command.action === 'forward')
              return page.travel(command.action === 'back' ? -1 : 1);
          },
          () => !this.closed && tabs.navigationView(command.viewVersion) === page
        );
      }
    }
  }

  private async clearFind(): Promise<void> {
    const page = this.findPage;
    this.findPage = undefined;
    await page?.find.update(this, { action: 'clear' }).catch(() => undefined);
  }

  private inputView(version: number): BrowserPageView | undefined {
    if (this.closed || version !== this.shown || version !== this.next?.version) return;
    return this.next.page;
  }

  private async dispatchInput(action: BrowserPageInput): Promise<void> {
    const page = this.inputView(action.viewVersion);
    if (!page) return;
    if (action.type === 'touch' && (action.phase === 'start') === !!this.pressed?.touch) return;
    if (action.type === 'key' && action.edge === 'up' && !this.pressed?.keys.has(action.key))
      return;
    if (
      action.type === 'button' &&
      action.edge === 'up' &&
      !this.pressed?.buttons.has(action.button)
    )
      return;
    if (!this.borrow.activity()) return;
    if (action.type === 'key' || action.type === 'button' || action.type === 'touch') {
      const pressed = (this.pressed ??= {
        page,
        version: action.viewVersion,
        keys: new Set(),
        buttons: new Set(),
        touch: false
      });
      if (action.type === 'touch') {
        if (action.phase === 'start') pressed.touch = true;
      } else if (action.edge === 'down') {
        if (action.type === 'key') pressed.keys.add(action.key);
        else pressed.buttons.add(action.button);
      }
      await page.input(action);
      if (action.type === 'touch')
        pressed.touch = action.phase === 'start' || action.phase === 'move';
      else if (action.edge === 'up') {
        if (action.type === 'key') pressed.keys.delete(action.key);
        else pressed.buttons.delete(action.button);
      }
      if (!pressed.keys.size && !pressed.buttons.size && !pressed.touch) {
        this.pressed = undefined;
      }
      return;
    }
    if (action.type === 'wheel') this.stream.scroll(action.y);
    await page.input(action);
  }

  private async releaseInput(): Promise<void> {
    const pressed = this.pressed;
    this.pressed = undefined;
    if (!pressed) return;
    await this.borrow.resource.orderInput(() =>
      pressed.page.releaseInput(pressed.keys, pressed.buttons, pressed.touch)
    );
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
