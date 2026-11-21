import type { InjectionKey } from 'vue';
import type { TabName } from './tab-types.js';
export const tabsKey: InjectionKey<{ id: string; active(): TabName | undefined }> =
  Symbol('mar-ui-tabs');
