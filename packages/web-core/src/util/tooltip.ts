import type { ElTooltipProps, TooltipInstance } from 'element-plus';
import type { ComponentPublicInstance, VNodeProps } from 'vue';

const boundTargets = new WeakSet<HTMLElement>();

// Element Plus closes on Escape inside its popper, but not on a focused trigger.
// Bind only to the actual trigger through its public ref; detached targets are collectible.
function bindEscape(value: Element | ComponentPublicInstance | null): void {
  if (value === null) return;
  const tooltip = value as TooltipInstance;
  const target = tooltip.popperRef?.triggerRef;
  if (!(target instanceof HTMLElement) || boundTargets.has(target)) return;
  boundTargets.add(target);
  target.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    // Element Plus sets this relation only while the hint is open.
    // Dismiss that layer without also closing its containing dialog.
    if (target.hasAttribute('aria-describedby')) event.stopPropagation();
    tooltip.onClose(event);
  });
}

// Keep hover/focus hints passive: Enter and Space belong to the underlying control.
export const tableTooltipOptions = {
  effect: 'light',
  popperClass: 'mar-tooltip',
  trigger: ['hover', 'focus'],
  triggerKeys: [],
  showAfter: 350,
  hideAfter: 100,
  showArrow: false
} satisfies Partial<ElTooltipProps>;

// Table overflow hints are created outside a Vue render owner and cannot take a template ref.
export const tooltipOptions = {
  ...tableTooltipOptions,
  ref: bindEscape
} satisfies Partial<ElTooltipProps> & VNodeProps;
