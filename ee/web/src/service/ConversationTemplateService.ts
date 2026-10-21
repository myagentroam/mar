import { resourceGrantSchema } from '@myagentroam/protocol';
import { createConversationTemplateService as createCore } from '@myagentroam/web-core/conversation-template-management';
import type { ConversationTemplateService as CoreService } from '@myagentroam/web-core/conversation-template-management';
export * from '@myagentroam/web-core/conversation-template-management';
type Request = <T>(path: string, init?: RequestInit) => Promise<T>;
export type ConversationTemplateGrant = ReturnType<typeof resourceGrantSchema.parse>;
export interface ConversationTemplateGrantTarget {
  readonly targetType: 'ORGANIZATION';
  readonly targetOrganizationId: number;
}
export interface ConversationTemplateService extends CoreService {
  listGrants(templateId: string): Promise<readonly ConversationTemplateGrant[]>;
  createGrant(templateId: string, target: ConversationTemplateGrantTarget): Promise<string>;
  removeGrant(grantId: string): Promise<void>;
}
export function createConversationTemplateService(request: Request): ConversationTemplateService {
  async function listGrants(templateId: string): Promise<readonly ConversationTemplateGrant[]> {
    const query = new URLSearchParams({
      resourceType: 'TEMPLATE',
      templateId: identifier(templateId)
    });
    const body = exactRecord(await request<unknown>(`/api/resource-grants?${query}`), ['grants']);
    return array(body['grants']).map((grant) => parseResponse(resourceGrantSchema, grant));
  }

  async function createGrant(
    templateId: string,
    target: ConversationTemplateGrantTarget
  ): Promise<string> {
    const body = exactRecord(
      await request<unknown>('/api/resource-grants', {
        method: 'POST',
        body: JSON.stringify({
          resourceType: 'TEMPLATE',
          templateId: identifier(templateId),
          targetType: target.targetType,
          targetOrganizationId: target.targetOrganizationId
        })
      }),
      ['id']
    );
    return identifier(body['id']);
  }

  return {
    ...createCore(request),
    listGrants,
    createGrant,
    removeGrant: async (grantId) => {
      await request(`/api/resource-grants/${segment(grantId)}`, { method: 'DELETE' });
    }
  };
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
