import type { BrowserFindOperation, BrowserFindResult } from '@myagentroam/protocol';
import type { Frame, JSHandle, Page } from 'playwright';

const MATCH_LIMIT = 500;
const NODE_LIMIT = 50_000;
const TEXT_LIMIT = 2_000_000;
const FRAME_LIMIT = 24;

type Marks = { ranges: Range[]; sheet: CSSStyleSheet; limited: boolean };

// Executed inside Chromium. Keep real Ranges and CSS highlights, not rewritten page DOM.
function markDocument({
  query,
  remaining,
  nodeLimit,
  textLimit
}: {
  query: string;
  remaining: number;
  nodeLimit: number;
  textLimit: number;
}): Marks {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    ::highlight(mar-page-find) { background-color: #ffe45b; color: #202124; }
    ::highlight(mar-page-find-current) { background-color: #ff963b; color: #202124; }
  `);
  const root = document.body;
  const result: Marks = { ranges: [], sheet, limited: false };
  if (!root || !query.trim() || !globalThis.Highlight || !CSS.highlights) return result;

  const literal = query
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s{1,64}');
  const pattern = new RegExp(literal, 'giu');
  let text = '';
  let pieces: { node: Text; start: number }[] = [];
  let chars = 0;
  let nodes = 0;

  function flush(): void {
    let startPiece = 0;
    for (const match of text.matchAll(pattern)) {
      if (result.ranges.length >= remaining) {
        result.limited = true;
        break;
      }
      const start = match.index;
      const end = start + match[0].length;
      while (pieces[startPiece + 1] && pieces[startPiece + 1]!.start <= start) startPiece++;
      let endPiece = startPiece;
      while (pieces[endPiece + 1] && pieces[endPiece + 1]!.start < end) endPiece++;
      const first = pieces[startPiece]!;
      const last = pieces[endPiece]!;
      const range = new Range();
      range.setStart(first.node, start - first.start);
      range.setEnd(last.node, end - last.start);
      result.ranges.push(range);
    }
    text = '';
    pieces = [];
  }

  // Use a depth-bounded stack of siblings rather than materializing the entire tree.
  const stack: { next: ChildNode | null; split: boolean; visible: boolean }[] = [
    { next: root.firstChild, split: true, visible: getComputedStyle(root).visibility === 'visible' }
  ];
  while (stack.length && !result.limited) {
    const level = stack.at(-1)!;
    const node = level.next;
    if (!node) {
      stack.pop();
      if (level.split) flush();
      continue;
    }
    level.next = node.nextSibling;
    if (++nodes > nodeLimit) {
      result.limited = true;
      break;
    }
    if (node instanceof Text && level.visible) {
      const value = node.data.slice(0, textLimit - chars);
      if (value) {
        pieces.push({ node, start: text.length });
        text += value;
        chars += value.length;
      }
      if (value.length < node.length) result.limited = true;
    } else if (node instanceof Element) {
      if (node.matches('script, style, noscript, template, select, textarea')) continue;
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.contentVisibility === 'hidden' || style.opacity === '0')
        continue;
      if (node.localName === 'br') {
        flush();
        continue;
      }
      const split = style.display !== 'inline' && style.display !== 'contents';
      if (split) flush();
      stack.push({
        next: node.localName === 'details' && !node.hasAttribute('open') ? null : node.firstChild,
        split,
        visible: style.visibility === 'visible'
      });
      if (node.localName === 'details' && !node.hasAttribute('open')) {
        const summary = Array.from(node.children).find((child) => child.localName === 'summary');
        if (summary) stack.at(-1)!.next = summary.firstChild;
      }
    }
  }
  flush();
  if (result.ranges.length) {
    document.adoptedStyleSheets.push(sheet);
    CSS.highlights.set('mar-page-find', new Highlight(...result.ranges));
  }
  return result;
}

type FoundFrame = { frame: Frame; marks: JSHandle<Marks>; count: number };

/** Owns the single transient find session painted on one Chromium page. */
export class BrowserPageFind {
  private owner: object | undefined;
  private sections: FoundFrame[] = [];
  private total = 0;
  private position = 0;
  private limited = false;
  private tail = Promise.resolve();

  constructor(private readonly page: Page) {}

  update(owner: object, operation: BrowserFindOperation): Promise<BrowserFindResult | undefined> {
    const task = this.tail.then(async () => {
      if (operation.action === 'clear') {
        if (this.owner === owner) await this.clear();
        return;
      }
      if (operation.action === 'start') {
        await this.clear();
        this.owner = owner;
        const frames = this.page.frames();
        this.limited = frames.length > FRAME_LIMIT;
        for (const frame of frames.slice(0, FRAME_LIMIT)) {
          if (this.total === MATCH_LIMIT) {
            this.limited = true;
            break;
          }
          let marks: JSHandle<Marks> | undefined;
          try {
            if (frame !== this.page.mainFrame()) {
              const element = await frame.frameElement();
              try {
                if (!(await element.isVisible())) continue;
              } finally {
                await element.dispose();
              }
            }
            marks = await frame.evaluateHandle(markDocument, {
              query: operation.query,
              remaining: MATCH_LIMIT - this.total,
              nodeLimit: NODE_LIMIT,
              textLimit: TEXT_LIMIT
            });
            const { count, limited } = await marks.evaluate(({ ranges, limited }) => ({
              count: ranges.length,
              limited
            }));
            this.total += count;
            this.limited ||= limited;
            if (count) this.sections.push({ frame, marks, count });
            else await marks.dispose();
          } catch {
            await marks?.dispose().catch(() => undefined);
            this.limited = true;
          }
        }
      } else if (this.owner !== owner) return;
      else if (this.total) {
        const step = operation.action === 'next' ? 1 : -1;
        this.position = (this.position + step + this.total) % this.total;
      }

      let offset = this.position;
      for (const { frame, marks, count } of this.sections) {
        const index = offset;
        offset -= count;
        try {
          if (index >= 0 && index < count && frame !== this.page.mainFrame()) {
            const element = await frame.frameElement();
            try {
              await element.scrollIntoViewIfNeeded({ timeout: 1000 });
            } finally {
              await element.dispose();
            }
          }
          await marks.evaluate(({ ranges }, i) => {
            const range = ranges[i];
            if (!range?.startContainer.isConnected) {
              CSS.highlights.delete('mar-page-find-current');
              return;
            }
            const active = new Highlight(range);
            active.priority = 1;
            CSS.highlights.set('mar-page-find-current', active);
            for (
              let parent = range.startContainer.parentElement;
              parent;
              parent = parent.parentElement
            ) {
              if (parent === document.scrollingElement) break;
              if (
                parent.scrollHeight <= parent.clientHeight &&
                parent.scrollWidth <= parent.clientWidth
              )
                continue;
              const { overflowX, overflowY } = getComputedStyle(parent);
              const rect = range.getBoundingClientRect();
              const viewport = parent.getBoundingClientRect();
              const x =
                /auto|scroll|hidden/.test(overflowX) &&
                (rect.left < viewport.left || rect.right > viewport.right)
                  ? rect.left - viewport.left - parent.clientWidth / 2
                  : 0;
              const y =
                /auto|scroll|hidden/.test(overflowY) &&
                (rect.top < viewport.top || rect.bottom > viewport.bottom)
                  ? rect.top - viewport.top - parent.clientHeight / 2
                  : 0;
              if (x || y) parent.scrollBy({ left: x, top: y, behavior: 'instant' });
            }
            const rect = range.getBoundingClientRect();
            if (
              rect.top < 0 ||
              rect.bottom > innerHeight ||
              rect.left < 0 ||
              rect.right > innerWidth
            )
              scrollBy({
                left: rect.left - innerWidth / 2,
                top: rect.top - innerHeight / 2,
                behavior: 'instant'
              });
          }, index);
        } catch {
          this.limited = true;
        }
      }
      return {
        index: this.total ? this.position + 1 : 0,
        total: this.total,
        limited: this.limited
      };
    });
    this.tail = task.then(
      () => undefined,
      () => undefined
    );
    return task;
  }

  private async clear(): Promise<void> {
    const sections = this.sections;
    this.sections = [];
    this.owner = undefined;
    this.total = this.position = 0;
    this.limited = false;
    await Promise.allSettled(
      sections.map(async ({ marks }) => {
        try {
          await marks.evaluate(({ sheet }) => {
            CSS.highlights.delete('mar-page-find');
            CSS.highlights.delete('mar-page-find-current');
            document.adoptedStyleSheets = document.adoptedStyleSheets.filter(
              (item) => item !== sheet
            );
          });
        } finally {
          await marks.dispose();
        }
      })
    );
  }
}
