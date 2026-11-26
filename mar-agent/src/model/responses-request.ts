import { AgentError } from '../error.js';
import {
  agentReasoningEffortSchema,
  resolveModelDefaultReasoningEffort,
  usesResponsesConfigurationUpdates,
  type AgentModelConfiguration
} from './configuration.js';
import type { ModelRequest } from './contracts.js';
import { modelImageUrl } from './image.js';
import { isRealUserMessage, uniqueModelImages } from './input-images.js';
import { responseItem } from './responses-event-projection.js';
import { record, text } from './sse.js';
import { resolveModelTextBlocks } from './text-blocks.js';
import { stableToolSchema } from './tool-schema.js';
import { jsonToolInput } from './tool-input.js';

export type ResponsesRequestBody = Readonly<Record<string, unknown>> & {
  readonly input: readonly unknown[];
};

export interface ResponsesToolPlaceholders {
  omitNull?: true;
  properties?: Map<string, ResponsesToolPlaceholders>;
  items?: ResponsesToolPlaceholders;
}

// Request-local metadata; never serialized with the tool definitions.
type ToolPlaceholders = Map<string, ResponsesToolPlaceholders | undefined>;

export interface ResponsesToolProjection {
  direct: ToolPlaceholders;
  deferred: Map<string, ToolPlaceholders>;
}

export function responsesRequestBody(
  configuration: AgentModelConfiguration,
  request: ModelRequest,
  messages: ModelRequest['messages'],
  previousOutputItems: readonly Record<string, unknown>[] = [],
  placeholders?: ResponsesToolProjection
): ResponsesRequestBody {
  const systemBlocks = resolveModelTextBlocks(request.system, request.systemBlocks ?? []);
  if (
    (request.systemBlocks !== undefined && systemBlocks.some((block) => block.cache)) ||
    messages.some(
      (message) =>
        message.textBlocks !== undefined &&
        resolveModelTextBlocks(message.content, message.textBlocks).some((block) => block.cache)
    )
  )
    throw new AgentError(
      'MAR_AGENT_MODEL_CAPABILITY_UNAVAILABLE',
      'This model protocol does not support explicit text-block cache markers.'
    );
  const tools: unknown[] =
    request.allowTools === false
      ? []
      : request.tools.map((tool) =>
          tool.nativeType === 'tool_search' &&
          configuration.responsesOptionalParameters?.nativeTools !== false
            ? {
                type: 'tool_search',
                execution: 'client',
                description: tool.description,
                parameters: stableToolSchema(strictToolParameters(tool, placeholders?.direct))
              }
            : responsesFunctionTool(
                tool,
                configuration.responsesOptionalParameters?.nativeTools !== false,
                placeholders?.direct
              )
        );
  if (configuration.responsesToolNamespace && tools.length > 0) {
    const native = tools.filter((tool) => record(tool).type === 'tool_search');
    const nested = tools.filter((tool) => record(tool).type !== 'tool_search');
    tools.splice(0, tools.length, ...native);
    if (nested.length)
      tools.push({
        type: 'namespace',
        name: configuration.responsesToolNamespace,
        description: 'Client-side agent tools.',
        tools: nested
      });
  }
  if (
    request.allowTools !== false &&
    request.allowHostedTools !== false &&
    configuration.hostedWebSearch
  )
    tools.push({ type: 'web_search' });
  const toolChoice = request.toolChoice ?? 'auto';
  const input = openAiInput(
    messages,
    request.images,
    configuration.id,
    true,
    usesResponsesConfigurationUpdates(configuration),
    configuration.responsesOptionalParameters?.nativeTools !== false,
    request.tools,
    previousOutputItems,
    placeholders?.deferred
  );
  const systemInput = responsesSystemInput(request, systemBlocks);
  if (systemInput !== undefined) input.unshift(systemInput);
  return {
    model: configuration.modelId,
    ...(request.outputLimit === undefined
      ? {}
      : {
          max_output_tokens: Math.min(request.outputLimit, configuration.maxOutputTokens)
        }),
    ...(configuration.serviceTier !== undefined
      ? { service_tier: configuration.serviceTier }
      : configuration.fastMode === true
        ? { service_tier: 'priority' }
        : {}),
    tools,
    ...(tools.length > 0 ? { tool_choice: toolChoice, parallel_tool_calls: true } : {}),
    input,
    stream: true,
    store:
      configuration.responsesPreviousResponseId === true &&
      configuration.responsesTransport?.transport !== 'WEBSOCKET',
    ...(configuration.responsesOptionalParameters?.textVerbosity === false
      ? {}
      : { text: { verbosity: 'low' } }),
    include: [
      'reasoning.encrypted_content',
      ...(configuration.hostedWebSearch &&
      request.allowTools !== false &&
      request.allowHostedTools !== false &&
      toolChoice !== 'none'
        ? ['web_search_call.action.sources']
        : [])
    ],
    ...(request.promptCacheKey &&
    configuration.responsesOptionalParameters?.promptCacheKey !== false
      ? { prompt_cache_key: request.promptCacheKey }
      : {}),
    ...(configuration.responsesOptionalParameters?.reasoningEffort === false &&
    configuration.responsesOptionalParameters?.reasoningSummary === false
      ? {}
      : {
          reasoning: {
            ...(configuration.responsesOptionalParameters?.reasoningEffort === false
              ? {}
              : {
                  effort:
                    request.requestReasoningEffort?.trim() ||
                    request.reasoningEffort?.trim() ||
                    resolveModelDefaultReasoningEffort(configuration)
                }),
            ...(configuration.responsesOptionalParameters?.reasoningSummary === false
              ? {}
              : { summary: 'auto' })
          }
        })
  };
}

function responsesSystemInput(
  request: Pick<ModelRequest, 'system' | 'systemBlocks'>,
  blocks = resolveModelTextBlocks(request.system, request.systemBlocks ?? [])
) {
  if (blocks.length === 0) return undefined;
  return {
    role: 'developer',
    content: blocks.map((block) => ({ type: 'input_text', text: block.text }))
  };
}

function strictFunctionSchema(
  value: unknown,
  optional = false,
  placeholders?: ResponsesToolPlaceholders
): unknown {
  const projected = projectStrictFunctionSchema(value, optional, placeholders);
  if (optional && placeholders && acceptsNull(value) === false && acceptsNull(projected) === true)
    placeholders.omitNull = true;
  return projected;
}

function projectStrictFunctionSchema(
  value: unknown,
  optional: boolean,
  placeholders: ResponsesToolPlaceholders | undefined
): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const schema = value as Record<string, unknown>;
  const supportedSchema = Object.fromEntries(
    Object.entries(schema).filter(
      ([keyword]) => keyword !== 'propertyNames' && keyword !== 'uniqueItems'
    )
  );
  if (Array.isArray(schema.anyOf))
    supportedSchema.anyOf = schema.anyOf.map((branch) => strictFunctionSchema(branch));
  if (optional && Array.isArray(schema.enum) && !schema.enum.includes(null))
    supportedSchema.enum = [...schema.enum, null];
  // Do not select a union branch or infer constraints from references.
  const childPlans =
    placeholders &&
    !hasUnresolvedNullConstraint(schema) &&
    !['anyOf', 'const', 'enum'].some((key) => Object.hasOwn(schema, key))
      ? placeholders
      : undefined;
  if (schema.type === 'object') {
    const properties = record(schema.properties);
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    return {
      ...supportedSchema,
      ...(optional ? { type: ['object', 'null'] } : {}),
      properties: Object.fromEntries(
        Object.entries(properties).map(([name, property]) => {
          const child = childPlans ? {} : undefined;
          const projected = strictFunctionSchema(property, !required.has(name), child);
          if (childPlans && child && hasPlaceholders(child))
            (childPlans.properties ??= new Map()).set(name, child);
          return [name, projected];
        })
      ),
      required: Object.keys(properties),
      additionalProperties: false
    };
  }
  if (schema.type === 'array') {
    const child = childPlans ? {} : undefined;
    const items =
      schema.items === undefined ? undefined : strictFunctionSchema(schema.items, false, child);
    if (childPlans && child && hasPlaceholders(child)) childPlans.items = child;
    return {
      ...supportedSchema,
      ...(items === undefined ? {} : { items }),
      ...(optional ? { type: ['array', 'null'] } : {})
    };
  }
  if (!optional) return supportedSchema;
  if (typeof schema.type === 'string')
    return schema.type === 'null'
      ? supportedSchema
      : { ...supportedSchema, type: [schema.type, 'null'] };
  if (Array.isArray(schema.type))
    return {
      ...supportedSchema,
      type: schema.type.includes('null') ? schema.type : [...schema.type, 'null']
    };
  if (Array.isArray(schema.enum)) return supportedSchema;
  if (Array.isArray(supportedSchema.anyOf))
    return {
      ...supportedSchema,
      anyOf: supportedSchema.anyOf.some((branch) => record(branch).type === 'null')
        ? supportedSchema.anyOf
        : [...supportedSchema.anyOf, { type: 'null' }]
    };
  return { anyOf: [supportedSchema, { type: 'null' }] };
}

function hasPlaceholders(plan: ResponsesToolPlaceholders): boolean {
  return Boolean(plan.omitNull || plan.properties || plan.items);
}

function hasUnresolvedNullConstraint(schema: Record<string, unknown>): boolean {
  return ['$ref', '$dynamicRef', '$recursiveRef', 'oneOf', 'allOf', 'not', 'if', 'nullable'].some(
    (key) => Object.hasOwn(schema, key)
  );
}

/** Only classify null for the explicit forms used by the Strict projection. */
function acceptsNull(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  const schema = record(value);
  if (hasUnresolvedNullConstraint(schema)) return undefined;
  if (
    (typeof schema.type === 'string' && schema.type !== 'null') ||
    (Array.isArray(schema.type) && !schema.type.includes('null')) ||
    (Object.hasOwn(schema, 'const') && schema.const !== null) ||
    (Array.isArray(schema.enum) && !schema.enum.includes(null))
  )
    return false;
  if (!Array.isArray(schema.anyOf)) return true;
  const branches = schema.anyOf.map(acceptsNull);
  return branches.includes(true) ? true : branches.includes(undefined) ? undefined : false;
}

export function openAiInput(
  messages: ModelRequest['messages'],
  images: ModelRequest['images'] | undefined,
  modelId: string,
  requireEncryptedReasoning: boolean,
  configurationUpdates = true,
  nativeTools = true,
  tools: ModelRequest['tools'] = [],
  previousOutputItems: readonly Record<string, unknown>[] = [],
  deferredPlaceholders?: ResponsesToolProjection['deferred']
) {
  const compatibleMessages = messages.filter(
    (message) =>
      message.role !== 'provider' ||
      (message.provider === 'OPENAI_RESPONSES' &&
        (message.providerModelId === undefined || message.providerModelId === modelId) &&
        (configurationUpdates || message.item?.type !== 'configuration_update') &&
        (nativeTools ||
          !['custom_tool_call', 'tool_search_call', 'tool_search_output'].includes(
            String(message.item?.type)
          )) &&
        (!requireEncryptedReasoning ||
          message.item?.type !== 'reasoning' ||
          typeof message.item.encrypted_content === 'string'))
  );
  const lastUser = compatibleMessages.findLast(isRealUserMessage);
  const providerCallIds = new Set<string>();
  const functionCallIds = new Set<string>();
  const customCallIds = new Set<string>();
  const searchCallIds = new Set<string>();
  const providerMessageTexts = new Set<string>();
  // Incremental input omits the calls already retained by the WebSocket response.
  for (const item of previousOutputItems) {
    if (typeof item.call_id !== 'string') continue;
    if (item.type === 'function_call') functionCallIds.add(item.call_id);
    if (nativeTools && item.type === 'custom_tool_call') customCallIds.add(item.call_id);
    if (nativeTools && item.type === 'tool_search_call') searchCallIds.add(item.call_id);
  }
  for (const message of compatibleMessages) {
    if (message.role !== 'provider' || !message.item) continue;
    if (message.item.type === 'function_call' && typeof message.item.call_id === 'string') {
      providerCallIds.add(message.item.call_id);
      functionCallIds.add(message.item.call_id);
    }
    if (message.item.type === 'tool_search_call' && typeof message.item.call_id === 'string') {
      providerCallIds.add(message.item.call_id);
      searchCallIds.add(message.item.call_id);
    }
    if (message.item.type === 'custom_tool_call' && typeof message.item.call_id === 'string') {
      providerCallIds.add(message.item.call_id);
      customCallIds.add(message.item.call_id);
    }
    if (message.item.type === 'message') {
      const content = Array.isArray(message.item.content) ? message.item.content : [];
      const value = content
        .map((part) => {
          const item = record(part);
          return text(item.text) ?? '';
        })
        .join('');
      if (value) providerMessageTexts.add(value);
    }
  }
  for (const message of compatibleMessages) {
    if (!nativeTools || message.role !== 'tool_call' || !message.callId) continue;
    if (message.inputMode === 'freeform') customCallIds.add(message.callId);
    else if (message.name === 'tool_search') searchCallIds.add(message.callId);
  }
  const orderedMessages: typeof compatibleMessages = [];
  for (const message of compatibleMessages) {
    if (message.role === 'provider' && message.item?.type === 'configuration_update') {
      const userIndex = orderedMessages.findLastIndex(isRealUserMessage);
      if (userIndex >= 0) {
        orderedMessages.splice(userIndex, 0, message);
        continue;
      }
    }
    orderedMessages.push(message);
  }
  // SDK records the update after the user input; the wire item must precede
  // that user message so the new effort applies to the response.
  const input: ReturnType<typeof openAiInputItem>[] = [];
  const searchDiagnostics: string[] = [];
  const flushSearchDiagnostics = () => {
    if (searchDiagnostics.length)
      input.push({ role: 'user', content: searchDiagnostics.splice(0).join('\n\n') });
  };
  for (let message of orderedMessages) {
    if (message.role === 'tool_call' && message.callId && providerCallIds.has(message.callId))
      continue;
    if (message.role === 'assistant' && providerMessageTexts.has(message.content)) continue;
    if (message.role !== 'tool') flushSearchDiagnostics();
    else if (
      message.callId &&
      searchCallIds.has(message.callId) &&
      !functionCallIds.has(message.callId) &&
      message.toolSearchTools === undefined
    ) {
      // Native search output has no text field; send the diagnostic after the tool batch.
      searchDiagnostics.push(
        `Tool Search failed (call ID: ${message.callId}):\n${message.content}`
      );
      message = { ...message, toolSearchTools: [] };
    }
    input.push(
      openAiInputItem(
        message,
        message === lastUser ? images : undefined,
        customCallIds,
        functionCallIds,
        nativeTools,
        tools,
        deferredPlaceholders
      )
    );
  }
  flushSearchDiagnostics();
  return input;
}

function openAiInputItem(
  message: ModelRequest['messages'][number],
  images?: ModelRequest['images'],
  customCallIds: ReadonlySet<string> = new Set(),
  functionCallIds: ReadonlySet<string> = new Set(),
  nativeTools = true,
  tools: ModelRequest['tools'] = [],
  deferredPlaceholders?: ResponsesToolProjection['deferred']
) {
  const userImages =
    message.role === 'user' ? uniqueModelImages(message.images, images) : ([] as const);
  if (message.role === 'provider') {
    if (message.provider !== 'OPENAI_RESPONSES' || !message.item)
      throw new AgentError('MAR_AGENT_MODEL_PROTOCOL_ERROR', 'Provider context item is invalid.');
    if (message.item.type === 'configuration_update') {
      const effort = agentReasoningEffortSchema.safeParse(record(message.item.reasoning).effort);
      if (effort.success)
        return { type: 'configuration_update', reasoning: { effort: effort.data } };
    }
    const item = responseItem(message.item);
    if (!item)
      throw new AgentError(
        'MAR_AGENT_MODEL_PROTOCOL_ERROR',
        'Provider context item type is unsupported.'
      );
    return item;
  }
  if (nativeTools && message.role === 'tool_call' && message.inputMode === 'freeform')
    return {
      type: 'custom_tool_call',
      call_id: message.callId,
      name: message.name,
      input: String(message.arguments ?? '')
    };
  if (nativeTools && message.role === 'tool_call' && message.name === 'tool_search')
    return {
      type: 'tool_search_call',
      call_id: message.callId,
      status: 'completed',
      execution: 'client',
      arguments: message.arguments ?? {}
    };
  if (message.role === 'tool_call')
    return {
      type: 'function_call',
      call_id: message.callId,
      name: message.name,
      arguments: JSON.stringify(
        message.inputMode === 'freeform'
          ? jsonToolInput(
              message,
              tools.find((tool) => tool.name === message.name)
            )
          : (message.arguments ?? {})
      )
    };
  if (
    message.role === 'tool' &&
    nativeTools &&
    message.toolSearchTools &&
    !functionCallIds.has(message.callId ?? '')
  ) {
    const placeholders: ToolPlaceholders | undefined = deferredPlaceholders ? new Map() : undefined;
    const projectedTools = message.toolSearchTools.map((tool) =>
      responsesFunctionTool(tool, true, placeholders)
    );
    if (placeholders && message.callId) deferredPlaceholders?.set(message.callId, placeholders);
    return {
      type: 'tool_search_output',
      call_id: message.callId,
      status: 'completed',
      execution: 'client',
      tools: projectedTools
    };
  }
  if (message.role === 'tool')
    return {
      type: customCallIds.has(message.callId ?? '')
        ? 'custom_tool_call_output'
        : 'function_call_output',
      call_id: message.callId,
      output:
        (message.textBlocks === undefined ? message.contentParts : undefined)?.map((part) =>
          part.type === 'text'
            ? { type: 'input_text', text: part.text }
            : {
                type: 'input_image',
                image_url: modelImageUrl(part.image)
              }
        ) ??
        (message.textBlocks !== undefined
          ? [
              ...resolveModelTextBlocks(message.content, message.textBlocks).map((block) => ({
                type: 'input_text',
                text: block.text
              })),
              ...(message.images ?? []).map((image) => ({
                type: 'input_image',
                image_url: modelImageUrl(image)
              }))
            ]
          : message.images?.length
            ? [
                { type: 'input_text', text: message.content },
                ...message.images.map((image) => ({
                  type: 'input_image',
                  image_url: modelImageUrl(image)
                }))
              ]
            : message.content)
    };
  return {
    role:
      message.role === 'user' && contextualAuthority(message) === 'instruction'
        ? 'developer'
        : message.role,
    content:
      message.textBlocks !== undefined
        ? [
            ...resolveModelTextBlocks(message.content, message.textBlocks).map((block) => ({
              type: message.role === 'assistant' ? 'output_text' : 'input_text',
              text: block.text
            })),
            ...userImages.map((image) => ({
              type: 'input_image',
              image_url: modelImageUrl(image)
            }))
          ]
        : userImages.length > 0
          ? [
              { type: 'input_text', text: message.content },
              ...userImages.map((image) => ({
                type: 'input_image',
                image_url: modelImageUrl(image)
              }))
            ]
          : message.content
  };
}

function contextualAuthority(message: ModelRequest['messages'][number]): string | undefined {
  return message.contextualBlock?.authority;
}

function strictToolParameters(
  tool: ModelRequest['tools'][number],
  placeholders?: ToolPlaceholders
) {
  const plan = placeholders ? {} : undefined;
  const parameters = strictFunctionSchema(stableToolSchema(tool.inputSchema), false, plan);
  placeholders?.set(tool.name, plan && hasPlaceholders(plan) ? plan : undefined);
  return parameters;
}

function responsesFunctionTool(
  tool: ModelRequest['tools'][number],
  nativeTools: boolean,
  placeholders?: ToolPlaceholders
) {
  if (tool.inputMode === 'freeform' && nativeTools) {
    placeholders?.set(tool.name, undefined);
    return { type: 'custom', name: tool.name, description: tool.description };
  }
  const strict = !hasOpenFunctionObject(tool.inputSchema);
  if (!strict) placeholders?.set(tool.name, undefined);
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: stableToolSchema(
      strict ? strictToolParameters(tool, placeholders) : tool.inputSchema
    ),
    strict
  };
}

function hasOpenFunctionObject(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const schema = record(value);
  if (
    (schema.type === 'object' || (Array.isArray(schema.type) && schema.type.includes('object'))) &&
    (schema.additionalProperties === true ||
      (schema.additionalProperties !== null && typeof schema.additionalProperties === 'object') ||
      (schema.properties === undefined && schema.additionalProperties !== false))
  )
    return true;
  const children = [
    ...Object.values(record(schema.properties)),
    ...Object.values(record(schema.$defs)),
    ...Object.values(record(schema.definitions)),
    schema.items,
    ...[schema.anyOf, schema.oneOf, schema.allOf].flatMap((items) =>
      Array.isArray(items) ? items : []
    )
  ];
  return children.some(hasOpenFunctionObject);
}
