import { ref } from 'vue';
import { parseComposerTags } from '@myagentroam/protocol';

export function createComposerQueueService() {
  const draggingQueueItemId = ref<string>();
  const editingQueueItemId = ref<string>();
  const editingContent = ref('');
  let editingTags = '';
  let editingOrigin = '';

  function startEditing(item: { readonly queueItemId: string; readonly content: string }): void {
    editingQueueItemId.value = item.queueItemId;
    const parts = parseComposerTags(item.content);
    editingContent.value = parts
      .flatMap((part) =>
        part.kind === 'text' ? [part.text] : part.kind === 'mar_steer' ? [part.payload.message] : []
      )
      .join('')
      .trim();
    editingTags = parts
      .filter(
        (part) =>
          part.kind !== 'text' &&
          part.kind !== 'mar_steer' &&
          part.kind !== 'mar_session_origin' &&
          part.kind !== 'mar_channel'
      )
      .map((part) => part.raw)
      .join('\n');
    editingOrigin = parts
      .filter((part) => part.kind === 'mar_session_origin' || part.kind === 'mar_channel')
      .map((part) => part.raw)
      .join('\n');
  }

  function finishEditing(): void {
    editingQueueItemId.value = undefined;
    editingContent.value = '';
    editingTags = '';
    editingOrigin = '';
  }

  return {
    draggingQueueItemId,
    editingQueueItemId,
    editingContent,
    startEditing,
    finishEditing,
    serializeEditedContent: (content: string) =>
      [editingOrigin, content.trim(), editingTags].filter(Boolean).join('\n')
  };
}
