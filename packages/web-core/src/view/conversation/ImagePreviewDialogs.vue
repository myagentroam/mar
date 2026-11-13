<script setup lang="ts">
import {
  mountMobileDialogReturn,
  unmountMobileDialogReturn
} from '../../service/mobile-dialog-return-service.js';
import { marIcon } from '../../util/mar-icons.js';
import { computed, ref, watch } from 'vue';
import { translate } from '../../service/locale-preference-service.js';
import type { ComposerAttachment } from '../../model/workbench.js';
import DecodedPreviewImage from './DecodedPreviewImage.vue';

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
const original = ref(false);
const resized = ref(false);
watch(
  [() => props.conversation?.url, () => props.conversationOpen],
  () => {
    original.value = false;
    resized.value = false;
  },
  { flush: 'sync' }
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
    <DecodedPreviewImage
      v-if="attachment?.previewUrl"
      :source="attachment.previewUrl"
      :name="attachment.file.name"
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
      <div class="image-preview-heading">
        <span v-tooltip="conversationTitle" :id="titleId" :class="titleClass">{{
          conversationTitle
        }}</span>
        <el-button
          v-if="resized && !original"
          v-tooltip="translate('generated.imagePreview.viewOriginal')"
          class="mar-icon-action"
          size="small"
          text
          :icon="marIcon('image')"
          :aria-label="translate('generated.imagePreview.viewOriginal')"
          @click="original = true"
        />
      </div>
    </template>
    <DecodedPreviewImage
      v-if="conversation !== undefined"
      :key="conversation.url"
      :source="conversation.url"
      :name="conversation.name"
      :original="original"
      @ready="resized = $event"
      @error="emit('conversationError', $event)"
    />
  </el-dialog>
</template>

<style scoped>
.image-preview-heading {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  min-width: 0;
}
.image-preview-heading .el-dialog__title {
  min-width: 0;
  flex: 1;
}
.image-preview-heading .el-button {
  flex-shrink: 0;
}
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
