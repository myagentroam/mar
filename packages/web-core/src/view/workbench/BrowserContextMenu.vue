<script setup lang="ts">
// Presents a resolved remote page context; the Browser Aside owns input and clipboard actions.
import { computed, onMounted, ref } from 'vue';
import {
  MarDropdown,
  MarDropdownItem,
  MarDropdownMenu,
  type MarDropdownInstance
} from '@myagentroam/mar-ui/dropdown';
import type { BrowserContextOptions } from '@myagentroam/protocol';
import { translate as t } from '../../service/locale-preference-service.js';

type Command = 'copy' | 'paste' | 'copyLink' | 'openLink' | 'back' | 'forward' | 'reload';

const props = defineProps<{
  options: BrowserContextOptions;
  anchor: DOMRect;
  canGoBack: boolean;
  canGoForward: boolean;
  canOpenTab: boolean;
}>();
const emit = defineEmits<{
  command: [command: Command];
  close: [];
}>();
const menu = ref<MarDropdownInstance>();
const virtualReference = { getBoundingClientRect: () => props.anchor };
const clipboard = computed(() => navigator.clipboard);
const modifier = /Mac/i.test(navigator.platform) ? '⌘' : 'Ctrl+';
onMounted(() => menu.value?.handleOpen());
</script>

<template>
  <!-- @vue-generic {Command} -->
  <MarDropdown
    ref="menu"
    trigger="contextmenu"
    virtual-triggering
    :virtual-ref="virtualReference"
    popper-class="browser-context-menu"
    placement="bottom-start"
    :offset="0"
    @command="emit('command', $event)"
    @visible-change="!$event && emit('close')"
  >
    <template #dropdown>
      <MarDropdownMenu :aria-label="t('browser.contextMenu')">
        <template v-if="options.link">
          <MarDropdownItem command="openLink" :disabled="!canOpenTab">{{
            t('browser.contextOpenLink')
          }}</MarDropdownItem>
          <MarDropdownItem command="copyLink">{{ t('browser.contextCopyLink') }}</MarDropdownItem>
        </template>
        <MarDropdownItem command="copy" :disabled="!options.copy" :divided="!!options.link">
          <span>{{ t('browser.contextCopy') }}</span>
          <kbd aria-hidden="true">{{ modifier }}C</kbd>
        </MarDropdownItem>
        <MarDropdownItem command="paste" :disabled="!options.paste || !clipboard?.readText">
          <span>{{ t('browser.contextPaste') }}</span>
          <kbd aria-hidden="true">{{ modifier }}V</kbd>
        </MarDropdownItem>
        <MarDropdownItem command="back" divided :disabled="!canGoBack">{{
          t('browser.back')
        }}</MarDropdownItem>
        <MarDropdownItem command="forward" :disabled="!canGoForward">{{
          t('browser.forward')
        }}</MarDropdownItem>
        <MarDropdownItem command="reload">{{ t('browser.reload') }}</MarDropdownItem>
      </MarDropdownMenu>
    </template>
  </MarDropdown>
</template>

<style>
.browser-context-menu.mar-ui-popup {
  --mar-ui-popup-padding: 6px 0;
  --mar-ui-popup-radius: 8px;
  --mar-ui-overlay-surface: #fff;
  --mar-ui-overlay-border: #dadce0;
  --mar-ui-overlay-shadow: 0 4px 12px rgb(0 0 0 / 24%);
  --mar-ui-text-primary: #202124;
  --mar-ui-text-secondary: var(--mar-ui-text-primary);
  --mar-ui-text-disabled: #6c7075;
  --mar-ui-border-subtle: var(--mar-ui-overlay-border);
  --mar-ui-overlay-row-hover: #f1f3f4;
  --mar-ui-font-size-control: max(13px, 0.75rem);
  min-inline-size: min(13rem, var(--mar-ui-popup-width-limit));
  font-family: Arial, system-ui, sans-serif;
}
.browser-context-menu .mar-ui-dropdown-item {
  gap: 1rem;
  justify-content: space-between;
  min-block-size: 26px;
  padding-inline: 1rem;
}
.browser-context-menu .mar-ui-dropdown-item:disabled {
  cursor: default;
}
.browser-context-menu kbd {
  color: var(--mar-ui-text-disabled);
  font: inherit;
  white-space: nowrap;
}
@supports (color: light-dark(#000, #fff)) {
  .browser-context-menu.mar-ui-popup {
    --mar-ui-overlay-surface: light-dark(#fff, #292a2d);
    --mar-ui-overlay-border: light-dark(#dadce0, #4b4c4f);
    --mar-ui-text-primary: light-dark(#202124, #e8eaed);
    --mar-ui-text-disabled: light-dark(#6c7075, #a1a5ab);
    --mar-ui-overlay-row-hover: light-dark(#f1f3f4, #3c4043);
  }
}
</style>
