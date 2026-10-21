import {
  MarAgentError,
  type ClientToolDefinition,
  type LocalAgentExecutionExtensions,
  type ToolExecutionResult
} from '@myagentroam/agent';
import {
  WEB_FETCH_MAX_URL_LENGTH,
  webFetchRequestSchema,
  webSearchRequestSchema,
  type WebFetchHandler
} from '../../service/web-fetch-contracts.js';

export const webSearchToolDefinition: ClientToolDefinition = {
  name: 'web_search',
  allowedCallers: ['direct', 'programmatic'],
  parallelSafety: 'safe',
  description:
    'Search the web for current information using the Node search service. Use web_fetch to open a specific result.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', maxLength: 500 },
      maxResults: { type: 'integer', minimum: 1, maximum: 10, default: 8 }
    },
    required: ['query'],
    additionalProperties: false
  }
};

export const webFetchToolDefinition: ClientToolDefinition = {
  name: 'web_fetch',
  allowedCallers: ['direct', 'programmatic'],
  parallelSafety: 'safe',
  description:
    'Read an HTTP or HTTPS URL from the Node network, including intranet URLs. Choose http for raw text/HTML without JavaScript, or browser for rendered visible text using an isolated headless Chromium. Modes never switch automatically; explicitly retry in the other mode when needed. No user browser login or cookies are shared.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', maxLength: WEB_FETCH_MAX_URL_LENGTH },
      mode: { type: 'string', enum: ['http', 'browser'] }
    },
    required: ['url', 'mode'],
    additionalProperties: false
  }
};

export function createWebToolsExtensions(input: {
  enabled: boolean;
  hostedWebSearch?: boolean;
  hostedSearchModelIds?: readonly string[];
  webSearch?: (
    input: { query: string; maxResults: number },
    signal: AbortSignal
  ) => Promise<ToolExecutionResult>;
  webFetch?: WebFetchHandler;
}): LocalAgentExecutionExtensions {
  const tools = input.enabled
    ? [
        ...((input.hostedSearchModelIds !== undefined || !input.hostedWebSearch) && input.webSearch
          ? [webSearchToolDefinition]
          : []),
        ...(input.webFetch ? [webFetchToolDefinition] : [])
      ]
    : [];
  const isToolAvailable: NonNullable<LocalAgentExecutionExtensions['isToolAvailable']> = (
    name,
    context
  ) =>
    tools.some((tool) => tool.name === name) &&
    (name !== 'web_search' ||
      !(context.modelId === undefined || input.hostedSearchModelIds === undefined
        ? input.hostedWebSearch
        : input.hostedSearchModelIds.includes(context.modelId)));
  return {
    tools,
    isToolAvailable,
    executeTool: async (call, context) => {
      if (!isToolAvailable(call.name, context))
        throw new MarAgentError('MAR_AGENT_TOOL_NOT_AVAILABLE', 'Node web tool is unavailable.');
      context.signal.throwIfAborted();
      const parsed =
        call.name === 'web_search'
          ? webSearchRequestSchema.safeParse(call.arguments)
          : webFetchRequestSchema.safeParse(call.arguments);
      if (!parsed.success)
        throw new MarAgentError('MAR_AGENT_TOOL_INPUT_INVALID', 'Node web tool input is invalid.');
      try {
        if (call.name === 'web_search')
          return await input.webSearch!(webSearchRequestSchema.parse(parsed.data), context.signal);
        const request = webFetchRequestSchema.parse(parsed.data);
        return await input.webFetch!(
          { ...request, url: new URL(request.url).href },
          context.signal
        );
      } catch (error) {
        if (context.signal.aborted || error instanceof MarAgentError) throw error;
        throw new MarAgentError(
          call.name === 'web_search' ? 'MAR_AGENT_WEB_SEARCH_FAILED' : 'MAR_AGENT_WEB_FETCH_FAILED',
          call.name === 'web_search' ? 'Web search failed.' : 'Web fetch failed.',
          { cause: error }
        );
      }
    }
  };
}
