import type { InjectionKey } from 'vue';
export type TabName = string | number;
export const tabsKey: InjectionKey<{ id: string; active(): TabName | undefined }> =
  Symbol('mar-ui-tabs');
