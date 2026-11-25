<script setup lang="ts">
import { MarDialog } from '@myagentroam/mar-ui/dialog';
import { MarIcon } from '@myagentroam/mar-ui/icons';
import { MarPopover } from '@myagentroam/mar-ui/popover';
import { onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  mountMobileDialogReturn,
  unmountMobileDialogReturn
} from '../../service/mobile-dialog-return-service.js';
import type { createWebPerformanceDiagnostics } from '../../service/web-performance-diagnostic-service.js';
import WebPerformanceDetails from './WebPerformanceDetails.vue';

// Owns sampling across layout changes; opening a surface only presents the existing data.
const props = defineProps<{
  readonly diagnostics: ReturnType<typeof createWebPerformanceDiagnostics>;
  readonly mobile?: boolean;
}>();
const mobileOpen = defineModel<boolean>('mobileOpen');
const { t } = useI18n();
const panelId = useId();
const open = ref(false);

watch(
  () => props.mobile,
  (mobile) => {
    if (mobile) open.value = false;
  }
);
onMounted(props.diagnostics.start);
onBeforeUnmount(props.diagnostics.dispose);
</script>

<template>
  <MarPopover
    v-if="!mobile"
    v-model:visible="open"
    trigger="click"
    placement="right-end"
    popper-class="mar-content-popover"
    :width="320"
    :show-arrow="false"
  >
    <template #reference>
      <button
        class="web-performance-indicator nav-menu-button mar-icon-button mar-icon-action"
        type="button"
        :aria-label="t('performanceDiagnostics.title')"
        :aria-expanded="open"
        :aria-controls="open ? panelId : undefined"
        @click="open = !open"
      >
        <MarIcon aria-hidden="true" name="info" />
      </button>
    </template>
    <WebPerformanceDetails :id="panelId" :diagnostics="diagnostics" />
  </MarPopover>
  <MarDialog
    v-else-if="mobileOpen"
    :model-value="mobileOpen"
    :title="t('performanceDiagnostics.title')"
    :width="420"
    align-center
    append-to-body
    @update:model-value="mobileOpen = $event"
    @vue:mounted="mountMobileDialogReturn"
    @vue:before-unmount="unmountMobileDialogReturn"
  >
    <WebPerformanceDetails :diagnostics="diagnostics" hide-title />
  </MarDialog>
</template>
