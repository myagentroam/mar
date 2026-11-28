import { onBeforeUnmount, shallowRef } from 'vue';

export type PopupPlacement =
  | 'bottom'
  | 'bottom-start'
  | 'bottom-end'
  | 'top'
  | 'top-start'
  | 'top-end'
  | 'right'
  | 'right-start'
  | 'right-end';
export type PopupAnchor =
  HTMLElement | { getBoundingClientRect(): DOMRectReadOnly; contextElement?: Element };

function anchorElement(anchor: PopupAnchor) {
  return anchor instanceof HTMLElement ? anchor : anchor.contextElement;
}

/** Owns placement and outside dismissal for one nonmodal, anchored surface. */
export function usePopup(onClose: () => void) {
  const open = shallowRef(false);
  let anchor: PopupAnchor | undefined;
  let surface: HTMLElement | undefined;
  let listeners: AbortController | undefined;
  let resizeObserver: ResizeObserver | undefined;
  let placement: PopupPlacement = 'bottom-start';
  let offset: number | undefined;
  let dismissOutside = true;
  const pendingExits = new WeakMap<HTMLElement, symbol>();

  function place() {
    if (!anchor || !surface) return;
    const rect = anchor.getBoundingClientRect();
    const { clientWidth: width, clientHeight: height } = surface.ownerDocument.documentElement;
    const edge = 8;
    // A zero-size pointer anchor exactly on the viewport edge is still visible.
    if (
      anchorElement(anchor)?.isConnected === false ||
      (anchor instanceof HTMLElement &&
        (!anchor.getClientRects().length || anchor.closest('[inert]'))) ||
      rect.bottom < 0 ||
      rect.top > height
    ) {
      dismiss(false);
      return;
    }
    const { style } = surface;
    const hasArrow = rect.width > 0 && rect.height > 0;
    const gap = offset ?? (hasArrow ? 12 : 4);
    style.setProperty('--mar-ui-popup-anchor-width', `${rect.width}px`);
    style.setProperty('--mar-ui-popup-max-width', `${Math.max(0, width - 2 * edge)}px`);
    const below = height - rect.bottom - gap - edge;
    const above = rect.top - gap - edge;
    const contentHeight = surface.firstElementChild?.scrollHeight ?? 0;
    const wantsTop = placement.startsWith('top');
    const flip = wantsTop
      ? above >= contentHeight + 2 || above >= below
      : below < contentHeight + 2 && above > below;
    const wantsRight = placement.startsWith('right');
    if (wantsRight)
      style.setProperty('--mar-ui-popup-max-height', String(height - 2 * edge) + 'px');
    const lateralWidth = surface.getBoundingClientRect().width;
    if (wantsRight && width - rect.right - gap >= lateralWidth + edge) {
      const panelHeight = surface.offsetHeight;
      const desired =
        placement === 'right-start'
          ? rect.top
          : placement === 'right-end'
            ? rect.bottom - panelHeight
            : rect.top + (rect.height - panelHeight) / 2;
      const top = Math.max(edge, Math.min(desired, height - edge - panelHeight));
      surface.dataset.side = 'right';
      surface.toggleAttribute('data-arrow', hasArrow);
      style.setProperty('--mar-ui-popup-left', String(rect.right + gap) + 'px');
      style.setProperty('--mar-ui-popup-top', String(top) + 'px');
      style.setProperty('--mar-ui-popup-arrow-y', `${rect.top + rect.height / 2 - top}px`);
      return;
    }
    style.setProperty('--mar-ui-popup-max-height', `${Math.max(0, flip ? above : below)}px`);
    const menuWidth = surface.getBoundingClientRect().width;
    const left =
      placement === 'bottom-end' || placement === 'top-end'
        ? rect.right - menuWidth
        : ['bottom', 'top', 'right'].includes(placement)
          ? rect.left + (rect.width - menuWidth) / 2
          : rect.left;
    const fittedLeft = Math.max(edge, Math.min(left, width - edge - menuWidth));
    surface.dataset.side = flip ? 'top' : 'bottom';
    surface.toggleAttribute('data-arrow', hasArrow);
    style.setProperty('--mar-ui-popup-arrow-x', `${rect.left + rect.width / 2 - fittedLeft}px`);
    style.setProperty('--mar-ui-popup-left', `${fittedLeft}px`);
    style.setProperty(
      '--mar-ui-popup-top',
      `${flip ? rect.top - gap - surface.offsetHeight : rect.bottom + gap}px`
    );
  }

  function hide(popup: HTMLElement, animate: boolean) {
    if (!popup.hidePopover) {
      popup.removeAttribute('data-open');
      return;
    }
    if (animate && popup.classList.contains('mar-ui-popup--animated-exit')) {
      // Logical dismissal is immediate; a fading surface must not retain input or focus.
      popup.inert = true;
      popup.setAttribute('aria-hidden', 'true');
      const view = popup.ownerDocument.defaultView;
      const nativeExit = view?.CSS.supports(
        '(overlay: auto) and (transition-behavior: allow-discrete)'
      );
      if (!nativeExit && view?.matchMedia('(prefers-reduced-motion: no-preference)').matches) {
        const exit = Symbol();
        pendingExits.set(popup, exit);
        popup.setAttribute('data-closing', '');
        void Promise.allSettled(popup.getAnimations().map((animation) => animation.finished)).then(
          () => {
            if (pendingExits.get(popup) !== exit) return;
            pendingExits.delete(popup);
            if (popup.isConnected) popup.hidePopover();
            popup.removeAttribute('data-closing');
          }
        );
        return;
      }
    }
    popup.hidePopover();
  }

  function dismiss(animate: boolean) {
    if (!open.value) return;
    listeners?.abort();
    listeners = undefined;
    resizeObserver?.disconnect();
    resizeObserver = undefined;
    open.value = false;
    if (surface) hide(surface, animate);
    surface = undefined;
    anchor = undefined;
    onClose();
  }

  function close() {
    dismiss(true);
  }

  function show(
    reference: PopupAnchor,
    popup: HTMLElement,
    options?: {
      placement?: PopupPlacement | undefined;
      offset?: number | undefined;
      outsideDismiss?: boolean;
    }
  ) {
    if (open.value && surface !== popup) close();
    const previousAnchor = anchor;
    anchor = reference;
    surface = popup;
    placement = options?.placement ?? 'bottom-start';
    offset = options?.offset;
    dismissOutside = options?.outsideDismiss ?? true;
    // A second programmatic/context-menu open can move the same surface in place.
    if (open.value) {
      if (previousAnchor !== reference) {
        if (previousAnchor instanceof HTMLElement) resizeObserver?.unobserve(previousAnchor);
        if (reference instanceof HTMLElement)
          resizeObserver?.observe(reference, { box: 'border-box' });
      }
      place();
      return;
    }
    if (surface.showPopover) {
      if (surface.classList.contains('mar-ui-popup--animated-exit')) {
        pendingExits.delete(surface);
        surface.removeAttribute('data-closing');
        surface.removeAttribute('aria-hidden');
        surface.inert = false;
      }
      surface.showPopover();
    } else surface.setAttribute('data-open', '');
    open.value = true;
    place();
    if (!open.value) return;
    listeners = new AbortController();
    const { signal } = listeners;
    popup.ownerDocument.addEventListener(
      'pointerdown',
      (event) => {
        const path = event.composedPath();
        const trigger = anchor && anchorElement(anchor);
        if (dismissOutside && !path.includes(popup) && (!trigger || !path.includes(trigger)))
          close();
      },
      { capture: true, signal }
    );
    const view = popup.ownerDocument.defaultView;
    view?.addEventListener('resize', place, { signal });
    view?.addEventListener('scroll', place, { capture: true, signal });
    if (typeof ResizeObserver !== 'undefined') {
      // Async options and wrapping tags can resize either side of the anchor gap.
      resizeObserver = new ResizeObserver(place);
      resizeObserver.observe(popup);
      if (reference instanceof HTMLElement)
        resizeObserver.observe(reference, { box: 'border-box' });
    }
  }

  onBeforeUnmount(() => dismiss(false));
  return { open, show, close };
}
