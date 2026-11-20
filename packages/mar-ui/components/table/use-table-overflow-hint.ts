import { nextTick, onBeforeUnmount, shallowRef, useId } from 'vue';
import { usePopup } from '../popup/use-popup.js';

const triggerSelector = '[data-mar-table-overflow]';

/** One full-value hint per table, delegated from cell events and placed by the shared popup. */
export function useTableOverflowHint() {
  const id = useId();
  const surface = shallowRef<HTMLElement>();
  const text = shallowRef('');
  let hovered: HTMLElement | null = null;
  let focused: HTMLElement | null = null;
  let focusTarget: Element | null = null;
  let visibleAnchor: HTMLElement | null = null;
  let described: Element | null = null;
  let contentObserver: MutationObserver | undefined;
  let session: AbortController | undefined;
  let pendingAnchor: HTMLElement | null = null;
  let overSurface = false;
  let showTimer: ReturnType<typeof setTimeout> | undefined;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;

  function describe(target: Element | null) {
    if (described && described !== target) {
      const ids = (described.getAttribute('aria-describedby') ?? '')
        .split(/\s+/)
        .filter((item) => item && item !== id);
      if (ids.length) described.setAttribute('aria-describedby', ids.join(' '));
      else described.removeAttribute('aria-describedby');
    }
    described = target;
    if (target) {
      const ids = (target.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
      if (!ids.includes(id)) target.setAttribute('aria-describedby', [...ids, id].join(' '));
    }
  }

  function release() {
    contentObserver?.disconnect();
    contentObserver = undefined;
    session?.abort();
    session = undefined;
    describe(null);
    visibleAnchor = null;
    overSurface = false;
  }

  const popup = usePopup(release);

  function onEscape(event: KeyboardEvent) {
    if (event.key !== 'Escape' || event.isComposing || !popup.open.value) return;
    event.stopPropagation();
    reset();
  }

  function onScroll(event: Event) {
    if (!visibleAnchor) return;
    const target = event.target;
    if (
      target === visibleAnchor.ownerDocument ||
      (target instanceof Element && target.contains(visibleAnchor))
    )
      reset();
  }

  function isClipped(anchor: HTMLElement): boolean {
    return (
      anchor.isConnected && anchor.clientWidth > 0 && anchor.scrollWidth > anchor.clientWidth + 1
    );
  }

  function schedule() {
    clearTimeout(hideTimer);
    const next = hovered && isClipped(hovered) ? hovered : focused;
    refresh();
    if (overSurface || next === visibleAnchor || next === pendingAnchor) {
      if (next !== pendingAnchor) {
        clearTimeout(showTimer);
        pendingAnchor = null;
      }
      if (overSurface || next) return;
    }
    clearTimeout(showTimer);
    pendingAnchor = null;
    if (!next || !isClipped(next)) {
      if (visibleAnchor) hideTimer = setTimeout(popup.close, 100);
      return;
    }
    pendingAnchor = next;
    showTimer = setTimeout(
      async () => {
        if (!isClipped(next)) {
          pendingAnchor = null;
          popup.close();
          return;
        }
        text.value = fullText(next);
        if (!text.value) {
          pendingAnchor = null;
          popup.close();
          return;
        }
        await nextTick();
        if (pendingAnchor !== next || !surface.value) return;
        pendingAnchor = null;
        if (!isClipped(next)) {
          popup.close();
          return;
        }
        release();
        visibleAnchor = next;
        refresh();
        session = new AbortController();
        const doc = next.ownerDocument;
        doc.addEventListener('keydown', onEscape, { capture: true, signal: session.signal });
        doc.addEventListener('scroll', onScroll, { capture: true, signal: session.signal });
        doc.addEventListener(
          'visibilitychange',
          () => {
            if (doc.hidden) reset();
          },
          { signal: session.signal }
        );
        if (typeof MutationObserver !== 'undefined') {
          contentObserver = new MutationObserver(refresh);
          contentObserver.observe(next, { childList: true, characterData: true, subtree: true });
        }
        popup.show(next, surface.value, false, { placement: 'bottom' });
      },
      visibleAnchor ? 100 : 350
    );
  }

  function anchorAt(event: MouseEvent | FocusEvent, target: EventTarget | null) {
    if (!(target instanceof Element)) return null;
    const anchor =
      target.closest<HTMLElement>(triggerSelector) ??
      target.closest('td')?.querySelector<HTMLElement>(triggerSelector);
    return anchor?.closest('.mar-ui-table__viewport') === event.currentTarget ? anchor : null;
  }

  function onPointerOver(event: PointerEvent) {
    if (event.pointerType === 'touch' || event.buttons) return;
    const next = anchorAt(event, event.target);
    if (hovered === next) return;
    hovered = next;
    schedule();
  }

  function onPointerOut(event: PointerEvent) {
    if (event.pointerType === 'touch' || !hovered) return;
    const next = anchorAt(event, event.relatedTarget);
    if (hovered === next) return;
    hovered = next;
    schedule();
  }

  function onFocusIn(event: FocusEvent) {
    focused =
      event.target instanceof Element && event.target.matches(':focus-visible')
        ? anchorAt(event, event.target)
        : null;
    focusTarget = focused && event.target instanceof Element ? event.target : null;
    schedule();
  }

  function onFocusOut() {
    focused = focusTarget = null;
    schedule();
  }

  function onSurfaceEnter() {
    overSurface = true;
    schedule();
  }

  function onSurfaceLeave() {
    overSurface = false;
    schedule();
  }

  function reset() {
    hovered = focused = pendingAnchor = null;
    focusTarget = null;
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    popup.close();
  }

  function fullText(anchor: HTMLElement): string {
    return (anchor.innerText || anchor.textContent || '').trim();
  }

  function refresh() {
    const anchor = visibleAnchor;
    if (!anchor) return;
    const value = isClipped(anchor) ? fullText(anchor) : '';
    if (!value) {
      popup.close();
      return;
    }
    text.value = value;
    describe(focused === anchor && focusTarget?.isConnected ? focusTarget : anchor);
  }

  onBeforeUnmount(reset);
  return {
    id,
    surface,
    text,
    onPointerOver,
    onPointerOut,
    onFocusIn,
    onFocusOut,
    onSurfaceEnter,
    onSurfaceLeave,
    reset,
    refresh
  };
}
