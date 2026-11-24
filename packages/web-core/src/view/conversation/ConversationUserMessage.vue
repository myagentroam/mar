<script setup lang="ts">
import { computed } from 'vue';
import { MarIcon } from '@myagentroam/mar-ui/icons';
import type { ComposerAttachmentFile } from '@myagentroam/protocol';
import MessageAttachmentFiles from '../composer/MessageAttachmentFiles.vue';
import MessageReferenceTags from '../composer/MessageReferenceTags.vue';
import ConversationImageThumbnail from './ConversationImageThumbnail.vue';
import { translate } from '../../service/locale-preference-service.js';
import {
  composerMessageCopyText,
  composerMessagePresentation
} from '../../util/composer-message.js';
import {
  absoluteMessageTime,
  composerMessageSource,
  conversationItemLabel
} from '../../util/conversation-presentation.js';
import { conversationUrlSegments } from '../../util/conversation-url-segments.js';

/** Render public input identically in the main flow and in the collaboration disclosure. */
const props = defineProps<{
  payload: unknown;
  sharerName?: string | undefined;
  timestamp?: number | undefined;
  images: readonly { name: string; previewUrl: string | undefined }[];
  imageResourceUrl?: ((path: string) => string) | undefined;
  openUrl?: ((url: string, alternate: boolean) => boolean) | undefined;
  copied: boolean;
  canRewind: boolean;
  canRollback: boolean;
  loading: boolean;
}>();
const emit = defineEmits<{
  openFile: [
    path: string,
    line: number | undefined,
    column: number | undefined,
    external: boolean,
    attachment?: ComposerAttachmentFile
  ];
  openImage: [attachment: { name: string; previewUrl: string | undefined }];
  imageUnavailable: [source: string];
  copy: [];
  rewind: [];
  rollback: [];
}>();
const message = computed(() => composerMessagePresentation(props.payload));
const text = computed(() =>
  message.value.restarted ? translate('presentation.systemRestartMessage') : message.value.text
);
const copyText = computed(() => composerMessageCopyText(props.payload));
const heading = computed(() => {
  const input = message.value;
  const label =
    props.sharerName ??
    (input.restarted || input.scheduled || input.goal
      ? conversationItemLabel('user_message', props.payload)
      : undefined);
  return (
    composerMessageSource(input) ?? (label === undefined ? undefined : { label, title: undefined })
  );
});
function openPlainUrl(event: MouseEvent, url: string): void {
  if (event.button === 0 && props.openUrl?.(url, event.ctrlKey || event.metaKey))
    event.preventDefault();
}
</script>

<template>
  <div v-if="heading" class="conversation-item-heading">
    <strong
      v-tooltip="{
        content: heading?.title,
        disabled: !heading?.title
      }"
      :aria-description="heading?.title"
      >{{ heading?.label }}</strong
    >
  </div>
  <MessageReferenceTags :references="message.references" />
  <p v-if="text" class="conversation-message">
    <template v-if="openUrl"
      ><template v-for="(part, index) in conversationUrlSegments(text)" :key="index"
        ><a
          v-if="part.url"
          :href="part.url"
          target="_blank"
          rel="noopener noreferrer"
          @click="openPlainUrl($event, part.url)"
          >{{ part.text }}</a
        ><template v-else>{{ part.text }}</template></template
      ></template
    ><template v-else>{{ text }}</template>
  </p>
  <MessageAttachmentFiles
    :files="message.files"
    :image-resource-url="props.imageResourceUrl"
    @open-file="
      (path, line, column, external, attachment) =>
        emit('openFile', path, line, column, external, attachment)
    "
  />
  <div v-if="!message.files.length && images.length" class="conversation-user-image-attachments">
    <template v-for="attachment in images" :key="attachment.name">
      <ConversationImageThumbnail
        v-if="attachment.previewUrl"
        :source="attachment.previewUrl"
        :name="attachment.name"
        :aria-label="
          translate('generated.conversationTimeline.enlarge', { value0: attachment.name })
        "
        @click="emit('openImage', attachment)"
        @unavailable="emit('imageUnavailable', $event)"
      />
      <span v-else class="conversation-user-image-placeholder"
        >{{ translate('generated.conversationTimeline.imageAttachment') }}:
        {{ attachment.name }}</span
      >
    </template>
  </div>
  <div
    v-if="timestamp !== undefined || copyText || canRewind || canRollback"
    class="conversation-message-actions"
  >
    <time
      v-tooltip="absoluteMessageTime(timestamp!)"
      v-if="timestamp !== undefined"
      class="conversation-message-time"
      :datetime="new Date(timestamp!).toISOString()"
      >{{ absoluteMessageTime(timestamp!) }}</time
    >
    <button
      v-tooltip="
        translate(
          copied
            ? 'generated.conversationTimeline.copiedMessage'
            : 'generated.conversationTimeline.copyMessage2'
        )
      "
      v-if="copyText"
      class="conversation-message-action mar-icon-button mar-icon-action"
      type="button"
      :aria-label="
        copied
          ? translate('generated.conversationTimeline.copiedMessage')
          : translate('generated.conversationTimeline.copyMessage', {
              value0: conversationItemLabel('user_message')
            })
      "
      @click.stop="emit('copy')"
    >
      <MarIcon name="check" v-if="copied" />
      <MarIcon name="copy" v-else />
    </button>
    <button
      v-tooltip="translate('generated.conversationTimeline.createSessionBranchBeforeMessage')"
      v-if="canRewind"
      class="conversation-message-action mar-icon-button mar-icon-action"
      type="button"
      :aria-label="translate('generated.conversationTimeline.createSessionBranchBeforeMessage')"
      @click.stop="emit('rewind')"
    >
      <MarIcon name="branch" />
    </button>
    <button
      v-tooltip="translate('generated.conversationTimeline.rollbackConversation')"
      v-if="canRollback"
      class="conversation-message-action mar-icon-button mar-icon-action"
      type="button"
      :disabled="props.loading"
      :aria-label="
        translate('generated.conversationTimeline.rollbackConversationBeforeThisMessage')
      "
      @click.stop="emit('rollback')"
    >
      <MarIcon name="undo" />
    </button>
  </div>
</template>
