import {
  hostedConversationFileDeleteResultSchema,
  hostedConversationFileReadResultSchema,
  hostedConversationUploadPreflightResultSchema,
  hostedConversationUploadSchema,
  type ConversationFileProjection,
  type HostedConversationFileDeleteResult,
  type HostedConversationFileReadResult,
  type HostedConversationUpload
} from '@myagentroam/protocol';

interface FileTarget {
  readonly nodeId: string;
  readonly conversationId: string;
}

export function createHostedConversationFileService(options: {
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly requireContext: () => FileTarget;
  readonly templateChanging: () => boolean;
  readonly removeFile: (target: FileTarget, fileId: string) => void;
  readonly acceptFile: (target: FileTarget, file: ConversationFileProjection) => void;
}) {
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
    const response = await options.request<unknown>(
      `${conversationBasePath(context)}/files/${encodeURIComponent(fileId)}?offset=${offset}&limit=${limit}`
    );
    const parsed = hostedConversationFileReadResultSchema.safeParse(response);
    if (
      !parsed.success ||
      parsed.data.file.id !== fileId ||
      parsed.data.file.conversationId !== context.conversationId ||
      parsed.data.offset !== offset
    )
      throw responseInvalid();
    const contentBytes = base64DecodedByteLength(parsed.data.content);
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

    let upload = parseUploadResponse(
      await options.request<unknown>(`${conversationBasePath(context)}/uploads`, {
        method: 'POST',
        body: JSON.stringify({
          name: file.name,
          size: file.size,
          mimeType,
          clientRequestId
        }),
        ...(signal === undefined ? {} : { signal })
      }),
      context.conversationId
    );
    onProgress?.(upload);
    const chunkSize = 512 * 1024;
    try {
      for (let offset = upload.receivedBytes; offset < file.size; offset += chunkSize) {
        const end = Math.min(file.size, offset + chunkSize);
        const chunk = new Uint8Array(await file.slice(offset, end).arrayBuffer());
        signal?.throwIfAborted();
        if (chunk.byteLength !== end - offset) throw responseInvalid();
        upload = parseUploadResponse(
          await options.request<unknown>(
            `${conversationBasePath(context)}/uploads/${encodeURIComponent(upload.uploadId)}/chunks`,
            {
              method: 'POST',
              body: JSON.stringify({
                offset,
                dataBase64: bytesToBase64(chunk)
              }),
              ...(signal === undefined ? {} : { signal })
            }
          ),
          context.conversationId
        );
        if (upload.receivedBytes !== end) throw responseInvalid();
        onProgress?.(upload);
      }
      upload = parseUploadResponse(
        await options.request<unknown>(
          `${conversationBasePath(context)}/uploads/${encodeURIComponent(upload.uploadId)}/complete`,
          {
            method: 'POST',
            body: '{}',
            ...(signal === undefined ? {} : { signal })
          }
        ),
        context.conversationId
      );
      if (upload.status !== 'COMPLETED' || upload.file === undefined) throw responseInvalid();
    } catch (error) {
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

  return { deleteFile, readFile, contentUrl, uploadFile };
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

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const stride = 32 * 1024;
  for (let offset = 0; offset < bytes.length; offset += stride)
    binary += String.fromCharCode(
      ...bytes.subarray(offset, Math.min(bytes.length, offset + stride))
    );
  return btoa(binary);
}

function base64DecodedByteLength(value: string): number {
  if (value.length === 0) return 0;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return (value.length * 3) / 4 - padding;
}
