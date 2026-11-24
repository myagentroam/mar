import type { BrowserContext } from 'playwright';

/** Adds word selection in each document of the managed Chromium. DevTools touch
 * injection omits long-press recognition; leave taps and drags to Chromium. */
export async function installBrowserTouchSelection(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const words = new Intl.Segmenter(undefined, { granularity: 'word' });
    const caretAt = document.caretPositionFromPoint.bind(document);

    function selectWord(path: EventTarget[], { clientX: x, clientY: y }: Touch): boolean {
      const target = path.find((item): item is Element => item instanceof Element);
      if (!target?.isConnected || getComputedStyle(target).userSelect === 'none') return false;
      const shadowRoots = path.filter((item): item is ShadowRoot => item instanceof ShadowRoot);
      const caret = caretAt(x, y, { shadowRoots });
      if (!caret) return false;
      const { offset, offsetNode: node } = caret;
      if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
        if (node !== target || node.matches(':disabled') || node.selectionStart === null)
          return false;
        const type = node.type;
        if (type === 'password') return false;
        const { value } = node;
        const word = words.segment(value).containing(Math.min(offset, value.length - 1));
        if (!word?.isWordLike) return false;
        node.focus({ preventScroll: true });
        // The site's focus handler can replace, reconfigure or redirect the field.
        if (!node.matches(':focus') || node.type !== type || node.value !== value) return false;
        node.setSelectionRange(word.index, word.index + word.segment.length);
        return true;
      }
      if (!(node instanceof Text) || !target.contains(node) || target.closest('button, select'))
        return false;
      const selection = getSelection();
      if (!selection) return false;
      const segments = words.segment(node.data);
      // Caret hit testing rounds to a character boundary; check either side of it.
      for (const word of [segments.containing(offset), segments.containing(offset - 1)]) {
        if (!word?.isWordLike) continue;
        const end = word.index + word.segment.length;
        const range = document.createRange();
        range.setStart(node, word.index);
        range.setEnd(node, end);
        if (
          Array.from(range.getClientRects()).some(
            (rect) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
          )
        ) {
          // Chromium keeps an input's selection while a document range is set
          // programmatically. Move focus off that field so copy uses the new range.
          let field = document.activeElement;
          while (field?.shadowRoot?.activeElement) field = field.shadowRoot.activeElement;
          if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)
            field.blur();
          if (!node.isConnected || end > node.length) return false;
          selection.setBaseAndExtent(node, word.index, node, end);
          return true;
        }
      }
      return false;
    }

    type Hold = { point: Touch; timer?: number; move?: TouchEvent; selected: boolean };
    let held: Hold | undefined;
    function stopPending() {
      if (held?.timer !== undefined) {
        clearTimeout(held.timer);
        delete held.timer;
      }
    }
    const listen = { capture: true, passive: true };
    window.addEventListener(
      'touchstart',
      (event) => {
        if (!event.isTrusted) return;
        stopPending();
        const point = event.touches[0];
        if (!point || event.touches.length !== 1) return;
        // The composed path is only available during dispatch. Keep the target
        // and shadow roots for the hit test after the hold interval.
        const path = event.composedPath();
        const gesture: Hold = (held = { point, selected: false });
        gesture.timer = window.setTimeout(() => {
          delete gesture.timer;
          if (!event.defaultPrevented && !gesture.move?.defaultPrevented)
            gesture.selected = selectWord(path, point);
        }, 500);
      },
      listen
    );
    window.addEventListener(
      'touchmove',
      (event) => {
        if (held?.timer === undefined || !event.isTrusted) return;
        const point = event.touches[0];
        if (
          held.move?.defaultPrevented ||
          !point ||
          event.touches.length !== 1 ||
          Math.hypot(point.clientX - held.point.clientX, point.clientY - held.point.clientY) >= 8
        )
          stopPending();
        else held.move = event;
      },
      listen
    );
    function finish(event: TouchEvent) {
      const gesture = held;
      if (
        !event.isTrusted ||
        !gesture ||
        !Array.from(event.changedTouches).some(
          ({ identifier }) => identifier === gesture.point.identifier
        )
      )
        return;
      stopPending();
      if (gesture.selected && event.type === 'touchend') event.preventDefault();
      held = undefined;
    }
    window.addEventListener('touchend', finish, { capture: true, passive: false });
    window.addEventListener('touchcancel', finish, listen);
    window.addEventListener('scroll', stopPending, listen);
    window.addEventListener('keydown', stopPending, listen);
    window.addEventListener(
      'pointerdown',
      (event) => {
        if (event.isTrusted && event.pointerType !== 'touch') stopPending();
      },
      listen
    );
  });
}
