import { ref, watch, type Ref } from 'vue';
import type { ComposerAttachmentFile } from '@myagentroam/protocol';
import { conversationPayload } from '../util/conversation-history.js';
import { stringField } from '../util/conversation-presentation.js';
import type { ConversationTurn } from '../model/workbench.js';
import { translate } from './locale-preference-service.js';

export interface ConversationImageAttachment {
  readonly name: string;
  readonly previewUrl: string | undefined;
}

export interface ConversationImageSourceInput {
  readonly nodeId: string;
  readonly runId: string;
  readonly imageSelector: number | string;
}

interface ConversationImageServiceOptions {
  readonly sourceUrl?: (input: ConversationImageSourceInput) => string | undefined;
  readonly fileAttachments?: {
    readonly target: Readonly<Ref<string | undefined>>;
    readonly revalidate: (file: ComposerAttachmentFile) => Promise<unknown>;
    readonly sourceUrl: (file: ComposerAttachmentFile, revision: number) => string;
    readonly onError: (error: unknown, path: string) => void;
  };
}

export function createConversationImageService(
  selectedNodeId: Ref<string | undefined>,
  options: ConversationImageServiceOptions = {}
) {
  const unavailable = ref<Record<string, true>>({});
  const preview = ref<{ readonly name: string; readonly url: string }>();
  const previewOpen = ref(false);
  let previewGeneration = 0;
  let filePreview:
    | { readonly file: ComposerAttachmentFile; readonly target: string; readonly url: string }
    | undefined;
  const stopTargetWatch =
    options.fileAttachments === undefined
      ? undefined
      : watch(
          options.fileAttachments.target,
          () => {
            previewGeneration += 1;
            if (filePreview !== undefined) {
              filePreview = undefined;
              previewOpen.value = false;
              preview.value = undefined;
            }
          },
          { flush: 'sync' }
        );
  const stopPreviewWatch =
    options.fileAttachments === undefined
      ? undefined
      : watch(
          previewOpen,
          (isOpen) => {
            if (!isOpen) {
              previewGeneration += 1;
              filePreview = undefined;
            }
          },
          { flush: 'sync' }
        );

  function currentFilePreview(generation: number, target: string): boolean {
    return generation === previewGeneration && options.fileAttachments?.target.value === target;
  }

  async function openFileAttachment(file: ComposerAttachmentFile): Promise<void> {
    const files = options.fileAttachments;
    const target = files?.target.value;
    if (files === undefined || target === undefined) return;
    filePreview = undefined;
    previewOpen.value = false;
    preview.value = undefined;
    const generation = ++previewGeneration;
    try {
      const url = files.sourceUrl(file, generation);
      await files.revalidate(file);
      if (!currentFilePreview(generation, target)) return;
      open({ name: file.name, previewUrl: url });
      filePreview = { file, target, url };
    } catch (error) {
      if (currentFilePreview(generation, target)) files.onError(error, file.path);
    }
  }

  async function previewFailed(url: string): Promise<void> {
    const files = options.fileAttachments;
    const source = filePreview;
    if (files === undefined || source?.url !== url || !previewOpen.value) return;
    const generation = ++previewGeneration;
    let failure: unknown = new Error('IMAGE_PREVIEW_FAILED');
    try {
      await files.revalidate(source.file);
    } catch (error) {
      failure = error;
    }
    if (
      !currentFilePreview(generation, source.target) ||
      preview.value?.url !== url ||
      !previewOpen.value
    )
      return;
    previewOpen.value = false;
    preview.value = undefined;
    files.onError(failure, source.file.path);
  }

  function dispose(): void {
    previewGeneration += 1;
    stopTargetWatch?.();
    stopPreviewWatch?.();
    filePreview = undefined;
    previewOpen.value = false;
    preview.value = undefined;
  }

  function sourceUrl(runId: string, imageSelector: number | string): string | undefined {
    const nodeId = selectedNodeId.value;
    if (nodeId === undefined) return undefined;
    if (options.sourceUrl !== undefined) return options.sourceUrl({ nodeId, runId, imageSelector });
    return `/api/agent-runs/${encodeURIComponent(runId)}/images/${encodeURIComponent(imageSelector)}?nodeId=${encodeURIComponent(nodeId)}`;
  }

  function attachmentSource(
    runId: string | null,
    value: Record<string, unknown>,
    inferredIndex: number
  ): string | undefined {
    const attachmentRunId = stringField(value, 'runId') || runId;
    if (attachmentRunId === null) return undefined;
    if (attachmentRunId.startsWith('native-history:')) {
      const imageRef = stringField(value, 'imageRef');
      return imageRef ? sourceUrl(attachmentRunId, imageRef) : undefined;
    }
    if (value.imageRef !== undefined) return undefined;
    const imageIndex = typeof value.imageIndex === 'number' ? value.imageIndex : inferredIndex;
    return sourceUrl(attachmentRunId, imageIndex);
  }

  function attachments(
    runId: string | null,
    payload: unknown
  ): readonly ConversationImageAttachment[] {
    const values = conversationPayload(payload)?.attachments;
    if (!Array.isArray(values)) return [];
    let inferredImageIndex = 0;
    return values.flatMap((attachment) => {
      const value = conversationPayload(attachment);
      if (value === undefined || !stringField(value, 'mime').startsWith('image/')) return [];
      const name =
        stringField(value, 'name') ||
        translate('generated.conversationImageService.imageAttachment');
      const source = attachmentSource(runId, value, inferredImageIndex);
      inferredImageIndex += 1;
      return [
        {
          name,
          previewUrl: source === undefined || unavailable.value[source] ? undefined : source
        }
      ];
    });
  }

  function retain(turns: readonly ConversationTurn[]): void {
    const next = new Set<string>();
    for (const turn of turns) {
      const values = turn.items.flatMap((item) => {
        const attachments = conversationPayload(item.payload)?.attachments;
        return Array.isArray(attachments) ? attachments : [];
      });
      let inferredImageIndex = 0;
      for (const attachment of values) {
        const value = conversationPayload(attachment);
        if (value === undefined || !stringField(value, 'mime').startsWith('image/')) continue;
        const source = attachmentSource(turn.runId, value, inferredImageIndex);
        inferredImageIndex += 1;
        if (source !== undefined) next.add(source);
      }
    }
    unavailable.value = Object.fromEntries(
      Object.entries(unavailable.value).filter(([source]) => next.has(source))
    );
  }

  function markUnavailable(source: string): void {
    unavailable.value = { ...unavailable.value, [source]: true };
  }

  function open(attachment: ConversationImageAttachment): void {
    if (attachment.previewUrl === undefined) return;
    previewGeneration += 1;
    filePreview = undefined;
    preview.value = { name: attachment.name, url: attachment.previewUrl };
    previewOpen.value = true;
  }

  return {
    unavailable,
    preview,
    previewOpen,
    attachments,
    retain,
    markUnavailable,
    open,
    openFileAttachment,
    previewFailed,
    dispose
  };
}
