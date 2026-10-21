import {
  hostedConversationActivityMessageSchema,
  hostedConversationActivityProjectionSchema
} from '@myagentroam/protocol';
import type { ConversationTemplateService } from './conversation-template-service.js';

export class HostedConversationActivityService {
  constructor(
    private readonly templates: Pick<ConversationTemplateService, 'assertCanUse'>,
    private readonly push: (userId: number, message: object) => void
  ) {}

  async consume(nodeId: string, value: unknown): Promise<boolean> {
    const parsed = hostedConversationActivityProjectionSchema.safeParse(value);
    if (!parsed.success) return false;
    const projection = parsed.data;
    try {
      const template = await this.templates.assertCanUse(projection.userId, projection.templateId);
      if (template.nodeId !== nodeId) return false;
    } catch {
      return false;
    }
    this.push(
      projection.userId,
      hostedConversationActivityMessageSchema.parse({
        type: 'hosted-conversation.activity',
        nodeId,
        conversationId: projection.conversationId,
        activity: projection.activity
      })
    );
    return true;
  }
}
