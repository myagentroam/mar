import {
  hostedConversationFileDeleteResultSchema,
  hostedConversationUploadPreflightResultSchema,
  hostedConversationUploadSchema,
  type ConversationFileProjection,
  type HostedConversationFileDeleteResult,
  type HostedConversationFileReadResult,
  type HostedConversationUpload
} from '@myagentroam/protocol';
import type { WorkbenchHttpService } from './workbench-http-service.js';
import type { createHostedFileDownloadService } from './hosted-file-download-service.js';

interface FileTarget {
  readonly nodeId: string;
  readonly conversationId: string;
}

/** Owns file requests and upload sequences; retiring uploads stops follow-up writes, not accepted commits. */
export function createHostedConversationFileService(options: {
  readonly request: WorkbenchHttpService['request'];
  readonly downloads: ReturnType<typeof createHostedFileDownloadService>;
  readonly sendUploadBody: (
    target: FileTarget & { readonly uploadId: string },
    file: File,
    signal: AbortSignal,
    onProgress: (offset: number) => void
  ) => Promise<void>;
  readonly requireContext: () => FileTarget;
  readonly templateChanging: () => boolean;
  readonly removeFile: (target: FileTarget, fileId: string) => void;
  readonly acceptFile: (target: FileTarget, file: ConversationFileProjection) => void;
}) {
  let uploads = new AbortController();
  function responseInvalid(): Error {
    return new Error('HOSTED_CONVERSATION_RESPONSE_INVALID');
  }
  function conversationBasePath(target: FileTarget): string {
    return `/api/nodes/${encodeURIComponent(target.nodeId)}/hosted-conversations/${encodeURIComponent(target.conversationId)}`;
  }
  async function deleteFile(fileId: string): Promise<HostedConversationFileDeleteResult> {
    const context = options.requireContext();
    if (options.templateChanging()) throw new Error('HOSTED_CONVERSATION_STATE_INVALID');
    const parsed = hostedConversationFileDeleteResultSchema.safeParse(
      await options.request<unknown>(
        `${conversationBasePath(context)}/files/${encodeURIComponent(fileId)}`,
        {
          method: 'DELETE',
          body: '{}'
        }
      )
    );
    if (
      !parsed.success ||
      parsed.data.deletedFileId !== fileId ||
      parsed.data.files.some((file) => file.conversationId !== context.conversationId)
    )
      throw responseInvalid();
    options.removeFile(context, fileId);
    return parsed.data;
  }

  async function readFile(
    fileId: string,
    offset = 0,
    limit = 512 * 1024,
    signal = new AbortController().signal
  ): Promise<HostedConversationFileReadResult> {
    const { nodeId, conversationId } = options.requireContext();
    const file = await options.downloads.describe({ nodeId, conversationId, fileId }, signal);
    signal.throwIfAborted();
    const bytes = await options.downloads.readRange(nodeId, file, offset, limit, signal);
    const nextOffset = offset + bytes.byteLength;
    const eof = nextOffset === file.size;
    return { file, bytes, offset, nextOffset: eof ? null : nextOffset, eof };
  }

  function contentUrl(file: ConversationFileProjection): string {
    const context = options.requireContext();
    if (file.conversationId !== context.conversationId) throw responseInvalid();
    return `${conversationBasePath(context)}/files/${encodeURIComponent(file.id)}/content`;
  }

  async function uploadFile(
    file: File,
    clientRequestId: string,
    onProgress?: (upload: HostedConversationUpload) => void,
    signal?: AbortSignal
  ): Promise<HostedConversationUpload> {
    const context = options.requireContext();
    const lifetime = uploads;
    const bodySignal =
      signal === undefined ? lifetime.signal : AbortSignal.any([signal, lifetime.signal]);
    const requireCurrent = () => {
      lifetime.signal.throwIfAborted();
    };
    if (options.templateChanging()) throw new Error('HOSTED_CONVERSATION_STATE_INVALID');
    const mimeType = file.type.trim() || 'application/octet-stream';
    signal?.throwIfAborted();
    const preflight = hostedConversationUploadPreflightResultSchema.safeParse(
      await options.request<unknown>(`${conversationBasePath(context)}/uploads/preflight`, {
        method: 'POST',
        body: JSON.stringify({
          files: [{ name: file.name, size: file.size, mimeType }]
        }),
        ...(signal === undefined ? {} : { signal })
      })
    );
    if (
      !preflight.success ||
      preflight.data.files.length !== 1 ||
      preflight.data.files[0]?.name !== file.name
    )
      throw responseInvalid();
    if (preflight.data.files[0].status !== 'READY')
      throw new Error(`HOSTED_CONVERSATION_UPLOAD_${preflight.data.files[0].status}`);
    requireCurrent();
    signal?.throwIfAborted();

    // Keep creation observable so a local abort can cancel the returned upload identity.
    let upload = parseUploadResponse(
      await options.request<unknown>(`${conversationBasePath(context)}/uploads`, {
        method: 'POST',
        body: JSON.stringify({
          name: file.name,
          size: file.size,
          mimeType,
          clientRequestId
        })
      }),
      context.conversationId
    );
    requireCurrent();
    try {
      bodySignal.throwIfAborted();
      onProgress?.(upload);
      if (upload.receivedBytes < file.size) {
        await options.sendUploadBody(
          {
            nodeId: context.nodeId,
            conversationId: context.conversationId,
            uploadId: upload.uploadId
          },
          file,
          bodySignal,
          (offset) => {
            upload = { ...upload, receivedBytes: offset };
            onProgress?.(upload);
          }
        );
      }
      requireCurrent();
      signal?.throwIfAborted();
      // Once submitted, completion must settle independently of the page's local cancellation.
      upload = parseUploadResponse(
        await options.request<unknown>(
          `${conversationBasePath(context)}/uploads/${encodeURIComponent(upload.uploadId)}/complete`,
          {
            method: 'POST',
            body: '{}'
          }
        ),
        context.conversationId
      );
      requireCurrent();
      if (upload.status !== 'COMPLETED' || upload.file === undefined) throw responseInvalid();
    } catch (error) {
      if (lifetime === uploads)
        await options
          .request(
            `${conversationBasePath(context)}/uploads/${encodeURIComponent(upload.uploadId)}/cancel`,
            { method: 'POST', body: '{}' }
          )
          .catch(() => undefined);
      throw error;
    }
    options.acceptFile(context, upload.file);
    onProgress?.(upload);
    return upload;
  }

  return {
    deleteFile,
    readFile,
    contentUrl,
    downloadFile: (fileId: string, signal: AbortSignal) => {
      const { nodeId, conversationId } = options.requireContext();
      return options.downloads.download({ nodeId, conversationId, fileId }, signal);
    },
    async previewObjectUrl(fileId: string, signal: AbortSignal) {
      const { nodeId, conversationId } = options.requireContext();
      const file = await options.downloads.describe({ nodeId, conversationId, fileId }, signal);
      return options.downloads.objectUrl(nodeId, file, signal);
    },
    uploadFile,
    clearUploads: () => {
      uploads.abort(new Error('UPLOAD_CANCELLED'));
      uploads = new AbortController();
    }
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function parseUploadResponse(value: unknown, conversationId: string): HostedConversationUpload {
  if (!record(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'upload'))
    throw new Error('HOSTED_CONVERSATION_RESPONSE_INVALID');
  const parsed = hostedConversationUploadSchema.safeParse(value.upload);
  if (!parsed.success || parsed.data.conversationId !== conversationId)
    throw new Error('HOSTED_CONVERSATION_RESPONSE_INVALID');
  return parsed.data;
}
