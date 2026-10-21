<script setup lang="ts">
import { translate } from '../../service/LocalePreferenceService.js';
import type { ComposerAttachment } from '../../model/workbench.js';

defineProps<{
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
</script>

<template>
  <el-dialog
    :model-value="attachmentOpen"
    :title="attachment?.file.name ?? translate('generated.imagePreviewDialogs.attachmentPreview')"
    append-to-body
    class="attachment-preview-dialog"
    width="min(960px, calc(100vw - 32px))"
    destroy-on-close
    @update:model-value="emit('update:attachmentOpen', $event)"
    @closed="emit('clearAttachment')"
  >
    <img
      v-if="attachment?.previewUrl"
      class="attachment-preview-image"
      :src="attachment.previewUrl"
      :alt="attachment.file.name"
    />
  </el-dialog>
  <el-dialog
    :model-value="conversationOpen"
    :title="conversation?.name ?? translate('generated.imagePreviewDialogs.imagePreview')"
    append-to-body
    class="attachment-preview-dialog"
    width="min(960px, calc(100vw - 32px))"
    destroy-on-close
    @update:model-value="emit('update:conversationOpen', $event)"
    @closed="emit('clearConversation')"
  >
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
:global(.attachment-preview-dialog .el-dialog__title) {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
:global(.attachment-preview-dialog .el-dialog__body) {
  display: grid;
  max-height: min(72vh, 760px);
  place-items: center;
  padding-top: 0;
}

.attachment-preview-image {
  display: block;
  max-width: 100%;
  max-height: min(68vh, 700px);
  object-fit: contain;
}
</style>
