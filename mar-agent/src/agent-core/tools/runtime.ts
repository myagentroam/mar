import { MarAgentError } from '../error.js';
import { randomUUID } from 'node:crypto';
import { AGENT_TOOL_HANDLERS, BUILTIN_TOOL_DEFINITIONS } from './registry.js';
import { normalizeToolInput } from './input.js';
import type { ToolRuntimeContext } from './runtime-context.js';
import { validateToolResult } from './output-projection.js';
import { withToolResultExtensions } from './result-extensions.js';
import { viewResourceImage } from './local/view-image.js';

export async function executeRegisteredTool(
  name: string,
  arguments_: unknown,
  callId: string,
  context: ToolRuntimeContext,
  caller: import('./contracts.js').ToolCaller = 'direct'
) {
  return withToolResultExtensions(context.writeToolResultResource, async () => {
    if (context.invokeTool)
      return validateToolResult(
        await context.invokeTool({ name, arguments: arguments_, callId }, context, caller)
      );
    return validateToolResult(
      await executeCapturedTool(
        AGENT_TOOL_HANDLERS.has(name) ? 'builtin' : name.startsWith('mcp__') ? 'mcp' : 'host',
        { name, arguments: arguments_, callId },
        context
      )
    );
  });
}

/** Invoke an already captured source; names never reselect a different backend. */
export async function executeCapturedTool(
  kind: 'builtin' | 'host' | 'mcp',
  call: import('./contracts.js').ToolCall,
  context: ToolRuntimeContext
): Promise<import('./contracts.js').ToolExecutionResult> {
  const definition =
    kind === 'builtin'
      ? BUILTIN_TOOL_DEFINITIONS.find((tool) => tool.name === call.name)
      : undefined;
  if (definition)
    call = { ...call, arguments: normalizeToolInput(call.arguments, definition.inputSchema) };
  if (
    kind !== 'mcp' &&
    call.name === 'view_image' &&
    call.arguments !== null &&
    typeof call.arguments === 'object' &&
    'resourceId' in call.arguments &&
    call.arguments.resourceId != null
  ) {
    const store = context.imageStore;
    if (!store)
      throw new MarAgentError(
        'MAR_AGENT_TOOL_INPUT_INVALID',
        'Session image resources are unavailable.'
      );
    return viewResourceImage(
      call.arguments,
      (resourceId) => store.readResource(context.sessionId, resourceId),
      context.signal
    );
  }
  if (kind === 'builtin') {
    const handler = AGENT_TOOL_HANDLERS.get(call.name);
    if (handler) return handler(call.arguments, context, call.callId ?? randomUUID());
  }
  if (kind === 'mcp') {
    if (!context.host.callMcpTool)
      throw new MarAgentError('MAR_AGENT_MCP_FAILED', 'MCP execution is unavailable.');
    return context.host.callMcpTool(call, context.signal, {
      sessionId: context.sessionId,
      executionId: context.executionId,
      mode: context.mode,
      ...(context.expectedMcpTool ? { expectedTool: context.expectedMcpTool } : {})
    });
  }
  return context.host.executeTool(call, {
    mode: context.mode,
    signal: context.signal,
    waitInterrupt: context.waitInterrupt,
    sessionId: context.sessionId,
    executionId: context.executionId,
    ...(context.modelId === undefined ? {} : { modelId: context.modelId }),
    ...(context.recentImages === undefined
      ? {}
      : {
          recentImages: context.recentImages.map((image) => ({
            ...image,
            data: Buffer.from(image.data)
          }))
        }),
    ...(context.codeMode === undefined ? {} : { codeMode: context.codeMode })
  });
}
