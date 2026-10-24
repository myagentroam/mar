<script setup lang="ts">
import {
  mountMobileDialogReturn,
  unmountMobileDialogReturn
} from '../../service/MobileDialogReturnService.js';
import { marIcon } from '../../util/mar-icons.js';
import { computed, watch } from 'vue';
import { translate } from '../../service/LocalePreferenceService.js';
import type { ComposerAttachment } from '../../model/workbench.js';

const props = defineProps<{
  readonly attachmentOpen: boolean;
  readonly attachment: ComposerAttachment | undefined;
  readonly conversationOpen: boolean;
  readonly conversation: { readonly name: string; readonly url: string } | undefined;
}>();

const emit = defineEmits<{
  'update:attachmentOpen': [value: boolean];
  'update:conversationOpen': [value: boolean];
  clearAttachment: [];
  clearConversation: [];
  conversationError: [url: string];
}>();

const attachmentTitle = computed(
  () => props.attachment?.file.name ?? translate('generated.imagePreviewDialogs.attachmentPreview')
);
const conversationTitle = computed(
  () => props.conversation?.name ?? translate('generated.imagePreviewDialogs.imagePreview')
);

watch(
  () => props.attachmentOpen,
  (open) => {
    if (!open) emit('clearAttachment');
  }
);
watch(
  () => props.conversationOpen,
  (open) => {
    if (!open) emit('clearConversation');
  }
);
</script>

<template>
  <el-dialog
    @vue:mounted="mountMobileDialogReturn"
    @vue:before-unmount="unmountMobileDialogReturn"
    v-if="attachmentOpen"
    :model-value="attachmentOpen"
    :title="attachmentTitle"
    append-to-body
    align-center
    class="attachment-preview-dialog"
    destroy-on-close
    @update:model-value="emit('update:attachmentOpen', $event)"
    :close-icon="marIcon('close')"
  >
    <template #header="{ titleId, titleClass }">
      <span v-tooltip="attachmentTitle" :id="titleId" :class="titleClass">{{
        attachmentTitle
      }}</span>
    </template>
    <img
      v-if="attachment?.previewUrl"
      class="attachment-preview-image"
      :src="attachment.previewUrl"
      :alt="attachment.file.name"
    />
  </el-dialog>
  <el-dialog
    @vue:mounted="mountMobileDialogReturn"
    @vue:before-unmount="unmountMobileDialogReturn"
    v-if="conversationOpen"
    :model-value="conversationOpen"
    :title="conversationTitle"
    append-to-body
    align-center
    class="attachment-preview-dialog"
    destroy-on-close
    @update:model-value="emit('update:conversationOpen', $event)"
    :close-icon="marIcon('close')"
  >
    <template #header="{ titleId, titleClass }">
      <span v-tooltip="conversationTitle" :id="titleId" :class="titleClass">{{
        conversationTitle
      }}</span>
    </template>
    <img
      v-if="conversation !== undefined"
      :key="conversation.url"
      class="attachment-preview-image"
      :src="conversation.url"
      :alt="conversation.name"
      @error="
        emit('conversationError', ($event.target as HTMLImageElement).getAttribute('src') ?? '')
      "
    />
  </el-dialog>
</template>

<style scoped>
:global(.attachment-preview-dialog.el-dialog) {
  --preview-left: max(16px, env(safe-area-inset-left, 0px));
  --preview-right: max(16px, env(safe-area-inset-right, 0px));
  --preview-top: max(16px, env(safe-area-inset-top, 0px));
  --preview-bottom: max(16px, env(safe-area-inset-bottom, 0px));
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  width: min(960px, calc(100vw - var(--preview-left) - var(--preview-right)));
  height: min(760px, calc(100dvh - var(--preview-top) - var(--preview-bottom)));
  margin: auto;
  left: calc((var(--preview-left) - var(--preview-right)) / 2);
  top: calc((var(--preview-top) - var(--preview-bottom)) / 2);
  background: var(--mar-control-bg-color-overlay);
}
:global(.attachment-preview-dialog .el-dialog__header) {
  min-width: 0;
  flex: 0 0 auto;
}
:global(.attachment-preview-dialog .el-dialog__title) {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--mar-font-size-title);
  font-weight: 600;
}
:global(.attachment-preview-dialog .el-dialog__body) {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex: 1;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  padding-top: 0;
}

.attachment-preview-image {
  display: block;
  width: auto;
  height: auto;
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}

@media (max-width: 767px) {
  :global(.attachment-preview-dialog.el-dialog) {
    width: 100%;
    height: 100dvh;
    margin: 0;
    left: 0;
    top: 0;
    border: 0;
    border-radius: 0;
    padding: calc(1rem + env(safe-area-inset-top, 0px)) calc(1rem + env(safe-area-inset-right, 0px))
      calc(1rem + env(safe-area-inset-bottom, 0px)) calc(1rem + env(safe-area-inset-left, 0px));
  }
}
</style>
