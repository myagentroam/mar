import type { ClientToolDefinition, ToolCall, ToolExecutionContext } from '../../src/index.js';

export const e2eWebFetchTool: ClientToolDefinition = {
  name: 'web_fetch',
  description: 'Fetch a web page using an explicit mode.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string' },
      mode: { type: 'string', enum: ['http', 'browser'] }
    },
    required: ['url', 'mode'],
    additionalProperties: false
  }
};

export const e2eWebSearchTool: ClientToolDefinition = {
  name: 'web_search',
  description: 'Search the web.',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string' }, maxResults: { type: 'integer' } },
    required: ['query'],
    additionalProperties: false
  }
};

export function createE2eWebExtensions(searxngUrl?: string) {
  const tools = searxngUrl === undefined ? [e2eWebFetchTool] : [e2eWebSearchTool, e2eWebFetchTool];
  return {
    tools,
    executeTool: async (call: ToolCall, context: ToolExecutionContext) => {
      if (call.name === 'web_fetch') {
        const input = call.arguments as { url: string; mode: 'http' | 'browser' };
        if (input.mode !== 'http') throw new Error('E2E_WEB_FETCH_MODE_UNSUPPORTED');
        const response = await fetch(input.url, { signal: context.signal });
        if (!response.ok) throw new Error(`E2E_WEB_FETCH_HTTP_${response.status}`);
        return { content: await response.text() };
      }
      if (call.name === 'web_search' && searxngUrl !== undefined) {
        const input = call.arguments as { query: string; maxResults?: number };
        const url = new URL('/search', searxngUrl);
        url.searchParams.set('q', input.query);
        url.searchParams.set('format', 'json');
        const response = await fetch(url, { signal: context.signal });
        if (!response.ok) throw new Error(`E2E_SEARXNG_HTTP_${response.status}`);
        const payload = (await response.json()) as {
          results?: { title?: string; url?: string; content?: string }[];
        };
        return {
          content: JSON.stringify(
            (payload.results ?? []).slice(0, input.maxResults ?? 8).map((result) => ({
              title: result.title ?? '',
              url: result.url ?? '',
              snippet: result.content ?? ''
            }))
          )
        };
      }
      throw new Error(`E2E_UNKNOWN_HOST_TOOL_${call.name}`);
    }
  };
}
