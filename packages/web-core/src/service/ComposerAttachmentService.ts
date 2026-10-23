import type { MessageFeedback } from '../model/message-feedback.js';
import { computed, ref, type Ref } from 'vue';
import type { ComposerAttachment } from '../model/workbench.js';
import { translate } from './LocalePreferenceService.js';
import { errorCode } from '../util/api-error.js';
import { workspaceFileSha256 } from '../util/workspace-file-checksum.js';
import { errorMessage } from '../util/error-presentation.js';
import type { DirectTransferDescriptor } from '@myagentroam/protocol';

const MAX_FILES = 5;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
const CHUNK_BYTES = 512 * 1024;

export function createComposerAttachmentService(options: {
  readonly context: () => { readonly nodeId: string; readonly workspaceId: string } | undefined;
  readonly notice: MessageFeedback;
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly resourceUrl?: (path: string) => string;
  readonly csrfToken: Ref<string>;
  readonly renewCsrfToken: () => Promise<string>;
  readonly onUnauthenticated: () => void;
  readonly direct?: {
    readonly generation: (nodeId: string) => string | undefined;
    readonly upload: (input: {
      readonly nodeId: string;
      readonly nodeGeneration: string;
      readonly descriptor: DirectTransferDescriptor;
      readonly file: File;
      readonly onProgress: (offset: number) => void;
      readonly signal: AbortSignal;
    }) => Promise<void>;
  };
}) {
  const attachments = ref<ComposerAttachment[]>([]);
  const submissions = new Map<string, number>();
  const attachmentKey = (attachment: ComposerAttachment) =>
    JSON.stringify([attachment.nodeId, attachment.workspaceId, attachment.id]);
  const visibleAttachments = computed(() => {
    const context = options.context();
    return context === undefined
      ? []
      : attachments.value.filter(
          (attachment) =>
            attachment.nodeId === context.nodeId && attachment.workspaceId === context.workspaceId
        );
  });
  const dragging = ref(false);
  const preview = ref<ComposerAttachment>();
  const previewOpen = ref(false);
  const directRequests = new Map<string, AbortController>();

  function add(files: Iterable<File>): void {
    for (const file of files) {
      if (visibleAttachments.value.length >= MAX_FILES)
        return options.notice(
          translate('generated.composerAttachmentService.theFirstMessageCanIncludeUpTo'),
          'warning'
        );
      if (file.size === 0 || file.size > MAX_FILE_BYTES) {
        options.notice(
          translate('generated.composerAttachmentService.attachmentMustBeLargerThan0And', {
            value0: file.name
          }),
          'warning'
        );
        continue;
      }
      const total = visibleAttachments.value.reduce(
        (size, attachment) => size + attachment.file.size,
        0
      );
      if (total + file.size > MAX_TOTAL_BYTES)
        return options.notice(
          translate('generated.composerAttachmentService.totalAttachmentSizeCannotExceed10MiB'),
          'warning'
        );
      const context = options.context();
      if (context === undefined)
        return options.notice(
          translate(
            'generated.composerAttachmentService.selectAnOnlineWorkspaceBeforeAddingAttachments'
          ),
          'warning'
        );
      const attachment: ComposerAttachment = {
        id: crypto.randomUUID(),
        file,
        nodeId: context.nodeId,
        workspaceId: context.workspaceId,
        previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
        receivedBytes: 0,
        status: 'UPLOADING'
      };
      attachments.value = [...attachments.value, attachment];
      void upload(attachment);
    }
  }

  function remove(id: string): void {
    const attachment = attachments.value.find((item) => item.id === id);
    if (preview.value?.id === id) previewOpen.value = false;
    if (attachment?.previewUrl !== null && attachment?.previewUrl !== undefined)
      URL.revokeObjectURL(attachment.previewUrl);
    attachments.value = attachments.value.filter((item) => item.id !== id);
    if (attachment !== undefined) void cancel(attachment);
  }

  function clear(discardUploads = true): void {
    const context = options.context();
    if (context === undefined) return;
    previewOpen.value = false;
    const current = visibleAttachments.value;
    for (const attachment of current) {
      if (attachment.previewUrl !== null) URL.revokeObjectURL(attachment.previewUrl);
      if (discardUploads) void cancel(attachment);
    }
    attachments.value = attachments.value.filter(
      (attachment) =>
        attachment.nodeId !== context.nodeId || attachment.workspaceId !== context.workspaceId
    );
  }

  function clearAll(): void {
    previewOpen.value = false;
    for (const attachment of attachments.value) {
      if (attachment.previewUrl !== null) URL.revokeObjectURL(attachment.previewUrl);
      void cancel(attachment);
    }
    attachments.value = [];
  }

  function retainForSubmission(submitted: readonly ComposerAttachment[]): () => void {
    const keys = submitted.map(attachmentKey);
    for (const key of keys) submissions.set(key, (submissions.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const key of keys) {
        const remaining = submissions.get(key)! - 1;
        if (remaining === 0) submissions.delete(key);
        else submissions.set(key, remaining);
      }
    };
  }

  function consume(submitted: readonly ComposerAttachment[]): void {
    attachments.value = attachments.value.filter((attachment) => {
      if (
        !submitted.some(
          (item) =>
            item.id === attachment.id &&
            item.nodeId === attachment.nodeId &&
            item.workspaceId === attachment.workspaceId
        )
      )
        return true;
      if (preview.value?.id === attachment.id) previewOpen.value = false;
      if (attachment.previewUrl !== null) URL.revokeObjectURL(attachment.previewUrl);
      return false;
    });
  }

  function openPreview(attachment: ComposerAttachment): void {
    if (attachment.previewUrl === null) return;
    preview.value = attachment;
    previewOpen.value = true;
  }

  async function upload(attachment: ComposerAttachment): Promise<void> {
    try {
      const generation = options.direct?.generation(attachment.nodeId);
      if (generation !== undefined) {
        const controller = new AbortController();
        directRequests.set(attachment.id, controller);
        try {
          if (!attachments.value.some((item) => item.id === attachment.id))
            throw new Error('UPLOAD_CANCELLED');
          attachment.transport = 'DIRECT';
          const sha256 = await workspaceFileSha256(attachment.file);
          if (controller.signal.aborted) throw new Error('UPLOAD_CANCELLED');
          await options.direct!.upload({
            nodeId: attachment.nodeId,
            nodeGeneration: generation,
            descriptor: {
              direction: 'UPLOAD',
              resource: {
                kind: 'WORKSPACE_FILE',
                workspaceId: attachment.workspaceId,
                path: attachment.file.name
              },
              fileName: attachment.file.name,
              size: attachment.file.size,
              sha256,
              overwrite: false,
              composerAttachment: {
                id: attachment.id,
                mime: attachment.file.type || 'application/octet-stream'
              }
            },
            file: attachment.file,
            onProgress: (offset) => {
              attachment.receivedBytes = offset;
            },
            signal: controller.signal
          });
          const current = attachments.value.find((item) => item.id === attachment.id);
          if (current !== undefined) current.status = 'COMPLETED';
          return;
        } catch {
          if (!attachments.value.some((item) => item.id === attachment.id)) return;
          attachment.receivedBytes = 0;
          attachment.transport = 'SERVER';
          attachment.directFallback = true;
        } finally {
          directRequests.delete(attachment.id);
        }
      }
      attachment.transport = 'SERVER';
      const created = await options.request<{
        upload: {
          readonly uploadId: string;
          readonly receivedBytes: number;
          readonly size: number;
        };
      }>(`/api/workspaces/${encodeURIComponent(attachment.workspaceId)}/uploads`, {
        method: 'POST',
        body: JSON.stringify({
          nodeId: attachment.nodeId,
          name: attachment.file.name,
          mime: attachment.file.type || 'application/octet-stream',
          size: attachment.file.size,
          overwrite: false,
          composerAttachmentId: attachment.id
        })
      });
      if (!attachments.value.some((item) => item.id === attachment.id)) {
        await cancel({ ...attachment, uploadId: created.upload.uploadId });
        return;
      }
      const current = attachments.value.find((item) => item.id === attachment.id);
      if (current === undefined) return;
      current.uploadId = created.upload.uploadId;
      current.receivedBytes = created.upload.receivedBytes;
      while (current.receivedBytes < current.file.size) {
        const offset = current.receivedBytes;
        const chunk = current.file.slice(offset, Math.min(current.file.size, offset + CHUNK_BYTES));
        const uploaded = await uploadChunk(current, offset, chunk);
        current.receivedBytes = uploaded.receivedBytes;
      }
      if (current.uploadId === undefined) throw new Error('COMPOSER_ATTACHMENT_UPLOAD_FAILED');
      await options.request(
        `/api/workspaces/${encodeURIComponent(attachment.workspaceId)}/uploads/${encodeURIComponent(current.uploadId)}/complete`,
        { method: 'POST', body: JSON.stringify({ nodeId: attachment.nodeId }) }
      );
      current.status = 'COMPLETED';
    } catch (error) {
      const current = attachments.value.find((item) => item.id === attachment.id);
      if (current === undefined) return;
      current.status = 'FAILED';
      current.error = errorMessage(error);
      window.setTimeout(() => remove(attachment.id), 1_000);
    }
  }

  async function uploadChunk(
    attachment: ComposerAttachment,
    offset: number,
    chunk: Blob
  ): Promise<{ readonly receivedBytes: number }> {
    let lastError: unknown;
    let renewedCsrfToken = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await new Promise<{ readonly receivedBytes: number }>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          const path = `/api/workspaces/${encodeURIComponent(attachment.workspaceId)}/uploads/${encodeURIComponent(attachment.uploadId ?? '')}/chunks?nodeId=${encodeURIComponent(attachment.nodeId)}&offset=${offset}`;
          xhr.open('POST', options.resourceUrl?.(path) ?? path);
          xhr.withCredentials = true;
          xhr.setRequestHeader('content-type', 'application/octet-stream');
          xhr.setRequestHeader('x-csrf-token', options.csrfToken.value);
          xhr.upload.onprogress = (event) => {
            if (event.lengthComputable)
              attachment.receivedBytes = Math.min(attachment.file.size, offset + event.loaded);
          };
          xhr.onerror = () => reject(new Error('UPLOAD_NETWORK_FAILED'));
          xhr.onabort = () => reject(new Error('UPLOAD_CANCELLED'));
          xhr.onload = () => {
            if (xhr.status < 200 || xhr.status >= 300) {
              let code: string | undefined;
              try {
                code = (JSON.parse(xhr.responseText) as { error?: { code?: string } }).error?.code;
              } catch {
                code = undefined;
              }
              if (code === 'UNAUTHENTICATED') options.onUnauthenticated();
              reject(new Error(code ?? `REQUEST_FAILED_${xhr.status}`));
              return;
            }
            try {
              const body = JSON.parse(xhr.responseText) as { upload?: { receivedBytes?: unknown } };
              if (!Number.isSafeInteger(body.upload?.receivedBytes))
                throw new Error('NODE_RESPONSE_INVALID');
              resolve({ receivedBytes: body.upload?.receivedBytes as number });
            } catch (error) {
              reject(error);
            }
          };
          xhr.send(chunk);
        });
      } catch (error) {
        lastError = error;
        if (errorCode(error) === 'UNAUTHENTICATED') throw error;
        if (errorCode(error) === 'CSRF_INVALID') {
          if (renewedCsrfToken) throw error;
          renewedCsrfToken = true;
          await options.renewCsrfToken();
        }
        attachment.receivedBytes = offset;
      }
    }
    throw lastError instanceof Error ? lastError : new Error('COMPOSER_ATTACHMENT_UPLOAD_FAILED');
  }

  async function cancel(attachment: ComposerAttachment): Promise<void> {
    // Removing a draft attachment must not cancel a message already in flight.
    // Unconsumed uploads removed in flight are left to Node's expiry cleanup.
    if (submissions.has(attachmentKey(attachment))) return;
    directRequests.get(attachment.id)?.abort();
    directRequests.delete(attachment.id);
    const uploadId = attachment.status === 'COMPLETED' ? attachment.id : attachment.uploadId;
    if (uploadId === undefined) return;
    await options
      .request(
        `/api/workspaces/${encodeURIComponent(attachment.workspaceId)}/uploads/${encodeURIComponent(uploadId)}/cancel`,
        { method: 'POST', body: JSON.stringify({ nodeId: attachment.nodeId }) }
      )
      .catch(() => undefined);
  }

  return {
    attachments: visibleAttachments,
    dragging,
    preview,
    previewOpen,
    add,
    remove,
    clear,
    clearAll,
    retainForSubmission,
    consume,
    openPreview
  };
}
