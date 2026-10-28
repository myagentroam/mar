import {
  conversationTemplateSummarySchema,
  type ConversationTemplateSummary
} from '@myagentroam/protocol';

/** Reads only the authorized published catalog; management data is never accepted. */
export async function listAvailableConversationTemplates(
  request: <T>(path: string, init?: RequestInit) => Promise<T>
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
