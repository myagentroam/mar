import type { Component } from 'vue';
import type { MarIconName } from '../../icons/icon-shapes.js';
import type { OptionValue } from './option-context.js';

export interface MarSelectProps<
  Value extends OptionValue,
  Multiple extends boolean = false,
  Clearable extends boolean = false
> {
  id?: string;
  ariaLabel?: string;
  ariaLabelledby?: string;
  modelValue?: Value | readonly Value[] | null | undefined;
  disabled?: boolean | undefined;
  validateEvent?: boolean;
  placeholder?: string;
  suffixIcon?: MarIconName | Component;
  clearIcon?: MarIconName | Component;
  clearable?: boolean & Clearable;
  filterable?: boolean;
  multiple?: boolean & Multiple;
  multipleLimit?: number;
  allowCreate?: boolean;
  defaultFirstOption?: boolean;
  collapseTags?: boolean;
  collapseTagsTooltip?: boolean;
  options?: readonly { readonly value: Value; readonly label: string | number }[];
  size?: 'small' | 'default';
  loading?: boolean;
  popperClass?: string;
}

export type MarSelection<
  Value extends OptionValue,
  Multiple extends boolean,
  Clearable extends boolean
> = Multiple extends true ? Value[] : Value | (Clearable extends true ? undefined : never);
