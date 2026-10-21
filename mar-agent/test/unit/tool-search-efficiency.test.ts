import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import type { McpToolCatalog } from '../../src/agent-core/sdk/types.js';
import { countModelTokens } from '../../src/agent-core/runtime/token-budget.js';
import {
  DeferredMcpRegistry,
  TOOL_SEARCH_LIMITS,
  toolSearchToolDefinition
} from '../../src/agent-core/tools/mcp/tool-search.js';

describe('bounded MCP catalog efficiency', () => {
  it.each([100, 1000, 10_000])('keeps initial schemas stable for %i remote tools', async (size) => {
    const catalog: McpToolCatalog = {
      revision: `size-${size}`,
      servers: [
        { id: 'remote', name: 'Inventory catalog', instructions: 'Search inventory records.' }
      ],
      tools: Array.from({ length: size }, (_, index) => ({
        definition: {
          name: `mcp__inventory__read_record_${index}`,
          description: `Read inventory record ${index}. ${'Validate the record before returning its data. '.repeat(8)}`,
          inputSchema: {
            type: 'object',
            properties: { record: { type: 'string', description: 'Inventory record identifier.' } },
            required: ['record'],
            additionalProperties: false
          }
        },
        serverId: 'remote',
        rawName: `read_record_${index}`,
        sourceIdentity: 'installation:inventory',
        definitionRevision: 'v1',
        lifetime: 'session',
        exposure: 'deferred'
      }))
    };
    const registry = new DeferredMcpRegistry([]);
    const start = performance.now();
    registry.update(catalog, () => true);
    const indexedMs = performance.now() - start;
    const baseline = [toolSearchToolDefinition];
    expect(registry.project(baseline)).toEqual(baseline);
    const beforeTokens = countModelTokens(JSON.stringify(registry.project(baseline)));
    expect(Buffer.byteLength(registry.navigation()!, 'utf8')).toBeLessThanOrEqual(
      TOOL_SEARCH_LIMITS.catalogBytes
    );
    expect(registry.navigation()).toContain('Inventory catalog');
    const target = catalog.tools.at(-1)!;
    const searchStart = performance.now();
    const result = await registry.expose(
      { query: target.definition.name },
      {
        signal: new AbortController().signal,
        base: baseline,
        window: 200_000,
        system: 'Stable system prefix.',
        persist: async () => undefined
      }
    );
    const searchMs = performance.now() - searchStart;
    expect(result.data).toEqual({ tools: [target.definition.name] });
    expect(registry.project(baseline)).toHaveLength(2);
    const activeTokens = countModelTokens(JSON.stringify(registry.project(baseline)));
    expect(activeTokens - beforeTokens).toBeLessThan(1000);
    const warmStart = performance.now();
    registry.update(catalog, () => true);
    const warmUpdateMs = performance.now() - warmStart;
    expect(registry.project(baseline)).toHaveLength(2);
    const fuzzyStart = performance.now();
    expect(registry.search('inventory record', 5)).toHaveLength(5);
    const fuzzyMs = performance.now() - fuzzyStart;
    console.info(
      'MCP_EFFICIENCY',
      JSON.stringify({
        size,
        indexedMs,
        warmUpdateMs,
        searchMs,
        fuzzyMs,
        beforeTokens,
        activeTokens,
        allDefinitionTokens: countModelTokens(
          JSON.stringify(catalog.tools.map((tool) => tool.definition))
        ),
        navigationBytes: Buffer.byteLength(registry.navigation()!, 'utf8')
      })
    );
  });
});
