import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertMcpToolCatalog,
  assertMcpToolDefinition,
  LocalAgentHost,
  SecretValue,
  type MarAgentModelConfiguration,
  type McpToolCatalog
} from '../../src/index.js';
import { createMarAgentWithAdapter } from '../../src/agent-core/sdk/agent.js';
import type {
  ModelAdapter,
  ModelEvent,
  ModelRequest
} from '../../src/agent-core/model/contracts.js';
import { DeferredMcpRegistry } from '../../src/agent-core/tools/mcp/tool-search.js';

const definition = {
  name: 'mcp__fixture__lookup',
  description: 'Read a fixture record.',
  inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] }
};

function catalog(): McpToolCatalog {
  return {
    revision: 'one',
    servers: [{ id: 'fixture', name: 'Fixture' }],
    tools: [
      {
        definition,
        serverId: 'fixture',
        rawName: 'lookup',
        sourceIdentity: 'fixture-installation',
        definitionRevision: 'definition-one',
        lifetime: 'session',
        exposure: 'deferred'
      }
    ]
  };
}

function invalidCode(action: () => void): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('Expected an invalid MCP catalog error.');
}

describe('MCP catalog validation boundary', () => {
  it('accepts only the supported trusted Code Mode exposure override', () => {
    expect(() =>
      assertMcpToolDefinition({ ...definition, codeModeExposure: 'both' })
    ).not.toThrow();
    for (const codeModeExposure of ['only', false, null])
      expect(
        invalidCode(() => assertMcpToolDefinition({ ...definition, codeModeExposure }))
      ).toMatchObject({ code: 'MAR_AGENT_MCP_CATALOG_INVALID' });
  });

  it('rejects malformed, deeply nested, oversized-definition, and oversized-catalog input', () => {
    const base = catalog();
    const malformed = {
      ...base,
      tools: [
        {
          ...base.tools[0]!,
          definition: {
            ...definition,
            inputSchema: { type: 'object', properties: { key: null } }
          }
        }
      ]
    };
    expect(invalidCode(() => assertMcpToolCatalog(malformed))).toMatchObject({
      code: 'MAR_AGENT_MCP_CATALOG_INVALID'
    });
    expect(
      invalidCode(() =>
        assertMcpToolDefinition({
          ...definition,
          inputSchema: { type: 'object', properties: {}, extension: 'x'.repeat(256 * 1024) }
        })
      )
    ).toMatchObject({ code: 'MAR_AGENT_MCP_CATALOG_INVALID' });
    expect(
      invalidCode(() =>
        assertMcpToolDefinition({
          ...definition,
          inputSchema: {
            type: 'object',
            properties: {},
            extension: Array.from({ length: 32_768 }, (_, index) => index)
          }
        })
      )
    ).toMatchObject({ code: 'MAR_AGENT_MCP_CATALOG_INVALID' });

    const overlongMetadata = {
      ...base,
      servers: [{ id: 'fixture', name: 'Fixture', instructions: '巡'.repeat(65_537) }]
    };
    expect(invalidCode(() => assertMcpToolCatalog(overlongMetadata))).toMatchObject({
      code: 'MAR_AGENT_MCP_CATALOG_INVALID'
    });

    let deepSchema: unknown = { type: 'string' };
    for (let depth = 0; depth < 65; depth++)
      deepSchema = { type: 'object', properties: { child: deepSchema } };
    const deeplyNested = {
      ...base,
      tools: [
        {
          ...base.tools[0]!,
          definition: { ...definition, inputSchema: deepSchema }
        }
      ]
    };
    expect(invalidCode(() => assertMcpToolCatalog(deeplyNested))).toMatchObject({
      code: 'MAR_AGENT_MCP_CATALOG_INVALID'
    });

    const oversizedCatalog = {
      revision: 'large',
      servers: Array.from({ length: 256 }, (_, index) => ({
        id: `server-${index}`,
        name: 'fixture',
        description: 'x'.repeat(65_536)
      })),
      tools: []
    };
    expect(invalidCode(() => assertMcpToolCatalog(oversizedCatalog))).toMatchObject({
      code: 'MAR_AGENT_MCP_CATALOG_INVALID'
    });
  });

  it('rejects undeclared metadata and cyclic JSON extensions while retaining bounded Schema extensions', () => {
    const base = catalog();
    for (const malformed of [
      { ...base, unexpected: true },
      { ...base, servers: [{ ...base.servers[0]!, unexpected: true }] },
      { ...base, tools: [{ ...base.tools[0]!, unexpected: true }] }
    ]) {
      expect(invalidCode(() => assertMcpToolCatalog(malformed))).toMatchObject({
        code: 'MAR_AGENT_MCP_CATALOG_INVALID'
      });
    }

    const cyclicExtension: Record<string, unknown> = {};
    cyclicExtension['self'] = cyclicExtension;
    const cyclicDefinition = {
      ...definition,
      inputSchema: {
        type: 'object',
        properties: {},
        'x-vendor': cyclicExtension
      }
    };
    expect(invalidCode(() => assertMcpToolDefinition(cyclicDefinition))).toMatchObject({
      code: 'MAR_AGENT_MCP_CATALOG_INVALID'
    });

    const extensionSchema = {
      type: 'object',
      properties: {},
      'x-vendor': { examples: [{ key: 'retained' }] }
    };
    expect(() =>
      assertMcpToolDefinition({ ...definition, inputSchema: extensionSchema })
    ).not.toThrow();
    expect(extensionSchema['x-vendor']).toEqual({ examples: [{ key: 'retained' }] });
  });

  it('keeps the last valid registry directory when Host catalog validation fails', () => {
    const current = catalog();
    const registry = new DeferredMcpRegistry([]);
    registry.update(current, () => true);
    const before = registry.project([]);
    const invalid = {
      ...current,
      revision: 'invalid',
      tools: [
        {
          ...current.tools[0]!,
          definition: {
            ...definition,
            inputSchema: { type: 'object', properties: { key: null } }
          }
        }
      ]
    };

    expect(invalidCode(() => registry.update(invalid, () => true))).toMatchObject({
      code: 'MAR_AGENT_MCP_CATALOG_INVALID'
    });
    expect(registry.project([])).toEqual(before);
    expect(registry.search('fixture lookup', 5)).toHaveLength(1);
  });

  it('returns a stable catalog error for malformed runtime Host data instead of TypeError', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-mcp-catalog-host-'));
    const invalid = {
      ...catalog(),
      tools: [
        {
          ...catalog().tools[0]!,
          definition: {
            ...definition,
            inputSchema: { type: 'object', properties: { key: null } }
          }
        }
      ]
    } as unknown as McpToolCatalog;
    const model: MarAgentModelConfiguration = {
      id: 'fixture-model',
      name: 'Fixture model',
      protocol: 'ANTHROPIC_MESSAGES',
      baseUrl: 'https://example.invalid',
      apiKey: new SecretValue('fixture-only'),
      modelId: 'fixture',
      contextWindowTokens: 32_000,
      maxOutputTokens: 1024,
      inputCapabilities: ['TEXT'],
      outputCapabilities: ['TEXT'],
      reasoningEfforts: [],
      defaultReasoningEffort: 'medium',
      hostedWebSearch: false,
      responsesPreviousResponseId: false,
      enabled: true
    };
    class NoopAdapter implements ModelAdapter {
      readonly configuration = model;
      requests = 0;
      async *start(_request: ModelRequest): AsyncIterable<ModelEvent> {
        this.requests++;
        yield { type: 'text.completed', itemId: 'answer', text: 'unexpected' };
        yield { type: 'completed', reason: 'completed' };
      }
    }
    const adapter = new NoopAdapter();
    const host = new LocalAgentHost({
      homeDirectory: home,
      workspace: home,
      mcpCatalog: () => invalid,
      callMcp: async () => ({ content: 'unused' })
    });
    const agent = await createMarAgentWithAdapter({
      mode: 'normal',
      host,
      models: [model],
      defaultModelId: model.id,
      adapterFactory: () => adapter
    });
    try {
      const session = await agent.createSession({ workspace: home, title: 'Catalog validation' });
      expect(await session.run({ prompt: 'Start.' }).result()).toMatchObject({
        status: 'failed',
        errorCode: 'MAR_AGENT_MCP_CATALOG_INVALID'
      });
      expect(adapter.requests).toBe(0);
    } finally {
      await agent.dispose();
      await rm(home, { recursive: true, force: true });
    }
  });
});
