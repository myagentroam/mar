import { ref, watch, type Ref } from 'vue';
import type { ComposerAttachmentFile } from '@myagentroam/protocol';
import { conversationPayload } from '../util/conversation-history.js';
import { stringField } from '../util/conversation-presentation.js';
import type { ConversationTurn } from '../model/workbench.js';
import { translate } from './locale-preference-service.js';

export interface ConversationImageAttachment {
  readonly name: string;
  readonly previewUrl: string | undefined;
  readonly direct?: boolean | undefined;
}

interface ConversationImagePreviewFailure {
  readonly cause: unknown;
  readonly path: string;
  readonly retry: () => void;
  readonly retrying?: boolean;
}

export interface ConversationImagePreview {
  readonly name: string;
  readonly url?: string;
  readonly direct?: boolean | undefined;
  readonly failure?: ConversationImagePreviewFailure;
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
  };
}

export function createConversationImageService(
  selectedNodeId: Ref<string | undefined>,
  options: ConversationImageServiceOptions = {}
) {
  const unavailable = ref<Record<string, true>>({});
  const preview = ref<ConversationImagePreview>();
  const previewOpen = ref(false);
  let previewGeneration = 0;
  let filePreview:
    | { readonly file: ComposerAttachmentFile; readonly target: string; readonly url: string }
    | undefined;
  function invalidateFilePreview(): void {
    previewGeneration += 1;
    filePreview = undefined;
  }
  const stopTargetWatch =
    options.fileAttachments === undefined
      ? undefined
      : watch(
          options.fileAttachments.target,
          () => {
            invalidateFilePreview();
            previewOpen.value = false;
            preview.value = undefined;
          },
          { flush: 'sync' }
        );
  const stopPreviewWatch =
    options.fileAttachments === undefined
      ? undefined
      : watch(
          previewOpen,
          (isOpen) => {
            if (!isOpen) invalidateFilePreview();
          },
          { flush: 'sync' }
        );

  function currentFilePreview(generation: number, target: string): boolean {
    return (
      previewOpen.value &&
      generation === previewGeneration &&
      options.fileAttachments?.target.value === target
    );
  }

  function failFilePreview(
    file: ComposerAttachmentFile,
    generation: number,
    target: string,
    cause: unknown
  ): void {
    if (!currentFilePreview(generation, target)) return;
    filePreview = undefined;
    const failure: ConversationImagePreviewFailure = {
      cause,
      path: file.path,
      retry: () => {
        if (currentFilePreview(generation, target)) void loadFileAttachment(file, failure);
      }
    };
    preview.value = { name: file.name, failure };
  }

  function openFileAttachment(file: ComposerAttachmentFile): Promise<void> {
    return loadFileAttachment(file);
  }

  async function loadFileAttachment(
    file: ComposerAttachmentFile,
    previousFailure?: ConversationImagePreviewFailure
  ): Promise<void> {
    const files = options.fileAttachments;
    const target = files?.target.value;
    if (files === undefined || target === undefined) return;
    filePreview = undefined;
    const generation = ++previewGeneration;
    // The dialog may open from the known filename. Only the successful check may
    // publish the image URL and let the renderer start loading it.
    preview.value = {
      name: file.name,
      ...(previousFailure === undefined ? {} : { failure: { ...previousFailure, retrying: true } })
    };
    previewOpen.value = true;
    try {
      await files.revalidate(file);
      if (!currentFilePreview(generation, target)) return;
      const url = files.sourceUrl(file, generation);
      preview.value = { name: file.name, url, direct: file.mime === 'image/gif' };
      filePreview = { file, target, url };
    } catch (error) {
      failFilePreview(file, generation, target, error);
    }
  }

  async function previewFailed(url: string): Promise<void> {
    const files = options.fileAttachments;
    const source = filePreview;
    if (files === undefined || source?.url !== url || !previewOpen.value) return;
    const generation = ++previewGeneration;
    let failure: unknown;
    try {
      await files.revalidate(source.file);
      return;
    } catch (error) {
      failure = error;
    }
    if (preview.value?.url === url)
      failFilePreview(source.file, generation, source.target, failure);
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
      if (value === undefined) return [];
      const mime = stringField(value, 'mime');
      if (!mime.startsWith('image/')) return [];
      const name =
        stringField(value, 'name') ||
        translate('generated.conversationImageService.imageAttachment');
      const source = attachmentSource(runId, value, inferredImageIndex);
      inferredImageIndex += 1;
      return [
        {
          name,
          previewUrl: source === undefined || unavailable.value[source] ? undefined : source,
          ...(mime === 'image/gif' ? { direct: true } : {})
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
    preview.value = {
      name: attachment.name,
      url: attachment.previewUrl,
      ...(attachment.direct ? { direct: true } : {})
    };
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
    invalidateFilePreview,
    dispose
  };
}
