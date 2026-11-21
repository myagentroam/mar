import type { InjectionKey, ObjectDirective } from 'vue';

/** A reader supplies full text only for a label whose accessible name is already complete. */
export type ReadOverflowText = () => string | undefined;
export type TooltipText = string | ReadOverflowText | undefined;

/** Optional adapter to the application's shared tooltip host. */
export const marUiTooltipDirectiveKey: InjectionKey<ObjectDirective<Element, TooltipText>> = Symbol(
  'mar-ui-tooltip-directive'
);

/** Read only the current label, and only when its full text is not visible. */
export function readOverflowText(label: HTMLElement | null): string | undefined {
  if (label && label.clientWidth > 0 && label.scrollWidth > label.clientWidth) {
    return label.textContent?.trim() || undefined;
  }
}
