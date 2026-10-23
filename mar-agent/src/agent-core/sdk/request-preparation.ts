import type { MarAgentModelConfiguration } from '../model/configuration.js';
import type { ClientToolDefinition, ModelMessage, ModelRequest } from '../model/contracts.js';
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
  model: Pick<MarAgentModelConfiguration, 'protocol' | 'inputCapabilities'>,
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
    tools: projectModelRequestTools(
      model,
      projectCodeModeTools(candidate.tools, residentTools),
      new Set(residentTools.map((tool) => tool.name))
    )
  };
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
