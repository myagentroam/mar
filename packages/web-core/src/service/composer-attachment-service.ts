import { createUuid } from '../util/uuid.js';
import type { MessageFeedback } from '../model/message-feedback.js';
import { computed, ref, type Ref } from 'vue';
import type { ComposerAttachment } from '../model/workbench.js';
import { translate } from './locale-preference-service.js';
import { errorCode } from '../util/api-error.js';
import { workspaceFileSha256 } from '../util/workspace-file-checksum.js';
import { errorMessage } from '../util/error-presentation.js';
import type { DirectTransferDescriptor } from '@myagentroam/protocol';
import type { DraftPane, DraftTarget } from './session-draft-service.js';
import { isBmpAttachment, normalizeComposerImage } from '../util/composer-image-compatibility.js';

interface AttachmentTarget {
  readonly nodeId: string;
  readonly workspaceId: string;
  readonly pane: DraftPane;
}

const MAX_FILES = 5;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
const CHUNK_BYTES = 512 * 1024;

/** Owns tab-local uploads by Workspace and Composer pane, independently of session selection.
 * Submission retention protects captured files; cancellation and preview URL cleanup stay here.
 */
export function createComposerAttachmentService(options: {
  readonly context: () => DraftTarget | undefined;
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
  let owners = new Map<string, AttachmentTarget>();
  const sameTarget = (left: AttachmentTarget | undefined, right: AttachmentTarget | undefined) =>
    left !== undefined &&
    right !== undefined &&
    left.nodeId === right.nodeId &&
    left.workspaceId === right.workspaceId &&
    left.pane === right.pane;
  const targetFor = (
    target: DraftTarget | undefined,
    pane: DraftPane = 'main'
  ): AttachmentTarget | undefined =>
    target === undefined
      ? undefined
      : { nodeId: target.nodeId, workspaceId: target.workspaceId, pane };
  const currentTarget = () => targetFor(options.context());
  const submissions = new Map<string, number>();
  const attachmentKey = (attachment: ComposerAttachment) =>
    JSON.stringify([attachment.nodeId, attachment.workspaceId, attachment.id]);
  function attachmentsFor(context: AttachmentTarget | undefined): ComposerAttachment[] {
    return context === undefined
      ? []
      : attachments.value.filter((attachment) => sameTarget(owners.get(attachment.id), context));
  }
  const visibleAttachments = computed(() => attachmentsFor(currentTarget()));
  const dragging = ref(false);
  const preview = ref<ComposerAttachment>();
  const previewOpen = ref(false);
  const directRequests = new Map<string, AbortController>();
  const activeRequests = new Map<string, XMLHttpRequest>();
  const isCurrent = (attachment: ComposerAttachment) => owners.has(attachment.id);

  function addFor(context: AttachmentTarget | undefined, files: Iterable<File>): void {
    for (const file of files) {
      const visible = attachmentsFor(context);
      if (visible.length >= MAX_FILES)
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
      const total = visible.reduce((size, attachment) => size + attachment.file.size, 0);
      if (total + file.size > MAX_TOTAL_BYTES)
        return options.notice(
          translate('generated.composerAttachmentService.totalAttachmentSizeCannotExceed10MiB'),
          'warning'
        );
      if (context === undefined)
        return options.notice(
          translate(
            'generated.composerAttachmentService.selectAnOnlineWorkspaceBeforeAddingAttachments'
          ),
          'warning'
        );
      const attachment: ComposerAttachment = {
        id: createUuid(),
        file,
        nodeId: context.nodeId,
        workspaceId: context.workspaceId,
        previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
        receivedBytes: 0,
        status: 'UPLOADING'
      };
      owners.set(attachment.id, { ...context });
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
    owners.delete(id);
    if (attachment !== undefined) void cancel(attachment);
  }

  function clearFor(context: AttachmentTarget | undefined, discardUploads = true): void {
    if (context === undefined) return;
    const current = attachmentsFor(context);
    if (current.some((attachment) => attachment.id === preview.value?.id))
      previewOpen.value = false;
    for (const attachment of current) {
      if (attachment.previewUrl !== null) URL.revokeObjectURL(attachment.previewUrl);
      if (discardUploads) void cancel(attachment);
      owners.delete(attachment.id);
    }
    const ids = new Set(current.map((attachment) => attachment.id));
    attachments.value = attachments.value.filter((attachment) => !ids.has(attachment.id));
  }

  function clearAll(): void {
    previewOpen.value = false;
    preview.value = undefined;
    dragging.value = false;
    for (const attachment of attachments.value) {
      if (attachment.previewUrl !== null) URL.revokeObjectURL(attachment.previewUrl);
      // A confirmed account switch may already have replaced the Server cookie.
      void cancel(attachment, false);
    }
    attachments.value = [];
    owners = new Map();
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
      owners.delete(attachment.id);
      return false;
    });
  }

  function openPreview(attachment: ComposerAttachment): void {
    if (attachment.previewUrl === null) return;
    preview.value = attachment;
    previewOpen.value = true;
  }

  function forTarget(target: () => DraftTarget | undefined, pane: DraftPane = 'main') {
    const context = () => targetFor(target(), pane);
    return {
      attachments: computed(() => attachmentsFor(context())),
      add: (files: Iterable<File>) => addFor(context(), files),
      remove: (id: string) => {
        if (sameTarget(owners.get(id), context())) remove(id);
      },
      clear: (discardUploads = true) => clearFor(context(), discardUploads)
    };
  }

  async function upload(attachment: ComposerAttachment): Promise<void> {
    const owner = owners;
    try {
      if (isBmpAttachment(attachment.file)) {
        const file = await normalizeComposerImage(attachment.file);
        const current = attachments.value.find((item) => item.id === attachment.id);
        if (current === undefined) return;
        const total = attachments.value
          .filter((item) => sameTarget(owners.get(item.id), owners.get(current.id)))
          .reduce((size, item) => size + (item.id === current.id ? file.size : item.file.size), 0);
        if (total > MAX_TOTAL_BYTES) throw new Error('COMPOSER_IMAGE_LIMIT_EXCEEDED');
        current.file = file;
        attachment = current;
      }
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
        if (owner === owners) await cancel({ ...attachment, uploadId: created.upload.uploadId });
        return;
      }
      const current = attachments.value.find((item) => item.id === attachment.id);
      if (current === undefined) return;
      current.uploadId = created.upload.uploadId;
      current.receivedBytes = created.upload.receivedBytes;
      while (current.receivedBytes < current.file.size) {
        if (!isCurrent(current)) return;
        const offset = current.receivedBytes;
        const chunk = current.file.slice(offset, Math.min(current.file.size, offset + CHUNK_BYTES));
        const uploaded = await uploadChunk(current, offset, chunk);
        if (!isCurrent(current)) return;
        current.receivedBytes = uploaded.receivedBytes;
      }
      if (!isCurrent(current)) return;
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
      if (!isCurrent(attachment)) throw new Error('UPLOAD_CANCELLED');
      try {
        return await new Promise<{ readonly receivedBytes: number }>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          activeRequests.set(attachment.id, xhr);
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
            if (!isCurrent(attachment)) {
              reject(new Error('UPLOAD_CANCELLED'));
              return;
            }
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
        if (!isCurrent(attachment) || errorCode(error) === 'UPLOAD_CANCELLED') throw error;
        if (errorCode(error) === 'UNAUTHENTICATED') throw error;
        if (errorCode(error) === 'CSRF_INVALID') {
          if (renewedCsrfToken) throw error;
          renewedCsrfToken = true;
          await options.renewCsrfToken();
        }
        attachment.receivedBytes = offset;
      } finally {
        activeRequests.delete(attachment.id);
      }
    }
    throw lastError instanceof Error ? lastError : new Error('COMPOSER_ATTACHMENT_UPLOAD_FAILED');
  }

  async function cancel(attachment: ComposerAttachment, remote = true): Promise<void> {
    directRequests.get(attachment.id)?.abort();
    directRequests.delete(attachment.id);
    activeRequests.get(attachment.id)?.abort();
    activeRequests.delete(attachment.id);
    // Removing a draft attachment must not cancel a message already in flight.
    // Unconsumed uploads removed in flight are left to Node's expiry cleanup.
    if (!remote || submissions.has(attachmentKey(attachment))) return;
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
    add: (files: Iterable<File>) => addFor(currentTarget(), files),
    remove,
    clear: (discardUploads = true) => clearFor(currentTarget(), discardUploads),
    clearAll,
    forTarget,
    retainForSubmission,
    consume,
    openPreview
  };
}
