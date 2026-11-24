import { randomUUID } from 'node:crypto';
import type { BrowserContextOptions } from '@myagentroam/protocol';
import type { BrowserContext, Frame, Page } from 'playwright';

type ProbeCommand =
  { type: 'arm' | 'read' | 'focus'; id: string } | { type: 'paste'; id: string; text: string };
const probeKey = `marContextMenu_${randomUUID()}`;

/** Registers the observer before site handlers, including in newly created child frames.
 * It has no Node binding and never reads the device clipboard. */
export async function installBrowserContextMenu(context: BrowserContext): Promise<void> {
  await context.addInitScript((key) => {
    let armed: string | undefined;
    let rightClick: { event: MouseEvent; path: EventTarget[] } | undefined;
    let pasteTarget: { id: string; element: Element } | undefined;

    window.addEventListener(
      'contextmenu',
      (event) => {
        // The composed path is only available during dispatch. Keep the event
        // too, so the later read still respects the page's preventDefault().
        if (armed && event.isTrusted && event.button === 2)
          rightClick = { event, path: event.composedPath() };
      },
      { capture: true }
    );
    function clearPasteTarget(): void {
      pasteTarget?.element.removeEventListener('focusout', clearPasteTarget, true);
      pasteTarget = undefined;
    }

    function editable(element: Element | null): boolean {
      if (element instanceof HTMLInputElement) {
        return (
          !element.disabled &&
          !element.readOnly &&
          (element.selectionStart !== null || ['email', 'number'].includes(element.type))
        );
      }
      if (element instanceof HTMLTextAreaElement) return !element.disabled && !element.readOnly;
      return element instanceof HTMLElement && element.isContentEditable;
    }

    const selection = window.getSelection.bind(window);
    const insert = document.execCommand.bind(document);
    Object.defineProperty(window, key, {
      value: (command: ProbeCommand): BrowserContextOptions | boolean | undefined => {
        if (command.type === 'arm') {
          armed = command.id;
          rightClick = undefined;
          clearPasteTarget();
          return;
        }
        let field = document.activeElement;
        while (field?.shadowRoot?.activeElement) field = field.shadowRoot.activeElement;
        if (command.type === 'paste') {
          const target = pasteTarget;
          clearPasteTarget();
          return (
            !!target &&
            target.id === command.id &&
            target.element === field &&
            document.hasFocus() &&
            editable(field) &&
            insert('insertText', false, command.text)
          );
        }
        const click = rightClick;
        if (command.type === 'read') {
          if (armed !== command.id) return;
          armed = rightClick = undefined;
          if (!click || click.event.defaultPrevented) return;
        } else if (!document.hasFocus() || field?.matches('iframe, frame')) return;

        const path = command.type === 'read' ? click?.path : undefined;
        const password = field instanceof HTMLInputElement && field.type === 'password';
        const fieldSelected =
          (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) &&
          field.selectionStart !== null &&
          field.selectionStart !== field.selectionEnd;
        clearPasteTarget();
        if (field && (!path || path.includes(field)) && editable(field)) {
          pasteTarget = { id: command.id, element: field };
          // Focus changes within one shadow tree may not reach window.
          field.addEventListener('focusout', clearPasteTarget, { capture: true });
        }
        const link = (
          path
            ? path.find(
                (target): target is HTMLAnchorElement | HTMLAreaElement =>
                  (target instanceof HTMLAnchorElement || target instanceof HTMLAreaElement) &&
                  target.hasAttribute('href')
              )
            : field?.closest<HTMLAnchorElement | HTMLAreaElement>('a[href], area[href]')
        )?.href;
        const url = link ? URL.parse(link) : null;
        return {
          copy: !password && (fieldSelected || !!selection()?.toString()),
          paste: !!pasteTarget,
          ...(url &&
          !url.username &&
          !url.password &&
          url.href.length <= 8192 &&
          (url.protocol === 'http:' || url.protocol === 'https:')
            ? { link: url.href }
            : {})
        };
      }
    });
  }, probeKey);
}

/** Resolves native context-menu intent for a single owned page. The attachment
 * owns view fencing and the lifetime of the resulting one-shot paste target. */
export class BrowserContextMenu {
  private target: { id: string; frame: Frame } | undefined;

  constructor(private readonly page: Page) {}

  async open(
    id: string,
    point?: { x: number; y: number }
  ): Promise<BrowserContextOptions | undefined> {
    this.target = undefined;
    // Screencasting a tab does not make it Chromium's focused tab. Context
    // actions must resolve the real editable focus of the selected tab.
    await this.page.bringToFront();
    const frames = this.page.frames();
    if (point) {
      await Promise.all(frames.map((frame) => this.probe(frame, { type: 'arm', id })));
      await this.page.mouse.click(point.x, point.y, { button: 'right' });
    }
    const results = await Promise.all(
      frames.map(async (frame) => ({
        frame,
        options: await this.probe(frame, { type: point ? 'read' : 'focus', id })
      }))
    );
    const match = results.find(({ options }) => !!options && typeof options === 'object');
    const options = match?.options;
    if (!match || !options || typeof options !== 'object') return;
    if (options.paste) this.target = { id, frame: match.frame };
    return options;
  }

  async paste(id: string, text: string): Promise<void> {
    const target = this.target;
    this.target = undefined;
    if (target?.id === id) await this.probe(target.frame, { type: 'paste', id, text });
  }

  private probe(
    frame: Frame,
    command: ProbeCommand
  ): Promise<BrowserContextOptions | boolean | undefined> {
    return frame
      .evaluate(
        ({ key, command }) => {
          const probe = (
            window as unknown as Record<
              string,
              ((value: ProbeCommand) => BrowserContextOptions | boolean | undefined) | undefined
            >
          )[key];
          return probe?.(command);
        },
        { key: probeKey, command }
      )
      .catch(() => undefined);
  }
}
