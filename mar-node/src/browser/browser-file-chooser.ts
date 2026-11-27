import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type BrowserFileChooser as ChooserSnapshot,
  type BrowserUpload,
  type BrowserUploadStream
} from '@myagentroam/protocol';
import type { NodeStream } from '@myagentroam/protocol/node-stream';
import type { FileChooser, Page } from 'playwright';
import { receiveFileUpload } from '../connection/file-upload-stream.js';

type StagedFile = { path: string; size: number; received: number; complete: boolean };
type Transfer = { id: string; directory: string; files: StagedFile[] };
type Selection = {
  id: string;
  chooser: FileChooser;
  timer: ReturnType<typeof setTimeout> | undefined;
  busy: Promise<void> | undefined;
  transfer: Transfer | undefined;
  lifetime: AbortController;
};

const windowsDeviceName = /^(?:con|prn|aux|nul|(?:com|lpt)[1-9¹²³]) *(?:\.|$)/iu;

/** Owns Chromium file selection and per-selection staging. The launcher owns
 * the run directory; a completed selection remains readable by its page. */
export class BrowserFileChooser {
  private active: Page | undefined;
  private pending: Selection | undefined;

  constructor(
    private readonly changed: () => void,
    private readonly failed: (error: unknown) => void,
    private readonly directory: string | undefined
  ) {}

  listen(page: Page): void {
    page.on('filechooser', (chooser) => {
      if (page !== this.active) {
        void this.dismiss(chooser);
        return;
      }
      void this.cancel();
      const selection: Selection = {
        id: randomUUID(),
        chooser,
        timer: undefined,
        busy: undefined,
        transfer: undefined,
        lifetime: new AbortController()
      };
      this.pending = selection;
      this.touch(selection);
      this.changed();
    });
    page.on('framenavigated', (frame) => {
      if (page === this.active && frame === page.mainFrame()) void this.cancel();
    });
    page.once('close', () => {
      if (page === this.active) void this.show(undefined);
    });
  }

  snapshot(): ChooserSnapshot | undefined {
    const pending = this.pending;
    return pending && { id: pending.id, multiple: pending.chooser.isMultiple() };
  }

  async show(page: Page | undefined): Promise<void> {
    if (this.active === page) return;
    this.active = page;
    await this.cancel();
  }

  async receive({ chooserId, command }: BrowserUpload): Promise<void> {
    const selection = this.pending;
    if (selection?.id !== chooserId) throw new Error('BROWSER_FILE_CHOOSER_ENDED');
    if (command.action === 'cancel') return this.cancel();
    if (selection.busy) throw new Error('BROWSER_UPLOAD_INVALID');
    this.touch(selection);
    selection.busy = this.write(selection, command);
    try {
      await selection.busy;
    } finally {
      selection.busy = undefined;
    }
  }

  async receiveStream(
    { chooserId, command }: BrowserUploadStream,
    stream: NodeStream,
    signal: AbortSignal
  ): Promise<void> {
    const selection = this.pending;
    if (selection?.id !== chooserId) throw new Error('BROWSER_FILE_CHOOSER_ENDED');
    const transfer = selection.transfer;
    const file = transfer?.files[command.index];
    if (selection.busy || transfer?.id !== command.transferId || !file || file.complete)
      throw new Error('BROWSER_UPLOAD_INVALID');
    this.touch(selection);
    const abort = () => stream.reset('BROWSER_FILE_CHOOSER_ENDED');
    selection.lifetime.signal.addEventListener('abort', abort, { once: true });
    selection.busy = this.writeStream(selection, file, stream, signal);
    try {
      await selection.busy;
      selection.lifetime.signal.throwIfAborted();
      file.complete = true;
    } finally {
      selection.lifetime.signal.removeEventListener('abort', abort);
      selection.busy = undefined;
    }
    await stream.endWrite();
  }

  private async writeStream(
    selection: Selection,
    file: StagedFile,
    stream: NodeStream,
    signal: AbortSignal
  ): Promise<void> {
    const handle = await open(file.path, 'r+');
    try {
      await receiveFileUpload(
        stream,
        {
          offset: file.received,
          async write(bytes) {
            let offset = 0;
            while (offset < bytes.length) {
              const { bytesWritten } = await handle.write(
                bytes,
                offset,
                bytes.length - offset,
                file.received + offset
              );
              if (bytesWritten === 0) throw new Error('BROWSER_UPLOAD_FAILED');
              offset += bytesWritten;
            }
            file.received += offset;
            selection.timer?.refresh();
            return file.received;
          }
        },
        file.size,
        signal
      );
    } finally {
      await handle.close();
    }
  }

  private async write(
    selection: Selection,
    command: Exclude<BrowserUpload['command'], { action: 'cancel' }>
  ): Promise<void> {
    if (command.action === 'begin') {
      await this.remove(selection.transfer);
      selection.transfer = {
        id: command.transferId,
        directory: await mkdtemp(join(this.directory ?? tmpdir(), 'upload-')),
        files: []
      };
      return;
    }
    const transfer = selection.transfer;
    if (transfer?.id !== command.transferId) throw new Error('BROWSER_UPLOAD_INVALID');
    switch (command.action) {
      case 'file': {
        const { index, name, size } = command;
        if (
          index !== transfer.files.length ||
          (index > 0 && !selection.chooser.isMultiple()) ||
          name === '.' ||
          name === '..' ||
          (process.platform === 'win32' &&
            (/[:<>"|?*]|[. ]$/u.test(name) || windowsDeviceName.test(name)))
        )
          throw new Error('BROWSER_UPLOAD_INVALID');
        const directory = join(transfer.directory, String(index));
        await mkdir(directory, { recursive: true });
        const path = join(directory, name);
        await writeFile(path, '');
        transfer.files.push({ path, size, received: 0, complete: false });
        return;
      }
      case 'finish': {
        if (!transfer.files.length || transfer.files.some((file) => !file.complete))
          throw new Error('BROWSER_UPLOAD_INVALID');
        this.clear(selection);
        const page = selection.chooser.page();
        try {
          await selection.chooser.setFiles(
            transfer.files.map((file) => file.path),
            { timeout: 10_000 }
          );
          if (page.isClosed()) await this.remove(transfer);
          else page.once('close', () => void this.remove(transfer));
        } catch {
          await this.remove(transfer);
          throw new Error('BROWSER_UPLOAD_FAILED');
        }
      }
    }
  }

  private touch(selection: Selection): void {
    clearTimeout(selection.timer);
    selection.timer = setTimeout(() => {
      if (this.pending === selection) void this.cancel();
    }, 120_000);
    selection.timer.unref();
  }

  private clear(selection: Selection): void {
    clearTimeout(selection.timer);
    selection.lifetime.abort();
    this.pending = undefined;
    this.changed();
  }

  private async cancel(): Promise<void> {
    const selection = this.pending;
    if (!selection) return;
    this.clear(selection);
    await Promise.all([this.dismiss(selection.chooser), selection.busy?.catch(() => undefined)]);
    await this.remove(selection.transfer);
  }

  private async remove(transfer: Transfer | undefined): Promise<void> {
    if (transfer) await rm(transfer.directory, { recursive: true, force: true }).catch(this.failed);
  }

  private async dismiss(chooser: FileChooser): Promise<void> {
    if (chooser.page().isClosed()) return;
    try {
      await chooser.setFiles([], { timeout: 2_000 });
    } catch (error) {
      if (!chooser.page().isClosed()) this.failed(error);
    }
  }
}
