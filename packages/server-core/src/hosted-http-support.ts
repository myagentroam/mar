import type { UserNodeAuthorization } from './node-access-contracts.js';
import type { HostedNodeControl } from './hosted-contracts.js';
export function requestHostedConversationNode(
  nodeControl: Pick<HostedNodeControl, 'requestHostedConversationNode'>,
  actor: UserNodeAuthorization,
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
      userId: actor.userId,
      sessionHash: actor.sessionHash
    },
    timeoutMs
  );
}
