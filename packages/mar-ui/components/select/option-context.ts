import type { InjectionKey } from 'vue';

export type OptionValue = string | number | boolean;

export interface Choice {
  readonly id: string;
  readonly group: string | undefined;
  readonly value: OptionValue;
  readonly label: string | number;
  readonly disabled: boolean;
}

export const optionGroupId: InjectionKey<string> = Symbol('mar-ui-option-group');

export const optionContext: InjectionKey<{
  register(option: Choice): () => void;
  visible(option: Choice): boolean;
  groupVisible(group: string): boolean;
  selected(option: Choice): boolean;
  active(option: Choice): boolean;
  disabled(option: Choice): boolean;
  multiple(): boolean;
  pointAt(option: Choice): void;
  choose(option: Choice): void;
}> = Symbol('mar-ui-option');
