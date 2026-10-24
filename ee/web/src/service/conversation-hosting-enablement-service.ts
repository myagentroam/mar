import {
  conversationHostingEnablementAvailability as coreAvailability,
  type ConversationHostingEnablementInput as CoreInput
} from '@myagentroam/web-core/hosting-enablement';
export * from '@myagentroam/web-core/hosting-enablement';
export interface ConversationHostingEnablementInput extends CoreInput {
  readonly ownerType: 'PERSONAL' | 'ORGANIZATION' | undefined;
}
export function conversationHostingEnablementAvailability(
  input: ConversationHostingEnablementInput
) {
  if (input.capability !== undefined && input.capability.state !== 'DISABLED')
    return coreAvailability(input);
  if (input.ownerType !== 'ORGANIZATION')
    return {
      enabled: false,
      canEnable: false,
      reasonCode: 'CONVERSATION_HOSTING_ENABLE_ORGANIZATION_NODE_REQUIRED'
    };
  return coreAvailability(input);
}
