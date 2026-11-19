import type { SessionModelMessage as ModelMessage } from '../../session/model-request.js';

import { providerToolCallId, providerToolName } from '../../runtime/context/projection.js';
import type { DeferredMcpRegistry } from './tool-search.js';
export function discoveredMcpToolNames(messages: readonly ModelMessage[]): string[] {
  return [...mcpToolNames(messages, true)];
}

/** Native search receipts still carry definitions for normal and Compact protocol projection. */
export function pairedMcpToolNames(messages: readonly ModelMessage[]): ReadonlySet<string> {
  return mcpToolNames(messages, false);
}

function mcpToolNames(
  messages: readonly ModelMessage[],
  includeProgrammatic: boolean
): Set<string> {
  const calls = toolSearchCallIds(messages);
  const names = new Set<string>();
  for (const message of messages) {
    if (includeProgrammatic) for (const name of message.mcpDiscovery?.names ?? []) names.add(name);
    for (const tool of calls.has(message.callId ?? '') ? (message.toolSearchTools ?? []) : [])
      // Paired discovery receipts provide candidates; the current captured MCP catalog is authority.
      names.add(tool.name);
  }
  return names;
}

export function rebindMcpToolSearchOutputs(
  messages: readonly ModelMessage[],
  registry: DeferredMcpRegistry
): void {
  const calls = toolSearchCallIds(messages);
  for (const message of messages) {
    if (!message.toolSearchTools) continue;
    if (!calls.has(message.callId ?? '')) {
      delete message.toolSearchTools;
      continue;
    }
    const definitions = registry.restoredDefinitions(
      message.toolSearchTools.map((tool) => tool.name)
    );
    message.toolSearchTools = definitions;
  }
}

function toolSearchCallIds(messages: readonly ModelMessage[]): Set<string> {
  return new Set(
    messages
      .filter(
        (message) =>
          (message.role === 'tool_call' &&
            message.name === 'tool_search' &&
            typeof message.callId === 'string') ||
          (message.role === 'provider' &&
            providerToolName(message) === 'tool_search' &&
            providerToolCallId(message) !== undefined)
      )
      .map((message) =>
        message.role === 'provider' ? providerToolCallId(message)! : message.callId!
      )
  );
}
