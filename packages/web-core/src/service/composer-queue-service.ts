import { computed, ref, type Ref } from 'vue';
import { parseComposerTags } from '@myagentroam/protocol';
import type { QueueEditDraft } from './session-draft-service.js';

export function createComposerQueueService(options?: {
  readonly draft: Ref<QueueEditDraft | undefined>;
  readonly persist: () => void;
}) {
  const draggingQueueItemId = ref<string>();
  const editingQueueItemId = ref<string>();
  const draft = options?.draft ?? ref<QueueEditDraft>();
  const editingContent = computed({
    get: () => draft.value?.content ?? '',
    set: (content: string) => {
      if (draft.value === undefined) return;
      draft.value = { ...draft.value, content };
      options?.persist();
    }
  });

  function startEditing(item: { readonly queueItemId: string; readonly content: string }): void {
    editingQueueItemId.value = item.queueItemId;
    if (draft.value?.queueItemId === item.queueItemId) return;
    const parts = parseComposerTags(item.content);
    const content = parts
      .flatMap((part) =>
        part.kind === 'text' ? [part.text] : part.kind === 'mar_steer' ? [part.payload.message] : []
      )
      .join('')
      .trim();
    const tags = parts
      .filter(
        (part) =>
          part.kind !== 'text' &&
          part.kind !== 'mar_steer' &&
          part.kind !== 'mar_session_origin' &&
          part.kind !== 'mar_channel'
      )
      .map((part) => part.raw)
      .join('\n');
    const origin = parts
      .filter((part) => part.kind === 'mar_session_origin' || part.kind === 'mar_channel')
      .map((part) => part.raw)
      .join('\n');
    draft.value = { queueItemId: item.queueItemId, content, tags, origin };
    options?.persist();
  }

  function finishEditing(): void {
    if (draft.value?.queueItemId === editingQueueItemId.value) {
      draft.value = undefined;
      options?.persist();
    }
    editingQueueItemId.value = undefined;
  }

  function rebind(): void {
    draggingQueueItemId.value = undefined;
    editingQueueItemId.value = draft.value?.queueItemId;
  }

  return {
    draggingQueueItemId,
    editingQueueItemId,
    editingContent,
    startEditing,
    finishEditing,
    rebind,
    serializeEditedContent: (content: string) =>
      [draft.value?.origin, content.trim(), draft.value?.tags].filter(Boolean).join('\n')
  };
}
