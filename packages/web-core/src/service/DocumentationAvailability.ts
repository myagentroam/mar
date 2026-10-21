import { inject, type InjectionKey } from 'vue';

export const DOCUMENTATION_AVAILABLE_KEY: InjectionKey<boolean> = Symbol('documentationAvailable');

export function useDocumentationAvailability(): boolean {
  return inject(DOCUMENTATION_AVAILABLE_KEY, true);
}
