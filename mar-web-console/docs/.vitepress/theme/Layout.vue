<script setup lang="ts">
import DefaultTheme from 'vitepress/theme';
import DocumentMeta from './components/DocumentMeta.vue';
import { DOCUMENTATION_LOCALES, useDocumentationMessages } from './messages';
import { LOCALE_STORAGE_KEY } from '@myagentroam/web-core/locale-config';
import { nextTick, onMounted, onUnmounted, watch } from 'vue';
import { useData, useRoute, useRouter } from 'vitepress';

const DefaultLayout = DefaultTheme.Layout;
const { t } = useDocumentationMessages();
const { lang } = useData();
const route = useRoute();
const router = useRouter();

function currentRelativePath(): string {
  const locale = DOCUMENTATION_LOCALES.find((candidate) => candidate.value === lang.value);
  const prefix = locale?.pathPrefix ?? '/docs';
  if (route.path === prefix) return '/getting-started/overview';
  if (route.path.startsWith(`${prefix}/`)) return route.path.slice(prefix.length) || '/';
  return '/getting-started/overview';
}

function navigateToLanguage(value: string): void {
  const locale = DOCUMENTATION_LOCALES.find((candidate) => candidate.value === value);
  if (locale === undefined || locale.value === lang.value) return;
  void router.go(`${locale.pathPrefix}${currentRelativePath()}`);
}

function onStorage(event: StorageEvent): void {
  if (event.key === LOCALE_STORAGE_KEY && event.newValue !== null)
    navigateToLanguage(event.newValue);
}

async function localizeCodeCopyButtons(): Promise<void> {
  await nextTick();
  for (const button of document.querySelectorAll<HTMLElement>(
    '.vp-doc div[class*="language-"] > button.copy'
  )) {
    button.title = t('copyCode');
    button.setAttribute('aria-label', t('copyCode'));
  }
}

onMounted(() => {
  void localizeCodeCopyButtons();
  window.addEventListener('storage', onStorage);
});
onUnmounted(() => window.removeEventListener('storage', onStorage));
watch([() => route.path, lang], localizeCodeCopyButtons, { flush: 'post' });
watch(
  lang,
  (value) => {
    if (
      typeof localStorage !== 'undefined' &&
      DOCUMENTATION_LOCALES.some((candidate) => candidate.value === value)
    )
      localStorage.setItem(LOCALE_STORAGE_KEY, value);
  },
  { immediate: true }
);
</script>

<template>
  <DefaultLayout>
    <template #nav-bar-content-after>
      <div class="docs-desktop-actions">
        <a class="docs-console-link" href="/console" target="_self">{{ t('console') }}</a>
      </div>
    </template>
    <template #nav-screen-content-after>
      <div class="docs-mobile-actions">
        <a class="docs-console-link" href="/console" target="_self">{{ t('console') }}</a>
      </div>
    </template>
    <template #doc-before>
      <DocumentMeta />
    </template>
  </DefaultLayout>
</template>
