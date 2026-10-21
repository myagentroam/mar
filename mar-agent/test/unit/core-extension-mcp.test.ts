import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  CoreSessionExtensionContext,
  CoreDomainFacts,
  CoreMcpBackend,
  CoreMcpToolCall,
  ToolExecutionResult,
  McpToolCatalog
} from '../../src/index.js';
import { MarAgentError } from '../../src/agent-core/error.js';
import { coreMcpCatalog } from '../../src/agent-core/extensions/mcp.js';
import { ExtensionTools, type CoreToolBinding } from '../../src/agent-core/extensions/tools.js';
import { ExtensionResourceScope } from '../../src/agent-core/extensions/resources.js';
import type { CoreOperationContext } from '../../src/agent-core/extensions/operation.js';
import {
  fixture,
  answer,
  call as modelCall,
  cleanupCoreFixtures,
  agents
} from './support/core-extension-fixture.js';

afterEach(cleanupCoreFixtures);
const protocolCases = (['OPENAI_RESPONSES', 'ANTHROPIC_MESSAGES'] as const).flatMap((protocol) =>
  [false, true].map((codeMode) => [protocol, codeMode] as const)
);

function backendFixture() {
  let value: McpToolCatalog = {
    revision: 'catalog-1',
    servers: [{ id: 'real-server', name: 'Test server' }],
    tools: [
      {
        definition: {
          name: 'query',
          description: 'Query records',
          inputSchema: { type: 'object' }
        },
        serverId: 'real-server',
        rawName: 'query_raw',
        sourceIdentity: 'actual-client-lease',
        definitionRevision: 'definition-1',
        lifetime: 'session',
        exposure: 'direct'
      }
    ]
  };
  const close = vi.fn(async () => {});
  const call = vi.fn(
    async (input: CoreMcpToolCall, _call: CoreOperationContext): Promise<ToolExecutionResult> => {
      const source = value.tools.find((tool) => tool.definition.name === input.name);
      if (
        !source ||
        input.expectedTool.sourceIdentity !== source.sourceIdentity ||
        input.expectedTool.definitionRevision !== source.definitionRevision
      )
        throw new MarAgentError('MAR_AGENT_MCP_TOOL_CHANGED', 'Actual Client source changed.');
      return { content: 'MCP_OK', data: { real: true } };
    }
  );
  const catalog = vi.fn(async () => value);
  const connect = vi.fn(async (_definition: unknown, _call: CoreOperationContext) => ({
    catalog,
    call,
    close
  }));
  return {
    port: { connect },
    connect,
    catalog,
    call,
    close,
    getCatalog: () => value,
    setCatalog: (next: McpToolCatalog) => {
      value = next;
    }
  };
}

async function nativeFixture(port?: CoreMcpBackend) {
  let context!: CoreSessionExtensionContext;
  const f = await fixture(
    [
      {
        id: 'mcp-native',
        apiVersion: '1.0',
        attachSession: (value) => {
          context = value;
        }
      }
    ],
    () => answer(),
    false,
    true,
    port ? { mcp: port } : {}
  );
  expect(await f.session.run({ prompt: 'initialize' }).result()).toHaveProperty(
    'status',
    'completed'
  );
  return { ...f, context };
}

describe('native MCP connections', () => {
  it('uses an actual supplied Client lease and captured tool source while idle', async () => {
    const backend = backendFixture();
    const { context } = await nativeFixture(backend.port);
    expect(context.mcp).toBeDefined();
    const definition = {
      id: 'declared',
      configuration: { transport: 'test', token: 'private-fixture' }
    };
    const registration = context.mcp!.register(definition);
    await registration.ready;
    definition.configuration.token = 'changed';
    const connection = await context.mcp!.connect({ server: registration.ref });
    expect(backend.connect.mock.calls[0]?.[0]).toEqual({
      id: 'declared',
      configuration: { transport: 'test', token: 'private-fixture' }
    });
    expect(backend.connect.mock.calls[0]?.[1]).not.toHaveProperty('executionId');
    const catalog = await context.mcp!.catalog({ connection });
    const tool = catalog.tools[0]!;
    expect(tool.source).toMatchObject({
      kind: 'mcp',
      id: 'actual-client-lease',
      revision: 'definition-1'
    });
    expect(await context.mcp!.call({ tool, arguments: {} })).toMatchObject({
      content: 'MCP_OK',
      data: { real: true }
    });
    expect(backend.call.mock.calls[0]?.[0]).toMatchObject({
      rawName: 'query_raw',
      expectedTool: { sourceIdentity: 'actual-client-lease', definitionRevision: 'definition-1' }
    });
    expect(await context.tools.check({ name: 'query', arguments: {} })).toHaveProperty(
      'available',
      true
    );
    await context.mcp!.disconnect({ connection });
    expect(backend.close).toHaveBeenCalledTimes(1);
    expect(await context.tools.check({ name: 'query', arguments: {} })).toHaveProperty(
      'available',
      false
    );
    await expect(context.mcp!.call({ tool, arguments: {} })).rejects.toMatchObject({
      code: 'MAR_AGENT_TOOL_NOT_AVAILABLE'
    });
  });

  it('does not advertise a dynamic facade without a real backend', async () => {
    const { context } = await nativeFixture();
    expect(context.mcp).toBeUndefined();
    expect(context.capabilities.has('mcp')).toBe(false);
  });

  it('rejects forged, cross-Session and revoked declarations and connection handles', async () => {
    const backend = backendFixture();
    const a = await nativeFixture(backend.port);
    const b = await nativeFixture(backend.port);
    const declaration = a.context.mcp!.register({ id: 'server', configuration: {} });
    await declaration.ready;
    await expect(a.context.mcp!.connect({ server: { ...declaration.ref } })).rejects.toMatchObject({
      code: 'MAR_AGENT_MCP_REFERENCE_INVALID'
    });
    await expect(b.context.mcp!.connect({ server: declaration.ref })).rejects.toMatchObject({
      code: 'MAR_AGENT_MCP_REFERENCE_INVALID'
    });
    const connection = await a.context.mcp!.connect({ server: declaration.ref });
    await expect(
      a.context.mcp!.disconnect({ connection: { ...connection } })
    ).rejects.toMatchObject({ code: 'MAR_AGENT_MCP_REFERENCE_INVALID' });
    await expect(b.context.mcp!.catalog({ connection })).rejects.toMatchObject({
      code: 'MAR_AGENT_MCP_REFERENCE_INVALID'
    });
    await declaration.dispose();
    await expect(a.context.mcp!.connect({ server: declaration.ref })).rejects.toMatchObject({
      code: 'MAR_AGENT_MCP_REFERENCE_INVALID'
    });
    // Revoking a declaration never silently closes an already acquired Client lease.
    expect(backend.close).not.toHaveBeenCalled();
    expect((await a.context.mcp!.catalog({ connection })).tools).toHaveLength(1);
    await a.context.mcp!.disconnect({ connection });
    await a.context.mcp!.disconnect({ connection });
    expect(backend.close).toHaveBeenCalledTimes(1);
  });

  it('refreshes changed catalogs without rebinding old refs and preserves unchanged refs', async () => {
    const backend = backendFixture();
    const { context } = await nativeFixture(backend.port);
    const declaration = context.mcp!.register({ id: 'server', configuration: {} });
    const connection = await context.mcp!.connect({ server: declaration.ref });
    const old = (await context.mcp!.catalog({ connection })).tools[0]!;
    await context.mcp!.catalog({ connection });
    expect(await context.mcp!.call({ tool: old, arguments: {} })).toHaveProperty(
      'content',
      'MCP_OK'
    );
    const original = backend.getCatalog();
    backend.setCatalog({
      ...original,
      revision: 'catalog-2',
      tools: original.tools.map((tool) => ({ ...tool, definitionRevision: 'definition-2' }))
    });
    const current = (await context.mcp!.catalog({ connection })).tools[0]!;
    await expect(context.mcp!.call({ tool: old, arguments: {} })).rejects.toMatchObject({
      code: 'MAR_AGENT_TOOL_NOT_AVAILABLE'
    });
    expect(await context.mcp!.call({ tool: current, arguments: {} })).toHaveProperty(
      'content',
      'MCP_OK'
    );
    expect(backend.call.mock.calls.at(-1)?.[0].expectedTool.definitionRevision).toBe(
      'definition-2'
    );
  });

  it('keeps the previous catalog after malformed refresh and closes a failed initial lease', async () => {
    const backend = backendFixture();
    const { context } = await nativeFixture(backend.port);
    const declaration = context.mcp!.register({ id: 'server', configuration: {} });
    const connection = await context.mcp!.connect({ server: declaration.ref });
    const old = (await context.mcp!.catalog({ connection })).tools[0]!;
    backend.catalog.mockResolvedValueOnce({
      ...backend.getCatalog(),
      tools: [{ ...backend.getCatalog().tools[0]!, sourceIdentity: '' }]
    });
    await expect(context.mcp!.catalog({ connection })).rejects.toMatchObject({
      code: 'MAR_AGENT_MCP_CATALOG_INVALID'
    });
    expect(await context.mcp!.call({ tool: old, arguments: {} })).toHaveProperty(
      'content',
      'MCP_OK'
    );
    await context.mcp!.disconnect({ connection });
    backend.catalog.mockResolvedValueOnce({
      ...backend.getCatalog(),
      tools: [...backend.getCatalog().tools, ...backend.getCatalog().tools]
    });
    await expect(context.mcp!.connect({ server: declaration.ref })).rejects.toMatchObject({
      code: 'MAR_AGENT_MCP_CATALOG_INVALID'
    });
    expect(context.mcp!.connections()).toEqual([]);
    expect(backend.close).toHaveBeenCalledTimes(2);
  });

  it('rolls back all source contributions on a name conflict', async () => {
    const backend = backendFixture();
    const { context } = await nativeFixture(backend.port);
    context.tools.register({
      name: 'query',
      description: 'Local definition',
      inputSchema: { type: 'object' },
      execute: async () => ({ content: 'LOCAL' })
    });
    const server = context.mcp!.register({ id: 'server', configuration: {} }).ref;
    await expect(context.mcp!.connect({ server })).rejects.toMatchObject({
      code: 'MAR_AGENT_EXTENSION_TOOL_CONFLICT'
    });
    expect(context.mcp!.connections()).toEqual([]);
    expect(await context.tools.invoke({ name: 'query', arguments: {} })).toHaveProperty(
      'content',
      'LOCAL'
    );
    expect(backend.call).not.toHaveBeenCalled();
    expect(backend.close).toHaveBeenCalledTimes(1);
  });

  it.each(protocolCases)(
    'projects Auto deferred schemas and strips metadata before the MCP backend (%s, Code Mode: %s)',
    async (protocol, codeMode) => {
      const backend = backendFixture();
      backend.setCatalog({
        ...backend.getCatalog(),
        tools: backend.getCatalog().tools.map((tool) => ({ ...tool, exposure: 'deferred' }))
      });
      const f = await fixture(
        [
          {
            id: 'auto-mcp',
            apiVersion: '1.0',
            attachSession: async (value) => {
              await value.mcp!.connect({
                server: value.mcp!.register({ id: 'server', configuration: {} }).ref
              });
            }
          }
        ],
        (request, index) => {
          if (index === 0) return modelCall('tool_search', { query: 'query' });
          if (index === 1) {
            const definition =
              request.tools.find((tool) => tool.name === 'query') ??
              request.messages
                .flatMap((message) => message.toolSearchTools ?? [])
                .find((tool) => tool.name === 'query');
            if (!codeMode) expect(definition?.inputSchema.properties).toHaveProperty('permission');
            return codeMode
              ? modelCall('code_exec', {
                  code: 'observe.text(await tools.query({input:{value:7},permission:null}));'
                })
              : modelCall('query', { input: { value: 7 }, permission: null });
          }
          return answer();
        },
        codeMode,
        true,
        { mcp: backend.port },
        protocol
      );
      expect(
        await f.session.run({ prompt: 'Read records.', permissionMode: 'auto' }).result()
      ).toMatchObject({ status: 'completed' });
      expect(backend.call).toHaveBeenCalledTimes(1);
      expect(backend.call.mock.calls[0]?.[0].arguments).toEqual({ value: 7 });
    }
  );

  it.each(protocolCases)(
    'uses captured MCP metadata at the model ingress (protocol: %s, Code Mode: %s)',
    async (protocol, codeMode) => {
      const backend = backendFixture();
      let context!: CoreSessionExtensionContext;
      const f = await fixture(
        [
          {
            id: 'model-mcp',
            apiVersion: '1.0',
            attachSession: async (value) => {
              context = value;
              const server = value.mcp!.register({ id: 'server', configuration: {} }).ref;
              await value.mcp!.connect({ server });
            }
          }
        ],
        (_request, index) =>
          index === 0
            ? codeMode
              ? modelCall('code_exec', { code: 'observe.text(await tools.query({ value: 7 }));' })
              : modelCall('query', { value: 7 })
            : answer(),
        codeMode,
        true,
        { mcp: backend.port },
        protocol
      );
      const run = f.session.run({ prompt: 'call the MCP tool' });
      expect(await run.result()).toHaveProperty('status', 'completed');
      expect(backend.call).toHaveBeenCalledTimes(1);
      expect(backend.call.mock.calls[0]?.[0]).toMatchObject({
        name: 'query',
        rawName: 'query_raw',
        arguments: { value: 7 }
      });
      expect(backend.call.mock.calls[0]?.[1]).toMatchObject({
        actor: codeMode ? 'code-mode' : 'model',
        entry: codeMode ? 'programmatic' : 'direct',
        executionId: run.executionId
      });
      expect(context.mcp!.connections()).toHaveLength(1);
    }
  );

  it.each(protocolCases)(
    'uses the existing deferred discovery in both model modes (protocol: %s, Code Mode: %s)',
    async (protocol, codeMode) => {
      const backend = backendFixture();
      backend.setCatalog({
        ...backend.getCatalog(),
        tools: backend.getCatalog().tools.map((tool) => ({ ...tool, exposure: 'deferred' }))
      });
      const f = await fixture(
        [
          {
            id: 'deferred-mcp',
            apiVersion: '1.0',
            attachSession: async (value) => {
              await value.mcp!.connect({
                server: value.mcp!.register({ id: 'server', configuration: {} }).ref
              });
            }
          }
        ],
        (request, index) => {
          if (index === 0) {
            expect(request.tools.some((tool) => tool.name === 'query')).toBe(false);
            return modelCall('tool_search', { query: 'query' });
          }
          if (index === 1) {
            if (!codeMode && protocol === 'ANTHROPIC_MESSAGES')
              expect(request.tools.some((tool) => tool.name === 'query')).toBe(true);
            if (!codeMode && protocol === 'OPENAI_RESPONSES')
              expect(
                request.messages.some((message) =>
                  message.toolSearchTools?.some((tool) => tool.name === 'query')
                )
              ).toBe(true);
            return codeMode
              ? modelCall('code_exec', { code: 'observe.text(await tools.query({}));' })
              : modelCall('query', {});
          }
          return answer();
        },
        codeMode,
        true,
        { mcp: backend.port },
        protocol
      );
      expect(await f.session.run({ prompt: 'discover then call' }).result()).toHaveProperty(
        'status',
        'completed'
      );
      expect(backend.call).toHaveBeenCalledTimes(1);
    }
  );

  it('publishes connections acquired during a tool batch at the next model boundary', async () => {
    const backend = backendFixture();
    const f = await fixture(
      [
        {
          id: 'late-mcp',
          apiVersion: '1.0',
          attachSession: (context) => {
            const server = context.mcp!.register({ id: 'server', configuration: {} }).ref;
            context.tools.register({
              name: 'connect_rpc',
              description: 'Connect now',
              inputSchema: { type: 'object' },
              execute: async () => {
                await context.mcp!.connect({ server });
                return { content: 'CONNECTED' };
              }
            });
          }
        }
      ],
      (request, index) => {
        if (index === 0) {
          expect(request.tools.some((tool) => tool.name === 'query')).toBe(false);
          return modelCall('connect_rpc', {});
        }
        if (index === 1) {
          expect(request.tools.some((tool) => tool.name === 'query')).toBe(true);
          return modelCall('query', {});
        }
        return answer();
      },
      false,
      true,
      { mcp: backend.port }
    );
    expect(await f.session.run({ prompt: 'connect and invoke' }).result()).toHaveProperty(
      'status',
      'completed'
    );
    expect(backend.call).toHaveBeenCalledTimes(1);
    expect(backend.connect.mock.calls[0]?.[1]).toHaveProperty('entry', 'direct');
  });

  it('keeps wrapped MCP discovery identity sensitive to the captured lower revision', async () => {
    const backend = backendFixture();
    const tool = backend.getCatalog().tools[0]!;
    const tools = new ExtensionTools();
    const owner = new ExtensionResourceScope();
    owner.activate();
    try {
      const registration = tools.register(owner, 'wrapper', {
        ...tool.definition,
        override: 'wrap',
        execute: async (input, call, next) => next!({ name: 'query', arguments: input })
      });
      await registration.ready;
      const lower: CoreToolBinding = {
        definition: tool.definition,
        mcp: tool,
        source: { kind: 'mcp', id: tool.sourceIdentity, revision: tool.definitionRevision },
        invoke: async () => ({ content: 'done' })
      };
      const a = coreMcpCatalog(backend.getCatalog().servers, tools.capture([lower]));
      const b = coreMcpCatalog(
        backend.getCatalog().servers,
        tools.capture([
          {
            ...lower,
            source: { ...lower.source, revision: 'definition-2' },
            mcp: { ...tool, definitionRevision: 'definition-2' }
          }
        ])
      );
      expect(a.tools[0]!.definitionRevision).not.toBe(b.tools[0]!.definitionRevision);
      expect(a.revision).not.toBe(b.revision);
    } finally {
      await owner.dispose();
    }
  });

  it('restores session-scoped deferred native aliases from a paired Tool Search receipt', async () => {
    const backend = backendFixture();
    backend.setCatalog({
      ...backend.getCatalog(),
      tools: backend.getCatalog().tools.map((tool) => ({ ...tool, exposure: 'deferred' }))
    });
    const f = await fixture(
      [
        {
          id: 'restore-native-mcp',
          apiVersion: '1.0',
          attachSession: async (context) => {
            await context.mcp!.connect({
              server: context.mcp!.register({ id: 'server', configuration: {} }).ref
            });
          }
        }
      ],
      (request, index) => {
        if (index === 0) return modelCall('tool_search', { query: 'query' });
        if (index === 1 || index === 3) {
          expect(request.tools.some((tool) => tool.name === 'query')).toBe(true);
          return modelCall('query', {});
        }
        return answer();
      },
      false,
      true,
      { mcp: backend.port }
    );
    expect(await f.session.run({ prompt: 'discover' }).result()).toHaveProperty(
      'status',
      'completed'
    );
    expect(await f.session.run({ prompt: 'reuse discovered source' }).result()).toHaveProperty(
      'status',
      'completed'
    );
    expect(backend.call).toHaveBeenCalledTimes(2);
  });

  it('keeps wrappers above refreshed backends and facts at the actual MCP leaf', async () => {
    const backend = backendFixture();
    const { context } = await nativeFixture(backend.port);
    const server = context.mcp!.register({ id: 'server', configuration: {} }).ref;
    const connection = await context.mcp!.connect({ server });
    const facts: CoreDomainFacts['mcp.completed'][] = [];
    context.hooks.observe('mcp.completed', (fact) => {
      facts.push(fact);
    });
    context.tools.register({
      name: 'query',
      description: 'Wrap real query',
      inputSchema: { type: 'object' },
      parseInput: (input) => input,
      override: 'wrap',
      execute: async (input, call, next) => ({
        ...(await next!({ name: 'query', arguments: input })),
        content: 'WRAPPED'
      })
    });
    const old = (await context.mcp!.catalog({ connection })).tools[0]!;
    expect(old.source.kind).toBe('extension');
    expect(
      await context.mcp!.call({ tool: old, arguments: { secret: 'fixture-not-for-facts' } })
    ).toHaveProperty('content', 'WRAPPED');
    backend.setCatalog({
      ...backend.getCatalog(),
      revision: 'catalog-2',
      tools: backend
        .getCatalog()
        .tools.map((tool) => ({ ...tool, definitionRevision: 'definition-2' }))
    });
    const current = (await context.mcp!.catalog({ connection })).tools[0]!;
    expect(current.source.kind).toBe('extension');
    await expect(context.mcp!.call({ tool: old, arguments: {} })).rejects.toMatchObject({
      code: 'MAR_AGENT_TOOL_NOT_AVAILABLE'
    });
    expect(await context.mcp!.call({ tool: current, arguments: {} })).toHaveProperty(
      'content',
      'WRAPPED'
    );
    expect(facts.filter((fact) => fact.operation === 'call')).toHaveLength(2);
    expect(JSON.stringify(facts)).not.toContain('fixture-not-for-facts');
    await context.mcp!.disconnect({ connection });
    expect(context.tools.catalog().some((tool) => tool.definition.name === 'query')).toBe(false);
    expect((await context.tools.check({ name: 'query', arguments: {} })).available).toBe(false);
    expect(
      (await context.tools.invoke({ name: 'read', arguments: { reads: [{ path: 'input.txt' }] } }))
        .content
    ).toContain('extension-data');
    const replacement = await context.mcp!.connect({ server });
    const restored = (await context.mcp!.catalog({ connection: replacement })).tools[0]!;
    await expect(context.mcp!.call({ tool: current, arguments: {} })).rejects.toMatchObject({
      code: 'MAR_AGENT_TOOL_NOT_AVAILABLE'
    });
    expect(backend.call).toHaveBeenCalledTimes(2);
    expect(await context.mcp!.call({ tool: restored, arguments: {} })).toHaveProperty(
      'content',
      'WRAPPED'
    );
    expect(backend.call).toHaveBeenCalledTimes(3);
    expect(backend.close).toHaveBeenCalledTimes(1);
  });

  it('closes a late acquired lease without publishing after connect cancellation', async () => {
    const backend = backendFixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    backend.connect.mockImplementationOnce(async () => {
      await gate;
      return { catalog: backend.catalog, call: backend.call, close: backend.close };
    });
    const { context } = await nativeFixture(backend.port);
    const server = context.mcp!.register({ id: 'server', configuration: {} }).ref;
    const stop = new AbortController();
    const pending = context.mcp!.connect({ server, signal: stop.signal });
    const rejected = expect(pending).rejects.toThrow('stop-connect');
    await vi.waitFor(() => expect(backend.connect).toHaveBeenCalledTimes(1));
    stop.abort(new Error('stop-connect'));
    release();
    await rejected;
    expect(backend.close).toHaveBeenCalledTimes(1);
    expect(context.mcp!.connections()).toEqual([]);
    expect(context.tools.catalog().some((tool) => tool.definition.name === 'query')).toBe(false);
    expect(backend.catalog).not.toHaveBeenCalled();
  });

  it('disconnects and joins pending calls even when the transport only settles on close', async () => {
    const backend = backendFixture();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    backend.call.mockImplementationOnce(async () => {
      await gate;
      return { content: 'too late', data: { real: true } };
    });
    backend.close.mockImplementationOnce(async () => {
      finish();
    });
    const { context } = await nativeFixture(backend.port);
    const connection = await context.mcp!.connect({
      server: context.mcp!.register({ id: 'server', configuration: {} }).ref
    });
    const tool = (await context.mcp!.catalog({ connection })).tools[0]!;
    const facts: CoreDomainFacts['mcp.completed'][] = [];
    context.hooks.observe('mcp.completed', (fact) => {
      facts.push(fact);
    });
    const pending = context.mcp!.call({ tool, arguments: {} });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'MAR_AGENT_CANCELLED' });
    await vi.waitFor(() => expect(backend.call).toHaveBeenCalledTimes(1));
    await context.mcp!.disconnect({ connection });
    await rejected;
    expect(backend.close).toHaveBeenCalledTimes(1);
    expect(facts.some((fact) => fact.operation === 'call')).toBe(false);
    expect(context.mcp!.connections()).toEqual([]);
  });

  it('owns a lease by its acquiring instance rather than a shared declaration author', async () => {
    const backend = backendFixture();
    const contexts = new Map<string, CoreSessionExtensionContext>();
    const f = await fixture(
      ['declarer', 'consumer'].map((id) => ({
        id,
        apiVersion: '1.0',
        attachSession: (context: CoreSessionExtensionContext) => {
          contexts.set(id, context);
        }
      })),
      () => answer(),
      false,
      true,
      { mcp: backend.port }
    );
    expect(await f.session.run({ prompt: 'initialize' }).result()).toHaveProperty(
      'status',
      'completed'
    );
    const a = contexts.get('declarer')!.mcp!;
    const b = contexts.get('consumer')!.mcp!;
    const declaration = a.register({ id: 'shared-server', configuration: {} });
    const connection = await b.connect({ server: declaration.ref });
    expect(connection.source.extensionId).toBe('consumer');
    expect(connection.source.ownerInstanceId).not.toBe(declaration.ref.source.ownerInstanceId);
    expect(a.connections()).toEqual([]);
    expect(b.connections()).toEqual([connection]);
    await declaration.dispose();
    expect(backend.close).not.toHaveBeenCalled();
    const tool = (await b.catalog({ connection })).tools[0]!;
    expect(tool.source.instanceId).toBe(connection.source.ownerInstanceId);
    expect(await b.call({ tool, arguments: {} })).toHaveProperty('content', 'MCP_OK');
    await b.disconnect({ connection });
    expect(backend.close).toHaveBeenCalledTimes(1);
  });

  it('captures native targets and arguments before asynchronous admission', async () => {
    const backend = backendFixture();
    const { context } = await nativeFixture(backend.port);
    const original = context.mcp!.register({ id: 'original', configuration: {} }).ref;
    const other = context.mcp!.register({ id: 'other', configuration: {} }).ref;
    const input = { server: original };
    const pending = context.mcp!.connect(input);
    input.server = other;
    const connection = await pending;
    expect(backend.connect.mock.calls[0]?.[0]).toHaveProperty('id', 'original');
    const tool = (await context.mcp!.catalog({ connection })).tools[0]!;
    const arguments_ = { nested: { value: 1 } };
    const call = context.mcp!.call({ tool, arguments: arguments_ });
    arguments_.nested.value = 2;
    await call;
    expect(backend.call.mock.calls[0]?.[0].arguments).toEqual({ nested: { value: 1 } });
  });

  it('keeps a delivered lease independent of its completed connect request signal', async () => {
    const backend = backendFixture();
    const { context } = await nativeFixture(backend.port);
    const stop = new AbortController();
    const connection = await context.mcp!.connect({
      server: context.mcp!.register({ id: 'server', configuration: {} }).ref,
      signal: stop.signal
    });
    const tool = (await context.mcp!.catalog({ connection })).tools[0]!;
    stop.abort(new Error('Finished acquisition caller has stopped.'));
    expect(await context.mcp!.call({ tool, arguments: {} })).toHaveProperty('content', 'MCP_OK');
    expect(context.mcp!.connections()).toEqual([connection]);
    expect(backend.close).not.toHaveBeenCalled();
    await context.mcp!.disconnect({ connection });
    expect(backend.close).toHaveBeenCalledTimes(1);
  });

  it('closes an idle owner lease before joining a Client call that ignores its signal', async () => {
    const backend = backendFixture();
    const { context, agent, session } = await nativeFixture(backend.port);
    const connection = await context.mcp!.connect({
      server: context.mcp!.register({ id: 'server', configuration: {} }).ref
    });
    const tool = (await context.mcp!.catalog({ connection })).tools[0]!;
    const entered = Promise.withResolvers<void>();
    const blocked = Promise.withResolvers<import('../../src/index.js').ToolExecutionResult>();
    backend.call.mockImplementationOnce(async () => {
      entered.resolve();
      return blocked.promise;
    });
    backend.close.mockImplementationOnce(async () => {
      blocked.resolve({ content: 'closed' });
    });
    const pending = context.mcp!.call({ tool, arguments: {} }).catch((error: unknown) => error);
    await entered.promise;
    const clearing = agent.clearSession(session.id);
    try {
      await expect.poll(() => backend.close.mock.calls.length, { timeout: 1000 }).toBe(1);
      await clearing;
      expect(await pending).toMatchObject({ code: 'MAR_AGENT_CANCELLED' });
    } finally {
      blocked.resolve({ content: 'test cleanup' });
      await clearing;
      await pending;
    }
  });

  it('normalizes lease cancellation even when a Client wraps the abort reason', async () => {
    const backend = backendFixture();
    const { context } = await nativeFixture(backend.port);
    const connection = await context.mcp!.connect({
      server: context.mcp!.register({ id: 'server', configuration: {} }).ref
    });
    const tool = (await context.mcp!.catalog({ connection })).tools[0]!;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const wrapped = new Error('Transport wrapped its abort reason.');
    const failures: unknown[] = [];
    context.hooks.observe('tool.failed', (fact) => {
      failures.push(fact);
    });
    backend.call.mockImplementationOnce(async (_input, call) => {
      entered();
      return new Promise((_resolve, reject) => {
        call.signal.addEventListener('abort', () => reject(wrapped), { once: true });
      });
    });
    const pending = context.mcp!.call({ tool, arguments: {} });
    const rejected = expect(pending).rejects.toMatchObject({
      code: 'MAR_AGENT_CANCELLED',
      cause: wrapped
    });
    await started;
    await context.mcp!.disconnect({ connection });
    await rejected;
    expect(failures).toEqual([
      expect.objectContaining({ status: 'cancelled', errorCode: 'MAR_AGENT_CANCELLED' })
    ]);
    expect(backend.close).toHaveBeenCalledTimes(1);
  });

  it('preserves real Client failures without emitting a successful call fact', async () => {
    const backend = backendFixture();
    const { context } = await nativeFixture(backend.port);
    const connection = await context.mcp!.connect({
      server: context.mcp!.register({ id: 'server', configuration: {} }).ref
    });
    const tool = (await context.mcp!.catalog({ connection })).tools[0]!;
    const facts: CoreDomainFacts['mcp.completed'][] = [];
    context.hooks.observe('mcp.completed', (fact) => {
      facts.push(fact);
    });
    const failure = new MarAgentError('MCP_TEST_FAILURE', 'Real Client failure.');
    backend.call.mockRejectedValueOnce(failure);
    await expect(context.mcp!.call({ tool, arguments: {} })).rejects.toBe(failure);
    expect(facts.some((fact) => fact.operation === 'call')).toBe(false);
  });

  it('rejects self-awaiting disconnect but allows a completed-call observer to close the lease', async () => {
    const backend = backendFixture();
    const { context } = await nativeFixture(backend.port);
    const connection = await context.mcp!.connect({
      server: context.mcp!.register({ id: 'server', configuration: {} }).ref
    });
    const tool = (await context.mcp!.catalog({ connection })).tools[0]!;
    backend.call.mockImplementationOnce(async () => {
      await context.mcp!.disconnect({ connection });
      return { content: 'unreachable', data: { real: true } };
    });
    await expect(context.mcp!.call({ tool, arguments: {} })).rejects.toMatchObject({
      code: 'MAR_AGENT_MCP_CONNECTION_BUSY'
    });
    expect(backend.close).not.toHaveBeenCalled();
    context.hooks.observe('mcp.completed', async (fact) => {
      if (fact.operation === 'call') await context.mcp!.disconnect({ connection });
    });
    expect(await context.mcp!.call({ tool, arguments: {} })).toHaveProperty('content', 'MCP_OK');
    expect(backend.close).toHaveBeenCalledTimes(1);
  });

  it('keeps a real cleanup failure observable and prevents half-closed reuse', async () => {
    const backend = backendFixture();
    const f = await nativeFixture(backend.port);
    const connection = await f.context.mcp!.connect({
      server: f.context.mcp!.register({ id: 'server', configuration: {} }).ref
    });
    const tool = (await f.context.mcp!.catalog({ connection })).tools[0]!;
    backend.close.mockRejectedValueOnce(new Error('client-close-failed'));
    try {
      await expect(f.context.mcp!.disconnect({ connection })).rejects.toMatchObject({
        code: 'MAR_AGENT_MCP_CLEANUP_FAILED'
      });
      await expect(f.context.mcp!.call({ tool, arguments: {} })).rejects.toMatchObject({
        code: 'MAR_AGENT_TOOL_NOT_AVAILABLE'
      });
      await expect(f.agent.dispose()).rejects.toMatchObject({
        code: 'MAR_AGENT_EXTENSION_CLEANUP_FAILED'
      });
      expect(backend.close).toHaveBeenCalledTimes(1);
    } finally {
      await f.agent.dispose().catch(() => undefined);
      // The failed disposal has been asserted; do not mask it with a duplicate fixture cleanup.
      const index = agents.indexOf(f.agent);
      if (index !== -1) agents.splice(index, 1);
    }
  });

  it('rejects malformed inputs and already-cancelled admission without connecting', async () => {
    const backend = backendFixture();
    const { context } = await nativeFixture(backend.port);
    for (const method of ['connect', 'catalog', 'call', 'disconnect'] as const)
      await expect(context.mcp![method](null as never)).rejects.toMatchObject({
        code: 'MAR_AGENT_MCP_INPUT_INVALID'
      });
    expect(() => context.mcp!.register(null as never)).toThrow(
      expect.objectContaining({ code: 'MAR_AGENT_MCP_INPUT_INVALID' })
    );
    const server = context.mcp!.register({ id: 'server', configuration: {} }).ref;
    await expect(
      context.mcp!.connect({
        server,
        signal: AbortSignal.abort(new Error('cancel-before-connect'))
      })
    ).rejects.toThrow('cancel-before-connect');
    expect(backend.connect).not.toHaveBeenCalled();
  });

  it('clears instance-owned Client leases and makes old API handles unusable', async () => {
    const backend = backendFixture();
    const { context, agent, session } = await nativeFixture(backend.port);
    const connection = await context.mcp!.connect({
      server: context.mcp!.register({ id: 'server', configuration: {} }).ref
    });
    const tool = (await context.mcp!.catalog({ connection })).tools[0]!;
    await agent.clearSession(session.id);
    expect(backend.close).toHaveBeenCalledTimes(1);
    await expect(context.mcp!.call({ tool, arguments: {} })).rejects.toMatchObject({
      code: 'MAR_AGENT_EXTENSION_RETIRED'
    });
    expect(backend.call).not.toHaveBeenCalled();
  });
});
