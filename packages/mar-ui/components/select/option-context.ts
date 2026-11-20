import type { InjectionKey } from 'vue';

export type OptionValue = string | number | boolean;

export interface Choice {
  readonly id: string;
  readonly value: OptionValue;
  readonly label?: string | number;
  readonly disabled?: boolean;
}

export const optionContext: InjectionKey<{
  register(option: Choice): () => void;
  selected(option: Choice): boolean;
  active(option: Choice): boolean;
  choose(option: Choice): void;
}> = Symbol('mar-ui-option');
