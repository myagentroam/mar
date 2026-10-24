import type { ComputerUseCapability, ConversationHostingCapability } from '@myagentroam/protocol';

export interface ResourceRow<Owner = unknown> {
  key: string;
  resourceType: 'NODE' | 'WORKSPACE';
  nodeId: string;
  nodeLabel?: string;
  workspaceId: string | null;
  label: string;
  ownership: Owner;
  ownerUsername?: string;
  manageable?: boolean;
  connected?: boolean;
  disabled?: boolean;
  lastHeartbeatAt?: number | null;
  registeredAddress?: string;
  platform?: string;
  architecture?: string;
  nodeAppVersion?: string;
  nodeVersion?: string;
  metadata?: {
    upgrade?: {
      state?: 'WAITING_FOR_RUNS' | 'READY_TO_RESTART' | 'FAILED';
      activeRunCount?: number;
      errorCode?: string;
    };
    runtimeCommands?: readonly unknown[];
  };
  upgradeAvailability?: {
    state:
      | 'AVAILABLE'
      | 'CURRENT'
      | 'SERVER_OLDER'
      | 'VERSION_INVALID'
      | 'NODE_UNSUPPORTED'
      | 'PACKAGE_UNAVAILABLE';
    targetVersion: string;
  };
  capabilities?: {
    codex?: { available?: boolean; version?: string };
    claudeCode?: { available?: boolean; version?: string };
    openCode?: { available?: boolean; version?: string };
    conversationHosting?: ConversationHostingCapability;
    computerUse?: ComputerUseCapability;
  };
  path?: string;
}
