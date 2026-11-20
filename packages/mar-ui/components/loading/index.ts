import type { Directive } from 'vue';
import './loading.css';

interface LoadingMask {
  readonly element: HTMLDivElement;
  readonly busy: string | null;
  readonly ownsBusy: boolean;
}

const masks = new WeakMap<HTMLElement, LoadingMask>();

function release(target: HTMLElement): void {
  const mask = masks.get(target);
  if (!mask) return;
  mask.element.remove();
  masks.delete(target);
  target.removeAttribute('data-mar-loading-position');
  if (!mask.ownsBusy) return;
  if (mask.busy === null) target.removeAttribute('aria-busy');
  else target.setAttribute('aria-busy', mask.busy);
}

function update(
  target: HTMLElement,
  active: boolean,
  variant: string | undefined,
  ownsBusy: boolean
): void {
  if (!active) return release(target);
  let mask = masks.get(target);
  if (!mask) {
    const doc = target.ownerDocument;
    const element = doc.createElement('div');
    element.className = 'mar-ui-loading';
    element.setAttribute('aria-hidden', 'true');
    const indicator = doc.createElement('span');
    indicator.className = 'mar-ui-loading__indicator';
    element.append(indicator);
    mask = { element, busy: target.getAttribute('aria-busy'), ownsBusy };
    masks.set(target, mask);
    if (doc.defaultView?.getComputedStyle(target).position === 'static')
      target.setAttribute('data-mar-loading-position', 'relative');
    target.append(element);
  }
  if (mask.ownsBusy) target.setAttribute('aria-busy', 'true');
  mask.element.dataset.variant = variant === 'page' ? 'page' : 'region';
}

/** Attaches reading feedback only to the page or region that owns the pending content. */
export const vMarLoading: Directive<HTMLElement, boolean> = {
  mounted: (target, binding, vnode) =>
    update(target, binding.value, binding.arg, !Object.hasOwn(vnode.props ?? {}, 'aria-busy')),
  updated: (target, binding, vnode) =>
    update(target, binding.value, binding.arg, !Object.hasOwn(vnode.props ?? {}, 'aria-busy')),
  beforeUnmount: release
};
