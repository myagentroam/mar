import { inject, shallowRef, type InjectionKey, type Ref } from 'vue';
import en from './en.js';

export interface MarUiLocale {
  readonly clear: string;
  readonly noData: string;
  readonly select: string;
  readonly invalidField: string;
  readonly close: string;
  readonly decrease: string;
  readonly increase: string;
  readonly datePicker: {
    readonly locale: string;
    readonly calendar: string;
    readonly start: string;
    readonly end: string;
    readonly time: string;
    readonly hours: string;
    readonly minutes: string;
    readonly startTime: string;
    readonly endTime: string;
    readonly confirm: string;
    readonly cancel: string;
    readonly previousMonth: string;
    readonly nextMonth: string;
    readonly previousYear: string;
    readonly nextYear: string;
  };
  readonly table: {
    readonly expand: string;
    readonly collapse: string;
  };
  readonly pagination: {
    readonly label: string;
    readonly total: string;
    readonly previous: string;
    readonly next: string;
    readonly page: string;
    readonly back: string;
    readonly forward: string;
  };
}

export const marUiLocaleKey: InjectionKey<Readonly<Ref<MarUiLocale>>> = Symbol('mar-ui-locale');
const defaultLocale = shallowRef<MarUiLocale>(en);

export function useMarUiLocale() {
  return inject(marUiLocaleKey, defaultLocale);
}
