import type { InjectionKey } from 'vue';
export type RadioValue = string | number | boolean;
export const radioGroupKey: InjectionKey<{
  name: string;
  disabled(): boolean;
  checked(value: RadioValue): boolean;
  select(value: RadioValue): void;
}> = Symbol('mar-ui-radio-group');
