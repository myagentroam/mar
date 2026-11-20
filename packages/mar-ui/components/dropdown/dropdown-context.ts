import type { InjectionKey, Ref, ShallowRef } from 'vue';

export type Command = string;
export const dropdownContext: InjectionKey<{
  menuId: string;
  triggerId: Readonly<Ref<string>>;
  surface: ShallowRef<HTMLElement | null>;
  run(command: Command): void;
}> = Symbol('mar-ui-command');
