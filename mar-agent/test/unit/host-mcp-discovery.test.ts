import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  LocalAgentHost,
  SecretValue,
  type MarAgentHost,
  type MarAgentModelConfiguration,
  type McpToolCatalog
} from '../../src/index.js';
import type {
  ModelAdapter,
  ModelEvent,
  ModelRequest
} from '../../src/agent-core/model/contracts.js';
import { createMarAgentWithAdapter } from '../../src/agent-core/sdk/agent.js';

const model: MarAgentModelConfiguration = {
  id: 'fake',
  name: 'Fake',
  protocol: 'ANTHROPIC_MESSAGES',
  baseUrl: 'https://example.test',
  apiKey: new SecretValue('fixture'),
  modelId: 'fake',
  contextWindowTokens: 100_000,
  maxOutputTokens: 4096,
  inputCapabilities: ['TEXT'],
  outputCapabilities: ['TEXT'],
  reasoningEfforts: [],
  hostedWebSearch: false,
  titleGeneration: false,
  codeMode: false,
  enabled: true
};
const definition = {
  name: 'mcp__fixture__lookup',
  description: 'Look up a fixture record.',
  inputSchema: {
    type: 'object',
    properties: { key: { type: 'string' } },
    required: ['key']
  }
};
const catalog: McpToolCatalog = {
  revision: 'fixture-one',
  servers: [{ id: 'fixture', name: 'Fixture' }],
  tools: [
    {
      definition,
      serverId: 'fixture',
      rawName: 'lookup',
      sourceIdentity: 'fixture-installation',
      definitionRevision: 'one',
      lifetime: 'execution',
      exposure: 'deferred'
    }
  ]
};

it.each([
  { source: 'catalog', hasCatalog: true, hasList: false, empty: false },
  { source: 'list fallback', hasCatalog: false, hasList: true, empty: false },
  { source: 'catalog before list', hasCatalog: true, hasList: true, empty: false },
  { source: 'missing methods', hasCatalog: false, hasList: false, empty: true },
  { source: 'empty catalog', hasCatalog: true, hasList: false, empty: true },
  { source: 'empty list', hasCatalog: false, hasList: true, empty: true },
  { source: 'empty catalog before populated list', hasCatalog: true, hasList: true, empty: true }
])('discovers MCP through $source without a Host capability', async (scenario) => {
  const home = await mkdtemp(join(tmpdir(), 'mar-host-mcp-discovery-'));
  const local = new LocalAgentHost({ homeDirectory: home, workspace: home });
  const listCatalog = vi.fn(async () => ({
    ...catalog,
    tools: scenario.empty ? [] : catalog.tools
  }));
  const listTools = vi.fn(async () => (scenario.empty && !scenario.hasCatalog ? [] : [definition]));
  const callMcpTool = vi.fn<NonNullable<MarAgentHost['callMcpTool']>>(async () => ({
    content: 'fixture-record-57'
  }));
  // Omit optional methods structurally instead of inheriting Local Host's catalog method.
  const host: MarAgentHost = {
    describe: async () => ({
      ...(await local.describe()),
      capabilities: [
        'workspace.read',
        'workspace.patch',
        'process.manage',
        'user-input.request',
        'event.publish'
      ]
    }),
    executeTool: local.executeTool.bind(local),
    emit: () => undefined,
    dispose: local.dispose.bind(local),
    ...(scenario.hasCatalog ? { listMcpToolCatalog: listCatalog } : {}),
    ...(scenario.hasList ? { listMcpTools: listTools } : {}),
    callMcpTool
  };
  const requests: ModelRequest[] = [];
  const available = !scenario.empty;
  const adapter: ModelAdapter = {
    configuration: model,
    async *start(request): AsyncIterable<ModelEvent> {
      requests.push(request);
      if (available && requests.length <= 2) {
        yield {
          type: 'client_tool.call',
          callId: `call-${requests.length}`,
          name: requests.length === 1 ? 'tool_search' : definition.name,
          arguments: requests.length === 1 ? { query: definition.name } : { key: '57' }
        };
        yield { type: 'completed', reason: 'tool_use' };
      } else {
        yield { type: 'text.completed', itemId: 'answer', text: 'done' };
        yield { type: 'completed', reason: 'completed' };
      }
    }
  };
  let agent: Awaited<ReturnType<typeof createMarAgentWithAdapter>> | undefined;
  try {
    agent = await createMarAgentWithAdapter({
      mode: 'normal',
      host,
      models: [model],
      adapterFactory: () => adapter
    });
    const session = await agent.createSession({ workspace: home, title: 'Host MCP discovery' });
    expect(await session.run({ prompt: 'Look up record 57.' }).result()).toMatchObject({
      status: 'completed',
      finalAnswer: 'done'
    });
    expect(requests[0]!.tools.some((tool) => tool.name === 'tool_search')).toBe(available);
    expect(requests[0]!.tools.some((tool) => tool.name === definition.name)).toBe(false);
    if (available) {
      expect(requests).toHaveLength(3);
      expect(requests[1]!.tools).toContainEqual(expect.objectContaining(definition));
      expect(callMcpTool).toHaveBeenCalledWith(
        expect.objectContaining({ name: definition.name, arguments: { key: '57' } }),
        expect.any(AbortSignal),
        expect.objectContaining({ sessionId: session.id })
      );
      expect(requests[2]!.messages).toContainEqual(
        expect.objectContaining({ role: 'tool', content: 'fixture-record-57' })
      );
    } else {
      expect(requests).toHaveLength(1);
      expect(callMcpTool).not.toHaveBeenCalled();
    }
    if (scenario.hasCatalog) expect(listCatalog).toHaveBeenCalled();
    else expect(listCatalog).not.toHaveBeenCalled();
    if (scenario.hasList && !scenario.hasCatalog) expect(listTools).toHaveBeenCalled();
    else expect(listTools).not.toHaveBeenCalled();
  } finally {
    await agent?.dispose();
    await local.dispose();
    await rm(home, { recursive: true, force: true });
  }
});
