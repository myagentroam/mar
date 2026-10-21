import {
  conversationHostingCleanupExecuteInputSchema,
  conversationHostingCleanupPreviewInputSchema,
  conversationHostingCleanupPreviewSchema,
  conversationHostingCleanupResultSchema,
  conversationHostingStorageCapacitySchema,
  type ConversationHostingCleanupPreview,
  type ConversationHostingCleanupResult,
  type ConversationHostingCapability,
  type ConversationHostingStorageCapacity
} from '@myagentroam/protocol';

type Request = <T>(path: string, init?: RequestInit) => Promise<T>;

export interface ConversationHostingMaintenanceService {
  storage(nodeId: string): Promise<ConversationHostingStorageCapacity>;
  preview(nodeId: string, inactiveDays: number): Promise<ConversationHostingCleanupPreview>;
  execute(nodeId: string, inactiveDays: number): Promise<ConversationHostingCleanupResult>;
}

export interface ConversationHostingMaintenanceAvailability {
  readonly available: boolean;
  readonly reasonCode?: string;
}

export interface ConversationHostingMaintenanceContext {
  readonly nodeId: string;
  readonly inactiveDays?: number;
  readonly sequence: number;
}

export function sameConversationHostingMaintenanceContext(
  expected: ConversationHostingMaintenanceContext,
  current: ConversationHostingMaintenanceContext
): boolean {
  return (
    expected.nodeId === current.nodeId &&
    expected.inactiveDays === current.inactiveDays &&
    expected.sequence === current.sequence
  );
}

export function conversationHostingMaintenanceAvailability(
  connected: boolean | undefined,
  disabled: boolean | undefined,
  capability: ConversationHostingCapability | undefined
): ConversationHostingMaintenanceAvailability {
  if (connected !== true || disabled === true)
    return {
      available: false,
      reasonCode: 'CONVERSATION_HOSTING_MAINTENANCE_NODE_OFFLINE'
    };
  if (capability?.state !== 'AVAILABLE')
    return {
      available: false,
      reasonCode: capability?.reasonCode ?? 'CONVERSATION_HOSTING_MAINTENANCE_UNAVAILABLE'
    };
  return { available: true };
}

export function createConversationHostingMaintenanceService(
  request: Request
): ConversationHostingMaintenanceService {
  async function storage(nodeId: string): Promise<ConversationHostingStorageCapacity> {
    const response = await request<unknown>(maintenancePath(nodeId, 'storage'));
    return parseResponse(response, 'storage', conversationHostingStorageCapacitySchema);
  }

  async function preview(
    nodeId: string,
    inactiveDays: number
  ): Promise<ConversationHostingCleanupPreview> {
    const input = conversationHostingCleanupPreviewInputSchema.parse({ inactiveDays });
    const response = await request<unknown>(maintenancePath(nodeId, 'cleanup/preview'), {
      method: 'POST',
      body: JSON.stringify(input)
    });
    return parseResponse(response, 'preview', conversationHostingCleanupPreviewSchema);
  }

  async function execute(
    nodeId: string,
    inactiveDays: number
  ): Promise<ConversationHostingCleanupResult> {
    const input = conversationHostingCleanupExecuteInputSchema.parse({ inactiveDays });
    const response = await request<unknown>(maintenancePath(nodeId, 'cleanup'), {
      method: 'POST',
      body: JSON.stringify(input)
    });
    return parseResponse(response, 'result', conversationHostingCleanupResultSchema);
  }

  return { storage, preview, execute };
}

function maintenancePath(nodeId: string, suffix: string): string {
  return `/api/management/nodes/${encodeURIComponent(nodeId)}/conversation-hosting/${suffix}`;
}

function parseResponse<T>(
  response: unknown,
  key: 'storage' | 'preview' | 'result',
  schema: { parse(value: unknown): T }
): T {
  try {
    if (response === null || typeof response !== 'object' || Array.isArray(response))
      throw new Error('invalid wrapper');
    return schema.parse((response as Record<string, unknown>)[key]);
  } catch {
    throw new Error('CONVERSATION_HOSTING_MAINTENANCE_RESPONSE_INVALID');
  }
}
