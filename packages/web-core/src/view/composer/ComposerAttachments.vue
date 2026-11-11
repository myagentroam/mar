<script setup lang="ts">
import MarIcon from '../common/MarIcon.vue';
import FileTypeIcon from '../workspace/FileTypeIcon.vue';
import { translate } from '../../service/locale-preference-service.js';
import type { ComposerAttachment } from '../../model/workbench.js';

defineProps<{ readonly attachments: readonly ComposerAttachment[] }>();
const emit = defineEmits<{
  preview: [attachment: ComposerAttachment];
  removeAttachment: [attachmentId: string];
}>();
</script>

<template>
  <ul v-if="attachments.length" class="composer-attachments attachment-list">
    <li
      v-for="attachment in attachments"
      :key="attachment.id"
      :class="{ 'attachment-with-preview': attachment.previewUrl !== null }"
    >
      <button
        v-tooltip="
          translate('generated.composerAttachments.enlarge', { value0: attachment.file.name })
        "
        v-if="attachment.previewUrl"
        class="composer-attachment-preview"
        type="button"
        :aria-label="
          translate('generated.composerAttachments.enlargeAttachment', {
            value0: attachment.file.name
          })
        "
        @click="emit('preview', attachment)"
      >
        <img
          class="composer-attachment-thumbnail"
          :src="attachment.previewUrl"
          :alt="attachment.file.name"
        />
      </button>
      <FileTypeIcon v-else :name="attachment.file.name" />
      <span class="attachment-name">{{ attachment.file.name }}</span>
      <small>{{ Math.ceil(attachment.file.size / 1024) }} KiB</small>
      <small v-if="attachment.status === 'UPLOADING'">
        <template v-if="attachment.transport === 'DIRECT'">
          {{ translate('generated.composerAttachments.directTransport') }} ·
        </template>
        <template v-else-if="attachment.transport === 'SERVER'">
          {{
            translate(
              attachment.directFallback
                ? 'generated.composerAttachments.serverFallbackTransport'
                : 'generated.composerAttachments.serverTransport'
            )
          }}
          ·
        </template>
        <template v-if="attachment.receivedBytes === 0">{{
          translate('generated.composerAttachments.uploading')
        }}</template>
        <template v-else>
          {{ translate('generated.composerAttachments.uploading2') }}
          {{ Math.round((attachment.receivedBytes / attachment.file.size) * 100) }}%
        </template>
      </small>
      <small v-else-if="attachment.status === 'COMPLETED'">{{
        translate('generated.composerAttachments.uploaded')
      }}</small>
      <small v-else
        >{{ translate('generated.composerAttachments.uploadFailed')
        }}{{ attachment.error ? `: ${attachment.error}` : '' }}</small
      >
      <button
        v-tooltip="
          translate('generated.composerAttachments.removeAttachment2', {
            value0: attachment.file.name
          })
        "
        type="button"
        class="composer-attachment-remove icon-action"
        :aria-label="
          translate('generated.composerAttachments.removeAttachment', {
            value0: attachment.file.name
          })
        "
        @click="emit('removeAttachment', attachment.id)"
      >
        <MarIcon name="delete" />
      </button>
    </li>
  </ul>
</template>
<style scoped>
.attachment-list {
  display: grid;
  gap: 0;
  max-height: 116px;
  margin: 0;
  overflow: auto;
  border-bottom: 1px solid var(--mar-border-medium);
  background: var(--mar-bg-panel);
  padding: 0;
  list-style: none;
}

.attachment-list li {
  display: grid;
  grid-template-columns: 1rem minmax(0, 1fr) auto auto auto;
  align-items: center;
  gap: 0.55rem;
  min-height: 32px;
  border: 0;
  border-radius: 0;
  border-bottom: 1px solid var(--mar-fill-hover);
  background: var(--mar-bg-panel);
  padding: 0.25rem 0.7rem;
  font-size: var(--mar-font-size-body);
}

.attachment-list li.attachment-with-preview {
  grid-template-columns: 34px minmax(0, 1fr) auto auto auto;
}

.attachment-list li:last-child {
  border-bottom: 0;
}

.attachment-list img {
  width: 30px;
  height: 30px;
  border-radius: 3px;
  object-fit: cover;
}

.attachment-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.attachment-list small {
  color: var(--mar-text-tertiary);
  font-size: var(--mar-font-size-meta);
}

.composer-attachment-preview {
  display: grid;
  width: 30px;
  height: 30px;
  padding: 0;
  overflow: hidden;
  border: 0;
  border-radius: 3px;
  background: transparent;
  cursor: pointer;
}

.composer-attachment-preview:hover,
.composer-attachment-preview:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 2px;
}

.composer-attachment-remove {
  --mar-action-icon-size: 14px;
  --mar-action-hover-color: var(--mar-color-danger-text);
  display: inline-grid;
  width: 24px;
  min-width: 24px;
  height: 24px;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: var(--mar-radius-control);
  background: transparent;
  cursor: pointer;
}
</style>
