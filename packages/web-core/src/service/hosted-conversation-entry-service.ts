import {
  hostedConversationSnapshotSchema,
  conversationTemplateSummarySchema,
  type ConversationTemplateSummary,
  type HostedConversationSnapshot
} from '@myagentroam/protocol';
import { ref, type Ref } from 'vue';

type Request = <T>(path: string, init?: RequestInit) => Promise<T>;
type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>;

const TEMPLATE_PREFERENCE_STORAGE_KEY = 'mar.hosted-conversations.last-template-id.v1';

export interface HostedConversationEntryService {
  readonly templates: Ref<readonly ConversationTemplateSummary[]>;
  readonly selectedTemplateId: Ref<string | undefined>;
  loadTemplates(): Promise<void>;
  setTemplates(templates: readonly ConversationTemplateSummary[]): void;
  selectTemplate(templateId: string): void;
  create(clientRequestId?: string): Promise<HostedConversationSnapshot>;
}

export function createHostedConversationEntryService(
  request: Request,
  options: { readonly storage?: PreferenceStorage } = {}
): HostedConversationEntryService {
  const templates = ref<readonly ConversationTemplateSummary[]>([]);
  const selectedTemplateId = ref<string>();
  const storage =
    options.storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage);
  let preferredTemplateId = readPreferredTemplateId(storage);
  let creationClientRequestId: string | undefined;
  let templateLoadSequence = 0;

  function resetCreationIntent(): void {
    creationClientRequestId = undefined;
  }

  async function loadTemplates(): Promise<void> {
    const sequence = ++templateLoadSequence;
    try {
      const nextTemplates = await listAvailableConversationTemplates(request);
      if (sequence !== templateLoadSequence) return;
      setTemplates(nextTemplates);
    } catch (error) {
      if (sequence === templateLoadSequence) throw error;
    }
  }

  function setTemplates(nextTemplates: readonly ConversationTemplateSummary[]): void {
    templates.value = [...nextTemplates];
    const currentTemplateId = selectedTemplateId.value;
    selectedTemplateId.value =
      templateIdIn(nextTemplates, currentTemplateId) ??
      templateIdIn(nextTemplates, preferredTemplateId) ??
      (nextTemplates.length === 1 ? nextTemplates[0]?.id : undefined);
    resetCreationIntent();
  }

  function selectTemplate(templateId: string): void {
    if (!templates.value.some((template) => template.id === templateId))
      throw new Error('HOSTED_CONVERSATION_TEMPLATE_NOT_AVAILABLE');
    if (selectedTemplateId.value !== templateId) resetCreationIntent();
    selectedTemplateId.value = templateId;
    preferredTemplateId = templateId;
    persistPreferredTemplateId(storage, templateId);
  }

  async function create(clientRequestId?: string): Promise<HostedConversationSnapshot> {
    const templateId = selectedTemplateId.value;
    if (templateId === undefined) throw new Error('HOSTED_CONVERSATION_TEMPLATE_REQUIRED');
    const template = templates.value.find((candidate) => candidate.id === templateId);
    if (template === undefined || !template.available)
      throw new Error('HOSTED_CONVERSATION_TEMPLATE_NOT_AVAILABLE');
    creationClientRequestId ??= clientRequestId ?? crypto.randomUUID();
    const response = await request<unknown>(
      `/api/nodes/${encodeURIComponent(template.nodeId)}/hosted-conversations`,
      {
        method: 'POST',
        body: JSON.stringify({ templateId, clientRequestId: creationClientRequestId })
      }
    );
    try {
      const snapshot = hostedConversationSnapshotSchema.parse(response);
      resetCreationIntent();
      return snapshot;
    } catch {
      throw new Error('HOSTED_CONVERSATION_RESPONSE_INVALID');
    }
  }

  return {
    templates,
    selectedTemplateId,
    loadTemplates,
    setTemplates,
    selectTemplate,
    create
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

/** Reads only the authorized published catalog; management data is never accepted. */
export async function listAvailableConversationTemplates(
  request: Request
): Promise<readonly ConversationTemplateSummary[]> {
  const value = await request<unknown>('/api/conversation-templates');
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('CONVERSATION_TEMPLATE_RESPONSE_INVALID');
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => key !== 'templates') || !Array.isArray(body['templates']))
    throw new Error('CONVERSATION_TEMPLATE_RESPONSE_INVALID');
  return body['templates'].map((template: unknown) => {
    const result = conversationTemplateSummarySchema.safeParse(template);
    if (!result.success) throw new Error('CONVERSATION_TEMPLATE_RESPONSE_INVALID');
    return result.data;
  });
}
