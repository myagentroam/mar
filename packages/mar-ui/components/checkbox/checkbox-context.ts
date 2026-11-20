import type { InjectionKey } from 'vue';

export type CheckboxValue = string | number | boolean;
export const checkboxGroupKey: InjectionKey<{
  id: string | undefined;
  disabled(): boolean;
  checked(value: CheckboxValue): boolean;
  select(value: CheckboxValue, checked: boolean): void;
}> = Symbol('mar-ui-checkbox-group');
