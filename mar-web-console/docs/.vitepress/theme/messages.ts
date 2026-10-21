import { computed } from 'vue';
import { useData } from 'vitepress';
import { enUS } from './messages.en-US';
import { zhCN } from './messages.zh-CN';
import { SUPPORTED_LOCALES } from '@myagentroam-enterprise/web-implementation/locale-config';

export type DocumentationMessageKey = keyof typeof enUS;

export const DOCUMENTATION_LOCALES = SUPPORTED_LOCALES.map((locale) => ({
  value: locale.value,
  pathPrefix: locale.docsPrefix
}));

const documentationMessages: Readonly<
  Record<string, Readonly<Record<DocumentationMessageKey, string>>>
> = {
  'en-US': enUS,
  'zh-CN': zhCN
};

export function useDocumentationMessages() {
  const { lang } = useData();
  const messages = computed(() => documentationMessages[lang.value] ?? enUS);
  return {
    t: (key: DocumentationMessageKey): string => messages.value[key]
  };
}
