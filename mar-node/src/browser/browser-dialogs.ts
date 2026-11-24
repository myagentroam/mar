import { randomUUID } from 'node:crypto';
import type { BrowserTabSnapshot } from '@myagentroam/protocol';
import type { BrowserContext, Dialog, Page } from 'playwright';

type DialogType = NonNullable<BrowserTabSnapshot['dialog']>['type'];

/** Owns the one pending, user-visible JS dialog in this browser context.
 * The context owns the listener lifetime; the attachment can respond or stop
 * presenting dialogs without owning Playwright's dialog handle.
 */
export class BrowserDialogs {
  private activePage: Page | undefined;
  private pending:
    | { id: string; type: DialogType; dialog: Dialog; timer: ReturnType<typeof setTimeout> }
    | undefined;

  constructor(
    context: BrowserContext,
    private readonly changed: () => void,
    private readonly failed: (error: unknown) => void
  ) {
    context.on('dialog', (dialog) => {
      const type = dialog.type();
      if (
        !this.activePage ||
        dialog.page() !== this.activePage ||
        this.pending ||
        (type !== 'alert' && type !== 'confirm' && type !== 'prompt' && type !== 'beforeunload')
      ) {
        void dialog.dismiss().catch(this.failed);
        return;
      }
      const id = randomUUID();
      const timer = setTimeout(() => void this.respond(id, false).catch(this.failed), 30_000);
      timer.unref();
      this.pending = { id, type, dialog, timer };
      this.changed();
    });
    context.once('close', () => {
      clearTimeout(this.pending?.timer);
      this.pending = undefined;
      this.activePage = undefined;
    });
  }

  snapshot(): BrowserTabSnapshot['dialog'] {
    const entry = this.pending;
    if (!entry) return undefined;
    return {
      id: entry.id,
      type: entry.type,
      message: entry.dialog.message().slice(0, 1024),
      defaultValue: entry.dialog.defaultValue().slice(0, 1024)
    };
  }

  async show(page: Page | undefined): Promise<void> {
    this.activePage = page;
    const entry = this.pending;
    if (entry && entry.dialog.page() !== page) await this.respond(entry.id, false);
  }

  async respond(id: string, accept: boolean, text?: string): Promise<void> {
    const entry = this.pending;
    if (entry?.id !== id) return;
    this.pending = undefined;
    clearTimeout(entry.timer);
    try {
      if (accept) await entry.dialog.accept(text);
      else await entry.dialog.dismiss();
    } finally {
      this.changed();
    }
  }
}
