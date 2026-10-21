import type { CurrentUserSession } from './session.js';
import type { HostedNodeControl } from './hosted-contracts.js';
export function requestHostedConversationNode(
  nodeControl: Pick<HostedNodeControl, 'requestHostedConversationNode'>,
  admin: CurrentUserSession,
  nodeId: string,
  operation: string,
  data: unknown,
  timeoutMs?: number
): Promise<unknown> {
  return nodeControl.requestHostedConversationNode(
    nodeId,
    operation,
    data,
    {
      userId: admin.userId,
      sessionHash: admin.sessionHash
    },
    timeoutMs
  );
}
