import type {
  ConversationFileProjection,
  HostedConversationFileReadResult
} from '@myagentroam/protocol';
import { computed, ref } from 'vue';
import { readFilePreview } from './file-preview-read-service.js';
import {
  decodeFilePreviewContent,
  filePreviewKind,
  shouldReadTextFilePreview,
  type FilePreviewKind
} from '../util/file-preview.js';

export { TEXT_FILE_PREVIEW_LIMIT_BYTES as TEXT_PREVIEW_LIMIT_BYTES } from '../util/file-preview.js';

interface HostedConversationPreviewContent {
  readonly path: string;
  readonly size: number;
  readonly encoding: 'utf-8' | 'base64';
  readonly previewEncoding?: string;
  readonly content: string;
  readonly truncated: boolean;
}

interface HostedConversationFilePreviewOptions {
  readonly source: {
    readonly selectedConversationId: {
      readonly value: string | undefined;
    };
    readonly readFile: (
      fileId: string,
      offset?: number,
      limit?: number
    ) => Promise<HostedConversationFileReadResult>;
    readonly contentUrl: (file: ConversationFileProjection, download?: boolean) => string;
  };
  readonly onError: (error: unknown) => void;
  readonly triggerDownload?: (url: string, name: string) => void;
}

/** Adapts stable Hosted file IDs to the shared read-only file preview shell. */
export function createHostedConversationFilePreviewService(
  options: HostedConversationFilePreviewOptions
) {
  const visible = ref(false);
  const downloading = ref(false);
  const file = ref<ConversationFileProjection>();
  const content = ref<HostedConversationPreviewContent>();
  const contentUrl = ref<string>();
  const targetLine = ref<number>();
  const targetColumn = ref<number>();
  const kind = computed<FilePreviewKind>(() => {
    const current = content.value;
    return current === undefined ? 'unsupported' : filePreviewKind(current.path, current.encoding);
  });
  const triggerDownload =
    options.triggerDownload ??
    ((url: string, name: string) => {
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = name;
      anchor.click();
    });
  let previewSequence = 0;

  async function openFile(
    nextFile: ConversationFileProjection,
    nextTargetLine?: number,
    nextTargetColumn?: number
  ): Promise<void> {
    const sequence = ++previewSequence;
    downloading.value = false;
    file.value = nextFile;
    visible.value = false;
    content.value = undefined;
    targetLine.value = nextTargetLine;
    targetColumn.value = nextTargetColumn;
    contentUrl.value = undefined;
    try {
      const path = projectedFilePath(nextFile);
      const text = shouldReadTextFilePreview(path, nextFile.mimeType);
      if (text) {
        const result = await readFilePreview(
          async (
            limit
          ): Promise<
            HostedConversationPreviewContent & { nextOffset: number | null; revision: string }
          > => {
            const read = await options.source.readFile(nextFile.id, 0, limit);
            const decoded = decodeFilePreviewContent(
              base64Bytes(read.content),
              path,
              read.eof,
              nextFile.mimeType
            );
            return {
              path,
              size: read.file.size,
              ...decoded,
              truncated: decoded.encoding === 'utf-8' && !read.eof,
              nextOffset: decoded.encoding === 'base64' ? null : read.nextOffset,
              revision: String(read.file.updatedAt)
            };
          },
          () => matchesPreview(sequence, nextFile)
        );
        if (!matchesPreview(sequence, nextFile)) return;
        content.value = result;
      } else {
        content.value = {
          path,
          size: nextFile.size,
          encoding: 'base64',
          content: '',
          truncated: false
        };
      }
      if (content.value.encoding === 'base64' && filePreviewKind(path, 'base64') !== 'unsupported')
        contentUrl.value = options.source.contentUrl(nextFile);
      visible.value = true;
    } catch (error) {
      if (sequence === previewSequence) options.onError(error);
    }
  }

  function close(): void {
    previewSequence += 1;
    visible.value = false;
    downloading.value = false;
    file.value = undefined;
    content.value = undefined;
    targetLine.value = undefined;
    targetColumn.value = undefined;
    contentUrl.value = undefined;
  }

  function download(): void {
    const currentFile = file.value;
    const conversationId = options.source.selectedConversationId.value;
    if (
      currentFile === undefined ||
      conversationId === undefined ||
      currentFile.conversationId !== conversationId ||
      downloading.value
    )
      return;
    triggerDownload(options.source.contentUrl(currentFile, true), currentFile.displayName);
  }

  function matchesPreview(sequence: number, expectedFile: ConversationFileProjection): boolean {
    return (
      sequence === previewSequence &&
      options.source.selectedConversationId.value === expectedFile.conversationId &&
      file.value?.id === expectedFile.id
    );
  }

  return {
    visible,
    downloading,
    file,
    content,
    contentUrl,
    targetLine,
    targetColumn,
    kind,
    openFile,
    close,
    download,
    dispose: close
  };
}

export function projectedFilePath(file: ConversationFileProjection): string {
  const directory = file.category === 'OUTPUT' ? 'output' : 'inbox';
  return `${directory}/${file.relativePath.replaceAll('\\', '/')}`;
}

function base64Bytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}
