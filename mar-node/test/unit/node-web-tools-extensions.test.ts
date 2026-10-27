import { describe, expect, it, vi } from 'vitest';
import { LocalAgentHost, type ToolExecutionContext } from '@myagentroam/agent/host';
import type { ToolCall } from '@myagentroam/agent';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createWebToolsExtensions,
  webFetchToolDefinition
} from '../../src/runner/mar-agent/web-tools-extensions.js';
import { combineExecutionExtensions } from '../../src/runner/mar-agent/execution-extensions.js';

const context = (signal = new AbortController().signal) => ({ signal }) as ToolExecutionContext;
const call = (name: string, args: unknown = { url: 'https://example.test', mode: 'browser' }) =>
  ({
    id: 'call-1',
    name,
    arguments: args
  }) as ToolCall;

describe('Node execution web tools', () => {
  it('projects root and child search separately using each actual model in one Host binding', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mar-web-model-policy-'));
    const provider = vi.fn(async () => ({ content: 'results' }));
    const host = new LocalAgentHost({ homeDirectory: directory, workspace: directory });
    const binding = host.bindExecutionExtensions(
      combineExecutionExtensions(
        createWebToolsExtensions({
          enabled: true,
          hostedWebSearch: true,
          hostedSearchModelIds: ['hosted'],
          webSearch: provider,
          webFetch: provider
        })
      )
    );
    const root = {
      sessionId: 'root',
      executionId: 'root-execution',
      modelId: 'hosted',
      claimExecutionScope: true
    };
    const child = {
      sessionId: 'child',
      executionId: 'child-execution',
      modelId: 'local',
      executionScopeId: root.executionId
    };
    try {
      expect((await host.listExecutionExtensions(root)).tools?.map((tool) => tool.name)).toEqual([
        'web_fetch'
      ]);
      expect((await host.listExecutionExtensions(child)).tools?.map((tool) => tool.name)).toEqual([
        'web_search',
        'web_fetch'
      ]);
      await expect(
        host.executeTool(call('web_search', { query: 'query' }), { ...root, ...context() })
      ).rejects.toThrow();
      await expect(
        host.executeTool(call('web_search', { query: 'query' }), { ...child, ...context() })
      ).resolves.toEqual({ content: 'results' });
      expect(provider).toHaveBeenCalledOnce();
    } finally {
      host.unbindExecutionMcp(binding);
      await host.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('projects explicit modes and forwards normalized input and cancellation', async () => {
    const webFetch = vi.fn(async () => ({ content: 'rendered' }));
    const webSearch = vi.fn(async () => ({ content: 'search' }));
    const extensions = createWebToolsExtensions({ enabled: true, webFetch, webSearch });
    expect(extensions.tools?.map((tool) => tool.name)).toEqual(['web_search', 'web_fetch']);
    expect(webFetchToolDefinition.inputSchema).toMatchObject({ required: ['url', 'mode'] });
    const ctx = context();
    await extensions.executeTool!(call('web_fetch'), ctx);
    expect(webFetch).toHaveBeenCalledWith(
      { url: 'https://example.test/', mode: 'browser' },
      ctx.signal
    );
    await extensions.executeTool!(call('web_search', { query: '  query  ' }), ctx);
    expect(webSearch).toHaveBeenCalledWith({ query: 'query', maxResults: 8 }, ctx.signal);
  });

  it.each([undefined, 'auto', 'invalid'])(
    'rejects absent or unsupported mode (%s) without invoking a backend',
    async (mode) => {
      const webFetch = vi.fn();
      const extensions = createWebToolsExtensions({ enabled: true, webFetch });
      await expect(
        extensions.executeTool!(
          call('web_fetch', { url: 'https://example.test/', mode }),
          context()
        )
      ).rejects.toMatchObject({ code: 'MAR_AGENT_TOOL_INPUT_INVALID' });
      expect(webFetch).not.toHaveBeenCalled();
    }
  );

  it('network NONE removes both definitions and rejects direct handler bypasses', async () => {
    const provider = vi.fn();
    const extensions = createWebToolsExtensions({
      enabled: false,
      webFetch: provider,
      webSearch: provider
    });
    expect(extensions.tools).toEqual([]);
    for (const name of ['web_fetch', 'web_search'])
      await expect(extensions.executeTool!(call(name), context())).rejects.toMatchObject({
        code: 'MAR_AGENT_TOOL_NOT_AVAILABLE'
      });
    expect(provider).not.toHaveBeenCalled();
  });

  it('reprojects hosted search priority for each Execution without removing Fetch', () => {
    const options = { enabled: true, webFetch: vi.fn(), webSearch: vi.fn() };
    expect(
      createWebToolsExtensions({ ...options, hostedWebSearch: true }).tools?.map(
        (tool) => tool.name
      )
    ).toEqual(['web_fetch']);
    expect(
      createWebToolsExtensions({ ...options, hostedWebSearch: false }).tools?.map(
        (tool) => tool.name
      )
    ).toEqual(['web_search', 'web_fetch']);
    expect(createWebToolsExtensions({ enabled: true }).tools).toEqual([]);
  });

  it('rejects cancelled calls before invoking a backend and preserves provider errors', async () => {
    const webFetch = vi.fn(async () => {
      throw new Error('private upstream details');
    });
    const extensions = createWebToolsExtensions({ enabled: true, webFetch });
    const abort = new AbortController();
    abort.abort();
    await expect(
      extensions.executeTool!(call('web_fetch'), context(abort.signal))
    ).rejects.toThrow();
    expect(webFetch).not.toHaveBeenCalled();
    await expect(extensions.executeTool!(call('web_fetch'), context())).rejects.toMatchObject({
      code: 'MAR_AGENT_WEB_FETCH_FAILED'
    });
    expect(webFetch).toHaveBeenCalledTimes(1);
  });

  it('composes image and Web domains without replacing handlers and rejects duplicate names', async () => {
    const webFetch = vi.fn(async () => ({ content: 'web' }));
    const imageHandler = vi.fn(async () => ({ content: 'image' }));
    const web = createWebToolsExtensions({ enabled: true, webFetch });
    const image = {
      tools: [{ ...webFetchToolDefinition, name: 'codex_image_gen' }],
      skills: [],
      executeTool: imageHandler
    };
    const combined = combineExecutionExtensions(image, web);
    await expect(combined.executeTool!(call('web_fetch'), context())).resolves.toEqual({
      content: 'web'
    });
    await expect(combined.executeTool!(call('codex_image_gen'), context())).resolves.toEqual({
      content: 'image'
    });
    expect(webFetch).toHaveBeenCalledOnce();
    expect(imageHandler).toHaveBeenCalledOnce();
    await expect(combined.executeTool!(call('unknown'), context())).rejects.toMatchObject({
      code: 'MAR_AGENT_TOOL_NOT_AVAILABLE'
    });
    expect(() => combineExecutionExtensions(web, web)).toThrow('Host tool names conflict');
  });
});
