import { onBeforeUnmount, shallowRef } from 'vue';

/** Owns placement and outside dismissal for one nonmodal, anchored surface. */
export function usePopup(onClose: () => void) {
  const open = shallowRef(false);
  let anchor: HTMLElement | undefined;
  let surface: HTMLElement | undefined;
  let listeners: AbortController | undefined;
  let matchAnchorWidth = false;

  function place() {
    if (!anchor || !surface) return;
    const rect = anchor.getBoundingClientRect();
    const width = document.documentElement.clientWidth;
    const height = document.documentElement.clientHeight;
    const gap = 4;
    const edge = 8;
    if (rect.bottom <= 0 || rect.top >= height) {
      close();
      return;
    }
    if (matchAnchorWidth) surface.style.width = `${rect.width}px`;
    surface.style.maxWidth = `${Math.max(0, width - 2 * edge)}px`;
    const below = height - rect.bottom - gap - edge;
    const above = rect.top - gap - edge;
    const flip = below < surface.scrollHeight && above > below;
    surface.style.maxHeight = `${Math.max(0, flip ? above : below)}px`;
    surface.style.left = `${Math.max(edge, Math.min(rect.left, width - edge - surface.offsetWidth))}px`;
    surface.style.top = `${flip ? rect.top - gap - surface.offsetHeight : rect.bottom + gap}px`;
  }

  function close() {
    if (!open.value) return;
    listeners?.abort();
    open.value = false;
    if (surface?.hidePopover) surface.hidePopover();
    else surface?.removeAttribute('data-open');
    onClose();
  }

  function show(trigger: HTMLElement, popup: HTMLElement, matchWidth = false) {
    anchor = trigger;
    surface = popup;
    matchAnchorWidth = matchWidth;
    if (surface.showPopover) surface.showPopover();
    else surface.setAttribute('data-open', '');
    open.value = true;
    place();
    if (!open.value) return;
    listeners = new AbortController();
    const { signal } = listeners;
    document.addEventListener(
      'pointerdown',
      (event) => {
        const path = event.composedPath();
        if (!path.includes(trigger) && !path.includes(popup)) close();
      },
      { capture: true, signal }
    );
    window.addEventListener('resize', place, { signal });
    window.addEventListener('scroll', place, { capture: true, signal });
  }

  onBeforeUnmount(close);
  return { open, show, close };
}
