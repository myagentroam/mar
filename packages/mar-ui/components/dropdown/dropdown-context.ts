import type { InjectionKey, Ref, ShallowRef, StyleValue } from 'vue';

export type DropdownCommand = string | number | object;
export interface MarDropdownInstance {
  handleOpen(): void;
  handleClose(): void;
}

export const dropdownContext: InjectionKey<{
  menuId: string;
  triggerId: Readonly<Ref<string | undefined>>;
  surface: ShallowRef<HTMLElement | null>;
  popupClass: Readonly<Ref<string | undefined>>;
  popupStyle: Readonly<Ref<StyleValue | undefined>>;
  activate(command?: DropdownCommand): void;
}> = Symbol('mar-ui-command');
