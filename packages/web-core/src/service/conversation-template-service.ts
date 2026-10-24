import { parseManagementPage } from './management-page-service.js';
import type { ManagementPage } from '@myagentroam/protocol';
import { listAvailableConversationTemplates } from '@myagentroam/web-core/hosted-conversation-entry';
import {
  conversationTemplateDraftSchema,
  conversationTemplateModelReferenceSchema,
  conversationTemplatePublishJobSchema,
  conversationTemplateSourceInspectionSchema,
  conversationTemplateSummarySchema,
  conversationTemplateVersionSchema,
  mcpTargetInspectionSchema,
  type ConversationTemplateDraft,
  type ConversationTemplateModelReference,
  type ConversationTemplatePublishJob,
  type ConversationTemplateSourceInspection,
  type ConversationTemplateSummary,
  type ConversationTemplateVersion,
  type McpTargetInspection
} from '@myagentroam/protocol';

type Request = <T>(path: string, init?: RequestInit) => Promise<T>;

export interface AdminConversationTemplateSummary extends ConversationTemplateSummary {
  readonly draftRevision: number;
  readonly publishedVersion: number | null;
}

export interface ConversationTemplateDetail {
  readonly template: AdminConversationTemplateSummary;
  readonly draft: ConversationTemplateDraft;
  readonly versions: readonly ConversationTemplateVersion[];
}

export type ConversationTemplateMcpOption = McpTargetInspection['installations'][number];
export type ConversationTemplateModelOption = ConversationTemplateModelReference;

export interface ConversationTemplateDraftInput {
  readonly nodeId?: unknown;
  readonly workspaceId?: unknown;
  readonly name?: unknown;
  readonly description?: unknown;
  readonly icon?: unknown;
  readonly allowedModels?: unknown;
  readonly defaultModelId?: unknown;
  readonly mcpIds?: unknown;
  readonly networkMode?: unknown;
  readonly quotas?: unknown;
  readonly draftRevision?: unknown;
  readonly [key: string]: unknown;
}

export interface ConversationTemplateRequestContext {
  readonly sequence: number;
  readonly resourceId?: string;
}

export interface ConversationTemplateService {
  listAvailable(): Promise<readonly ConversationTemplateSummary[]>;
  listAdmin(): Promise<readonly AdminConversationTemplateSummary[]>;
  listAdminPage(
    page: number,
    sortBy?: string,
    sortOrder?: string
  ): Promise<ManagementPage<AdminConversationTemplateSummary>>;
  listModelOptions(nodeId: string): Promise<readonly ConversationTemplateModelOption[]>;
  listMcpOptions(
    nodeId: string,
    workspaceId: string
  ): Promise<readonly ConversationTemplateMcpOption[]>;
  detail(templateId: string): Promise<ConversationTemplateDetail>;
  create(input: ConversationTemplateDraftInput): Promise<{
    readonly template: ConversationTemplateSummary;
    readonly draft: ConversationTemplateDraft;
  }>;
  update(
    templateId: string,
    input: ConversationTemplateDraftInput
  ): Promise<{
    readonly template: ConversationTemplateSummary;
    readonly draft: ConversationTemplateDraft;
  }>;
  test(
    templateId: string,
    input: ConversationTemplateDraftInput
  ): Promise<ConversationTemplateSourceInspection>;
  publish(
    templateId: string,
    draftRevision: number,
    requestId: string
  ): Promise<ConversationTemplatePublishJob>;
  publishStatus(templateId: string, jobId: string): Promise<ConversationTemplatePublishJob>;
  disable(templateId: string): Promise<void>;
  archive(templateId: string): Promise<void>;
  remove(templateId: string): Promise<void>;
}

const ERROR_MESSAGE_KEYS: Readonly<Record<string, string>> = {
  CONVERSATION_TEMPLATE_INPUT_INVALID: 'conversationTemplates.errorInputInvalid',
  CONVERSATION_TEMPLATE_NAME_CONFLICT: 'conversationTemplates.errorNameConflict',
  CONVERSATION_TEMPLATE_NOT_FOUND: 'conversationTemplates.errorNotFound',
  CONVERSATION_TEMPLATE_NOT_AUTHORIZED: 'conversationTemplates.errorNotAuthorized',
  CONVERSATION_TEMPLATE_NOT_PUBLISHED: 'conversationTemplates.errorNotPublished',
  CONVERSATION_TEMPLATE_REVISION_CONFLICT: 'conversationTemplates.errorRevisionConflict',
  CONVERSATION_TEMPLATE_SOURCE_INVALID: 'conversationTemplates.errorSourceInvalid',
  CONVERSATION_TEMPLATE_SOURCE_EXCLUDED: 'conversationTemplates.errorSourceExcluded',
  CONVERSATION_TEMPLATE_SOURCE_LINK_INVALID: 'conversationTemplates.errorSourceLinkInvalid',
  CONVERSATION_TEMPLATE_SOURCE_MISSING: 'conversationTemplates.errorSourceMissing',
  CONVERSATION_TEMPLATE_SOURCE_TOO_LARGE: 'conversationTemplates.errorSourceTooLarge',
  CONVERSATION_TEMPLATE_SOURCE_TYPE_INVALID: 'conversationTemplates.errorSourceTypeInvalid',
  CONVERSATION_TEMPLATE_SOURCE_CHANGED: 'conversationTemplates.errorSourceChanged',
  CONVERSATION_TEMPLATE_SOURCE_IMMUTABLE: 'conversationTemplates.errorSourceImmutable',
  CONVERSATION_TEMPLATE_RESERVED_PATH: 'conversationTemplates.errorReservedPath',
  CONVERSATION_TEMPLATE_MODEL_INVALID: 'conversationTemplates.errorModelInvalid',
  CONVERSATION_TEMPLATE_MCP_INVALID: 'conversationTemplates.errorMcpInvalid',
  CONVERSATION_TEMPLATE_HOST_NODE_INVALID: 'conversationTemplates.errorHostNodeInvalid',
  CONVERSATION_TEMPLATE_GRANT_SCOPE_INVALID: 'conversationTemplates.errorGrantScopeInvalid',
  CONVERSATION_TEMPLATE_IN_USE: 'conversationTemplates.errorInUse',
  CONVERSATION_TEMPLATE_PUBLISH_BUSY: 'conversationTemplates.errorPublishBusy',
  CONVERSATION_TEMPLATE_PUBLISH_FAILED: 'conversationTemplates.errorPublishFailed',
  CONVERSATION_TEMPLATE_PUBLISH_INTERRUPTED: 'conversationTemplates.errorPublishInterrupted',
  CONVERSATION_TEMPLATE_PUBLISH_JOB_NOT_FOUND: 'conversationTemplates.errorPublishJobNotFound',
  CONVERSATION_TEMPLATE_PUBLISH_RESULT_INVALID: 'conversationTemplates.errorPublishResultInvalid',
  CONVERSATION_TEMPLATE_VERSION_CORRUPTED: 'conversationTemplates.errorVersionCorrupted',
  WORKSPACE_NOT_FOUND: 'conversationTemplates.errorWorkspaceNotFound',
  TEMPLATE_RESOURCE_ADMIN_REQUIRED: 'conversationTemplates.errorAdminRequired'
};

const DRAFT_INPUT_KEYS = [
  'nodeId',
  'workspaceId',
  'name',
  'description',
  'icon',
  'allowedModels',
  'defaultModelId',
  'mcpIds',
  'networkMode',
  'quotas'
] as const;
const MEBIBYTE = 1024 * 1024;

export function conversationTemplateErrorMessageKey(code: string): string | undefined {
  return ERROR_MESSAGE_KEYS[code];
}

export function conversationTemplateBytesToMiB(bytes: number): number {
  return bytes / MEBIBYTE;
}

export function conversationTemplateMiBToBytes(mebibytes: number): number {
  return Math.round(mebibytes * MEBIBYTE);
}

export function sameConversationTemplateRequestContext(
  current: ConversationTemplateRequestContext,
  expected: ConversationTemplateRequestContext
): boolean {
  return current.sequence === expected.sequence && current.resourceId === expected.resourceId;
}

export function reconcileConversationTemplateModelSelection(
  allowedModels: readonly string[],
  defaultModelId: string,
  options: readonly ConversationTemplateModelOption[]
): { readonly allowedModels: string[]; readonly defaultModelId: string } {
  const available = new Set(options.map((option) => option.modelId));
  const nextAllowedModels = allowedModels.filter((modelId) => available.has(modelId));
  return {
    allowedModels: nextAllowedModels,
    defaultModelId: nextAllowedModels.includes(defaultModelId)
      ? defaultModelId
      : (nextAllowedModels[0] ?? '')
  };
}

export function conversationTemplateModelReferences(
  allowedModels: readonly string[],
  options: readonly ConversationTemplateModelOption[]
): ConversationTemplateModelReference[] {
  const byId = new Map(options.map((option) => [option.modelId, option]));
  return allowedModels.flatMap((modelId) => {
    const option = byId.get(modelId);
    return option === undefined ? [] : [option];
  });
}

export function conversationTemplateModelSelectionIsAvailable(
  allowedModels: readonly string[],
  defaultModelId: string,
  options: readonly ConversationTemplateModelOption[]
): boolean {
  return (
    allowedModels.length > 0 &&
    allowedModels.includes(defaultModelId) &&
    conversationTemplateModelReferences(allowedModels, options).length === allowedModels.length
  );
}

export function createConversationTemplateService(request: Request): ConversationTemplateService {
  async function listAvailable(): Promise<readonly ConversationTemplateSummary[]> {
    return listAvailableConversationTemplates(request);
  }

  async function listAdmin(): Promise<readonly AdminConversationTemplateSummary[]> {
    const body = exactRecord(await request<unknown>('/api/admin/conversation-templates'), [
      'templates'
    ]);
    return array(body['templates']).map(parseAdminSummary);
  }

  async function listAdminPage(
    page: number,
    sortBy?: string,
    sortOrder?: string
  ): Promise<ManagementPage<AdminConversationTemplateSummary>> {
    const query = new URLSearchParams({ page: String(page), limit: '20' });
    if (sortBy && sortOrder) {
      query.set('sortBy', sortBy);
      query.set('sortOrder', sortOrder);
    }
    return parseManagementPage(
      await request<unknown>(`/api/admin/conversation-templates?${query}`),
      'templates',
      parseAdminSummary
    );
  }

  async function listModelOptions(
    nodeId: string
  ): Promise<readonly ConversationTemplateModelOption[]> {
    const query = new URLSearchParams({ nodeId: identifier(nodeId) });
    const body = exactRecord(
      await request<unknown>(`/api/admin/conversation-templates/model-options?${query}`),
      ['models']
    );
    const models = array(body['models']).map((model) =>
      parseResponse(conversationTemplateModelReferenceSchema, model)
    );
    if (new Set(models.map((model) => model.modelId)).size !== models.length) invalidResponse();
    return models;
  }

  async function listMcpOptions(
    nodeId: string,
    workspaceId: string
  ): Promise<readonly ConversationTemplateMcpOption[]> {
    const query = new URLSearchParams({ nodeId: identifier(nodeId) });
    const inspection = parseResponse(
      mcpTargetInspectionSchema,
      await request<unknown>(`/api/workspaces/${segment(workspaceId)}/mcps?${query}`)
    );
    return inspection.installations.filter(
      (installation) =>
        installation.enabled &&
        installation.status !== 'INVALID' &&
        installation.status !== 'UNAVAILABLE'
    );
  }

  async function detail(templateId: string): Promise<ConversationTemplateDetail> {
    const body = exactRecord(
      await request<unknown>(`/api/admin/conversation-templates/${segment(templateId)}`),
      ['template', 'draft', 'versions']
    );
    return {
      template: parseAdminSummary(body['template']),
      draft: parseResponse(conversationTemplateDraftSchema, body['draft']),
      versions: array(body['versions']).map((version) =>
        parseResponse(conversationTemplateVersionSchema, version)
      )
    };
  }

  async function create(input: ConversationTemplateDraftInput) {
    return parseDraftResult(
      await request<unknown>('/api/admin/conversation-templates', {
        method: 'POST',
        body: JSON.stringify(draftInput(input, false))
      })
    );
  }

  async function update(templateId: string, input: ConversationTemplateDraftInput) {
    return parseDraftResult(
      await request<unknown>(`/api/admin/conversation-templates/${segment(templateId)}`, {
        method: 'PUT',
        body: JSON.stringify(draftInput(input, true))
      })
    );
  }

  async function test(
    templateId: string,
    input: ConversationTemplateDraftInput
  ): Promise<ConversationTemplateSourceInspection> {
    const body = exactRecord(
      await request<unknown>(`/api/admin/conversation-templates/${segment(templateId)}/test`, {
        method: 'POST',
        body: JSON.stringify(draftInput(input, true))
      }),
      ['inspection']
    );
    return parseResponse(conversationTemplateSourceInspectionSchema, body['inspection']);
  }

  async function publish(
    templateId: string,
    draftRevision: number,
    requestId: string
  ): Promise<ConversationTemplatePublishJob> {
    const body = exactRecord(
      await request<unknown>(`/api/admin/conversation-templates/${segment(templateId)}/publish`, {
        method: 'POST',
        body: JSON.stringify({ templateId, draftRevision, requestId })
      }),
      ['job']
    );
    return parseResponse(conversationTemplatePublishJobSchema, body['job']);
  }

  async function publishStatus(
    templateId: string,
    jobId: string
  ): Promise<ConversationTemplatePublishJob> {
    const body = exactRecord(
      await request<unknown>(
        `/api/admin/conversation-templates/${segment(templateId)}/publish-jobs/${segment(jobId)}`
      ),
      ['job']
    );
    return parseResponse(conversationTemplatePublishJobSchema, body['job']);
  }

  async function mutateWithoutBody(
    templateId: string,
    action: 'disable' | 'archive'
  ): Promise<void> {
    await request(`/api/admin/conversation-templates/${segment(templateId)}/${action}`, {
      method: 'POST'
    });
  }

  return {
    listAvailable,
    listAdmin,
    listAdminPage,
    listModelOptions,
    listMcpOptions,
    detail,
    create,
    update,
    test,
    publish,
    publishStatus,
    disable: (templateId) => mutateWithoutBody(templateId, 'disable'),
    archive: (templateId) => mutateWithoutBody(templateId, 'archive'),
    remove: async (templateId) => {
      await request(`/api/admin/conversation-templates/${segment(templateId)}`, {
        method: 'DELETE'
      });
    }
  };
}

function parseAdminSummary(value: unknown): AdminConversationTemplateSummary {
  const body = exactRecord(value, [
    'id',
    'nodeId',
    'name',
    'description',
    'icon',
    'status',
    'currentVersionId',
    'available',
    'createdAt',
    'updatedAt',
    'draftRevision',
    'publishedVersion'
  ]);
  const { draftRevision, publishedVersion, ...summary } = body;
  if (!Number.isSafeInteger(draftRevision) || Number(draftRevision) < 1) invalidResponse();
  if (
    publishedVersion !== null &&
    (!Number.isSafeInteger(publishedVersion) || Number(publishedVersion) < 1)
  )
    invalidResponse();
  if ((summary['currentVersionId'] === null) !== (publishedVersion === null)) invalidResponse();
  return {
    ...parseResponse(conversationTemplateSummarySchema, summary),
    draftRevision: Number(draftRevision),
    publishedVersion: publishedVersion === null ? null : Number(publishedVersion)
  };
}

function parseDraftResult(value: unknown): {
  readonly template: ConversationTemplateSummary;
  readonly draft: ConversationTemplateDraft;
} {
  const body = exactRecord(value, ['template', 'draft']);
  return {
    template: parseResponse(conversationTemplateSummarySchema, body['template']),
    draft: parseResponse(conversationTemplateDraftSchema, body['draft'])
  };
}

function draftInput(input: ConversationTemplateDraftInput, updating: boolean): object {
  const output = Object.fromEntries(
    DRAFT_INPUT_KEYS.flatMap((key) => {
      const value = input[key];
      if (value === undefined) return [];
      if (key === 'name' && typeof value === 'string') return [[key, value.trim()]];
      return [[key, value]];
    })
  );
  return updating ? { ...output, draftRevision: input.draftRevision } : output;
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalidResponse();
  const body = value as Record<string, unknown>;
  const allowed = new Set(keys);
  if (Object.keys(body).some((key) => !allowed.has(key))) invalidResponse();
  return body;
}

function array(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) invalidResponse();
  return value;
}

function parseResponse<T>(schema: { parse(value: unknown): T }, value: unknown): T {
  try {
    return schema.parse(value);
  } catch {
    return invalidResponse();
  }
}

function segment(value: string): string {
  return encodeURIComponent(identifier(value));
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(value))
    invalidResponse();
  return value;
}

function invalidResponse(): never {
  throw new Error('CONVERSATION_TEMPLATE_RESPONSE_INVALID');
}
