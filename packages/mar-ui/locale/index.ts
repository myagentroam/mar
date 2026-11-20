import { inject, shallowRef, type InjectionKey, type Ref } from 'vue';
import en from './en.js';

export interface MarUiLocale {
  readonly clear: string;
  readonly noData: string;
  readonly select: string;
}

export const marUiLocaleKey: InjectionKey<Readonly<Ref<MarUiLocale>>> = Symbol('mar-ui-locale');
const defaultLocale = shallowRef<MarUiLocale>(en);

export function useMarUiLocale() {
  return inject(marUiLocaleKey, defaultLocale);
}
