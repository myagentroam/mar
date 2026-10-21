import {
  WORKBENCH_PROTOCOL_VERSION,
  type ServerWorkbenchCapabilities
} from '@myagentroam/protocol';
export function serverWorkbenchCapabilities(serverVersion: string): ServerWorkbenchCapabilities {
  return {
    workbenchProtocolVersion: WORKBENCH_PROTOCOL_VERSION,
    serverVersion,
    conversationItemVersions: [1],
    supportsSessionDetailStream: false,
    supportsTerminalBrowserRelay: true,
    supportsTerminalNodeDataChannel: true,
    maxSseSubscriptionsPerUser: 8,
    maxTerminalBrowserConnectionsPerUser: 10
  };
}
