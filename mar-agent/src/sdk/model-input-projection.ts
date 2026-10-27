import type { ModelMessage, ModelRequest, ModelToolDefinition } from '../model/contracts.js';
import type { SessionModelMessage, SessionModelRequest } from '../session/model-request.js';
import { observationModelParts } from '../session/code-observation-projection.js';

function projectTool(tool: ModelToolDefinition): ModelToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.nativeType === undefined ? {} : { nativeType: tool.nativeType }),
    ...(tool.inputMode === undefined ? {} : { inputMode: tool.inputMode })
  };
}

function projectMessage(message: SessionModelMessage): ModelMessage {
  const {
    calls: _calls,
    observations: _observations,
    observationId: _id,
    toolSearchTools,
    ...input
  } = message;
  const parts = message.role === 'tool' ? observationModelParts(message) : undefined;
  return {
    ...input,
    ...(parts === undefined ? {} : { contentParts: parts }),
    ...(toolSearchTools === undefined ? {} : { toolSearchTools: toolSearchTools.map(projectTool) })
  };
}

/** Project without mutating execution history, the captured request or its retry state. */
export function projectModelRequest(request: SessionModelRequest): ModelRequest {
  return {
    ...request,
    messages: request.messages.map(projectMessage),
    tools: request.tools.map(projectTool)
  };
}
