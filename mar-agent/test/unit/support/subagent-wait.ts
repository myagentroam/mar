import type { ModelEvent, ModelRequest } from '../../../src/agent-core/model/contracts.js';

/** Scripted parents explicitly join a newly started child before consuming its result. */
export function waitForNewChild(request: ModelRequest): ModelEvent | undefined {
  const receipt = request.messages.findLast((message) => message.role === 'tool');
  if (receipt?.name !== 'agent_start' || receipt.isError) return;
  const { agentId } = JSON.parse(receipt.content) as { agentId: string };
  return {
    type: 'client_tool.call',
    callId: `${receipt.callId}-wait`,
    name: 'agent_wait',
    arguments: { agentId, waitMs: 300_000 }
  };
}
