import type { InjectionKey, ObjectDirective } from 'vue';

/** Optional adapter to the application's shared tooltip host. */
export const marUiTooltipDirectiveKey: InjectionKey<ObjectDirective<Element, string | undefined>> =
  Symbol('mar-ui-tooltip-directive');
