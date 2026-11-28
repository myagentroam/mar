import { createUuid } from '../util/uuid.js';
import type { MessageFeedback } from '../model/message-feedback.js';
import { computed, reactive, ref } from 'vue';
import type { ComposerAttachment } from '../model/workbench.js';
import { translate } from './locale-preference-service.js';
import { workspaceFileSha256 } from '../util/workspace-file-checksum.js';
import { errorMessage } from '../util/error-presentation.js';
import type { createWorkspaceFileStreamClient } from './workspace-file-stream-client.js';
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

/** Owns tab-local uploads by Workspace and Composer pane, independently of session selection.
 * Submission retention protects captured files; cancellation and preview URL cleanup stay here.
 */
export function createComposerAttachmentService(options: {
  readonly context: () => DraftTarget | undefined;
  readonly onAdded?: (target: AttachmentTarget) => void;
  readonly notice: MessageFeedback;
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly sendBody: ReturnType<typeof createWorkspaceFileStreamClient>['upload'];
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
  const streamRequests = new Map<string, AbortController>();
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
      const attachment = reactive<ComposerAttachment>({
        id: createUuid(),
        file,
        nodeId: context.nodeId,
        workspaceId: context.workspaceId,
        previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
        receivedBytes: 0,
        status: 'UPLOADING'
      });
      owners.set(attachment.id, { ...context });
      attachments.value = [...attachments.value, attachment];
      options.onAdded?.(context);
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
      const controller = new AbortController();
      streamRequests.set(attachment.id, controller);
      try {
        if (!isCurrent(attachment)) return;
        const sha256 = await workspaceFileSha256(attachment.file, controller.signal);
        controller.signal.throwIfAborted();
        await options.sendBody({
          nodeId: attachment.nodeId,
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
          onTransport: (transport) => {
            attachment.transport = transport;
          },
          onProgress: (offset) => {
            attachment.receivedBytes = offset;
          },
          signal: controller.signal
        });
        attachment.status = 'COMPLETED';
        if (!isCurrent(attachment) && owner === owners) await cancel(attachment);
      } finally {
        streamRequests.delete(attachment.id);
      }
    } catch (error) {
      const current = attachments.value.find((item) => item.id === attachment.id);
      if (current === undefined) return;
      current.status = 'FAILED';
      current.error = errorMessage(error);
      window.setTimeout(() => remove(attachment.id), 1_000);
    }
  }

  async function cancel(attachment: ComposerAttachment, remote = true): Promise<void> {
    streamRequests.get(attachment.id)?.abort();
    streamRequests.delete(attachment.id);
    // Removing a draft attachment must not cancel a message already in flight.
    // Unconsumed uploads removed in flight are left to Node's expiry cleanup.
    if (!remote || submissions.has(attachmentKey(attachment))) return;
    if (attachment.status !== 'COMPLETED') return;
    await options
      .request(
        `/api/workspaces/${encodeURIComponent(attachment.workspaceId)}/uploads/${encodeURIComponent(attachment.id)}/cancel`,
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
