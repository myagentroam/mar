import {
  hostedConversationModelOptionsSchema,
  hostedConversationSnapshotSchema,
  type ConversationTemplateSummary,
  type HostedConversationModelOptions,
  type HostedConversationSnapshot,
  type HostedConversationUpload
} from '@myagentroam/protocol';
import { computed, ref, shallowRef, type Ref } from 'vue';
import { listAvailableConversationTemplates } from './hosted-conversation-template-client.js';
import { errorCode } from '../util/api-error.js';

export interface HostedAttachment {
  readonly id: string;
  readonly file: File;
  readonly previewUrl: string | null;
  name: string;
  clientRequestId: string;
  readonly controller: AbortController;
  fileId?: string;
  receivedBytes: number;
  status: 'PENDING' | 'UPLOADING' | 'COMPLETED' | 'FAILED';
  error?: string;
}

interface FirstMessageSubmission {
  readonly workspace: {
    readonly selectedNodeId: Readonly<Ref<string | undefined>>;
    readonly selectedConversationId: Readonly<Ref<string | undefined>>;
    readonly watchReady: Readonly<Ref<boolean>>;
    readonly snapshot: Readonly<
      Ref<Pick<HostedConversationSnapshot, 'conversation' | 'models'> | undefined>
    >;
    rememberConversation(conversation: HostedConversationSnapshot['conversation']): void;
    uploadFile(
      file: File,
      clientRequestId: string,
      onProgress?: (upload: HostedConversationUpload) => void,
      signal?: AbortSignal
    ): Promise<HostedConversationUpload>;
    sendMessage(input: {
      readonly prompt: string;
      readonly attachmentIds: readonly string[];
      readonly clientMessageId: string;
      readonly modelId?: string;
    }): Promise<unknown>;
  };
  readonly select: (snapshot: HostedConversationSnapshot) => Promise<void>;
}

type Request = <T>(path: string, init?: RequestInit) => Promise<T>;
type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>;

const TEMPLATE_PREFERENCE_STORAGE_KEY = 'mar.hosted-conversations.last-template-id.v1';

export interface HostedConversationEntryService {
  readonly templates: Ref<readonly ConversationTemplateSummary[]>;
  readonly selectedTemplateId: Ref<string | undefined>;
  readonly models: Ref<HostedConversationModelOptions['models']>;
  readonly modelOptionsLoaded: Ref<boolean>;
  readonly selectedModelId: Ref<string | undefined>;
  readonly prompt: Ref<string>;
  readonly attachments: Ref<HostedAttachment[]>;
  readonly submitting: Ref<boolean>;
  readonly target: Ref<HostedConversationSnapshot | undefined>;
  readonly writable: Readonly<Ref<boolean>>;
  loadTemplates(): Promise<void>;
  loadModelOptions(): Promise<void>;
  setTemplates(templates: readonly ConversationTemplateSummary[]): void;
  selectTemplate(templateId: string): void;
  selectModel(modelId: string): void;
  create(clientRequestId?: string): Promise<HostedConversationSnapshot>;
  addFiles(files: Iterable<File>): void;
  removeAttachment(id: string): void;
  retryAttachment(id: string): Promise<void>;
  submit(): Promise<boolean>;
  suspend(): void;
  resume(): void;
  dispose(): void;
}

export function createHostedConversationEntryService(
  request: Request,
  options: {
    readonly storage?: PreferenceStorage;
    readonly submission?: FirstMessageSubmission;
  } = {}
): HostedConversationEntryService {
  const templates = ref<readonly ConversationTemplateSummary[]>([]);
  const selectedTemplateId = ref<string>();
  const storage =
    options.storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage);
  let preferredTemplateId = readPreferredTemplateId(storage);
  let creationClientRequestId: string | undefined;
  let creationModelId: string | undefined;
  let creationIntentRevision = 0;
  let templateLoadSequence = 0;
  let modelLoadSequence = 0;
  const models = shallowRef<HostedConversationModelOptions['models']>([]);
  const modelOptionsLoaded = ref(false);
  const selectedModelId = ref<string>();

  function resetModelOptions(): void {
    modelLoadSequence += 1;
    models.value = [];
    modelOptionsLoaded.value = false;
    selectedModelId.value = undefined;
  }
  const prompt = ref('');
  const attachments = ref<HostedAttachment[]>([]);
  const submitting = ref(false);
  const target = ref<HostedConversationSnapshot>();
  let active = true;
  let generation = 0;
  let disposed = false;
  let messageIntent: { readonly fingerprint: string; readonly clientMessageId: string } | undefined;
  const writable = computed(() => {
    const workspace = options.submission?.workspace;
    return target.value === undefined || !sameTarget() || workspace?.watchReady.value === true;
  });

  function sameTarget(): boolean {
    const workspace = options.submission?.workspace;
    return (
      target.value !== undefined &&
      workspace?.selectedNodeId.value === target.value.conversation.nodeId &&
      workspace.selectedConversationId.value === target.value.conversation.id
    );
  }

  function requireActive(expectedGeneration: number): void {
    if (disposed) throw new Error('HOSTED_CONVERSATION_DRAFT_DISPOSED');
    if (!active || generation !== expectedGeneration)
      throw new Error('HOSTED_CONVERSATION_DRAFT_PAUSED');
  }

  function requireReady(): void {
    if (!sameTarget() || options.submission?.workspace.watchReady.value !== true)
      throw new Error('HOSTED_CONVERSATION_WATCH_NOT_READY');
  }

  function addFiles(files: Iterable<File>): void {
    if (submitting.value || disposed) return;
    for (const file of files) {
      if (attachments.value.length >= 32) break;
      attachments.value.push({
        id: crypto.randomUUID(),
        file,
        name: file.name,
        previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
        clientRequestId: crypto.randomUUID(),
        controller: new AbortController(),
        receivedBytes: 0,
        status: 'PENDING'
      });
    }
  }

  function releaseAttachments(): void {
    for (const attachment of attachments.value)
      if (attachment.previewUrl !== null) URL.revokeObjectURL(attachment.previewUrl);
    attachments.value = [];
  }

  function removeAttachment(id: string): void {
    if (submitting.value) return;
    const attachment = attachments.value.find((candidate) => candidate.id === id);
    attachment?.controller.abort();
    if (attachment?.previewUrl != null) URL.revokeObjectURL(attachment.previewUrl);
    attachments.value = attachments.value.filter((candidate) => candidate.id !== id);
  }

  async function uploadAttachment(attachment: HostedAttachment): Promise<void> {
    const workspace = options.submission!.workspace;
    requireReady();
    if (
      attachment.status === 'FAILED' &&
      attachment.error !== undefined &&
      /^[A-Z][A-Z0-9_]+$/u.test(attachment.error)
    )
      attachment.clientRequestId = crypto.randomUUID();
    attachment.status = 'UPLOADING';
    const progress = (upload: HostedConversationUpload): void => {
      attachment.receivedBytes = upload.receivedBytes;
      attachment.name = upload.name;
      if (upload.file !== undefined) attachment.fileId = upload.file.id;
    };
    try {
      const result = await workspace.uploadFile(
        attachment.file,
        attachment.clientRequestId,
        progress,
        attachment.controller.signal
      );
      progress(result);
      attachment.status = 'COMPLETED';
      delete attachment.error;
    } catch (error) {
      attachment.status = 'FAILED';
      attachment.error =
        errorCode(error) ??
        (error instanceof Error ? error.message : 'HOSTED_CONVERSATION_UPLOAD_FAILED');
      throw error;
    }
  }

  async function retryAttachment(id: string): Promise<void> {
    if (submitting.value || disposed) return;
    const attachment = attachments.value.find((candidate) => candidate.id === id);
    if (attachment?.status !== 'FAILED') return;
    const submission = options.submission;
    if (target.value === undefined || submission === undefined) return;
    const expectedGeneration = generation;
    submitting.value = true;
    try {
      requireActive(expectedGeneration);
      if (!sameTarget()) await submission.select(target.value);
      requireActive(expectedGeneration);
      await uploadAttachment(attachment);
    } finally {
      submitting.value = false;
      if (disposed) releaseAttachments();
    }
  }

  async function submit(): Promise<boolean> {
    if (
      submitting.value ||
      disposed ||
      (prompt.value.trim() === '' && attachments.value.length === 0)
    )
      return false;
    const submission = options.submission;
    if (submission === undefined) throw new Error('HOSTED_CONVERSATION_REQUIRED');
    const expectedGeneration = generation;
    requireActive(expectedGeneration);
    submitting.value = true;
    let submittedIntent: typeof messageIntent;
    try {
      if (target.value === undefined) {
        target.value = await create();
        submission.workspace.rememberConversation(target.value.conversation);
      }
      requireActive(expectedGeneration);
      if (!sameTarget()) await submission.select(target.value);
      requireActive(expectedGeneration);
      requireReady();
      for (const attachment of attachments.value) {
        if (attachment.status !== 'COMPLETED') {
          requireActive(expectedGeneration);
          await uploadAttachment(attachment);
        }
      }
      requireActive(expectedGeneration);
      requireReady();
      const current = submission.workspace.snapshot.value!;
      if (current.models.length === 0) throw new Error('HOSTED_CONVERSATION_MODEL_REQUIRED');
      const input = {
        prompt: prompt.value,
        attachmentIds: attachments.value.flatMap((attachment) =>
          attachment.fileId === undefined ? [] : [attachment.fileId]
        ),
        modelId: current.conversation.modelId
      };
      const fingerprint = JSON.stringify(input);
      if (messageIntent?.fingerprint !== fingerprint)
        messageIntent = { fingerprint, clientMessageId: crypto.randomUUID() };
      submittedIntent = messageIntent;
      await submission.workspace.sendMessage({
        ...input,
        clientMessageId: submittedIntent.clientMessageId
      });
      prompt.value = '';
      releaseAttachments();
      messageIntent = undefined;
      target.value = undefined;
      return active && expectedGeneration === generation;
    } catch (error) {
      if (
        submittedIntent !== undefined &&
        messageIntent === submittedIntent &&
        errorCode(error) !== undefined
      )
        messageIntent = undefined;
      throw error;
    } finally {
      submitting.value = false;
      if (disposed) releaseAttachments();
    }
  }

  function suspend(): void {
    active = false;
    generation += 1;
  }
  function resume(): void {
    if (!disposed) active = true;
  }
  function dispose(): void {
    suspend();
    disposed = true;
    if (!submitting.value) releaseAttachments();
  }

  function resetCreationIntent(): void {
    creationClientRequestId = undefined;
    creationModelId = undefined;
    creationIntentRevision += 1;
  }

  async function loadTemplates(): Promise<void> {
    const sequence = ++templateLoadSequence;
    const creationRevision = creationIntentRevision;
    try {
      const nextTemplates = await listAvailableConversationTemplates(request);
      if (sequence !== templateLoadSequence) return;
      applyTemplates(nextTemplates, creationRevision);
    } catch (error) {
      if (sequence === templateLoadSequence) throw error;
    }
  }

  function setTemplates(nextTemplates: readonly ConversationTemplateSummary[]): void {
    applyTemplates(nextTemplates, creationIntentRevision);
  }

  function applyTemplates(
    nextTemplates: readonly ConversationTemplateSummary[],
    creationRevision: number
  ): void {
    templates.value = [...nextTemplates];
    const currentTemplateId = selectedTemplateId.value;
    selectedTemplateId.value =
      templateIdIn(nextTemplates, currentTemplateId) ??
      templateIdIn(nextTemplates, preferredTemplateId) ??
      (nextTemplates.length === 1 ? nextTemplates[0]?.id : undefined);
    if (selectedTemplateId.value !== currentTemplateId) resetModelOptions();
    if (
      selectedTemplateId.value !== currentTemplateId ||
      creationIntentRevision === creationRevision
    ) {
      resetCreationIntent();
    }
  }

  async function loadModelOptions(): Promise<void> {
    const templateId = selectedTemplateId.value;
    const template = templates.value.find((candidate) => candidate.id === templateId);
    if (templateId === undefined || template === undefined) {
      resetModelOptions();
      return;
    }
    const sequence = ++modelLoadSequence;
    modelOptionsLoaded.value = false;
    try {
      const result = hostedConversationModelOptionsSchema.safeParse(
        await request<unknown>(
          `/api/nodes/${encodeURIComponent(template.nodeId)}/conversation-templates/${encodeURIComponent(templateId)}/model-options`
        )
      );
      if (!result.success) throw new Error('HOSTED_CONVERSATION_RESPONSE_INVALID');
      const response = result.data;
      if (sequence !== modelLoadSequence || selectedTemplateId.value !== templateId) return;
      const currentModelId = selectedModelId.value;
      const nextModelId = response.models.some((model) => model.id === currentModelId)
        ? currentModelId
        : (response.defaultModelId ?? undefined);
      if (currentModelId !== undefined && nextModelId !== currentModelId) resetCreationIntent();
      models.value = response.models;
      selectedModelId.value = nextModelId;
      modelOptionsLoaded.value = true;
    } catch (error) {
      if (sequence === modelLoadSequence && selectedTemplateId.value === templateId) throw error;
    }
  }

  function selectTemplate(templateId: string): void {
    if (!templates.value.some((template) => template.id === templateId))
      throw new Error('HOSTED_CONVERSATION_TEMPLATE_NOT_AVAILABLE');
    if (selectedTemplateId.value !== templateId) {
      resetCreationIntent();
      resetModelOptions();
    }
    selectedTemplateId.value = templateId;
    preferredTemplateId = templateId;
    persistPreferredTemplateId(storage, templateId);
  }

  function selectModel(modelId: string): void {
    if (!models.value.some((model) => model.id === modelId))
      throw new Error('HOSTED_CONVERSATION_MODEL_NOT_AVAILABLE');
    if (selectedModelId.value !== modelId) resetCreationIntent();
    selectedModelId.value = modelId;
  }

  async function create(clientRequestId?: string): Promise<HostedConversationSnapshot> {
    const templateId = selectedTemplateId.value;
    if (templateId === undefined) throw new Error('HOSTED_CONVERSATION_TEMPLATE_REQUIRED');
    const template = templates.value.find((candidate) => candidate.id === templateId);
    if (template === undefined || !template.available)
      throw new Error('HOSTED_CONVERSATION_TEMPLATE_NOT_AVAILABLE');
    if (creationClientRequestId === undefined) {
      creationClientRequestId = clientRequestId ?? crypto.randomUUID();
      creationModelId = selectedModelId.value;
    }
    const creationRevision = ++creationIntentRevision;
    const response = await request<unknown>(
      `/api/nodes/${encodeURIComponent(template.nodeId)}/hosted-conversations`,
      {
        method: 'POST',
        body: JSON.stringify({
          templateId,
          clientRequestId: creationClientRequestId,
          modelId: creationModelId
        })
      }
    );
    try {
      const snapshot = hostedConversationSnapshotSchema.parse(response);
      if (creationIntentRevision === creationRevision) resetCreationIntent();
      return snapshot;
    } catch {
      throw new Error('HOSTED_CONVERSATION_RESPONSE_INVALID');
    }
  }

  return {
    templates,
    selectedTemplateId,
    models,
    modelOptionsLoaded,
    selectedModelId,
    prompt,
    attachments,
    submitting,
    target,
    writable,
    loadTemplates,
    loadModelOptions,
    setTemplates,
    selectTemplate,
    selectModel,
    create,
    addFiles,
    removeAttachment,
    retryAttachment,
    submit,
    suspend,
    resume,
    dispose
  };
}

function templateIdIn(
  templates: readonly ConversationTemplateSummary[],
  templateId: string | undefined
): string | undefined {
  return templateId !== undefined && templates.some((template) => template.id === templateId)
    ? templateId
    : undefined;
}

function readPreferredTemplateId(storage: PreferenceStorage | undefined): string | undefined {
  try {
    const stored = storage?.getItem(TEMPLATE_PREFERENCE_STORAGE_KEY)?.trim();
    return stored === undefined || stored.length === 0 ? undefined : stored;
  } catch {
    return undefined;
  }
}

function persistPreferredTemplateId(
  storage: PreferenceStorage | undefined,
  templateId: string
): void {
  try {
    storage?.setItem(TEMPLATE_PREFERENCE_STORAGE_KEY, templateId);
  } catch {
    // Template preference is a local convenience only.
  }
}
