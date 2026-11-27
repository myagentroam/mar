import {
  hostedConversationFileDeleteResultSchema,
  hostedConversationFileReadResultSchema,
  decodeFileRelayFrame,
  hostedConversationUploadPreflightResultSchema,
  hostedConversationUploadSchema,
  type ConversationFileProjection,
  type HostedConversationFileDeleteResult,
  type HostedConversationFileReadResult,
  type HostedConversationUpload
} from '@myagentroam/protocol';
import type { WorkbenchHttpService } from './workbench-http-service.js';

interface FileTarget {
  readonly nodeId: string;
  readonly conversationId: string;
}

/** Owns file requests and upload sequences; retiring uploads stops follow-up writes, not accepted commits. */
export function createHostedConversationFileService(options: {
  readonly request: WorkbenchHttpService['request'];
  readonly requireContext: () => FileTarget;
  readonly templateChanging: () => boolean;
  readonly removeFile: (target: FileTarget, fileId: string) => void;
  readonly acceptFile: (target: FileTarget, file: ConversationFileProjection) => void;
}) {
  let uploadGeneration = 0;
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
    limit = 512 * 1024
  ): Promise<HostedConversationFileReadResult> {
    const context = options.requireContext();
    const response = await options.request<ArrayBuffer>(
      `${conversationBasePath(context)}/files/${encodeURIComponent(fileId)}?offset=${offset}&limit=${limit}`,
      { responseType: 'arrayBuffer' }
    );
    let decoded: ReturnType<typeof decodeFileRelayFrame>;
    try {
      decoded = decodeFileRelayFrame(response);
    } catch {
      throw responseInvalid();
    }
    const { type, ...metadata } = decoded.metadata;
    const parsed = hostedConversationFileReadResultSchema.safeParse({
      ...metadata,
      bytes: decoded.payload
    });
    if (
      type !== 'file.read' ||
      'bytes' in metadata ||
      !parsed.success ||
      parsed.data.file.id !== fileId ||
      parsed.data.file.conversationId !== context.conversationId ||
      parsed.data.offset !== offset
    )
      throw responseInvalid();
    const contentBytes = parsed.data.bytes.byteLength;
    const nextOffset = offset + contentBytes;
    if (
      contentBytes > limit ||
      nextOffset > parsed.data.file.size ||
      (parsed.data.eof
        ? parsed.data.nextOffset !== null || nextOffset !== parsed.data.file.size
        : parsed.data.nextOffset !== nextOffset)
    )
      throw responseInvalid();
    return parsed.data;
  }

  function contentUrl(file: ConversationFileProjection, download = false): string {
    const context = options.requireContext();
    if (file.conversationId !== context.conversationId) throw responseInvalid();
    return `${conversationBasePath(context)}/files/${encodeURIComponent(file.id)}/content${
      download ? '?download=1' : ''
    }`;
  }

  async function uploadFile(
    file: File,
    clientRequestId: string,
    onProgress?: (upload: HostedConversationUpload) => void,
    signal?: AbortSignal
  ): Promise<HostedConversationUpload> {
    const context = options.requireContext();
    const generation = uploadGeneration;
    const requireCurrent = () => {
      if (generation !== uploadGeneration) throw new Error('UPLOAD_CANCELLED');
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
    const chunkSize = 512 * 1024;
    try {
      signal?.throwIfAborted();
      onProgress?.(upload);
      for (let offset = upload.receivedBytes; offset < file.size; offset += chunkSize) {
        const end = Math.min(file.size, offset + chunkSize);
        const chunk = await file.slice(offset, end).arrayBuffer();
        requireCurrent();
        signal?.throwIfAborted();
        if (chunk.byteLength !== end - offset) throw responseInvalid();
        upload = parseUploadResponse(
          await options.request<unknown>(
            `${conversationBasePath(context)}/uploads/${encodeURIComponent(upload.uploadId)}/chunks?offset=${offset}`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/octet-stream' },
              body: chunk,
              ...(signal === undefined ? {} : { signal })
            }
          ),
          context.conversationId
        );
        requireCurrent();
        if (upload.receivedBytes !== end) throw responseInvalid();
        onProgress?.(upload);
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
      if (generation === uploadGeneration)
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
    uploadFile,
    clearUploads: () => {
      uploadGeneration += 1;
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
