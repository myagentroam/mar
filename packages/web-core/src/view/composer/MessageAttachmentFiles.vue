<script setup lang="ts">
import type { ComposerAttachmentFile } from '@myagentroam/protocol';
import FileTypeIcon from '../workspace/FileTypeIcon.vue';
import ConversationImageThumbnail from '../conversation/ConversationImageThumbnail.vue';
import { translate } from '../../service/locale-preference-service.js';
defineProps<{
  files: readonly ComposerAttachmentFile[];
  imageResourceUrl?: ((path: string) => string) | undefined;
}>();
const emit = defineEmits<{
  openFile: [
    path: string,
    line: number | undefined,
    column: number | undefined,
    external: boolean,
    attachment: ComposerAttachmentFile
  ];
}>();
</script>

<template>
  <div
    v-if="files.length"
    class="conversation-file-attachments"
    :aria-label="translate('generated.conversationTimeline.attachments')"
  >
    <template v-for="file in files" :key="file.path">
      <ConversationImageThumbnail
        v-if="file.mime.startsWith('image/')"
        class="conversation-file-attachment"
        :source="imageResourceUrl?.(file.path) ?? ''"
        :name="translate('generated.conversationTimeline.imageAttachment')"
        :aria-label="
          translate('generated.conversationTimeline.enlarge', {
            value0: translate('generated.conversationTimeline.imageAttachment')
          })
        "
        @click="
          emit('openFile', file.path, undefined, undefined, $event.ctrlKey || $event.metaKey, file)
        "
      />
      <button
        v-tooltip="file.path"
        v-else
        type="button"
        class="conversation-file-attachment conversation-file-chip"
        :aria-label="translate('generated.conversationTimeline.previewFile', { value0: file.name })"
        @click="
          emit('openFile', file.path, undefined, undefined, $event.ctrlKey || $event.metaKey, file)
        "
      >
        <FileTypeIcon :name="file.name" /><span class="conversation-file-name">{{
          file.name
        }}</span>
      </button>
    </template>
  </div>
</template>

<style scoped>
.conversation-file-attachments {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 0.4rem;
  margin-top: 0.5rem;
}
.conversation-file-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  min-width: 0;
  max-width: 100%;
  border: 1px solid var(--mar-border-default);
  border-radius: 6px;
  padding: 0.35rem 0.55rem;
  background: color-mix(in srgb, var(--mar-conversation-surface) 65%, transparent);
  color: var(--mar-conversation-text);
  font: inherit;
  cursor: pointer;
}
.conversation-file-chip:hover {
  border-color: var(--mar-border-strong);
  background: var(--mar-fill-row-hover);
}
.conversation-file-chip:focus-visible {
  outline: 2px solid var(--mar-color-brand);
  outline-offset: 2px;
}
.conversation-file-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
}
</style>
