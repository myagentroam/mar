<script setup lang="ts">
import { themePreferenceService } from './service/ThemePreferenceService.js';
import {
  computed,
  defineAsyncComponent,
  onBeforeUnmount,
  onMounted,
  provide,
  type Component
} from 'vue';
import { DOCUMENTATION_AVAILABLE_KEY } from './service/DocumentationAvailability.js';
import en from 'element-plus/es/locale/lang/en';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import { localePreferenceService } from './service/LocalePreferenceService.js';
import { consoleKeyboardShortcutService } from './service/ConsoleKeyboardShortcutService.js';
const SessionSharePage = defineAsyncComponent(
  () => import('./view/conversation/SessionSharePage.vue')
);

const props = defineProps<{
  readonly home: Component;
  readonly rootWorkbench?: boolean;
  readonly documentationAvailable?: boolean;
  readonly workbench: Component;
  readonly filePreview: Component;
}>();

provide(DOCUMENTATION_AVAILABLE_KEY, props.documentationAvailable ?? true);

const marketingHome =
  !props.rootWorkbench && (location.pathname === '/' || location.pathname === '/index.html');
const query = new URLSearchParams(location.search);
const shareId = /^[/]share[/]([A-Za-z0-9_-]{1,128})$/u.exec(location.pathname)?.[1];
const renderedFilePreview =
  query.get('markdownPreview') === '1' || query.get('htmlPreview') === '1';
const standaloneFilePreview =
  query.get('standaloneFile') === '1' && (renderedFilePreview || query.get('source') === 'hosted');
document.documentElement.classList.toggle('console-ui', !marketingHome);
if (!marketingHome) themePreferenceService();
const localeService = localePreferenceService();
const elementLocales = { 'zh-CN': zhCn, 'en-US': en } as const;
const elementLocale = computed(() => elementLocales[localeService.locale.value]);

function revealApplication(): void {
  const bootstrap = document.getElementById('mar-bootstrap');
  if (!bootstrap) return;
  bootstrap.classList.add('mar-bootstrap--leaving');
  bootstrap.addEventListener('transitionend', () => bootstrap.remove(), { once: true });
  window.setTimeout(() => bootstrap.remove(), 240);
}

function preventBrowserContextMenu(event: MouseEvent): void {
  if (standaloneFilePreview && renderedFilePreview) return;
  const pointerType = (event as PointerEvent).pointerType;
  if (
    pointerType === 'touch' ||
    (pointerType !== 'mouse' && window.matchMedia('(hover: none) and (pointer: coarse)').matches)
  )
    return;
  const target = event.target;
  if (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.matches('input, textarea, select') ||
      target.closest('img, video, audio') !== null ||
      target.closest('[contenteditable]:not([contenteditable="false"])') !== null)
  )
    return;
  event.preventDefault();
}

onMounted(() => {
  document.addEventListener('contextmenu', preventBrowserContextMenu);
  document.addEventListener('keydown', consoleKeyboardShortcutService.handle, { capture: true });
});
onBeforeUnmount(() => {
  document.removeEventListener('contextmenu', preventBrowserContextMenu);
  document.removeEventListener('keydown', consoleKeyboardShortcutService.handle, { capture: true });
});
</script>

<template>
  <Suspense @resolve="revealApplication">
    <el-config-provider :locale="elementLocale">
      <component :is="home" v-if="marketingHome" />
      <SessionSharePage v-else-if="shareId" :share-id="shareId" />
      <component :is="filePreview" v-else-if="standaloneFilePreview" />
      <component :is="workbench" v-else />
    </el-config-provider>
  </Suspense>
</template>
