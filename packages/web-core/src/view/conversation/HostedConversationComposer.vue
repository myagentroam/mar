<script setup lang="ts">
import { MarDropdown, MarDropdownMenu, MarDropdownItem } from '@myagentroam/mar-ui/dropdown';
import { createUuid } from '../../util/uuid.js';
// Owns the current hosted Composer draft; quote callbacks bind its watch and reuse the existing submission snapshot.
import { parseComposerTags, type ComposerReference } from '@myagentroam/protocol';
import type { ComposerQuoteTarget } from '../../model/composer-quote.js';
import { appendComposerQuote } from '../../util/composer-quote.js';
import { composerReferenceKey } from '../../util/composer-reference.js';
import { serializeComposerMessage } from '../../service/composer-skill-token-service.js';
import { showMessage } from '../../service/message-feedback-service.js';

import { marIcon } from '../../util/mar-icons.js';

import MarIcon from '../common/MarIcon.vue';
import ComposerSendButton from '../composer/ComposerSendButton.vue';
import '../composer/composer-toolbar.css';
import type { ConversationTemplateSummary, HostedConversationUpload } from '@myagentroam/protocol';
import { MarMessageBox } from '../../service/message-box-service.js';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { registerComposerShortcuts } from '../../service/composer-shortcut-service.js';
import { createComposerAttachmentInputService } from '../../service/composer-attachment-input-service.js';
import { createWorkbenchClockService } from '../../service/workbench-clock-service.js';
import { translate } from '../../service/locale-preference-service.js';
import {
  hostedConversationSubmissionContext,
  type createHostedConversationWorkspaceService
} from '../../service/hosted-conversation-workspace-service.js';
import type {
  HostedAttachment,
  createHostedConversationEntryService
} from '../../service/hosted-conversation-entry-service.js';
import { errorCode } from '../../util/api-error.js';
import { errorMessage } from '../../util/error-presentation.js';
import {
  isBmpAttachment,
  normalizeComposerImage
} from '../../util/composer-image-compatibility.js';
import {
  conversationActivityLabel,
  conversationActivityBusy,
  conversationElapsedLabel
} from '../../util/conversation-activity.js';
import ConversationComposer from '../composer/ConversationComposer.vue';

const props = defineProps<{
  readonly connected?: boolean;
  readonly workspace: ReturnType<typeof createHostedConversationWorkspaceService>;
  readonly mobileViewport: boolean;
  readonly readonly: boolean;
  readonly readonlyReason: string;
  readonly templateChangeBlocked?: boolean;
  readonly draft?: boolean;
  readonly entry?: ReturnType<typeof createHostedConversationEntryService>;
  readonly reloadTemplates?: (visible: boolean) => void;
  readonly reloadModels?: (visible: boolean) => void;
}>();
const emit = defineEmits<{
  started: [];
}>();

const input = props.draft && props.entry ? props.entry.prompt : ref('');
const references = ref<readonly ComposerReference[]>([]);
const composer = ref<{ readonly $el: HTMLElement; focusAt(cursor: number): void }>();
const attachments =
  props.draft && props.entry ? props.entry.attachments : ref<HostedAttachment[]>([]);
const draggingAttachments = ref(false);
const fileInput = ref<HTMLInputElement>();
const configurationUpdating = ref(false);
const existingTemplates = ref<readonly ConversationTemplateSummary[]>([]);
let disposed = false;
const templatesLoading = ref(false);
const templatesFailed = ref(false);
const templateMenuOpen = ref(false);
let messageIntent:
  | {
      readonly fingerprint: string;
      readonly clientMessageId: string;
    }
  | undefined;

function restoreMessage(text: string): void {
  const parts = parseComposerTags(text);
  references.value = parts.flatMap((part) =>
    part.kind === 'mar_references' ? part.payload.references : []
  );
  input.value = parts
    .map((part) =>
      part.kind === 'mar_references' ? '' : part.kind === 'text' ? part.text : part.raw
    )
    .join('')
    .trim();
  messageIntent = undefined;
  composer.value?.focusAt(text.length);
}

const quoteTarget: ComposerQuoteTarget = {
  capture() {
    const target = props.workspace.selectedWatchId();
    if (props.draft || composerReadonly.value || disposed || target === undefined) return undefined;
    return (quote) => {
      if (composerReadonly.value || disposed || target !== props.workspace.selectedWatchId())
        return false;
      try {
        references.value = appendComposerQuote(references.value, quote, input.value);
        return true;
      } catch {
        showMessage(translate('composer.quoteTooLarge'), 'warning');
        return false;
      }
    };
  }
};
defineExpose({ restoreMessage, quoteTarget });

const snapshot = computed(() => {
  if (!props.draft || !props.entry) return props.workspace.snapshot.value;
  const target = props.entry.target.value;
  if (target === undefined) return undefined;
  return props.workspace.selectedNodeId.value === target.conversation.nodeId &&
    props.workspace.selectedConversationId.value === target.conversation.id
    ? (props.workspace.snapshot.value ?? target)
    : target;
});
const selectedSubmissionContext = computed(() => {
  const conversation = snapshot.value?.conversation;
  return conversation === undefined
    ? undefined
    : hostedConversationSubmissionContext(conversation.nodeId, conversation.id);
});
const submitting = computed(
  () =>
    (props.draft === true && props.entry?.submitting.value === true) ||
    (props.workspace.messageSubmitting.value &&
      props.workspace.messageSubmissionContext.value === selectedSubmissionContext.value)
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
const failedDraftAttachments = computed(
  () =>
    props.draft === true && attachments.value.some((attachment) => attachment.status === 'FAILED')
);
const completedAttachmentIds = computed(() =>
  attachments.value.flatMap((attachment) =>
    attachment.status === 'COMPLETED' && attachment.fileId !== undefined ? [attachment.fileId] : []
  )
);
const inputHasContent = computed(
  () =>
    input.value.trim().length > 0 ||
    references.value.length > 0 ||
    completedAttachmentIds.value.length > 0 ||
    attachments.value.some((attachment) => attachment.status === 'PENDING')
);
const canReplaceCurrent = computed(
  () => activeRun.value !== undefined && activeRun.value.status !== 'CANCELLING'
);
const canStopCurrent = computed(
  () =>
    activeRun.value !== undefined && activeRun.value.status !== 'CANCELLING' && !submitting.value
);
const composerReadonly = computed(
  () =>
    props.readonly ||
    props.workspace.templateChanging.value ||
    (!props.draft && snapshot.value !== undefined && !props.workspace.watchReady.value) ||
    (props.draft === true && props.entry?.writable.value === false) ||
    submitting.value ||
    (activeRun.value !== undefined && !canReplaceCurrent.value)
);
const syncingOnly = computed(
  () =>
    !props.draft &&
    props.connected !== false &&
    snapshot.value !== undefined &&
    !props.workspace.watchReady.value &&
    props.workspace.watchFailureCode.value === undefined &&
    !props.readonly &&
    !props.workspace.templateChanging.value &&
    !submitting.value &&
    (activeRun.value === undefined || canReplaceCurrent.value)
);
const working = clockWorking;
const sendLabel = computed(() =>
  translate(
    submitting.value
      ? 'workbench.sending'
      : props.mobileViewport && canReplaceCurrent.value
        ? 'composerSend.steer'
        : 'hostedConversations.send'
  )
);
const workingLabel = computed(() =>
  conversationActivityLabel(activeRun.value, props.readonly ? [] : props.workspace.turns.value)
);
const elapsedLabel = computed(() =>
  props.readonly ? '' : conversationElapsedLabel(workingStartedAt.value, workingNow.value)
);
const models = computed(
  () => snapshot.value?.models ?? (props.draft ? (props.entry?.models.value ?? []) : [])
);
const selectedModelId = computed(
  () =>
    snapshot.value?.conversation.modelId ??
    (props.draft ? (props.entry?.selectedModelId.value ?? '') : '')
);
const modelUnavailable = computed(
  () =>
    (snapshot.value !== undefined ||
      (props.draft === true && props.entry?.modelOptionsLoaded.value === true)) &&
    models.value.length === 0
);
const modelSelectionDisabled = computed(
  () =>
    props.readonly ||
    (props.draft === true && props.entry?.writable.value === false) ||
    submitting.value ||
    activeRun.value !== undefined ||
    configurationUpdating.value ||
    props.workspace.templateChanging.value ||
    modelUnavailable.value ||
    (props.draft === true &&
      snapshot.value === undefined &&
      props.entry?.modelOptionsLoaded.value !== true)
);
const selectedModelLabel = computed(
  () =>
    models.value.find((model) => model.id === selectedModelId.value)?.name ??
    (selectedModelId.value || translate('hostedConversations.model'))
);
const templateName = computed(() => snapshot.value?.conversation.templateName ?? '');
const draftTemplates = computed(() => props.entry?.templates.value ?? []);
const draftTemplateId = computed(() => props.entry?.selectedTemplateId.value ?? '');
const draftTemplateLabel = computed(
  () =>
    draftTemplates.value.find((template) => template.id === draftTemplateId.value)?.name ??
    translate('hostedConversations.templatePlaceholder')
);
const templateSelectionDisabled = computed(() =>
  props.draft
    ? props.readonly || submitting.value
    : props.readonly ||
      props.connected === false ||
      props.templateChangeBlocked === true ||
      !props.workspace.watchReady.value ||
      snapshot.value?.conversation.status !== 'ACTIVE' ||
      snapshot.value.conversation.activity.status !== 'IDLE' ||
      activeRun.value !== undefined ||
      submitting.value ||
      pendingAttachments.value ||
      configurationUpdating.value ||
      props.workspace.templateChanging.value
);
const menuTemplates = computed(() =>
  props.draft ? draftTemplates.value : existingTemplates.value
);
const menuTemplateId = computed(() =>
  props.draft ? draftTemplateId.value : snapshot.value?.conversation.templateId
);
const menuTemplateLabel = computed(() =>
  props.draft ? draftTemplateLabel.value : templateName.value
);
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
  if (props.draft && props.entry) {
    props.entry.addFiles(files);
    return;
  }
  for (const file of files) {
    if (attachments.value.length >= 32) {
      showMessage(translate('hostedConversations.attachmentLimit'), 'warning');
      break;
    }
    const attachment: HostedAttachment = {
      id: createUuid(),
      file,
      previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
      name: file.name,
      clientRequestId: createUuid(),
      controller: new AbortController(),
      receivedBytes: 0,
      status: props.draft && snapshot.value === undefined ? 'PENDING' : 'UPLOADING'
    };
    attachments.value = [...attachments.value, attachment];
    messageIntent = undefined;
    if (attachment.status === 'UPLOADING') void uploadAttachment(attachment);
  }
}

async function uploadAttachment(attachment: HostedAttachment): Promise<void> {
  try {
    if (isBmpAttachment(attachment.file)) {
      const file = await normalizeComposerImage(attachment.file);
      attachment.controller.signal.throwIfAborted();
      attachment.file = file;
      attachment.name = file.name;
    }
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
  if (props.draft && props.entry) {
    void props.entry
      .retryAttachment(attachmentId)
      .catch((error) => showMessage(hostedErrorMessage(error), 'error', error));
    return;
  }
  const attachment = attachments.value.find((candidate) => candidate.id === attachmentId);
  if (attachment === undefined || attachment.status !== 'FAILED') return;
  const retry: HostedAttachment = {
    id: attachment.id,
    file: attachment.file,
    previewUrl: attachment.previewUrl,
    name: attachment.name,
    clientRequestId: createUuid(),
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
  if (props.draft && props.entry) {
    props.entry.removeAttachment(attachmentId);
    return;
  }
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
    references: references.value,
    attachments: completedAttachmentIds.value,
    modelId: selectedModelId.value,
    templateId: snapshot.value?.conversation.templateId ?? draftTemplateId.value
  });
}

async function selectTemplate(templateId: string): Promise<void> {
  if (props.draft) {
    props.entry?.selectTemplate(templateId);
    messageIntent = undefined;
    props.reloadModels?.(true);
    return;
  }
  const conversation = snapshot.value?.conversation;
  const target = existingTemplates.value.find((template) => template.id === templateId);
  if (
    templateSelectionDisabled.value ||
    conversation === undefined ||
    target === undefined ||
    templateId === conversation.templateId
  )
    return;
  const watchId = props.workspace.selectedWatchId();
  try {
    await MarMessageBox.confirm(
      translate('hostedConversations.templateSwitchConfirmation', { name: target.name }),
      translate('hostedConversations.templateSwitchTitle'),
      {
        confirmButtonText: translate('hostedConversations.switchTemplate'),
        cancelButtonText: translate('common.cancel')
      }
    );
  } catch {
    return;
  }
  if (
    disposed ||
    templateSelectionDisabled.value ||
    props.workspace.selectedWatchId() !== watchId ||
    snapshot.value?.conversation.id !== conversation.id ||
    snapshot.value.conversation.nodeId !== conversation.nodeId ||
    snapshot.value.conversation.templateId !== conversation.templateId ||
    snapshot.value.conversation.activeVersionId !== conversation.activeVersionId
  )
    return;
  try {
    await props.workspace.switchTemplate(templateId, conversation.templateId);
    messageIntent = undefined;
  } catch (error) {
    showMessage(hostedErrorMessage(error), 'error', error);
  }
}

async function handleTemplateMenuVisibility(visible: boolean): Promise<void> {
  templateMenuOpen.value = visible;
  if (!visible) return;
  if (props.draft) {
    props.reloadTemplates?.(true);
    return;
  }
  const conversation = snapshot.value?.conversation;
  if (conversation === undefined || templatesLoading.value) return;
  templatesLoading.value = true;
  templatesFailed.value = false;
  try {
    const templates = await props.workspace.listTemplateOptions();
    if (
      snapshot.value?.conversation.id === conversation.id &&
      snapshot.value.conversation.nodeId === conversation.nodeId
    )
      existingTemplates.value = templates;
  } catch (error) {
    templatesFailed.value = true;
    showMessage(hostedErrorMessage(error), 'error', error);
  } finally {
    templatesLoading.value = false;
  }
}

async function confirmDroppedAttachments(files: readonly File[]): Promise<boolean> {
  try {
    await MarMessageBox.confirm(
      translate('hostedConversations.confirmDroppedAttachments', { count: files.length }),
      translate('hostedConversations.confirmDroppedAttachmentsTitle'),
      {
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
    failedDraftAttachments.value ||
    !inputHasContent.value
  )
    return;
  if (props.draft && props.entry) {
    try {
      if (await props.entry.submit()) emit('started');
    } catch (error) {
      showMessage(hostedErrorMessage(error), 'error', error);
    }
    return;
  }
  let submittedIntent: typeof messageIntent;
  try {
    if (snapshot.value === undefined) return;
    const submittedMessage = messageFingerprint();
    const submittedAttachments = attachments.value;
    const fingerprint = JSON.stringify({ deliveryIntent, message: submittedMessage });
    if (messageIntent?.fingerprint !== fingerprint)
      messageIntent = { fingerprint, clientMessageId: createUuid() };
    submittedIntent = messageIntent;
    await props.workspace.sendMessage({
      prompt: serializeComposerMessage([], input.value, references.value),
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
    references.value = [];
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

let unregisterComposerActions: (() => void) | undefined;
onMounted(() => {
  unregisterComposerActions = registerComposerShortcuts({
    owner: () => composer.value?.$el.querySelector('textarea') ?? undefined,
    canSend: () => !props.mobileViewport,
    canReplace: () => !composerReadonly.value,
    canStop: () => canStopCurrent.value,
    send: (replace) => {
      void send(replace ? 'REPLACE_CURRENT' : undefined);
    },
    stop: () => {
      void stop();
    }
  });
});

async function updateModel(modelId: string): Promise<void> {
  if (modelSelectionDisabled.value || modelId === selectedModelId.value) return;
  if (props.draft === true && snapshot.value === undefined) {
    try {
      props.entry?.selectModel(modelId);
      messageIntent = undefined;
    } catch (error) {
      showMessage(hostedErrorMessage(error), 'error', error);
    }
    return;
  }
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

function attachmentError(attachment: HostedAttachment): string | undefined {
  return props.draft && attachment.error !== undefined
    ? hostedErrorMessage(new Error(attachment.error))
    : attachment.error;
}

function hostedErrorMessage(error: unknown): string {
  switch (errorCode(error)) {
    case 'COMPOSER_IMAGE_CONVERSION_FAILED':
    case 'COMPOSER_IMAGE_LIMIT_EXCEEDED':
      return errorMessage(error);
    case 'HOSTED_CONVERSATION_DRAFT_PAUSED':
      return translate('hostedConversations.firstMessagePaused');
    case 'HOSTED_CONVERSATION_DRAFT_DISPOSED':
      return translate('hostedConversations.firstMessageDisposed');
    case 'HOSTED_CONVERSATION_WATCH_NOT_READY':
      return translate('hostedConversations.firstMessageWatchRequired');
    case 'HOSTED_CONVERSATION_TEMPLATE_REQUIRED':
      return translate('hostedConversations.templateRequired');
    case 'HOSTED_CONVERSATION_MODEL_REQUIRED':
      return translate('hostedConversations.modelUnavailable');
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
  unregisterComposerActions?.();
  disposed = true;
  if (props.draft && props.entry) return;
  for (const attachment of attachments.value) {
    attachment.controller.abort();
    if (attachment.previewUrl !== null) URL.revokeObjectURL(attachment.previewUrl);
  }
});
</script>

<template>
  <ConversationComposer
    ref="composer"
    :class="{ 'hosted-draft-composer': draft, 'hosted-syncing': syncingOnly }"
    v-model:input="input"
    :placeholder="readonly ? readonlyReason : translate('hostedConversations.messagePlaceholder')"
    :working="working"
    :working-label="workingLabel"
    :working-busy="!readonly && conversationActivityBusy(activeRun, workspace.turns.value)"
    :elapsed-label="elapsedLabel"
    :connection-busy="
      connected === false ||
      (!draft && !workspace.watchReady.value && !workspace.watchFailureCode.value)
    "
    :connection-label="
      connected === false
        ? translate('conversationActivity.reconnecting')
        : !draft && !workspace.watchReady.value && !workspace.watchFailureCode.value
          ? translate('conversationActivity.syncing')
          : ''
    "
    :readonly="composerReadonly"
    :drop-target="draggingAttachments"
    :mobile-viewport="mobileViewport"
    :command-states="[]"
    :loading="submitting || configurationUpdating || workspace.templateChanging.value"
    :skill-tokens="[]"
    :file-references="references"
    @remove-reference="
      references = references.filter((reference) => composerReferenceKey(reference) !== $event)
    "
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
          <small v-if="attachment.status === 'PENDING'" role="status" aria-live="polite">
            {{ translate('hostedConversations.uploadAfterCreate') }}
          </small>
          <small v-else-if="attachment.status === 'UPLOADING'" role="status" aria-live="polite">
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
          <small v-else class="attachment-error" role="alert">{{
            attachmentError(attachment)
          }}</small>
          <button
            v-if="attachment.status === 'FAILED'"
            class="mar-text-action"
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
            class="mar-icon-action"
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
      <div
        class="hosted-composer-toolbar mar-composer-toolbar"
        :class="{ 'is-mobile': mobileViewport }"
      >
        <input
          ref="fileInput"
          class="hosted-file-input"
          type="file"
          multiple
          @change="selectedFiles"
        />
        <button
          v-tooltip="translate('hostedConversations.addAttachment')"
          class="hosted-icon-button mar-composer-attachment mar-icon-action"
          type="button"
          :disabled="composerReadonly"
          :aria-label="translate('hostedConversations.addAttachment')"
          @click="chooseFiles"
        >
          <MarIcon name="attachment" />
        </button>
        <MarDropdown
          v-if="!draft || !snapshot"
          class="hosted-template-menu hosted-model-menu"
          :disabled="templateSelectionDisabled"
          trigger="click"
          @command="selectTemplate(String($event))"
          @visible-change="handleTemplateMenuVisibility"
        >
          <button
            v-tooltip="{ content: menuTemplateLabel, disabled: templateMenuOpen }"
            class="hosted-template-trigger hosted-model-trigger"
            type="button"
            :disabled="templateSelectionDisabled"
            :aria-label="translate('hostedConversations.chooseTemplate')"
            :aria-description="menuTemplateLabel"
          >
            <MarIcon name="document" aria-hidden="true" />
            <span>{{ menuTemplateLabel }}</span>
            <MarIcon name="chevron-down" aria-hidden="true" />
          </button>
          <template #dropdown>
            <MarDropdownMenu>
              <MarDropdownItem v-if="templatesLoading" disabled>
                {{ translate('common.loading') }}
              </MarDropdownItem>
              <MarDropdownItem v-else-if="templatesFailed" disabled>
                {{ translate('hostedConversations.templateOptionsFailed') }}
              </MarDropdownItem>
              <MarDropdownItem
                v-for="template in templatesLoading || templatesFailed ? [] : menuTemplates"
                :key="template.id"
                :command="template.id"
                :disabled="!template.available || (!draft && template.id === menuTemplateId)"
                :class="{ 'is-selected': template.id === menuTemplateId }"
              >
                {{ template.name }}
              </MarDropdownItem>
              <MarDropdownItem
                v-if="!templatesLoading && !templatesFailed && menuTemplates.length === 0"
                disabled
              >
                {{
                  translate(
                    draft
                      ? 'hostedConversations.noTemplates'
                      : 'hostedConversations.noSameNodeTemplates'
                  )
                }}
              </MarDropdownItem>
            </MarDropdownMenu>
          </template>
        </MarDropdown>
        <span
          v-tooltip="loadedTemplateLabel"
          v-else-if="templateName"
          class="hosted-template-name"
          :aria-label="loadedTemplateLabel"
        >
          <MarIcon name="document" aria-hidden="true" />
          <span>{{ templateName }}</span>
        </span>
        <div v-if="snapshot || (draft && draftTemplateId)" class="hosted-model-slot">
          <MarDropdown
            class="hosted-model-menu"
            :disabled="modelSelectionDisabled"
            trigger="click"
            @command="updateModel(String($event))"
          >
            <button
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
              <MarDropdownMenu>
                <MarDropdownItem
                  v-for="model in models"
                  :key="model.id"
                  :command="model.id"
                  :class="{ 'is-selected': model.id === selectedModelId }"
                >
                  {{ model.name }}
                </MarDropdownItem>
              </MarDropdownMenu>
            </template>
          </MarDropdown>
        </div>
        <span v-if="modelUnavailable" class="hosted-model-unavailable" aria-live="polite">
          {{ translate('hostedConversations.modelUnavailable') }}
        </span>
        <div class="hosted-composer-actions">
          <span
            v-if="!mobileViewport && canReplaceCurrent && !submitting"
            class="hosted-replace-hint"
            role="status"
          >
            {{ translate('hostedConversations.replaceCurrentHint') }}
          </span>
          <span
            v-if="submitting"
            class="composer-submitting mar-composer-submitting mar-composer-mobile-status"
            role="status"
            >{{ translate('workbench.sending') }}</span
          >
          <button
            v-tooltip="
              translate(
                activeRun.status === 'CANCELLING'
                  ? 'generated.composerToolbar.stopping'
                  : 'hostedConversations.stopWithEsc'
              )
            "
            v-if="activeRun"
            class="hosted-stop-button mar-composer-action mar-composer-stop-action"
            type="button"
            :disabled="!canStopCurrent"
            :aria-label="translate('hostedConversations.stopWithEsc')"
            @click="stop"
          >
            <MarIcon name="stop" aria-hidden="true" />
          </button>
          <ComposerSendButton
            v-tooltip="sendLabel"
            v-if="!activeRun || (mobileViewport && canReplaceCurrent && inputHasContent)"
            class="hosted-send-button mar-composer-action"
            :disabled="
              composerReadonly ||
              pendingAttachments ||
              failedDraftAttachments ||
              !inputHasContent ||
              configurationUpdating ||
              modelUnavailable
            "
            :mobile-viewport="mobileViewport"
            :can-steer="canReplaceCurrent"
            :context-key="`${selectedSubmissionContext ?? draftTemplateId}:${activeRun?.id ?? ''}`"
            :submitting="submitting"
            :label="sendLabel"
            @send="send(mobileViewport && canReplaceCurrent ? 'REPLACE_CURRENT' : undefined)"
            @steer="send('REPLACE_CURRENT')"
          />
        </div>
      </div>
    </template>
  </ConversationComposer>
</template>

<style scoped>
.hosted-draft-composer :deep(.composer) {
  background: transparent;
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
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
}

.hosted-attachments .attachment-error {
  color: var(--mar-color-danger-text);
}

.hosted-attachments button {
  border: 0;
  cursor: pointer;
}

.hosted-composer-actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: inherit;
  margin-inline-start: auto;
}

.hosted-syncing :deep(.composer-shell.readonly) {
  border-color: var(--mar-border-medium);
  background: var(--mar-bg-panel);
}

.hosted-syncing :deep(.composer-shell.readonly .composer-input) {
  background: transparent;
  cursor: text;
}

.hosted-icon-button:disabled {
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
  display: inline-flex;
  min-height: var(--mar-compact-control-size);
  min-width: 0;
  max-width: 100%;
  align-items: center;
  gap: 0.35rem;
  box-sizing: border-box;
  border: 0;
  border-radius: var(--mar-radius-control);
  padding: 0 0.55rem;
  background: var(--mar-bg-panel);
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
  line-height: 1;
}

.hosted-model-trigger {
  border-radius: 6px;
  padding-right: 0.35rem;
  background: transparent;
  color: var(--mar-text-primary);
  cursor: pointer;
}

.hosted-model-trigger > span,
.hosted-template-name > span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hosted-model-trigger > .mar-icon,
.hosted-template-name > .mar-icon {
  flex: none;
  color: var(--mar-text-secondary);
}

.hosted-template-trigger > .mar-icon[data-mar-icon='document'],
.hosted-template-name > .mar-icon[data-mar-icon='document'] {
  width: 14px;
  height: 14px;
}

.hosted-model-trigger:hover:not(:disabled) {
  background: var(--mar-fill-soft);
  box-shadow: 0 0 0 1px var(--mar-border-medium) inset;
}

.hosted-model-trigger[aria-expanded='true']:not(:disabled) {
  background: var(--mar-fill-soft);
  box-shadow: 0 0 0 1px var(--mar-color-brand) inset;
}

.hosted-model-trigger:focus-visible {
  background: var(--mar-fill-soft);
  outline: 1px solid var(--mar-color-brand);
  outline-offset: -1px;
}

.hosted-model-trigger:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.hosted-template-menu,
.hosted-template-name {
  max-width: min(22rem, 42%);
}

.hosted-template-name {
  overflow: hidden;
  white-space: nowrap;
  background: transparent;
  color: var(--mar-text-primary);
}

.hosted-model-unavailable {
  min-width: 0;
  color: var(--mar-color-warning-text);
  font-size: var(--mar-font-size-meta);
  line-height: 1.35;
  overflow-wrap: anywhere;
}

.hosted-replace-hint {
  min-width: 0;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
  line-height: 1.35;
}

@container (max-width: 680px) {
  .hosted-replace-hint {
    display: none;
  }
}

@media (max-width: 767px) {
  .hosted-composer-toolbar {
    grid-template-columns: auto minmax(0, 0.9fr) minmax(0, 1.1fr) auto;
  }

  .hosted-icon-button {
    grid-column: 1;
    grid-row: 1;
  }

  .hosted-model-unavailable {
    grid-column: 1 / -1;
    grid-row: 2;
  }

  .hosted-model-slot {
    width: 100%;
    grid-column: 3;
    grid-row: 1;
  }

  .hosted-model-menu,
  .hosted-model-trigger {
    width: 100%;
  }

  .hosted-template-name,
  .hosted-template-menu {
    width: 100%;
    max-width: 100%;
    grid-column: 2;
    grid-row: 1;
  }

  .hosted-template-trigger {
    width: 100%;
  }

  .hosted-composer-actions {
    grid-column: 4;
    grid-row: 1;
  }
}
</style>
