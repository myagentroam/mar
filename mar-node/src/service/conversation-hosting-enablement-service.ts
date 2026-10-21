import {
  conversationHostingDisableInputSchema,
  conversationHostingEnableInputSchema,
  conversationHostingEnableResultSchema,
  type ConversationHostingCapability,
  type ConversationHostingEnableResult
} from '@myagentroam/protocol';
import { saveNodeConfig, type NodeConfig } from '../config.js';
import type { NodeOperationHandler } from '../connector/node-operation-router.js';
import { nodeOperationData } from '../util/node-operation-data.js';

interface ConversationHostingEnablementServiceOptions {
  readonly config: () => NodeConfig | undefined;
  readonly setConfig: (config: NodeConfig) => void;
  readonly configPath: string | undefined;
  readonly platform: () => string;
  readonly capability: () => ConversationHostingCapability | undefined;
  readonly initialize: () => Promise<void>;
  readonly prepareForDisable: () => (() => void) | undefined;
  readonly publishCapabilities: () => void;
}

/** Owns management operations that persist and hot-apply hosting configuration. */
export class ConversationHostingEnablementService {
  constructor(private readonly options: ConversationHostingEnablementServiceOptions) {}

  operations(): Readonly<Record<string, NodeOperationHandler>> {
    return {
      'conversation.hosting.enable': (data) => this.enable(data),
      'conversation.hosting.disable': (data) => this.disable(data)
    };
  }

  private async disable(data: unknown): Promise<ConversationHostingEnableResult> {
    const parsed = conversationHostingDisableInputSchema.safeParse(nodeOperationData(data));
    if (!parsed.success) throw new Error('CONVERSATION_HOSTING_DISABLE_INPUT_INVALID');
    if (this.options.platform() !== 'linux')
      throw new Error('CONVERSATION_HOSTING_DISABLE_PLATFORM_UNSUPPORTED');
    const current = this.options.config();
    if (current === undefined) throw new Error('NODE_CONFIG_UNAVAILABLE');
    if (current.conversationHosting?.enabled !== true)
      return conversationHostingEnableResultSchema.parse({
        capability: this.requireCapability()
      });
    const resume = this.options.prepareForDisable();
    if (resume === undefined) throw new Error('CONVERSATION_HOSTING_DISABLE_ACTIVE_RUNS');

    const next: NodeConfig = {
      ...current,
      conversationHosting: {
        ...current.conversationHosting,
        enabled: false
      }
    };
    try {
      await saveNodeConfig(next, this.options.configPath);
      this.options.setConfig(next);
      await this.options.initialize();
      const result = conversationHostingEnableResultSchema.parse({
        capability: this.requireCapability()
      });
      this.options.publishCapabilities();
      return result;
    } catch (error) {
      resume();
      throw error;
    }
  }

  private async enable(data: unknown): Promise<ConversationHostingEnableResult> {
    const parsed = conversationHostingEnableInputSchema.safeParse(nodeOperationData(data));
    if (!parsed.success) throw new Error('CONVERSATION_HOSTING_ENABLE_INPUT_INVALID');
    if (this.options.platform() !== 'linux')
      throw new Error('CONVERSATION_HOSTING_PLATFORM_UNSUPPORTED');
    const current = this.options.config();
    if (current === undefined) throw new Error('NODE_CONFIG_UNAVAILABLE');
    if (current.conversationHosting?.enabled === true)
      return conversationHostingEnableResultSchema.parse({
        capability: this.requireCapability()
      });

    const next: NodeConfig = {
      ...current,
      conversationHosting: {
        ...current.conversationHosting,
        enabled: true,
        storeDirectory: current.conversationHosting?.storeDirectory ?? 'hosted-conversations',
        inactiveRetentionDays: current.conversationHosting?.inactiveRetentionDays ?? 60
      }
    };
    await saveNodeConfig(next, this.options.configPath);
    this.options.setConfig(next);
    await this.options.initialize();
    const result = conversationHostingEnableResultSchema.parse({
      capability: this.requireCapability()
    });
    this.options.publishCapabilities();
    return result;
  }

  private requireCapability(): ConversationHostingCapability {
    const capability = this.options.capability();
    if (capability === undefined) throw new Error('CONVERSATION_HOSTING_UNAVAILABLE');
    return capability;
  }
}
