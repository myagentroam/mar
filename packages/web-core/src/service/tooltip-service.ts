import { shallowRef, type InjectionKey } from 'vue';
import type { ElTooltipProps } from 'element-plus';
import { tableTooltipOptions } from '../util/tooltip.js';

export interface TooltipOptions {
  readonly content: string;
  readonly disabled?: boolean;
  readonly placement?: ElTooltipProps['placement'];
  readonly popperClass?: string;
  readonly touch?: boolean;
}

export type TooltipValue = string | TooltipOptions | null | undefined;

interface ActiveTooltip extends TooltipOptions {
  readonly target: Element;
}

export const TOOLTIP_SERVICE_KEY: InjectionKey<TooltipService> = Symbol('tooltip');

// One coordinator per application. Registered targets carry no reactive effects or listeners.
export class TooltipService {
  readonly active = shallowRef<ActiveTooltip>();
  private readonly targets = new WeakMap<Element, TooltipOptions>();
  private pending: Element | undefined;
  private showTimer: ReturnType<typeof setTimeout> | undefined;
  private hideTimer: ReturnType<typeof setTimeout> | undefined;
  private observer: MutationObserver | undefined;
  private descriptionId = '';
  private pointerWithin = false;
  private touchInput = false;
  private readonly dismissedEscapes = new WeakMap<KeyboardEvent, 'control' | 'menu'>();

  constructor(private readonly document: Document) {}

  update(target: Element, value: TooltipValue): void {
    const options = typeof value === 'string' ? { content: value } : value;
    if (!options?.content || options.disabled) {
      this.remove(target);
      return;
    }
    this.targets.set(target, options);
    const active = this.active.value;
    if (active?.target === target) {
      if (!this.available(target)) {
        this.close();
        return;
      }
      if (
        active.content !== options.content ||
        active.placement !== options.placement ||
        active.popperClass !== options.popperClass
      )
        this.active.value = { ...options, target };
      this.describe(target);
    }
  }

  remove(target: Element): void {
    this.targets.delete(target);
    if (this.pending === target || this.active.value?.target === target) this.close();
  }

  close = (): void => {
    clearTimeout(this.showTimer);
    clearTimeout(this.hideTimer);
    this.pending = undefined;
    this.pointerWithin = false;
    this.observer?.disconnect();
    this.observer = undefined;
    const target = this.active.value?.target;
    if (target) {
      const ids = (target.getAttribute('aria-describedby') ?? '')
        .split(/\s+/u)
        .filter((id) => id && id !== this.descriptionId);
      if (ids.length) target.setAttribute('aria-describedby', ids.join(' '));
      else target.removeAttribute('aria-describedby');
    }
    this.active.value = undefined;
  };

  connect(descriptionId: string): () => void {
    this.descriptionId = descriptionId;
    const doc = this.document;
    const win = doc.defaultView;
    doc.addEventListener('pointerover', this.onPointerOver, true);
    doc.addEventListener('pointerout', this.onPointerOut, true);
    doc.addEventListener('pointerdown', this.onPointerDown, true);
    doc.addEventListener('click', this.onClick, true);
    doc.addEventListener('focusin', this.onFocusIn, true);
    doc.addEventListener('focusout', this.onFocusOut, true);
    doc.addEventListener('keydown', this.onKeyDown, true);
    doc.addEventListener('keydown', this.onKeyDownBubble);
    doc.addEventListener('scroll', this.close, true);
    doc.addEventListener('visibilitychange', this.close);
    win?.addEventListener('resize', this.close);
    win?.addEventListener('blur', this.close);
    return () => {
      this.close();
      doc.removeEventListener('pointerover', this.onPointerOver, true);
      doc.removeEventListener('pointerout', this.onPointerOut, true);
      doc.removeEventListener('pointerdown', this.onPointerDown, true);
      doc.removeEventListener('click', this.onClick, true);
      doc.removeEventListener('focusin', this.onFocusIn, true);
      doc.removeEventListener('focusout', this.onFocusOut, true);
      doc.removeEventListener('keydown', this.onKeyDown, true);
      doc.removeEventListener('keydown', this.onKeyDownBubble);
      doc.removeEventListener('scroll', this.close, true);
      doc.removeEventListener('visibilitychange', this.close);
      win?.removeEventListener('resize', this.close);
      win?.removeEventListener('blur', this.close);
    };
  }

  private find(target: EventTarget | null): Element | undefined {
    for (
      let element = target instanceof Element ? target : null;
      element;
      element = element.parentElement
    )
      if (this.targets.has(element)) return element;
    return undefined;
  }

  private available(target: Element): boolean {
    return (
      !this.document.hidden &&
      target.isConnected &&
      target.getClientRects().length > 0 &&
      !target.closest('[inert]') &&
      this.document.defaultView?.getComputedStyle(target).visibility !== 'hidden'
    );
  }

  private describe(target: Element): void {
    const ids = new Set(
      (target.getAttribute('aria-describedby') ?? '').split(/\s+/u).filter(Boolean)
    );
    ids.add(this.descriptionId);
    target.setAttribute('aria-describedby', [...ids].join(' '));
  }

  private request(target: Element, input: 'pointer' | 'focus' | 'touch'): void {
    clearTimeout(this.hideTimer);
    if (this.active.value?.target === target || this.pending === target) {
      if (input === 'pointer') this.pointerWithin = true;
      return;
    }
    this.close();
    if (!this.available(target)) return;
    this.pointerWithin = input === 'pointer';
    this.pending = target;
    // Observe only the active target's ancestor chain, including while the delay is pending.
    // No document-wide subtree observer, per-row observer, or polling is needed.
    this.observer = new MutationObserver(() => {
      if (!this.available(target)) this.close();
    });
    for (let ancestor: Element | null = target; ancestor; ancestor = ancestor.parentElement)
      this.observer.observe(ancestor, {
        childList: true,
        attributes: true,
        attributeFilter: ['class', 'style', 'hidden', 'inert']
      });
    this.showTimer = setTimeout(() => {
      const options = this.targets.get(target);
      if (this.pending !== target || !options || !this.available(target)) {
        this.close();
        return;
      }
      this.pending = undefined;
      this.active.value = { ...options, target };
      this.describe(target);
    }, tableTooltipOptions.showAfter);
  }

  private leave(target: Element | undefined): void {
    if (!target) return;
    if (this.pending === target) this.close();
    else if (this.active.value?.target === target) {
      clearTimeout(this.hideTimer);
      this.hideTimer = setTimeout(this.close, tableTooltipOptions.hideAfter);
    }
  }

  private onPointerOver = (event: PointerEvent): void => {
    if (event.pointerType === 'touch' || event.buttons) return;
    this.touchInput = false;
    const target = this.find(event.target);
    if (target && target !== this.find(event.relatedTarget)) this.request(target, 'pointer');
  };

  private onPointerOut = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') return;
    const target = this.find(event.target);
    if (target === this.find(event.relatedTarget)) return;
    if (!target || (target !== this.pending && target !== this.active.value?.target)) return;
    this.pointerWithin = false;
    if (target?.contains(this.document.activeElement)) return;
    this.leave(target);
  };

  private onPointerDown = (event: PointerEvent): void => {
    this.touchInput = event.pointerType === 'touch';
    this.close();
  };

  private onClick = (event: MouseEvent): void => {
    const pointerType = 'pointerType' in event ? event.pointerType : undefined;
    if (pointerType ? pointerType !== 'touch' : !this.touchInput || event.detail === 0) return;
    const target = this.find(event.target);
    // Only explicit detail entries opt in. Never consume the underlying action or long press.
    if (target && this.targets.get(target)?.touch) this.request(target, 'touch');
  };

  private onFocusIn = (event: FocusEvent): void => {
    if (this.touchInput) return;
    const target = this.find(event.target);
    if (target) this.request(target, 'focus');
    else if (!this.pointerWithin) this.close();
  };

  private onFocusOut = (event: FocusEvent): void => {
    const target = this.find(event.target);
    if (target !== this.find(event.relatedTarget) && !this.pointerWithin) this.leave(target);
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    this.touchInput = false;
    if (event.key !== 'Escape' || event.isComposing) return;
    const active = this.active.value;
    this.close();
    if (!active) return;
    const target = event.target instanceof Element ? event.target : undefined;
    // Native menus dismiss through the existing document-level focus-layer stack.
    if (target?.closest('[role="menu"]')) {
      this.dismissedEscapes.set(event, 'menu');
      return;
    }
    if (!target || !active.target.contains(target)) {
      // A hovered hint must not forward Escape into an unrelated focused run/composer.
      event.stopImmediatePropagation();
      return;
    }
    this.dismissedEscapes.set(event, 'control');
  };

  private onKeyDownBubble = (event: KeyboardEvent): void => {
    // Keep same-document menu dismissal, but never forward it to window-level
    // parent surfaces. Other hints must also isolate outer document-level dialogs.
    const owner = this.dismissedEscapes.get(event);
    if (owner === 'menu') event.stopPropagation();
    else if (owner === 'control') event.stopImmediatePropagation();
  };
}
