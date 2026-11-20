<script setup lang="ts">
import { themePreferenceService } from './service/theme-preference-service.js';
import { MarMessageBox } from './service/message-box-service.js';
import { clearMessages } from './service/message-feedback-service.js';
import {
  computed,
  defineAsyncComponent,
  onBeforeUnmount,
  onMounted,
  provide,
  type Component
} from 'vue';
import { DOCUMENTATION_AVAILABLE_KEY } from './service/documentation-availability.js';
import marEn from '@myagentroam/mar-ui/locale/en';
import marZhCn from '@myagentroam/mar-ui/locale/zh-cn';
import { marUiLocaleKey } from '@myagentroam/mar-ui/locale';
import { localePreferenceService } from './service/locale-preference-service.js';
import { consoleKeyboardShortcutService } from './service/console-keyboard-shortcut-service.js';
import SharedTooltipHost from './view/common/SharedTooltipHost.vue';
const SessionSharePage = defineAsyncComponent(
  () => import('./view/conversation/SessionSharePage.vue')
);
const RemoteDesktopPage = defineAsyncComponent(
  () => import('./view/remote-desktop/RemoteDesktopPage.vue')
);

const props = defineProps<{
  readonly documentationAvailable?: boolean;
  readonly workbench: Component;
  readonly filePreview: Component;
}>();

provide(DOCUMENTATION_AVAILABLE_KEY, props.documentationAvailable ?? true);

const query = new URLSearchParams(location.search);
const remoteDesktopNode = query.get('remoteDesktop') === '1' ? query.get('nodeId') : null;
const standaloneDesktop =
  remoteDesktopNode !== null && remoteDesktopNode.length > 0 && remoteDesktopNode.length <= 512;
const shareId = /^[/]share[/]([A-Za-z0-9_-]{1,128})$/u.exec(location.pathname)?.[1];
const renderedFilePreview =
  query.get('markdownPreview') === '1' || query.get('htmlPreview') === '1';
const standaloneFilePreview =
  query.get('standaloneFile') === '1' && (renderedFilePreview || query.get('source') === 'hosted');
document.documentElement.classList.toggle('console-ui', true);
themePreferenceService();
const localeService = localePreferenceService();
const marLocales = { 'zh-CN': marZhCn, 'en-US': marEn } as const;
provide(
  marUiLocaleKey,
  computed(() => marLocales[localeService.locale.value])
);

function revealApplication(): void {
  document.getElementById('mar-bootstrap')?.remove();
}

function preventBrowserContextMenu(event: MouseEvent): void {
  if (standaloneDesktop) return;
  if (standaloneFilePreview && renderedFilePreview) return;
  const pointerType = (event as PointerEvent).pointerType;
  if (pointerType === 'touch' || window.matchMedia('(hover: none) and (pointer: coarse)').matches)
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
  if (location.pathname === '/' || location.pathname === '/index.html')
    window.history.replaceState(
      window.history.state,
      '',
      `/console${location.search}${location.hash}`
    );
  document.addEventListener('contextmenu', preventBrowserContextMenu);
  if (!standaloneDesktop)
    document.addEventListener('keydown', consoleKeyboardShortcutService.handle, { capture: true });
});
onBeforeUnmount(() => {
  MarMessageBox.close();
  clearMessages();
  document.removeEventListener('contextmenu', preventBrowserContextMenu);
  document.removeEventListener('keydown', consoleKeyboardShortcutService.handle, { capture: true });
});
</script>

<template>
  <SharedTooltipHost />
  <Suspense @resolve="revealApplication">
    <SessionSharePage v-if="shareId" :share-id="shareId" />
    <RemoteDesktopPage v-else-if="standaloneDesktop" :node-id="remoteDesktopNode!" />
    <component :is="filePreview" v-else-if="standaloneFilePreview" />
    <component :is="workbench" v-else />
  </Suspense>
</template>
