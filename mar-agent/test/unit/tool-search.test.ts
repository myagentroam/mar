import { describe, expect, it } from 'vitest';
import {
  DeferredMcpRegistry,
  parseToolSearchInput
} from '../../src/agent-core/tools/mcp/tool-search.js';
import type { McpCatalogTool, McpToolCatalog } from '../../src/agent-core/sdk/types.js';
import {
  codeModeToolDefinition,
  projectCodeModeTools
} from '../../src/agent-core/tools/code-mode/index.js';

function catalog(): McpToolCatalog {
  return {
    revision: 'one',
    servers: [{ id: 'sentry', name: 'sentry', description: 'Production errors and traces' }],
    tools: ['get_trace', 'search_errors'].map((name) => ({
      definition: {
        name: `mcp__sentry__${name}`,
        description:
          name === 'get_trace' ? 'Read production trace spans' : 'Search production errors',
        inputSchema: { type: 'object', properties: {} }
      },
      rawName: name,
      serverId: 'sentry',
      sourceIdentity: 'installation-one',
      definitionRevision: name,
      lifetime: 'session',
      exposure: 'deferred'
    }))
  };
}

function generatedCatalog(
  count: number,
  options: {
    readonly longSelectors?: boolean;
    readonly sourceIdentity?: (index: number) => string;
  } = {}
): McpToolCatalog {
  const tools: McpCatalogTool[] = Array.from({ length: count }, (_, index) => {
    const suffix = String(index).padStart(4, '0');
    const name = options.longSelectors
      ? `mcp__s__${suffix}${'n'.repeat(244)}`
      : `mcp__s__tool_${suffix}`;
    return {
      definition: {
        name,
        description: `Tool ${suffix}`,
        inputSchema: { type: 'object', properties: {} }
      },
      rawName: `tool_${suffix}`,
      serverId: 's',
      sourceIdentity: options.sourceIdentity?.(index) ?? `source-${suffix}`,
      definitionRevision: `revision-${suffix}`,
      lifetime: 'session',
      exposure: 'deferred'
    };
  });
  return { revision: `generated-${count}`, servers: [{ id: 's', name: 'server' }], tools };
}
function exposureContext() {
  return {
    signal: new AbortController().signal,
    base: [],
    window: 1_000_000,
    system: ''
  };
}

describe('deferred tool search', () => {
  it('stabilizes resident catalogs and navigation across source enumeration order', () => {
    const value = catalog();
    const other = {
      ...value.tools[0]!,
      serverId: 'other',
      definition: { ...value.tools[0]!.definition, name: 'mcp__other__lookup' }
    };
    const direct = {
      ...value.tools[0]!,
      exposure: 'direct' as const,
      definition: { ...value.tools[0]!.definition, name: 'mcp__sentry__direct' }
    };
    const tools = [...value.tools, other, direct];
    const servers = [...value.servers, { id: 'other', name: 'Other' }];
    const base = ['zeta', 'alpha'].map((name) => ({ ...direct.definition, name }));
    const registry = new DeferredMcpRegistry([]);
    registry.update({ ...value, servers, tools }, () => true);
    const navigation = registry.navigation();
    const projected = JSON.stringify(registry.project(base));
    registry.update(
      { ...value, servers: [...servers].reverse(), tools: [...tools].reverse() },
      () => true
    );
    expect(registry.navigation()).toBe(navigation);
    expect(JSON.stringify(registry.project([...base].reverse()))).toBe(projected);
    expect(base.map((tool) => tool.name)).toEqual(['zeta', 'alpha']);
  });

  it('budgets deferred schemas even when Only mode keeps its description unchanged', async () => {
    const registry = new DeferredMcpRegistry([]);
    const value = catalog();
    const tool = value.tools[0]!;
    registry.update(
      {
        ...value,
        tools: [
          {
            ...tool,
            definition: { ...tool.definition, description: 'x'.repeat(20_000) }
          }
        ]
      },
      () => true
    );
    const base = [codeModeToolDefinition];
    await expect(
      registry.expose(
        { query: tool.definition.name },
        {
          ...exposureContext(),
          base,
          window: 10_000
        }
      )
    ).rejects.toMatchObject({ code: 'MAR_AGENT_TOOL_EXPOSURE_LIMIT' });
    expect(registry.snapshot()).toEqual([]);
    const before = projectCodeModeTools(registry.project(base), registry.projectDirect(base));
    await registry.expose({ query: tool.definition.name }, { ...exposureContext(), base });
    expect(projectCodeModeTools(registry.project(base), registry.projectDirect(base))).toEqual(
      before
    );
  });
  it('accepts bounded inputs and rejects unknown fields', () => {
    expect(parseToolSearchInput({ query: ' get_trace ' })).toEqual({
      query: ' get_trace ',
      limit: 5
    });
    for (const input of [
      { query: ' ' },
      { query: 'a', limit: 0 },
      { query: 'a', limit: 1.5 },
      { query: 'a', limit: 21 },
      { query: 'a', server: 'sentry' },
      { query: 'a'.repeat(4097) }
    ])
      expect(() => parseToolSearchInput(input)).toThrow('MAR_AGENT_TOOL_INPUT_INVALID');
  });

  it('exactly selects only a full callable name and searches raw names normally', () => {
    const registry = new DeferredMcpRegistry([]);
    registry.update(catalog(), () => true);
    expect(
      registry.search('mcp__sentry__get_trace', 1).map((tool) => tool.definition.name)
    ).toEqual(['mcp__sentry__get_trace']);
    expect(registry.search('production errors', 1)[0]?.definition.name).toBe(
      'mcp__sentry__search_errors'
    );
    expect(registry.search('unrelatedword', 5)).toEqual([]);

    const spaced = parseToolSearchInput({
      query: ' mcp__sentry__get_trace ',
      limit: 2
    });
    expect(spaced).toEqual({ query: ' mcp__sentry__get_trace ', limit: 2 });
    const candidates = registry
      .search(spaced.query, spaced.limit)
      .map((tool) => tool.definition.name);
    expect(candidates).toHaveLength(2);
    expect(candidates).toContain('mcp__sentry__get_trace');
  });

  it('does not search tools that are already direct', async () => {
    const value = catalog();
    const direct = { ...value.tools[0]!, exposure: 'direct' as const };
    const registry = new DeferredMcpRegistry([]);
    registry.update({ ...value, tools: [direct, value.tools[1]!] }, () => true);
    const result = await registry.expose(
      { query: direct.definition.name, limit: 20 },
      exposureContext()
    );
    expect(result.data).toEqual({ tools: [] });
    expect(registry.snapshot()).toEqual([]);
    expect(registry.project([]).map((tool) => tool.name)).toEqual([direct.definition.name]);
  });

  it('appends selection once and rejects budget failures atomically', async () => {
    const registry = new DeferredMcpRegistry([]);
    registry.update(catalog(), () => true);
    const context = exposureContext();
    expect(registry.project([])).toEqual([]);
    await registry.expose({ query: 'mcp__sentry__get_trace' }, context);
    await registry.expose({ query: 'mcp__sentry__get_trace' }, context);
    expect(registry.project([])).toHaveLength(1);
    await expect(
      registry.expose(
        { query: 'production' },
        {
          ...context,
          window: 1
        }
      )
    ).rejects.toMatchObject({ code: 'MAR_AGENT_TOOL_EXPOSURE_LIMIT' });
    expect(registry.project([])).toHaveLength(1);
    const restored = new DeferredMcpRegistry(registry.snapshot());
    restored.update(catalog(), () => true);
    expect(restored.project([])).toHaveLength(1);
    restored.update(
      {
        ...catalog(),
        tools: catalog().tools.map((tool) => ({
          ...tool,
          sourceIdentity: 'replacement'
        }))
      },
      () => true
    );
    expect(restored.project([])).toHaveLength(1);
  });

  it('does not persist execution tools and filters scope before search', async () => {
    const registry = new DeferredMcpRegistry([]);
    registry.update(
      {
        ...catalog(),
        tools: catalog().tools.map((tool) => ({
          ...tool,
          lifetime: 'execution'
        }))
      },
      (tool) => tool.definition.name.endsWith('get_trace')
    );
    expect(registry.search('errors', 5)).toHaveLength(1);
    await registry.expose(
      { query: 'mcp__sentry__get_trace' },
      {
        ...exposureContext()
      }
    );
    expect(registry.snapshot()).toEqual([]);
    expect(registry.project([])).toHaveLength(1);
    const names = [catalog().tools[0]!.definition.name];
    expect(registry.restoredDefinitions(names)).toHaveLength(1);
    const nextExecution = new DeferredMcpRegistry(names);
    nextExecution.update(
      { ...catalog(), tools: catalog().tools.map((tool) => ({ ...tool, lifetime: 'execution' })) },
      () => true
    );
    nextExecution.restore(names);
    expect(nextExecution.project([])).toEqual([]);
    expect(nextExecution.restoredDefinitions(names)).toEqual([]);
  });

  it('retains only current-Execution discoveries with surviving GC evidence and never revives removed discoveries', async () => {
    const current = generatedCatalog(4);
    const tools = current.tools.map((tool, index) => ({
      ...tool,
      lifetime: index === 0 ? ('session' as const) : ('execution' as const)
    }));
    const registry = new DeferredMcpRegistry([]);
    registry.update({ ...current, tools }, () => true);
    const names = tools.map((tool) => tool.definition.name);
    for (const query of names.slice(0, 3)) await registry.expose({ query }, exposureContext());
    registry.restore([names[0]!, names[1]!, names[3]!]);
    expect(registry.project([]).map((tool) => tool.name)).toEqual(names.slice(0, 2));
    expect(registry.restoredDefinitions(names).map((tool) => tool.name)).toEqual(names.slice(0, 2));
    expect(registry.snapshot()).toEqual([names[0]]);
    registry.restore(names);
    expect(registry.project([]).map((tool) => tool.name)).toEqual(names.slice(0, 2));
    registry.update(
      {
        ...current,
        revision: 'revoked',
        tools: tools.filter((tool) => tool.definition.name !== names[1])
      },
      () => true
    );
    registry.restore(names);
    expect(registry.restoredDefinitions(names).map((tool) => tool.name)).toEqual([names[0]]);
    registry.restore([]);
    expect(registry.project([])).toEqual([]);
    expect(registry.restoredDefinitions(names)).toEqual([]);
  });

  it('indexes bounded long Chinese metadata and keeps Chinese BM25 matching', () => {
    const value = catalog();
    const prefix = '设备错误恢复';
    const instructions =
      prefix +
      '巡检告警'.repeat(Math.ceil((65_536 - prefix.length) / 4)).slice(0, 65_536 - prefix.length);
    expect(instructions.length).toBe(65_536);
    const registry = new DeferredMcpRegistry([]);
    registry.update(
      {
        ...value,
        servers: [{ ...value.servers[0]!, instructions }]
      },
      () => true
    );

    expect(registry.search('设备错误', 5).map((tool) => tool.definition.name)).toContain(
      'mcp__sentry__get_trace'
    );
  });

  it('caps indexed server and per-tool metadata tokens', () => {
    const value = catalog();
    const registry = new DeferredMcpRegistry([]);
    registry.update(
      {
        ...value,
        servers: [
          {
            id: 'sentry',
            name: 'sentry',
            instructions: Array.from(
              { length: 300 },
              (_, index) => `serverword${String(index).padStart(3, '0')}`
            ).join(' ')
          }
        ],
        tools: value.tools.map((tool, index) => ({
          ...tool,
          definition: {
            ...tool.definition,
            description:
              index === 0
                ? Array.from(
                    { length: 4_000 },
                    (_, token) => `toolword${String(token).padStart(4, '0')}`
                  ).join(' ')
                : tool.definition.description
          }
        }))
      },
      () => true
    );

    expect(registry.search('serverword254', 5).map((tool) => tool.definition.name)).toContain(
      'mcp__sentry__get_trace'
    );
    expect(registry.search('serverword255', 5)).toEqual([]);
    expect(registry.search('toolword3500', 5).map((tool) => tool.definition.name)).toContain(
      'mcp__sentry__get_trace'
    );
    expect(registry.search('toolword3999', 5)).toEqual([]);
  });

  it('keeps complete navigation names and reports every omitted tool', () => {
    const value = generatedCatalog(100, { longSelectors: true });
    const registry = new DeferredMcpRegistry([]);
    registry.update(
      {
        ...value,
        servers: [
          {
            id: 's',
            name: 'Important records',
            description: 'Searchable records from the fixture server.'
          }
        ]
      },
      () => true
    );

    const navigation = registry.navigation();
    expect(navigation).toBeDefined();
    const rows = navigation!.split('\n').filter((line) => line.startsWith('- '));
    const names = value.tools.map((tool) => tool.definition.name);
    expect(rows.every((line) => names.includes(line.slice(2)))).toBe(true);
    expect(Buffer.byteLength(navigation!, 'utf8')).toBeLessThanOrEqual(16 * 1024);
    expect(navigation).toMatch(
      new RegExp(
        `${names.length - rows.length} tool names omitted; the complete catalog remains searchable\\.`
      )
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(names.length);

    const titleIndex = navigation!.indexOf('Important records');
    const summaryIndex = navigation!.indexOf('Searchable records from the fixture server.');
    const firstToolIndex = navigation!.indexOf(rows[0]!);
    expect(titleIndex).toBeGreaterThanOrEqual(0);
    expect(summaryIndex).toBeGreaterThanOrEqual(0);
    expect(titleIndex).toBeLessThan(summaryIndex);
    expect(summaryIndex).toBeLessThan(firstToolIndex);
  });

  it('keeps the prior schema prefix and projects deferred tools in first-selection order', async () => {
    const value = catalog();
    const template = value.tools[0]!;
    const makeTool = (
      name: string,
      lifetime: 'session' | 'execution',
      exposure: 'direct' | 'deferred'
    ): McpCatalogTool => ({
      ...template,
      definition: { ...template.definition, name, description: name },
      rawName: name.slice(name.lastIndexOf('__') + 2),
      lifetime,
      exposure
    });
    const sessionAlpha = makeTool('mcp__sentry__alpha', 'session', 'deferred');
    const sessionZeta = makeTool('mcp__sentry__zeta', 'session', 'deferred');
    const executionAlpha = makeTool('mcp__sentry__execution_alpha', 'execution', 'deferred');
    const executionZeta = makeTool('mcp__sentry__execution_zeta', 'execution', 'deferred');
    const direct = makeTool('mcp__sentry__direct', 'session', 'direct');
    const registry = new DeferredMcpRegistry([]);
    registry.update(
      {
        ...value,
        tools: [sessionAlpha, sessionZeta, executionAlpha, executionZeta, direct]
      },
      () => true
    );

    const context = exposureContext();
    for (const query of [
      'mcp__sentry__zeta',
      'mcp__sentry__execution_zeta',
      'mcp__sentry__alpha',
      'mcp__sentry__execution_alpha'
    ])
      await registry.expose({ query }, context);

    const base = [
      { ...template.definition, name: 'prior_schema_one' },
      { ...template.definition, name: 'prior_schema_two' }
    ];
    expect(registry.project(base).map((tool) => tool.name)).toEqual([
      'mcp__sentry__direct',
      'prior_schema_one',
      'prior_schema_two',
      'mcp__sentry__zeta',
      'mcp__sentry__alpha',
      'mcp__sentry__execution_zeta',
      'mcp__sentry__execution_alpha'
    ]);
  });

  it('keeps one discovered canonical name across current source revisions', async () => {
    const registry = new DeferredMcpRegistry([]);
    const context = exposureContext();
    const name = 'mcp__sentry__get_trace';

    for (let generation = 0; generation < 100; generation++) {
      const next = {
        ...catalog(),
        revision: `source-${generation}`,
        tools: catalog().tools.map((tool) => ({
          ...tool,
          sourceIdentity: `installation-${generation}`,
          definitionRevision: `definition-${generation}`
        }))
      };
      registry.update(next, () => true);
      await registry.expose({ query: name }, context);
      expect(registry.snapshot()).toHaveLength(1);
    }

    expect(registry.snapshot()).toEqual([name]);
  });

  it('never evicts an existing discovery when a new batch exceeds the budget', async () => {
    const registry = new DeferredMcpRegistry([]);
    registry.update(catalog(), () => true);
    await registry.expose({ query: 'mcp__sentry__get_trace' }, exposureContext());
    await expect(
      registry.expose({ query: 'mcp__sentry__search_errors' }, { ...exposureContext(), window: 1 })
    ).rejects.toMatchObject({ code: 'MAR_AGENT_TOOL_EXPOSURE_LIMIT' });
    expect(registry.snapshot()).toEqual(['mcp__sentry__get_trace']);
  });
});
