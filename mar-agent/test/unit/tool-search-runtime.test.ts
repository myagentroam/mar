import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalAgentHost, type McpToolCatalog } from '../../src/host.js';
import { SecretValue, type AgentModelConfiguration } from '../../src/index.js';
import { AgentError } from '../../src/error.js';
import { anthropicMessages } from '../../src/model/anthropic-messages.js';
import { openAiInput } from '../../src/model/responses-request.js';
import { createAgentWithAdapter } from '../../src/sdk/agent.js';
import { JsonlSessionStore } from '../../src/session/store/index.js';
import type { AgentExtension } from '../../src/extensions/contracts.js';
import type {
  ModelAdapter,
  ModelEvent,
  ModelRequest,
  ToolCaller
} from '../../src/model/contracts.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});
const model: AgentModelConfiguration = {
  id: 'fake',
  name: 'Fake',
  protocol: 'ANTHROPIC_MESSAGES',
  baseUrl: 'https://example.test',
  apiKey: new SecretValue('fixture'),
  modelId: 'fake',
  contextWindowTokens: 100000,
  maxOutputTokens: 4096,
  inputCapabilities: ['TEXT'],
  outputCapabilities: ['TEXT'],
  reasoningEfforts: [],
  defaultReasoningEffort: 'medium',
  hostedWebSearch: false,
  responsesPreviousResponseId: false,
  enabled: true
};
const externalName = 'mcp__external__lookup';
const programmaticOnlyName = 'mcp__external__programmatic';
const internalName = 'mcp__builtin__status';
const searchInCell = (name: string) => ({
  name: 'code_exec',
  arguments: { code: `await tools.tool_search({ query: ${JSON.stringify(name)} });` }
});
function catalog({
  externalExposure = 'deferred',
  externalCallers = ['direct', 'programmatic']
}: {
  externalExposure?: 'direct' | 'deferred';
  externalCallers?: readonly ToolCaller[] | null;
} = {}): McpToolCatalog {
  return {
    revision: 'v1',
    servers: [
      { id: 'external', name: 'External', description: 'Lookup records' },
      { id: 'builtin', name: 'Builtin' }
    ],
    tools: [
      {
        name: externalName,
        description: 'Private detailed lookup documentation',
        serverId: 'external',
        rawName: 'lookup',
        sourceIdentity: externalName,
        definitionRevision: 'one',
        lifetime: 'session',
        exposure: externalExposure,
        allowedCallers: externalCallers
      },
      {
        name: programmaticOnlyName,
        description: 'Programmatic-only internal resolver.',
        serverId: 'external',
        rawName: 'programmatic',
        sourceIdentity: programmaticOnlyName,
        definitionRevision: 'one',
        lifetime: 'session',
        exposure: 'deferred',
        allowedCallers: ['programmatic']
      },
      {
        name: internalName,
        description: 'Status',
        serverId: 'builtin',
        rawName: 'lookup',
        sourceIdentity: internalName,
        definitionRevision: 'one',
        lifetime: 'session',
        exposure: 'direct',
        allowedCallers: ['direct', 'programmatic']
      }
    ].map(({ allowedCallers, ...tool }) => ({
      definition: {
        name: tool.name,
        description: tool.description,
        inputSchema: {
          type: 'object',
          properties: { record: { type: 'string' } },
          required: ['record']
        },
        ...(allowedCallers === null ? {} : { allowedCallers })
      },
      serverId: tool.serverId,
      rawName: tool.rawName,
      sourceIdentity: tool.sourceIdentity,
      definitionRevision: tool.definitionRevision,
      lifetime: tool.lifetime,
      exposure: tool.exposure
    }))
  };
}
class Adapter implements ModelAdapter {
  constructor(
    readonly configuration: AgentModelConfiguration = model,
    private readonly callPrefix = 'call'
  ) {}
  readonly requests: ModelRequest[] = [];
  readonly batches: Array<Array<{ name: string; arguments: unknown }>> = [];
  rejectDiscoveryOnce = false;
  async *start(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    if (
      this.rejectDiscoveryOnce &&
      request.toolChoice !== 'none' &&
      request.messages.some((m) => m.mcpDiscovery)
    ) {
      this.rejectDiscoveryOnce = false;
      throw new AgentError('context_length_exceeded', 'The request exceeds the context window.');
    }
    const calls = this.batches.shift() ?? [];
    for (const [index, call] of calls.entries())
      yield {
        type: 'client_tool.call',
        callId: `${this.callPrefix}-${this.requests.length}-${index}`,
        ...call
      };
    if (!calls.length)
      yield { type: 'text.completed', itemId: `answer-${this.requests.length}`, text: 'Done.' };
    yield { type: 'completed', reason: calls.length ? 'tool_use' : 'completed' };
  }
}
async function fixture(
  codeMode = false,
  catalogOptions?: Parameters<typeof catalog>[0],
  overrides: Partial<AgentModelConfiguration> = {},
  extensions: readonly AgentExtension[] = [],
  onMcpCall?: () => Promise<void>
) {
  const home = await mkdtemp(join(tmpdir(), 'mar-discovery-'));
  directories.push(home);
  let current = catalog(catalogOptions);
  let catalogReads = 0;
  const calls: string[] = [];
  const createHost = () =>
    new LocalAgentHost({
      homeDirectory: home,
      workspace: home,
      mcpCatalog: () => {
        catalogReads++;
        return current;
      },
      callMcp: async (call) => {
        calls.push(call.name);
        await onMcpCall?.();
        return { content: 'Record found.' };
      }
    });
  const host = createHost();
  const configuration = { ...model, ...overrides, codeMode };
  const adapter = new Adapter(configuration);
  const create = (activeHost = createHost()) =>
    createAgentWithAdapter(
      {
        mode: 'normal',
        host: activeHost,
        models: [configuration],
        defaultModelId: model.id,
        extensions
      },
      () => adapter
    );
  const agent = await create(host);
  const session = await agent.createSession({ workspace: home, title: 'Discovery test' });
  return {
    home,
    host,
    agent,
    create,
    session,
    adapter,
    calls,
    catalogReads: () => catalogReads,
    update: (value: McpToolCatalog) => {
      current = value;
    }
  };
}

describe('MCP discovery runtime', () => {
  it('runs unmarked external MCP calls concurrently after discovery', async () => {
    const release = Promise.withResolvers<void>();
    let entered = 0;
    const f = await fixture(false, undefined, {}, [], async () => {
      entered++;
      await release.promise;
    });
    try {
      f.adapter.batches.push(
        [{ name: 'tool_search', arguments: { query: externalName } }],
        [
          { name: externalName, arguments: { record: 'one' } },
          { name: externalName, arguments: { record: 'two' } }
        ]
      );
      const execution = f.session.run({ prompt: 'Discover and call independently.' });
      await expect.poll(() => entered, { timeout: 3000 }).toBe(2);
      release.resolve();
      expect((await execution.result()).status).toBe('completed');
    } finally {
      release.resolve();
      await f.agent.dispose();
    }
  }, 15000);

  it.each([
    ['OPENAI_RESPONSES', true, false],
    ['OPENAI_RESPONSES', true, true],
    ['OPENAI_RESPONSES', false, false],
    ['OPENAI_RESPONSES', false, true],
    ['ANTHROPIC_MESSAGES', false, false],
    ['ANTHROPIC_MESSAGES', false, true]
  ] as const)(
    'projects %s discovery before request hooks with native tools=%s and reinstatement=%s without losing execution bindings',
    async (protocol, nativeTools, reinstateDiscovered) => {
      const hookTools: string[][] = [];
      const f = await fixture(
        false,
        undefined,
        {
          protocol,
          responsesOptionalParameters: {
            nativeTools,
            reasoningEffort: false,
            reasoningSummary: false,
            textVerbosity: false,
            promptCacheKey: false
          }
        },
        [
          {
            id: 'inspect-discovery',
            apiVersion: '1.0',
            attachSession(context) {
              context.hooks.intercept('model.request', (request, _call, next) => {
                hookTools.push(request.tools.map((tool) => tool.name));
                const tools = request.tools.map((tool) => ({
                  ...tool,
                  description: 'Hook description'
                }));
                if (
                  reinstateDiscovered &&
                  hookTools.length > 1 &&
                  !tools.some((tool) => tool.name === externalName)
                )
                  tools.push(
                    catalog().tools.find((tool) => tool.definition.name === externalName)!
                      .definition
                  );
                return next({ ...request, tools });
              });
            }
          }
        ]
      );
      try {
        f.adapter.batches.push(
          [{ name: 'tool_search', arguments: { query: externalName } }],
          [{ name: externalName, arguments: { record: 'record' } }]
        );
        expect(
          await f.session.run({ prompt: 'Discover and call the deferred tool.' }).result()
        ).toMatchObject({ status: 'completed' });
        expect(hookTools).toHaveLength(3);
        expect(hookTools[0]).toContain(internalName);
        expect(hookTools[0]).not.toContain(externalName);
        for (const index of [1, 2]) {
          expect(hookTools[index]).toContain(internalName);
          expect(hookTools[index]!.includes(externalName)).toBe(protocol === 'ANTHROPIC_MESSAGES');
          const expectedNames = [...hookTools[index]!];
          if (reinstateDiscovered && !expectedNames.includes(externalName))
            expectedNames.push(externalName);
          expect(f.adapter.requests[index]!.tools.map((tool) => tool.name)).toEqual(expectedNames);
          expect(
            f.adapter.requests[index]!.tools.find((tool) => tool.name === internalName)?.description
          ).toBe('Hook description');
          expect(
            f.adapter.requests[index]!.messages.flatMap((message) => message.toolSearchTools ?? [])
          ).toContainEqual(expect.objectContaining({ name: externalName }));
        }
        expect(f.calls).toEqual([externalName]);
      } finally {
        await f.agent.dispose();
      }
    }
  );

  it.each([false, true])(
    'does not inherit execution-scoped discovery on a later Execution with Code Mode=%s',
    async (codeMode) => {
      const f = await fixture(codeMode);
      f.update({
        ...catalog(),
        tools: catalog().tools.map((tool) =>
          tool.definition.name === externalName ? { ...tool, lifetime: 'execution' } : tool
        )
      });
      const call = codeMode
        ? {
            name: 'code_exec',
            arguments: { code: `observe.text(await tools.${externalName}({record:"record"}));` }
          }
        : { name: externalName, arguments: { record: 'record' } };
      try {
        f.adapter.batches.push(
          [
            codeMode
              ? searchInCell(externalName)
              : { name: 'tool_search', arguments: { query: externalName } }
          ],
          [call]
        );
        expect(
          (await f.session.run({ prompt: 'Discover and use a tool for this Execution.' }).result())
            .status
        ).toBe('completed');
        expect(f.calls).toEqual([externalName]);
        f.adapter.batches.push([call]);
        const execution = f.session.run({ prompt: 'Try the old discovery without searching.' });
        const events = [];
        for await (const event of execution) events.push(event);
        expect((await execution.result()).status).toBe('completed');
        expect(f.calls).toEqual([externalName]);
        expect(events).toContainEqual(
          expect.objectContaining({ type: 'tool.failed', code: 'MAR_AGENT_TOOL_NOT_AVAILABLE' })
        );
        expect(
          f.adapter.requests
            .at(-1)!
            .messages.flatMap((message) => message.toolSearchTools ?? [])
            .some((tool) => tool.name === externalName)
        ).toBe(false);
        f.adapter.batches.push(
          [
            codeMode
              ? searchInCell(externalName)
              : { name: 'tool_search', arguments: { query: externalName } }
          ],
          [call]
        );
        expect(
          (await f.session.run({ prompt: 'Search again before using the tool.' }).result()).status
        ).toBe('completed');
        expect(f.calls).toEqual([externalName, externalName]);
      } finally {
        await f.agent.dispose();
      }
    }
  );

  it('keeps direct-only MCP discovered in a cell callable directly in Responses', async () => {
    const f = await fixture(
      true,
      { externalCallers: ['direct'] },
      { protocol: 'OPENAI_RESPONSES' }
    );
    try {
      f.adapter.batches.push(
        [searchInCell(externalName)],
        [{ name: externalName, arguments: { record: 'direct-only' } }],
        [
          {
            name: 'code_exec',
            arguments: { code: `await tools.${externalName}({record:"denied"});` }
          }
        ]
      );
      const execution = f.session.run({ prompt: 'Use the direct-only MCP.' });
      const events = [];
      for await (const event of execution) events.push(event);
      expect((await execution.result()).status).toBe('completed');
      expect(f.calls).toEqual([externalName]);
      const request = f.adapter.requests[1]!;
      expect(request.tools.map((tool) => tool.name)).toContain(externalName);
      expect(request.tools.find((tool) => tool.name === 'code_exec')!.description).not.toContain(
        externalName
      );
      expect(request.messages.find((message) => message.mcpDiscovery)?.content).toContain(
        '"caller":"direct"'
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'tool.failed',
          toolName: 'code_exec',
          code: 'MAR_AGENT_TOOL_NOT_AVAILABLE'
        })
      );
    } finally {
      await f.agent.dispose();
    }
  });

  it('does not enable a newly searched MCP inside a cell from the same response', async () => {
    const f = await fixture(true);
    const cell = {
      name: 'code_exec',
      arguments: { code: `observe.text(await tools.${externalName}({record:"visible"}));` }
    };
    try {
      f.adapter.batches.push([searchInCell(externalName), cell], [cell]);
      const execution = f.session.run({ prompt: 'Search, then call in the next response.' });
      const events = [];
      for await (const event of execution) events.push(event);
      expect((await execution.result()).status).toBe('completed');
      expect(f.calls).toEqual([externalName]);
      expect(events.filter((event) => event.type === 'tool.failed')).toEqual([
        expect.objectContaining({ toolName: 'code_exec', code: 'MAR_AGENT_TOOL_NOT_AVAILABLE' })
      ]);
      expect(f.adapter.requests[0]!.tools).toEqual(f.adapter.requests[1]!.tools);
    } finally {
      await f.agent.dispose();
    }
  });

  it.each([{ protocol: 'ANTHROPIC_MESSAGES' as const }, { protocol: 'OPENAI_RESPONSES' as const }])(
    'routes undeclared MCP through Code Mode Only after discovery: $protocol',
    async (overrides) => {
      const f = await fixture(true, { externalCallers: null }, overrides);
      try {
        f.adapter.batches.push(
          [{ name: 'tool_search', arguments: { query: externalName } }],
          [
            {
              name: 'code_exec',
              arguments: {
                code: `observe.text((await tools.${externalName}({ record: "cell" })).content);`
              }
            }
          ],
          [{ name: externalName, arguments: { record: 'direct' } }]
        );
        const execution = f.session.run({ prompt: 'Discover, then verify Code Mode Only.' });
        const events = [];
        for await (const event of execution) events.push(event);
        expect((await execution.result()).status).toBe('completed');
        expect(f.calls).toEqual([externalName, externalName]);
        expect(events.filter((event) => event.type === 'tool.failed')).toEqual([]);
        expect(
          f.adapter.requests[0]!.tools.find((tool) => tool.name === 'code_exec')!.description
        ).not.toContain(externalName);
        const request = f.adapter.requests[1]!;
        expect(request.tools.find((tool) => tool.name === 'code_exec')!.description).toBe(
          f.adapter.requests[0]!.tools.find((tool) => tool.name === 'code_exec')!.description
        );
        expect(request.messages.find((m) => m.toolSearchTools)?.content).toContain(
          'Private detailed lookup documentation'
        );
        expect(request.tools.some((tool) => tool.name === externalName)).toBe(false);
      } finally {
        await f.agent.dispose();
      }
    }
  );
  it('loads one frozen catalog per execution rather than once per model round', async () => {
    const f = await fixture();
    try {
      f.adapter.batches.push([{ name: 'tool_search', arguments: { query: externalName } }]);
      await f.session.run({ prompt: 'Find a tool.' }).result();
      expect(f.catalogReads()).toBe(1);
      await f.session.run({ prompt: 'Continue.' }).result();
      expect(f.catalogReads()).toBe(2);
    } finally {
      await f.agent.dispose();
    }
  });

  it('exposes a directly searched tool to the following Code Mode cell', async () => {
    const f = await fixture(true);
    try {
      f.adapter.batches.push(
        [{ name: 'tool_search', arguments: { query: externalName } }],
        [
          {
            name: 'code_exec',
            arguments: {
              code: `observe.text((await tools.${externalName}({ record: "visible" })).content);`
            }
          }
        ]
      );
      expect((await f.session.run({ prompt: 'Search, then read a record.' }).result()).status).toBe(
        'completed'
      );
      expect(f.calls).toEqual([externalName]);
      expect(f.adapter.requests[1]!.tools.some((tool) => tool.name === externalName)).toBe(false);
      const codeModeDescription = f.adapter.requests[1]!.tools.find(
        (tool) => tool.name === 'code_exec'
      )!.description;
      expect(codeModeDescription).not.toContain(externalName);
      expect(f.adapter.requests[1]!.messages.find((m) => m.toolSearchTools)?.content).toContain(
        externalName
      );
    } finally {
      await f.agent.dispose();
    }
  });

  it.each(['ANTHROPIC_MESSAGES', 'OPENAI_RESPONSES'] as const)(
    'loads tool discovery without observing the result and restores it after restart: %s',
    async (protocol) => {
      const f = await fixture(true, undefined, { protocol });
      let reopened: Awaited<ReturnType<typeof f.create>> | undefined;
      try {
        f.adapter.batches.push([
          {
            name: 'code_exec',
            arguments: {
              code: `const {data,content} = await tools.tool_search({query:${JSON.stringify(externalName)}});
            if (JSON.stringify(data) !== ${JSON.stringify(JSON.stringify({ tools: [externalName] }))} || content !== undefined) throw Error('unexpected search result');
            const miss = await tools.tool_search({query:'nothing_matches_this'});
            if (miss.data.tools.length !== 0) throw Error('unexpected match');
            if (catalog.tools().some(tool => tool.name === ${JSON.stringify(externalName)})) throw Error('cell directory changed');`
            }
          }
        ]);
        const events = [];
        const execution = f.session.run({ prompt: 'Try nested search.' });
        for await (const event of execution) events.push(event);
        expect((await execution.result()).status).toBe('completed');
        expect(f.calls).toEqual([]);
        expect(events.filter((event) => event.type === 'tool.failed')).toEqual([]);
        const [first, next] = f.adapter.requests;
        expect(first!.tools.map((tool) => tool.name)).not.toContain('tool_search');
        expect(first!.tools.find((tool) => tool.name === 'code_exec')?.description).toContain(
          'tools.tool_search'
        );
        const receipt = next!.messages.filter((message) => message.mcpDiscovery);
        expect(receipt).toHaveLength(1);
        expect(receipt[0]).toMatchObject({ role: 'user', contextKind: 'contextual' });
        expect(receipt[0]!.content).toContain('Private detailed lookup documentation');
        expect(next!.messages.some((message) => message.toolSearchTools)).toBe(false);
        const wire =
          protocol === 'OPENAI_RESPONSES'
            ? openAiInput(next!.messages, next!.images, f.adapter.configuration.id, false)
            : anthropicMessages(next!.messages, next!.images, next!.tools);
        const content = JSON.stringify(wire);
        expect(content).toContain('mcp_discovery');
        expect(content.indexOf('mcp_discovery')).toBeGreaterThan(
          content.indexOf(
            protocol === 'OPENAI_RESPONSES' ? 'custom_tool_call_output' : 'tool_result'
          )
        );
        await f.agent.dispose();
        f.update({
          ...catalog(),
          revision: 'after-restart',
          tools: catalog().tools.map((tool) =>
            tool.definition.name === externalName
              ? {
                  ...tool,
                  definitionRevision: 'updated',
                  definition: { ...tool.definition, description: 'Fresh lookup definition.' }
                }
              : tool
          )
        });
        reopened = await f.create();
        const session = await reopened.openSession(f.session.id);
        f.adapter.batches.push([
          {
            name: 'code_exec',
            arguments: { code: `await tools.${externalName}({record:'after restart'});` }
          }
        ]);
        const resumed = session.run({ prompt: 'Call the previously discovered tool.' });
        const failed = [];
        for await (const event of resumed) if (event.type === 'tool.failed') failed.push(event);
        expect(await resumed.result()).toMatchObject({ status: 'completed' });
        expect(failed).toEqual([]);
        expect(f.calls).toEqual([externalName]);
        expect(
          f.adapter.requests.at(-1)!.messages.find((message) => message.mcpDiscovery)?.content
        ).toContain('Fresh lookup definition.');
      } finally {
        await reopened?.dispose();
        await f.agent.dispose();
      }
    }
  );

  it.each(['OPENAI_RESPONSES', 'ANTHROPIC_MESSAGES'] as const)(
    'retries pending %s discovery after overflow without adding definitions to Compact',
    async (protocol) => {
      const f = await fixture(true, undefined, { protocol });
      try {
        f.adapter.rejectDiscoveryOnce = true;
        f.adapter.batches.push(
          [searchInCell(externalName)],
          [],
          [
            {
              name: 'code_exec',
              arguments: {
                code: `await tools.${externalName}({record:'after recovery'});`
              }
            }
          ]
        );
        expect(
          await f.session.run({ prompt: 'Discover and use the lookup.' }).result()
        ).toMatchObject({ status: 'completed' });
        const compact = f.adapter.requests.findIndex((request) => request.toolChoice === 'none');
        expect(compact).toBeGreaterThan(0);
        expect(f.adapter.requests[compact]!.messages.some((message) => message.mcpDiscovery)).toBe(
          false
        );
        expect(f.adapter.requests[compact]!.tools.map((tool) => tool.name)).not.toContain(
          externalName
        );
        expect(
          f.adapter.requests[compact + 1]!.messages.find((message) => message.mcpDiscovery)?.content
        ).toContain(externalName);
        expect(f.calls).toEqual([externalName]);
      } finally {
        await f.agent.dispose();
      }
    }
  );

  it('keeps a successful discovery even when the originating cell fails', async () => {
    const f = await fixture(true);
    try {
      const call = {
        name: 'code_exec',
        arguments: {
          code: `await tools.${externalName}({record:'next cell'});`
        }
      };
      f.adapter.batches.push(
        [
          {
            name: 'code_exec',
            arguments: {
              code: `await tools.tool_search({query:${JSON.stringify(externalName)}});
          await tools.${externalName}({record:'same cell'});`
            }
          }
        ],
        [call]
      );
      const execution = f.session.run({ prompt: 'Search before using the lookup.' });
      const failures = [];
      for await (const event of execution) if (event.type === 'tool.failed') failures.push(event);
      expect(await execution.result()).toMatchObject({ status: 'completed' });
      expect(failures).toEqual([
        expect.objectContaining({
          toolName: 'code_exec',
          code: 'MAR_AGENT_TOOL_NOT_AVAILABLE'
        })
      ]);
      expect(f.calls).toEqual([externalName]);
    } finally {
      await f.agent.dispose();
    }
  });

  it('delivers discovery from a retained cell to a later Execution', async () => {
    const waiting = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const f = await fixture(true, undefined, {}, [], async () => {
      waiting.resolve();
      await release.promise;
    });
    try {
      f.adapter.batches.push([
        {
          name: 'code_exec',
          arguments: {
            code: `
        await cell.yield_control();
        await tools.${internalName}({record:'pause'});
        await tools.tool_search({query:${JSON.stringify(externalName)}});`
          }
        }
      ]);
      expect(
        await f.session.run({ prompt: 'Start the background lookup.' }).result()
      ).toMatchObject({ status: 'completed' });
      await waiting.promise;
      const result = f.adapter.requests
        .at(-1)!
        .messages.findLast((message) => message.role === 'tool');
      const { cellId } = JSON.parse(result!.content);
      f.adapter.batches.push([{ name: 'code_exec_wait', arguments: { cellId } }]);
      const next = f.session.run({ prompt: 'Wait for discovery.' });
      for await (const event of next)
        if (event.type === 'tool.started' && event.toolName === 'code_exec_wait') release.resolve();
      expect(await next.result()).toMatchObject({ status: 'completed' });
      expect(
        f.adapter.requests.at(-1)!.messages.find((message) => message.mcpDiscovery)?.content
      ).toContain(externalName);
    } finally {
      release.resolve();
      await f.agent.dispose();
    }
  });

  it('retains an unconsumed background discovery through cold Compact but not after delivery', async () => {
    const waiting = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const f = await fixture(true, undefined, {}, [], async () => {
      waiting.resolve();
      await release.promise;
    });
    let agent = f.agent;
    const reopen = async () => {
      await agent.dispose();
      agent = await f.create();
      return agent.openSession(f.session.id);
    };
    const discoveries = (request: ModelRequest) =>
      request.messages.filter((message) => message.mcpDiscovery);
    try {
      f.adapter.batches.push([
        {
          name: 'code_exec',
          arguments: {
            code: `await cell.yield_control();
await tools.${internalName}({record:'pause'});
await tools.tool_search({query:${JSON.stringify(externalName)}});`
          }
        }
      ]);
      expect(await f.session.run({ prompt: 'Search in the background.' }).result()).toMatchObject({
        status: 'completed'
      });
      await waiting.promise;
      expect(f.adapter.requests.flatMap(discoveries)).toEqual([]);
      const store = await JsonlSessionStore.open(f.home);
      try {
        release.resolve();
        await vi.waitFor(async () => {
          expect(await store.read(f.session.id)).toContainEqual(
            expect.objectContaining({
              type: 'tool.completed',
              payload: expect.objectContaining({ toolName: 'tool_search' })
            })
          );
        });
      } finally {
        await store.close();
      }

      let session = await reopen();
      expect(await session.compact({}).result()).toMatchObject({ status: 'completed' });
      expect(discoveries(f.adapter.requests.at(-1)!)).toEqual([]);
      session = await reopen();
      expect(await session.compact({}).result()).toMatchObject({ status: 'completed' });
      f.adapter.batches.push([
        { name: 'code_exec', arguments: { code: `await tools.${externalName}({record:'found'});` } }
      ]);
      expect(await session.run({ prompt: 'Use the discovered tool.' }).result()).toMatchObject({
        status: 'completed'
      });
      expect(discoveries(f.adapter.requests.at(-1)!)).toHaveLength(1);
      expect(f.calls).toEqual([internalName, externalName]);

      session = await reopen();
      expect(await session.compact({}).result()).toMatchObject({ status: 'completed' });
      expect(await session.run({ prompt: 'Continue.' }).result()).toMatchObject({
        status: 'completed'
      });
      expect(discoveries(f.adapter.requests.at(-1)!)).toEqual([]);
    } finally {
      release.resolve();
      await agent.dispose();
    }
  });

  it('rebuilds a candidate when a retained cell discovers a tool during a request hook', async () => {
    const waiting = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let onCandidate: (() => Promise<void>) | undefined;
    const f = await fixture(
      true,
      undefined,
      {},
      [
        {
          id: 'synchronize-discovery',
          apiVersion: '1.0',
          attachSession(context) {
            context.hooks.intercept('model.request', async (request, _call, next) => {
              const wait = onCandidate;
              onCandidate = undefined;
              await wait?.();
              return next(request);
            });
          }
        }
      ],
      async () => {
        waiting.resolve();
        await release.promise;
      }
    );
    try {
      f.adapter.batches.push([
        {
          name: 'code_exec',
          arguments: {
            code: `
        await cell.yield_control();
        await tools.${internalName}({record:'pause'});
        await tools.tool_search({query:${JSON.stringify(externalName)}});`
          }
        }
      ]);
      expect(
        await f.session.run({ prompt: 'Start the background lookup.' }).result()
      ).toMatchObject({ status: 'completed' });
      await waiting.promise;
      const start = f.adapter.requests.length;
      onCandidate = async () => {
        const store = await JsonlSessionStore.open(f.home);
        try {
          release.resolve();
          await vi.waitFor(async () => {
            const records = await store.read(f.session.id);
            expect(
              records.some(
                (record) =>
                  record.type === 'tool.completed' &&
                  (record.payload as { toolName?: string }).toolName === 'tool_search'
              )
            ).toBe(true);
          });
        } finally {
          await store.close();
        }
      };
      expect(await f.session.run({ prompt: 'Continue.' }).result()).toMatchObject({
        status: 'completed'
      });
      expect(f.adapter.requests.slice(start)).toHaveLength(1);
      expect(
        f.adapter.requests[start]!.messages.find((message) => message.mcpDiscovery)?.content
      ).toContain(externalName);
    } finally {
      release.resolve();
      await f.agent.dispose();
    }
  });

  it('keeps programmatic-only MCP definitions in local history and the next Code Mode directory only', async () => {
    const f = await fixture(true);
    let resumed: Awaited<ReturnType<typeof createAgentWithAdapter>> | undefined;
    try {
      const cell = `const result = await tools.${programmaticOnlyName}({ record: "cell" }); observe.text(result.content);`;
      f.adapter.batches.push(
        [{ name: 'tool_search', arguments: { query: programmaticOnlyName } }],
        [
          { name: programmaticOnlyName, arguments: { record: 'forged-direct' } },
          { name: 'code_exec', arguments: { code: cell } }
        ]
      );
      const events = [];
      const execution = f.session.run({ prompt: 'Search and use the programmatic-only resolver.' });
      for await (const event of execution) events.push(event);
      expect((await execution.result()).status).toBe('completed');
      expect(f.calls).toEqual([programmaticOnlyName]);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'tool.failed',
          toolName: programmaticOnlyName,
          code: 'MAR_AGENT_TOOL_NOT_AVAILABLE'
        })
      );

      const secondRequest = f.adapter.requests[1]!;
      expect(secondRequest.tools.some((tool) => tool.name === programmaticOnlyName)).toBe(false);
      const codeModeDescription = secondRequest.tools.find(
        (tool) => tool.name === 'code_exec'
      )!.description;
      expect(codeModeDescription).not.toContain(programmaticOnlyName);
      expect(secondRequest.messages.find((m) => m.toolSearchTools)?.content).toContain(
        'Programmatic-only internal resolver.'
      );
      const searchMessage = secondRequest.messages.find(
        (message) => message.role === 'tool' && message.callId === 'call-1-0'
      )!;
      expect(
        searchMessage.toolSearchTools?.some((tool) => tool.name === programmaticOnlyName)
      ).toBe(true);
      expect(searchMessage.content).toContain('Call only as tools.');

      await f.agent.dispose();
      const store = await JsonlSessionStore.open(f.home);
      try {
        const records = await store.read(f.session.id);
        const persistedSearch = records.find(
          (record) =>
            record.type === 'model.context' &&
            (record.payload as { role?: string; callId?: string }).role === 'tool' &&
            (record.payload as { callId?: string }).callId === 'call-1-0'
        );
        const persistedTools =
          (persistedSearch?.payload as { toolSearchTools?: Array<{ name: string }> } | undefined)
            ?.toolSearchTools ?? [];
        expect(persistedTools.map((tool) => tool.name)).toContain(programmaticOnlyName);
      } finally {
        await store.close();
      }

      const recoveredCatalog = catalog();
      const recoveredTool = recoveredCatalog.tools.find(
        (tool) => tool.definition.name === programmaticOnlyName
      )!;
      recoveredTool.definition.description = 'Recovered programmatic resolver.';
      const recoveredAdapter = new Adapter({ ...model, codeMode: true }, 'resumed');
      recoveredAdapter.batches.push([
        { name: programmaticOnlyName, arguments: { record: 'forged-after-resume' } },
        { name: 'code_exec', arguments: { code: cell } }
      ]);
      resumed = await createAgentWithAdapter(
        {
          mode: 'normal',
          host: new LocalAgentHost({
            homeDirectory: f.home,
            workspace: f.home,
            mcpCatalog: () => recoveredCatalog,
            callMcp: async (call) => {
              f.calls.push(call.name);
              return { content: 'Recovered record found.' };
            }
          }),
          models: [{ ...model, codeMode: true }],
          defaultModelId: model.id
        },
        () => recoveredAdapter
      );
      const resumedSession = await resumed.openSession(f.session.id);
      const resumedEvents = [];
      const resumedExecution = resumedSession.run({ prompt: 'Continue using the resolver.' });
      for await (const event of resumedExecution) resumedEvents.push(event);
      expect((await resumedExecution.result()).status).toBe('completed');
      expect(f.calls).toEqual([programmaticOnlyName, programmaticOnlyName]);
      expect(resumedEvents).toContainEqual(
        expect.objectContaining({
          type: 'tool.failed',
          toolName: programmaticOnlyName,
          code: 'MAR_AGENT_TOOL_NOT_AVAILABLE'
        })
      );

      const recoveredRequest = recoveredAdapter.requests[0]!;
      expect(recoveredRequest.tools.some((tool) => tool.name === programmaticOnlyName)).toBe(false);
      const recoveredDescription = recoveredRequest.tools.find(
        (tool) => tool.name === 'code_exec'
      )!.description;
      expect(recoveredDescription).not.toContain('Recovered programmatic resolver.');
      expect(recoveredRequest.messages.find((m) => m.toolSearchTools)?.content).toContain(
        'Recovered programmatic resolver.'
      );
      expect(
        recoveredRequest.messages
          .find((message) => message.role === 'tool' && message.callId === 'call-1-0')
          ?.toolSearchTools?.some((tool) => tool.name === programmaticOnlyName)
      ).toBe(true);
    } finally {
      await resumed?.dispose();
      await f.agent.dispose();
    }
  });

  it('intersects historical discoveries with each execution catalog', async () => {
    const f = await fixture();
    try {
      f.adapter.batches.push([{ name: 'tool_search', arguments: { query: externalName } }]);
      await f.session.run({ prompt: 'Find a tool.' }).result();
      f.update({
        ...catalog(),
        revision: 'revoked',
        tools: catalog().tools.filter((tool) => tool.definition.name !== externalName)
      });
      await f.session.run({ prompt: 'Continue without access.' }).result();
      expect(f.adapter.requests.at(-1)!.tools.some((tool) => tool.name === externalName)).toBe(
        false
      );
      expect(
        f.adapter.requests
          .at(-1)!
          .messages.some((message) =>
            message.toolSearchTools?.some((tool) => tool.name === externalName)
          )
      ).toBe(false);
      f.update({
        ...catalog(),
        revision: 'restored-v2',
        tools: catalog().tools.map((tool) =>
          tool.definition.name === externalName
            ? {
                ...tool,
                definitionRevision: 'two',
                definition: { ...tool.definition, description: 'Updated lookup documentation' }
              }
            : tool
        )
      });
      await f.session.run({ prompt: 'Access restored.' }).result();
      expect(f.adapter.requests.at(-1)!.tools.some((tool) => tool.name === externalName)).toBe(
        true
      );
      expect(
        f.adapter.requests
          .at(-1)!
          .messages.flatMap((message) => message.toolSearchTools ?? [])
          .find((tool) => tool.name === externalName)?.description
      ).toBe('Updated lookup documentation');
    } finally {
      await f.agent.dispose();
    }
  });
  it('hides external schemas, exposes next round, freezes batches and reuses across executions', async () => {
    const f = await fixture();
    try {
      f.adapter.batches.push(
        [
          { name: 'tool_search', arguments: { query: externalName } },
          { name: externalName, arguments: { record: 'hidden' } }
        ],
        [{ name: externalName, arguments: { record: 'visible' } }]
      );
      expect((await f.session.run({ prompt: 'Lookup a record.' }).result()).status).toBe(
        'completed'
      );
      expect(f.calls).toEqual([externalName]);
      const first = f.adapter.requests[0]!;
      expect(first.tools.some((tool) => tool.name === externalName)).toBe(false);
      expect(first.tools.some((tool) => tool.name === internalName)).toBe(true);
      expect(JSON.stringify(first.messages)).toContain(externalName);
      expect(JSON.stringify(first)).not.toContain('Private detailed lookup documentation');
      expect(f.adapter.requests[1]!.tools.some((tool) => tool.name === externalName)).toBe(true);
      expect(
        f.adapter.requests[1]!.messages.some(
          (message) =>
            message.role === 'tool' && message.content.includes('MAR_AGENT_TOOL_NOT_AVAILABLE')
        )
      ).toBe(true);
      expect(first.system).toBe(f.adapter.requests[1]!.system);
      expect((await f.session.run({ prompt: 'Continue.' }).result()).status).toBe('completed');
      expect(f.adapter.requests.at(-1)!.tools.some((tool) => tool.name === externalName)).toBe(
        true
      );
    } finally {
      await f.agent.dispose();
    }
  });

  it('keeps a historical discovery until context GC removes its output', async () => {
    const f = await fixture();
    try {
      f.adapter.batches.push([{ name: 'tool_search', arguments: { query: externalName } }]);
      await f.session.run({ prompt: 'Find a tool.' }).result();
      f.update({
        ...catalog(),
        revision: 'huge',
        tools: catalog().tools.map((tool) =>
          tool.definition.name === externalName
            ? {
                ...tool,
                definitionRevision: 'huge',
                definition: { ...tool.definition, description: 'x'.repeat(65536) }
              }
            : tool
        )
      });
      expect((await f.session.run({ prompt: 'Continue.' }).result()).status).toBe('completed');
      expect(f.adapter.requests.at(-1)!.tools.some((tool) => tool.name === externalName)).toBe(
        true
      );
    } finally {
      await f.agent.dispose();
    }
  });

  it('drops discovered tools when compacted history removes the search output', async () => {
    const f = await fixture();
    try {
      f.adapter.batches.push([{ name: 'tool_search', arguments: { query: externalName } }]);
      await f.session.run({ prompt: 'Find a tool.' }).result();
      const store = await JsonlSessionStore.open(f.home);
      try {
        const release = await store.acquireSessionLease(f.session.id);
        try {
          await store.compact(f.session.id, {
            summary: 'Continue the task.',
            automatic: false,
            replacementHistory: [{ role: 'user', content: 'Continue the task.', kind: 'summary' }]
          });
        } finally {
          await release();
        }
      } finally {
        await store.close();
      }
      await f.agent.dispose();
      const adapter = new Adapter();
      const resumed = await createAgentWithAdapter(
        {
          mode: 'normal',
          host: new LocalAgentHost({
            homeDirectory: f.home,
            workspace: f.home,
            mcpCatalog: catalog,
            callMcp: async () => ({ content: 'ok' })
          }),
          models: [model],
          defaultModelId: model.id
        },
        () => adapter
      );
      try {
        await (await resumed.openSession(f.session.id)).run({ prompt: 'Continue.' }).result();
        expect(adapter.requests[0]!.tools.some((tool) => tool.name === externalName)).toBe(false);
      } finally {
        await resumed.dispose();
      }
    } finally {
      await f.agent.dispose();
    }
  });
});
