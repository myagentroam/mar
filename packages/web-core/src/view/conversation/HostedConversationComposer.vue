<script setup lang="ts">
import { showMessage } from '../../service/MessageFeedbackService.js';

import { marIcon } from '../../util/mar-icons.js';

import MarIcon from '../common/MarIcon.vue';
import type { HostedConversationUpload } from '@myagentroam/protocol';
import { ElMessageBox } from 'element-plus';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { createComposerAttachmentInputService } from '../../service/ComposerAttachmentInputService.js';
import { createWorkbenchClockService } from '../../service/WorkbenchClockService.js';
import { translate } from '../../service/LocalePreferenceService.js';
import {
  hostedConversationSubmissionContext,
  type createHostedConversationWorkspaceService
} from '../../service/HostedConversationWorkspaceService.js';
import { errorCode } from '../../util/api-error.js';
import {
  conversationActivityLabel,
  conversationActivityBusy,
  conversationElapsedLabel
} from '../../util/conversation-activity.js';
import ConversationComposer from '../composer/ConversationComposer.vue';

interface HostedAttachment {
  readonly id: string;
  readonly file: File;
  readonly previewUrl: string | null;
  name: string;
  clientRequestId: string;
  readonly controller: AbortController;
  fileId?: string;
  receivedBytes: number;
  status: 'UPLOADING' | 'COMPLETED' | 'FAILED';
  error?: string;
}

const props = defineProps<{
  readonly connected?: boolean;
  readonly workspace: ReturnType<typeof createHostedConversationWorkspaceService>;
  readonly mobileViewport: boolean;
  readonly readonly: boolean;
  readonly readonlyReason: string;
}>();

const input = ref('');
const composer = ref<{ focusAt(cursor: number): void }>();
const attachments = ref<HostedAttachment[]>([]);
const draggingAttachments = ref(false);
const fileInput = ref<HTMLInputElement>();
const configurationUpdating = ref(false);
let messageIntent:
  | {
      readonly fingerprint: string;
      readonly clientMessageId: string;
    }
  | undefined;

function restoreMessage(text: string): void {
  input.value = text;
  messageIntent = undefined;
  composer.value?.focusAt(text.length);
}

defineExpose({ restoreMessage });

const snapshot = computed(() => props.workspace.snapshot.value);
const selectedSubmissionContext = computed(() => {
  const conversation = snapshot.value?.conversation;
  return conversation === undefined
    ? undefined
    : hostedConversationSubmissionContext(conversation.nodeId, conversation.id);
});
const submitting = computed(
  () =>
    props.workspace.messageSubmitting.value &&
    props.workspace.messageSubmissionContext.value === selectedSubmissionContext.value
);
const activeRun = computed(() => {
  const run = snapshot.value?.run;
  return run !== null &&
    run !== undefined &&
    ['STARTING', 'RUNNING', 'CANCELLING'].includes(run.status)
    ? run
    : undefined;
});
const clockRun = computed(() => {
  const run = activeRun.value;
  const conversation = snapshot.value?.conversation;
  if (run === undefined || conversation === undefined) return undefined;
  return {
    sessionId: conversation.sessionId,
    startedAt: run.startedAt
  };
});
const authoritativeWorking = computed(() => activeRun.value !== undefined);
const {
  working: clockWorking,
  workingNow,
  workingStartedAt
} = createWorkbenchClockService(
  computed(() => snapshot.value?.conversation.sessionId),
  authoritativeWorking,
  clockRun
);
const pendingAttachments = computed(() =>
  attachments.value.some((attachment) => attachment.status === 'UPLOADING')
);
const completedAttachmentIds = computed(() =>
  attachments.value.flatMap((attachment) =>
    attachment.status === 'COMPLETED' && attachment.fileId !== undefined ? [attachment.fileId] : []
  )
);
const inputHasContent = computed(
  () => input.value.trim().length > 0 || completedAttachmentIds.value.length > 0
);
const canReplaceCurrent = computed(
  () =>
    !props.mobileViewport &&
    activeRun.value !== undefined &&
    activeRun.value.status !== 'CANCELLING'
);
const canStopCurrent = computed(
  () =>
    activeRun.value !== undefined && activeRun.value.status !== 'CANCELLING' && !submitting.value
);
const composerReadonly = computed(
  () =>
    props.readonly ||
    submitting.value ||
    (activeRun.value !== undefined && !canReplaceCurrent.value)
);
const working = clockWorking;
const workingLabel = computed(() =>
  conversationActivityLabel(activeRun.value, props.readonly ? [] : props.workspace.turns.value)
);
const elapsedLabel = computed(() =>
  props.readonly ? '' : conversationElapsedLabel(workingStartedAt.value, workingNow.value)
);
const models = computed(() => snapshot.value?.models ?? []);
const selectedModelId = computed(() => snapshot.value?.conversation.modelId ?? '');
const modelUnavailable = computed(() => models.value.length === 0);
const modelSelectionDisabled = computed(
  () =>
    props.readonly ||
    submitting.value ||
    activeRun.value !== undefined ||
    configurationUpdating.value ||
    modelUnavailable.value
);
const selectedModelLabel = computed(
  () =>
    models.value.find((model) => model.id === selectedModelId.value)?.name ?? selectedModelId.value
);
const templateName = computed(() => snapshot.value?.conversation.templateName ?? '');
const loadedTemplateLabel = computed(() =>
  templateName.value === ''
    ? ''
    : translate('hostedConversations.loadedTemplateNamed', { name: templateName.value })
);
const attachmentInput = createComposerAttachmentInputService({
  canAcceptFiles: () => !composerReadonly.value,
  addFiles: queueFiles,
  confirmDrop: confirmDroppedAttachments,
  rejectDirectory: () =>
    showMessage(translate('hostedConversations.folderAttachmentUnsupported'), 'warning'),
  setDragging: (dragging) => (draggingAttachments.value = dragging)
});

watch(input, () => {
  messageIntent = undefined;
});

function chooseFiles(): void {
  if (composerReadonly.value) return;
  fileInput.value?.click();
}

function selectedFiles(event: Event): void {
  const element = event.target as HTMLInputElement;
  if (element.files !== null) queueFiles(element.files);
  element.value = '';
}

function queueFiles(files: Iterable<File>): void {
  for (const file of files) {
    if (attachments.value.length >= 32) {
      showMessage(translate('hostedConversations.attachmentLimit'), 'warning');
      break;
    }
    const attachment: HostedAttachment = {
      id: crypto.randomUUID(),
      file,
      previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
      name: file.name,
      clientRequestId: crypto.randomUUID(),
      controller: new AbortController(),
      receivedBytes: 0,
      status: 'UPLOADING'
    };
    attachments.value = [...attachments.value, attachment];
    messageIntent = undefined;
    void uploadAttachment(attachment);
  }
}

async function uploadAttachment(attachment: HostedAttachment): Promise<void> {
  try {
    const result = await props.workspace.uploadFile(
      attachment.file,
      attachment.clientRequestId,
      (upload) => updateUploadProgress(attachment.id, upload),
      attachment.controller.signal
    );
    updateAttachment(attachment.id, {
      receivedBytes: result.receivedBytes,
      status: 'COMPLETED',
      name: result.name,
      ...(result.file === undefined ? {} : { fileId: result.file.id })
    });
  } catch (error) {
    updateAttachment(attachment.id, {
      status: 'FAILED',
      error: hostedErrorMessage(error)
    });
  }
}

function retryAttachment(attachmentId: string): void {
  if (composerReadonly.value) return;
  const attachment = attachments.value.find((candidate) => candidate.id === attachmentId);
  if (attachment === undefined || attachment.status !== 'FAILED') return;
  const retry: HostedAttachment = {
    id: attachment.id,
    file: attachment.file,
    previewUrl: attachment.previewUrl,
    name: attachment.name,
    clientRequestId: crypto.randomUUID(),
    controller: new AbortController(),
    receivedBytes: 0,
    status: 'UPLOADING'
  };
  attachments.value = attachments.value.map((candidate) =>
    candidate.id === attachmentId ? retry : candidate
  );
  messageIntent = undefined;
  void uploadAttachment(retry);
}

function updateUploadProgress(attachmentId: string, upload: HostedConversationUpload): void {
  updateAttachment(attachmentId, {
    receivedBytes: upload.receivedBytes,
    status: upload.status === 'COMPLETED' ? 'COMPLETED' : 'UPLOADING',
    name: upload.name,
    ...(upload.file === undefined ? {} : { fileId: upload.file.id })
  });
}

function updateAttachment(
  attachmentId: string,
  patch: Partial<Pick<HostedAttachment, 'name' | 'receivedBytes' | 'status' | 'fileId' | 'error'>>
): void {
  attachments.value = attachments.value.map((attachment) =>
    attachment.id === attachmentId ? { ...attachment, ...patch } : attachment
  );
}

function removeAttachment(attachmentId: string): void {
  const attachment = attachments.value.find((candidate) => candidate.id === attachmentId);
  attachment?.controller.abort();
  if (attachment?.previewUrl !== null && attachment?.previewUrl !== undefined)
    URL.revokeObjectURL(attachment.previewUrl);
  attachments.value = attachments.value.filter((candidate) => candidate.id !== attachmentId);
  messageIntent = undefined;
}

function messageFingerprint(): string {
  return JSON.stringify({
    input: input.value,
    attachments: completedAttachmentIds.value,
    modelId: selectedModelId.value
  });
}

async function confirmDroppedAttachments(files: readonly File[]): Promise<boolean> {
  try {
    await ElMessageBox.confirm(
      translate('hostedConversations.confirmDroppedAttachments', { count: files.length }),
      translate('hostedConversations.confirmDroppedAttachmentsTitle'),
      {
        closeIcon: marIcon('close'),
        icon: marIcon('warning'),
        type: 'warning',
        confirmButtonText: translate('hostedConversations.confirmUpload'),
        cancelButtonText: translate('hostedConversations.cancel')
      }
    );
    return true;
  } catch {
    return false;
  }
}

async function send(deliveryIntent?: 'REPLACE_CURRENT'): Promise<void> {
  if (
    composerReadonly.value ||
    pendingAttachments.value ||
    !inputHasContent.value ||
    snapshot.value === undefined
  )
    return;
  const submittedMessage = messageFingerprint();
  const submittedAttachments = attachments.value;
  const fingerprint = JSON.stringify({ deliveryIntent, message: submittedMessage });
  if (messageIntent?.fingerprint !== fingerprint)
    messageIntent = { fingerprint, clientMessageId: crypto.randomUUID() };
  const submittedIntent = messageIntent;
  try {
    await props.workspace.sendMessage({
      prompt: input.value,
      attachmentIds: completedAttachmentIds.value,
      clientMessageId: submittedIntent.clientMessageId,
      modelId: selectedModelId.value,
      ...(deliveryIntent === undefined ? {} : { deliveryIntent })
    });
    if (
      messageIntent !== submittedIntent ||
      messageFingerprint() !== submittedMessage ||
      attachments.value !== submittedAttachments
    )
      return;
    input.value = '';
    for (const attachment of attachments.value)
      if (attachment.previewUrl !== null) URL.revokeObjectURL(attachment.previewUrl);
    attachments.value = [];
    messageIntent = undefined;
  } catch (error) {
    if (messageIntent === submittedIntent && errorCode(error) !== undefined)
      messageIntent = undefined;
    showMessage(hostedErrorMessage(error), 'error', error);
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (event.isComposing) return;
  if (event.key === 'Escape' && canStopCurrent.value) {
    event.preventDefault();
    void stop();
    return;
  }
  if (props.mobileViewport) return;
  if (
    event.key === 'Enter' &&
    event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    !composerReadonly.value
  ) {
    event.preventDefault();
    void send('REPLACE_CURRENT');
    return;
  }
  if (event.key === 'Enter' && !event.shiftKey && !event.altKey) {
    event.preventDefault();
    void send();
  }
}

async function updateModel(modelId: string): Promise<void> {
  if (configurationUpdating.value || modelId === selectedModelId.value) return;
  configurationUpdating.value = true;
  try {
    await props.workspace.updateConfiguration({ modelId });
    messageIntent = undefined;
  } catch (error) {
    showMessage(hostedErrorMessage(error), 'error', error);
  } finally {
    configurationUpdating.value = false;
  }
}

async function stop(): Promise<void> {
  try {
    await props.workspace.interrupt();
  } catch (error) {
    showMessage(hostedErrorMessage(error), 'error', error);
  }
}

function hostedErrorMessage(error: unknown): string {
  switch (errorCode(error)) {
    case 'HOSTED_CONVERSATION_QUOTA_EXCEEDED':
    case 'HOSTED_CONVERSATION_UPLOAD_QUOTA_EXCEEDED':
      return translate('hostedConversations.quotaExceeded');
    case 'HOSTED_CONVERSATION_UPLOAD_TOO_LARGE':
      return translate('hostedConversations.attachmentTooLarge');
    case 'HOSTED_CONVERSATION_UPLOAD_INVALID_NAME':
      return translate('hostedConversations.attachmentInvalidName');
    case 'HOSTED_CONVERSATION_UPLOAD_CONFLICT':
      return translate('hostedConversations.attachmentConflict');
    case 'CONVERSATION_HOSTING_STORAGE_FULL':
      return translate('hostedConversations.storageFull');
    case 'HOSTED_CONVERSATION_RUN_ACTIVE':
      return translate('hostedConversations.runActive');
    case 'HOSTED_CONVERSATION_REPLACE_UNSUPPORTED':
      return translate('hostedConversations.replaceCurrentUnsupported');
    case 'HOSTED_CONVERSATION_UPGRADE_FAILED':
      return translate('hostedConversations.upgradeFailed');
    default:
      return error instanceof Error
        ? error.message
        : translate('hostedConversations.operationFailed');
  }
}

onBeforeUnmount(() => {
  for (const attachment of attachments.value) {
    attachment.controller.abort();
    if (attachment.previewUrl !== null) URL.revokeObjectURL(attachment.previewUrl);
  }
});
</script>

<template>
  <ConversationComposer
    ref="composer"
    v-model:input="input"
    :placeholder="readonly ? readonlyReason : translate('hostedConversations.messagePlaceholder')"
    :working="working"
    :working-label="workingLabel"
    :working-busy="!readonly && conversationActivityBusy(activeRun, workspace.turns.value)"
    :elapsed-label="elapsedLabel"
    :connection-busy="
      connected === false || (!workspace.watchReady.value && !workspace.watchFailureCode.value)
    "
    :connection-label="
      connected === false
        ? translate('conversationActivity.reconnecting')
        : !workspace.watchReady.value && !workspace.watchFailureCode.value
          ? translate('conversationActivity.syncing')
          : ''
    "
    :readonly="composerReadonly"
    :drop-target="draggingAttachments"
    :mobile-viewport="mobileViewport"
    :command-states="[]"
    :loading="submitting || configurationUpdating"
    :skill-tokens="[]"
    @keydown="onKeydown"
    @submit="send"
    @paste="attachmentInput.onPaste"
    @dragenter="attachmentInput.onDragEnter"
    @dragleave="attachmentInput.onDragLeave"
    @drop="attachmentInput.onDrop"
  >
    <template #attachments>
      <ul v-if="attachments.length" class="hosted-attachments">
        <li v-for="attachment in attachments" :key="attachment.id">
          <img v-if="attachment.previewUrl" :src="attachment.previewUrl" :alt="attachment.name" />
          <span v-tooltip="attachment.name">{{ attachment.name }}</span>
          <small v-if="attachment.status === 'UPLOADING'" role="status" aria-live="polite">
            {{
              translate('hostedConversations.uploadProgress', {
                value: Math.round(
                  (attachment.receivedBytes / Math.max(1, attachment.file.size)) * 100
                )
              })
            }}
          </small>
          <small v-else-if="attachment.status === 'COMPLETED'" role="status" aria-live="polite">
            {{ translate('hostedConversations.uploaded') }}
          </small>
          <small v-else class="attachment-error" role="alert">{{ attachment.error }}</small>
          <button
            v-if="attachment.status === 'FAILED'"
            type="button"
            :disabled="composerReadonly"
            :aria-label="
              translate('hostedConversations.retryAttachmentNamed', {
                name: attachment.name
              })
            "
            @click="retryAttachment(attachment.id)"
          >
            {{ translate('hostedConversations.retryAttachment') }}
          </button>
          <button
            type="button"
            :aria-label="
              translate('hostedConversations.removeAttachment', {
                name: attachment.name
              })
            "
            @click="removeAttachment(attachment.id)"
          >
            <MarIcon name="close" />
          </button>
        </li>
      </ul>
    </template>

    <template #toolbar>
      <div class="hosted-composer-toolbar">
        <input
          ref="fileInput"
          class="hosted-file-input"
          type="file"
          multiple
          @change="selectedFiles"
        />
        <button
          v-tooltip="translate('hostedConversations.addAttachment')"
          class="hosted-icon-button utility-control"
          type="button"
          :disabled="composerReadonly"
          :aria-label="translate('hostedConversations.addAttachment')"
          @click="chooseFiles"
        >
          <MarIcon name="attachment" />
        </button>
        <div class="hosted-model-slot">
          <el-dropdown
            class="hosted-model-menu"
            :disabled="modelSelectionDisabled"
            trigger="click"
            @command="updateModel(String($event))"
          >
            <button
              v-tooltip="selectedModelLabel"
              class="hosted-model-trigger"
              type="button"
              :disabled="modelSelectionDisabled"
              :aria-label="translate('hostedConversations.model')"
              :aria-description="selectedModelLabel"
            >
              <span>{{ selectedModelLabel }}</span>
              <MarIcon name="chevron-down" aria-hidden="true" />
            </button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item
                  v-for="model in models"
                  :key="model.id"
                  :command="model.id"
                  :class="{ 'is-selected': model.id === selectedModelId }"
                >
                  {{ model.name }}
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
        <span
          v-tooltip="loadedTemplateLabel"
          v-if="templateName"
          class="hosted-template-name"
          :aria-label="loadedTemplateLabel"
        >
          <MarIcon name="document" aria-hidden="true" />
          <span>{{ templateName }}</span>
        </span>
        <span v-if="modelUnavailable" class="hosted-model-unavailable" aria-live="polite">
          {{ translate('hostedConversations.modelUnavailable') }}
        </span>
        <span v-if="canReplaceCurrent" class="hosted-replace-hint" role="status">
          {{ translate('hostedConversations.replaceCurrentHint') }}
        </span>
        <span v-if="submitting" class="composer-submitting" role="status">{{
          translate('workbench.sending')
        }}</span>
        <button
          v-tooltip="translate('hostedConversations.stopWithEsc')"
          v-if="activeRun"
          class="hosted-stop-button"
          type="button"
          :disabled="!canStopCurrent"
          :aria-label="translate('hostedConversations.stopWithEsc')"
          @click="stop"
        >
          <i aria-hidden="true" />
        </button>
        <button
          v-else
          class="hosted-send-button"
          type="submit"
          :disabled="
            composerReadonly ||
            pendingAttachments ||
            !inputHasContent ||
            configurationUpdating ||
            modelUnavailable
          "
          :aria-label="translate('hostedConversations.send')"
        >
          <MarIcon name="send" />
        </button>
      </div>
    </template>
  </ConversationComposer>
</template>

<style scoped>
.composer-submitting {
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
  flex-shrink: 0;
}

.hosted-file-input {
  display: none;
}

.hosted-attachments {
  display: grid;
  max-height: 120px;
  margin: 0;
  overflow: auto;
  border-bottom: 1px solid var(--mar-border-subtle);
  padding: 0;
  list-style: none;
}

.hosted-attachments li {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto auto auto;
  align-items: center;
  gap: 8px;
  min-height: 36px;
  border-bottom: 1px solid var(--mar-border-subtle);
  padding: 5px 10px;
  font-size: var(--mar-font-size-body);
}

.hosted-attachments img {
  width: 28px;
  height: 28px;
  border-radius: 5px;
  object-fit: cover;
}

.hosted-attachments span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hosted-attachments small {
  color: var(--mar-text-tertiary);
  font-size: var(--mar-font-size-meta);
}

.hosted-attachments .attachment-error {
  color: var(--mar-color-danger-text);
}

.hosted-attachments button {
  border: 0;
  background: transparent;
  color: var(--mar-text-tertiary);
  cursor: pointer;
}

.hosted-composer-toolbar {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
  border-top: 1px solid var(--mar-border-subtle);
  padding: 8px 10px;
}

.hosted-icon-button,
.hosted-send-button,
.hosted-stop-button {
  display: inline-grid;
  width: 30px;
  min-width: 30px;
  height: 30px;
  place-items: center;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--mar-text-secondary);
  cursor: pointer;
}

.hosted-send-button {
  margin-left: auto;
  background: var(--mar-color-brand);
  color: var(--mar-color-on-accent);
}

.hosted-stop-button {
  margin-left: auto;
  border: 1px solid var(--mar-color-danger-text);
  color: var(--mar-color-danger-text);
}

.hosted-stop-button i {
  width: 9px;
  height: 9px;
  border-radius: 1px;
  background: currentcolor;
}

.hosted-icon-button:disabled,
.hosted-send-button:disabled,
.hosted-stop-button:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.hosted-model-slot {
  display: inline-flex;
  min-width: 0;
  max-width: 100%;
}

.hosted-model-menu {
  min-width: 0;
  max-width: 100%;
}

.hosted-model-trigger,
.hosted-template-name {
  min-height: var(--mar-compact-control-size);
  box-sizing: border-box;
  border-radius: 6px;
  background: var(--mar-bg-panel);
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
  line-height: 1;
}

.hosted-model-trigger {
  display: inline-flex;
  max-width: 100%;
  align-items: center;
  gap: 0.35rem;
  border: 0;
  padding: 0 0.35rem 0 0.55rem;
  cursor: pointer;
}

.hosted-model-trigger > span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hosted-model-trigger > .mar-icon {
  flex: none;
  color: var(--mar-text-tertiary);
}

.hosted-model-trigger:hover:not(:disabled) {
  background: var(--mar-fill-soft);
  color: var(--mar-text-primary);
}

.hosted-model-trigger:focus-visible {
  outline: 2px solid var(--mar-color-brand-text);
  outline-offset: 1px;
}

.hosted-model-trigger:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.hosted-template-name {
  display: inline-flex;
  min-width: 0;
  max-width: min(22rem, 42%);
  align-items: center;
  gap: 5px;
  overflow: hidden;
  border: 1px solid var(--mar-border-medium);
  padding: 0 0.55rem;
  white-space: nowrap;
}

.hosted-template-name > .mar-icon {
  flex: none;
  color: var(--mar-text-tertiary);
}

.hosted-template-name > span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.hosted-model-unavailable {
  color: var(--mar-color-warning-text);
  font-size: var(--mar-font-size-meta);
  line-height: 1;
  white-space: nowrap;
}

.hosted-replace-hint {
  min-width: 0;
  color: var(--mar-text-tertiary);
  font-size: var(--mar-font-size-meta);
  line-height: 1.35;
}

@media (max-width: 767px) {
  .hosted-composer-toolbar {
    display: grid;
    grid-template-columns: 34px minmax(72px, 0.9fr) minmax(0, 1.1fr) 34px;
  }

  .hosted-model-unavailable,
  .hosted-replace-hint {
    grid-column: 1 / -1;
  }

  .hosted-model-slot {
    width: 100%;
  }

  .hosted-model-menu,
  .hosted-model-trigger {
    width: 100%;
  }

  .hosted-template-name {
    width: 100%;
    max-width: 100%;
    box-sizing: border-box;
  }

  .hosted-send-button,
  .hosted-stop-button {
    grid-column: 4;
    grid-row: 1;
  }
}
</style>
