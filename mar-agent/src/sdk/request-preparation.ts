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
      autoPermission
    ),
    tools: projectSessionRequestTools(model, candidate.tools, residentTools)
  };
}

/** Conversation and Compact keep identical Code Mode and native discovery tool prefixes. */
export function projectSessionRequestTools(
  model: Pick<AgentModelConfiguration, 'protocol'>,
  tools: readonly ClientToolDefinition[],
  residentTools: readonly ClientToolDefinition[]
): readonly ClientToolDefinition[] {
  return projectModelRequestTools(
    model,
    projectCodeModeTools(tools, residentTools),
    new Set(residentTools.map((tool) => tool.name))
  );
}

/** The actual candidate and current Session view share the same side-effect-free projection. */
export function projectSessionRequestMessages(
  messages: readonly ModelMessage[],
  entries: ContextualWorldState['entries'],
  supportsImages: boolean,
  codeMode: boolean,
  autoPermission = false
): ModelMessage[] {
  return normalizeMessagesForModel(insertContextualWorldState(messages, entries), {
    supportsImages
  }).map((message) =>
    projectCodeModeSearchResult(
      autoPermission && message.toolSearchTools
        ? { ...message, toolSearchTools: message.toolSearchTools.map(projectPermissionTool) }
        : projectSmartCompactionMessage(message),
      codeMode
    )
  );
}
