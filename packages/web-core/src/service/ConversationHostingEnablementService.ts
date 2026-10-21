import {
  conversationHostingDisableInputSchema,
  conversationHostingEnableInputSchema,
  conversationHostingEnableResultSchema,
  type ConversationHostingCapability
} from '@myagentroam/protocol';

type Request = <T>(path: string, init?: RequestInit) => Promise<T>;

export interface ConversationHostingEnablementAvailability {
  readonly enabled: boolean;
  readonly canEnable: boolean;
  readonly reasonCode?: string;
}

export interface ConversationHostingEnablementInput {
  readonly platform: string | undefined;
  readonly connected: boolean | undefined;
  readonly disabled: boolean | undefined;
  readonly capability: ConversationHostingCapability | undefined;
  readonly writable: boolean;
}

export interface ConversationHostingDisablementAvailability {
  readonly enabled: boolean;
  readonly canDisable: boolean;
  readonly reasonCode?: string;
}

export function conversationHostingEnablementAvailability(
  input: ConversationHostingEnablementInput
): ConversationHostingEnablementAvailability {
  if (input.capability !== undefined && input.capability.state !== 'DISABLED')
    return {
      enabled: true,
      canEnable: false,
      ...(input.capability.reasonCode === undefined
        ? {}
        : { reasonCode: input.capability.reasonCode })
    };
  if (input.platform !== 'linux')
    return {
      enabled: false,
      canEnable: false,
      reasonCode: 'CONVERSATION_HOSTING_ENABLE_PLATFORM_UNSUPPORTED'
    };
  if (input.connected !== true || input.disabled === true)
    return {
      enabled: false,
      canEnable: false,
      reasonCode: 'CONVERSATION_HOSTING_ENABLE_NODE_OFFLINE'
    };
  if (!input.writable)
    return {
      enabled: false,
      canEnable: false,
      reasonCode: 'CONVERSATION_HOSTING_ENABLE_READ_ONLY'
    };
  if (input.capability?.state !== 'DISABLED')
    return {
      enabled: false,
      canEnable: false,
      reasonCode: 'CONVERSATION_HOSTING_ENABLE_STATE_UNKNOWN'
    };
  return { enabled: false, canEnable: true };
}

export function conversationHostingDisablementAvailability(
  input: ConversationHostingEnablementInput
): ConversationHostingDisablementAvailability {
  if (input.capability === undefined || input.capability.state === 'DISABLED')
    return { enabled: false, canDisable: false };
  if (input.platform !== 'linux')
    return {
      enabled: true,
      canDisable: false,
      reasonCode: 'CONVERSATION_HOSTING_DISABLE_PLATFORM_UNSUPPORTED'
    };
  if (input.connected !== true || input.disabled === true)
    return {
      enabled: true,
      canDisable: false,
      reasonCode: 'CONVERSATION_HOSTING_DISABLE_NODE_OFFLINE'
    };
  if (!input.writable)
    return {
      enabled: true,
      canDisable: false,
      reasonCode: 'CONVERSATION_HOSTING_DISABLE_READ_ONLY'
    };
  return { enabled: true, canDisable: true };
}

export function createConversationHostingEnablementService(request: Request): {
  enable(nodeId: string): Promise<ConversationHostingCapability>;
  disable(nodeId: string): Promise<ConversationHostingCapability>;
} {
  return {
    async enable(nodeId) {
      const input = conversationHostingEnableInputSchema.parse({ enabled: true });
      const response = await request<unknown>(
        `/api/management/nodes/${encodeURIComponent(nodeId)}/conversation-hosting/enable`,
        {
          method: 'POST',
          body: JSON.stringify(input)
        }
      );
      try {
        return conversationHostingEnableResultSchema.parse(response).capability;
      } catch {
        throw new Error('CONVERSATION_HOSTING_ENABLE_RESPONSE_INVALID');
      }
    },
    async disable(nodeId) {
      const input = conversationHostingDisableInputSchema.parse({});
      const response = await request<unknown>(
        `/api/management/nodes/${encodeURIComponent(nodeId)}/conversation-hosting/disable`,
        {
          method: 'POST',
          body: JSON.stringify(input)
        }
      );
      try {
        return conversationHostingEnableResultSchema.parse(response).capability;
      } catch {
        throw new Error('CONVERSATION_HOSTING_DISABLE_RESPONSE_INVALID');
      }
    }
  };
}
