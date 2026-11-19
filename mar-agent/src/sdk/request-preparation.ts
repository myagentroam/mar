import type { ClientToolDefinition } from '../tools/contracts.js';
import type { SessionModelMessage as ModelMessage } from '../session/model-request.js';
import type { SessionModelRequest as ModelRequest } from '../session/model-request.js';
import type { AgentModelConfiguration } from '../model/configuration.js';

import { projectModelRequestTools } from '../model/tool-declarations.js';
import { projectSmartCompactionMessage } from '../runtime/compaction/smart.js';
import { normalizeMessagesForModel } from '../runtime/context/normalize.js';
import {
  insertContextualWorldState,
  type ContextualWorldState
} from '../runtime/context/world-state.js';
import { projectCodeModeSearchResult, projectCodeModeTools } from '../tools/code-mode/index.js';
import { projectPermissionTool } from '../tools/permissions.js';
import { markupText } from '../prompts/markup.js';
import { providerToolCallId } from '../runtime/context/projection.js';

/** Assemble captured round values only. Admission, Hooks and publication belong to Session. */
export function prepareSessionModelRequest(
  candidate: ModelRequest,
  model: Pick<AgentModelConfiguration, 'protocol' | 'inputCapabilities'>,
  entries: ContextualWorldState['entries'],
  residentTools: readonly ClientToolDefinition[],
  autoPermission: boolean
): ModelRequest {
  const codeMode = candidate.tools.some((tool) => tool.name === 'code_exec');
  return {
    ...candidate,
    messages: projectSessionRequestMessages(
      candidate.messages,
      entries,
      model.inputCapabilities.includes('IMAGE'),
      codeMode,
      autoPermission,
      candidate.tools
    ),
    tools: projectSessionRequestTools(model, candidate.tools, residentTools, candidate.messages)
  };
}

/** Conversation and Compact keep identical Code Mode and native discovery tool prefixes. */
export function projectSessionRequestTools(
  model: Pick<AgentModelConfiguration, 'protocol'>,
  tools: readonly ClientToolDefinition[],
  residentTools: readonly ClientToolDefinition[],
  messages: readonly ModelMessage[] = []
): readonly ClientToolDefinition[] {
  return projectModelRequestTools(
    model,
    projectCodeModeTools(tools, residentTools),
    new Set([
      ...residentTools.map((tool) => tool.name),
      // There is no native provider call to pair with a programmatic discovery receipt.
      ...messages.flatMap((message) => message.mcpDiscovery?.names ?? [])
    ])
  );
}

/** The actual candidate and current Session view share the same side-effect-free projection. */
export function projectSessionRequestMessages(
  messages: readonly ModelMessage[],
  entries: ContextualWorldState['entries'],
  supportsImages: boolean,
  codeMode: boolean,
  autoPermission = false,
  tools: readonly ClientToolDefinition[] = []
): ModelMessage[] {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const latest = new Map<string, string>();
  for (const { mcpDiscovery } of messages)
    if (mcpDiscovery) for (const name of mcpDiscovery.names) latest.set(name, mcpDiscovery.id);
  const result: ModelMessage[] = [];
  const pending: ModelMessage[] = [];
  const openCalls = new Set<string>();
  for (const message of normalizeMessagesForModel(insertContextualWorldState(messages, entries), {
    supportsImages
  })) {
    if (message.mcpDiscovery) {
      const { id, names } = message.mcpDiscovery;
      const definitions = names.flatMap((name) => {
        const tool = byName.get(name);
        return latest.get(name) === id && tool ? [tool] : [];
      });
      const projected = projectCodeModeSearchResult(
        { ...message, toolSearchTools: definitions },
        codeMode
      );
      const visibleNames = projected.toolSearchTools?.map((tool) => tool.name) ?? [];
      if (!visibleNames.length) continue;
      pending.push({
        ...message,
        mcpDiscovery: { id, names: visibleNames },
        content: markupText(
          'mcp_discovery',
          projected.content || JSON.stringify({ tools: visibleNames })
        )
      });
      continue;
    }
    // A retained cell can publish while the current assistant tool batch is still open.
    // Never split a provider's tool call/result group with an SDK context message.
    if (!openCalls.size && pending.length && message.role !== 'tool')
      result.push(...pending.splice(0));
    const callId = message.role === 'tool_call' ? message.callId : providerToolCallId(message);
    if (callId) openCalls.add(callId);
    if (message.role === 'tool' && message.callId) openCalls.delete(message.callId);
    result.push(
      projectCodeModeSearchResult(
        autoPermission && message.toolSearchTools
          ? { ...message, toolSearchTools: message.toolSearchTools.map(projectPermissionTool) }
          : projectSmartCompactionMessage(message),
        codeMode
      )
    );
  }
  return result.concat(pending);
}
