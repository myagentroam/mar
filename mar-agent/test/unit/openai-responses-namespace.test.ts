import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SecretValue, parseModelCatalog, type AgentModelConfiguration } from '../../src/index.js';
import type { ModelEvent, ModelRequest } from '../../src/model/contracts.js';
import { OpenAiResponsesAdapter, openAiInput } from '../../src/model/openai-responses.js';
import { projectCodeModeSearchResult } from '../../src/tools/code-mode/index.js';
import { projectPermissionTool } from '../../src/tools/permissions.js';
import { startResponsesWebSocketServer } from './support/responses-transport-servers.js';

type WebSocketFixture = Awaited<ReturnType<typeof startResponsesWebSocketServer>>;

interface HttpFixture {
  readonly server: Server;
  readonly baseUrl: string;
  readonly requests: Record<string, unknown>[];
}

const schemaProbeTool = {
  name: 'schema_probe',
  description: 'Inspect optional arrays and enums.',
  inputSchema: {
    type: 'object',
    properties: {
      values: {
        type: 'array',
        items: { type: 'string', minLength: 1 },
        minItems: 1,
        maxItems: 8,
        uniqueItems: true
      },
      mode: { type: 'string', enum: ['any', 'all'] },
      phase: { type: 'string', enum: ['ready', 'changed'] }
    },
    required: [],
    additionalProperties: false
  }
} as const;

const adapters: OpenAiResponsesAdapter[] = [];
const webSocketFixtures: WebSocketFixture[] = [];
const httpFixtures: HttpFixture[] = [];

afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.close()));
  await Promise.all(
    webSocketFixtures
      .splice(0)
      .map(({ server }) => closeServer(server))
      .concat(httpFixtures.splice(0).map(({ server }) => closeServer(server)))
  );
});

describe('OpenAI Responses tool namespace on STANDARD transport', () => {
  it.each([undefined, 'mar'])(
    'omits unsupported array uniqueness for direct and deferred generic tools with namespace=%s',
    async (namespace) => {
      const fixture = await startHttpResponsesServer(completedEvents('schema-probe'));
      httpFixtures.push(fixture);
      const adapter = registerAdapter(
        new OpenAiResponsesAdapter(
          configuration(fixture.baseUrl, {
            responsesTransport: { transport: 'HTTP', httpVersion: '1.1' },
            responsesPreviousResponseId: false,
            ...(namespace ? { responsesToolNamespace: namespace } : {})
          })
        )
      );
      const original = structuredClone(schemaProbeTool.inputSchema);
      await collect(adapter.start(toolRequest([schemaProbeTool]), new AbortController().signal));
      const tools = fixture.requests[0]!.tools as Array<Record<string, unknown>>;
      const projected = namespace
        ? (tools[0]!.tools as Array<Record<string, unknown>>)[0]!
        : tools[0]!;
      expect(projected).toMatchObject({ name: 'schema_probe', strict: true });
      const properties = (projected.parameters as { properties: Record<string, unknown> })
        .properties;
      expect(properties.values).toMatchObject({
        type: ['array', 'null'],
        items: { type: 'string', minLength: 1 },
        minItems: 1,
        maxItems: 8
      });
      expect(properties.values).not.toHaveProperty('uniqueItems');
      expect(properties.mode).toMatchObject({
        type: ['string', 'null'],
        enum: ['any', 'all', null]
      });
      expect(properties.phase).toMatchObject({
        type: ['string', 'null'],
        enum: ['ready', 'changed', null]
      });
      const deferred = openAiInput(
        [
          { role: 'tool_call', content: '', callId: 'search', name: 'tool_search', arguments: {} },
          {
            role: 'tool',
            content: 'found',
            callId: 'search',
            toolSearchTools: [schemaProbeTool]
          }
        ],
        undefined,
        'standard',
        true
      );
      expect(deferred[1]).toMatchObject({
        type: 'tool_search_output',
        tools: [expect.objectContaining({ strict: true, parameters: projected.parameters })]
      });
      expect(schemaProbeTool.inputSchema).toEqual(original);
    }
  );

  it('preserves optional enum nullability and required constraints in direct and deferred tools', async () => {
    const fixture = await startHttpResponsesServer(completedEvents('nullable-enums'));
    httpFixtures.push(fixture);
    const adapter = registerAdapter(
      new OpenAiResponsesAdapter(
        configuration(fixture.baseUrl, {
          responsesTransport: { transport: 'HTTP', httpVersion: '1.1' },
          responsesPreviousResponseId: false
        })
      )
    );
    const tool = {
      name: 'enum_probe',
      description: 'Inspect optional and required enums.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', enum: ['one', 'two'] },
          number: { type: 'integer', enum: [1, 2] },
          untyped: { enum: ['one', 'two'] },
          union: { type: ['string', 'integer'], enum: ['one', 1] },
          nullable: { type: ['string', 'null'], enum: ['one', null] },
          required: { type: 'string', enum: ['one', 'two'] },
          nested: {
            type: 'array',
            items: {
              type: 'object',
              properties: { mode: { type: 'string', enum: ['any', 'all'] } },
              additionalProperties: false
            }
          }
        },
        required: ['required'],
        additionalProperties: false
      }
    };
    const original = structuredClone(tool.inputSchema);
    await collect(adapter.start(toolRequest([tool]), new AbortController().signal));
    const projected = (fixture.requests[0]!.tools as Array<{ parameters: unknown }>)[0]!.parameters;
    expect(projected).toMatchObject({
      required: ['nested', 'nullable', 'number', 'required', 'text', 'union', 'untyped'],
      properties: {
        text: { type: ['string', 'null'], enum: ['one', 'two', null] },
        number: { type: ['integer', 'null'], enum: [1, 2, null] },
        untyped: { enum: ['one', 'two', null] },
        union: { type: ['string', 'integer', 'null'], enum: ['one', 1, null] },
        nullable: { type: ['string', 'null'], enum: ['one', null] },
        required: { type: 'string', enum: ['one', 'two'] },
        nested: {
          items: {
            required: ['mode'],
            properties: { mode: { type: ['string', 'null'], enum: ['any', 'all', null] } }
          }
        }
      }
    });
    const deferred = openAiInput(
      [
        { role: 'tool_call', content: '', callId: 'search', name: 'tool_search', arguments: {} },
        { role: 'tool', content: 'found', callId: 'search', toolSearchTools: [tool] }
      ],
      undefined,
      'standard',
      true
    );
    expect(deferred[1]).toMatchObject({
      type: 'tool_search_output',
      tools: [expect.objectContaining({ strict: true, parameters: projected })]
    });
    expect(tool.inputSchema).toEqual(original);
  });

  it.each([false, true])(
    'recursively lowers anyOf branches without wrapping nullable unions (nullable=%s)',
    async (nullable) => {
      const fixture = await startHttpResponsesServer(completedEvents('union-schema'));
      httpFixtures.push(fixture);
      const adapter = registerAdapter(
        new OpenAiResponsesAdapter(
          configuration(fixture.baseUrl, {
            responsesTransport: { transport: 'HTTP', httpVersion: '1.1' },
            responsesPreviousResponseId: false
          })
        )
      );
      const choice = {
        anyOf: [
          {
            type: 'object',
            properties: {
              label: { type: 'string', enum: ['ready', 'done'] },
              values: { type: 'array', items: { type: 'string' }, uniqueItems: true }
            },
            additionalProperties: false
          },
          ...(nullable ? [{ type: 'null' }] : [])
        ]
      };
      const tool = {
        name: 'union_probe',
        description: 'Inspect nested optional values.',
        inputSchema: {
          type: 'object',
          properties: { choice, requiredChoice: choice },
          required: ['requiredChoice'],
          additionalProperties: false
        }
      };
      const original = structuredClone(tool.inputSchema);
      await collect(adapter.start(toolRequest([tool]), new AbortController().signal));
      const projected = (
        fixture.requests[0]!.tools as Array<{
          strict: boolean;
          parameters: { properties: Record<string, { anyOf: unknown[] }> };
        }>
      )[0]!;
      expect(projected.strict).toBe(true);
      const loweredObject = {
        type: 'object',
        properties: {
          label: { type: ['string', 'null'], enum: ['ready', 'done', null] },
          values: { type: ['array', 'null'], items: { type: 'string' } }
        },
        required: ['label', 'values'],
        additionalProperties: false
      };
      expect(projected.parameters.properties.choice).toEqual({
        anyOf: [loweredObject, { type: 'null' }]
      });
      expect(projected.parameters.properties.requiredChoice).toEqual({
        anyOf: [loweredObject, ...(nullable ? [{ type: 'null' }] : [])]
      });
      const deferred = openAiInput(
        [
          { role: 'tool_call', content: '', callId: 'search', name: 'tool_search', arguments: {} },
          { role: 'tool', content: 'found', callId: 'search', toolSearchTools: [tool] }
        ],
        undefined,
        'standard',
        true
      );
      expect(deferred[1]).toMatchObject({
        tools: [expect.objectContaining({ strict: true, parameters: projected.parameters })]
      });
      expect(tool.inputSchema).toEqual(original);
    }
  );

  it('makes optional Auto permission objects nullable for strict direct and deferred tools', async () => {
    const fixture = await startHttpResponsesServer(completedEvents('auto-permission'));
    httpFixtures.push(fixture);
    const adapter = registerAdapter(
      new OpenAiResponsesAdapter(
        configuration(fixture.baseUrl, {
          responsesTransport: { transport: 'HTTP', httpVersion: '1.1' },
          responsesPreviousResponseId: false
        })
      )
    );
    const tool = projectPermissionTool({
      name: 'probe',
      description: 'Test permission.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    });
    await collect(adapter.start({ ...toolRequest(), tools: [tool] }, new AbortController().signal));
    const projected = (fixture.requests[0]?.tools as Array<{ parameters: unknown }>)[0]?.parameters;
    expect(projected).toMatchObject({
      required: ['permission'],
      properties: { permission: { type: ['object', 'null'], required: ['action', 'reason'] } }
    });
    expect(tool.inputSchema.required).toBeUndefined();
    const deferred = openAiInput(
      [
        { role: 'tool_call', content: '', callId: 'search', name: 'tool_search', arguments: {} },
        { role: 'tool', content: 'found', callId: 'search', toolSearchTools: [tool] }
      ],
      undefined,
      'standard',
      true
    );
    expect(deferred[1]).toMatchObject({
      type: 'tool_search_output',
      tools: [expect.objectContaining({ strict: true, parameters: projected })]
    });
  });
  it.each([
    { name: 'open-empty', schema: { type: 'object' }, strict: false },
    {
      name: 'nullable-dictionary',
      schema: {
        type: 'object',
        properties: { values: { type: ['object', 'null'] } },
        additionalProperties: false
      },
      strict: false
    },
    {
      name: 'array-dictionary',
      schema: {
        type: 'object',
        properties: { values: { type: 'array', items: { type: 'object' } } },
        additionalProperties: false
      },
      strict: false
    },
    {
      name: 'union-dictionary',
      schema: {
        type: 'object',
        properties: { values: { anyOf: [{ type: 'string' }, { type: 'object' }] } },
        additionalProperties: false
      },
      strict: false
    },
    {
      name: 'open-extra',
      schema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        additionalProperties: true
      },
      strict: false
    },
    {
      name: 'nested-dictionary',
      schema: {
        type: 'object',
        properties: { values: { type: 'object', additionalProperties: { type: 'string' } } },
        required: ['values'],
        additionalProperties: false
      },
      strict: false
    },
    {
      name: 'closed-empty',
      schema: { type: 'object', additionalProperties: false },
      strict: true
    }
  ])(
    'preserves $name extension schemas for direct and deferred exposure',
    async ({ schema, strict }) => {
      const fixture = await startHttpResponsesServer(completedEvents('extension-schema'));
      httpFixtures.push(fixture);
      const adapter = registerAdapter(
        new OpenAiResponsesAdapter(
          configuration(fixture.baseUrl, {
            responsesTransport: { transport: 'HTTP', httpVersion: '1.1' },
            responsesPreviousResponseId: false
          })
        )
      );
      const tool = {
        name: 'extension_probe',
        description: 'Extension arguments.',
        inputSchema: schema
      };
      const original = structuredClone(schema);
      await collect(
        adapter.start({ ...toolRequest(), tools: [tool] }, new AbortController().signal)
      );
      expect(fixture.requests[0]?.tools).toEqual([
        expect.objectContaining({
          name: tool.name,
          strict,
          parameters: strict
            ? {
                type: 'object',
                properties: {},
                required: [],
                additionalProperties: false
              }
            : original
        })
      ]);
      const deferred = openAiInput(
        [
          {
            role: 'tool_call',
            content: '',
            callId: 'extension-search',
            name: 'tool_search',
            arguments: { query: 'extension' }
          },
          { role: 'tool', content: 'found', callId: 'extension-search', toolSearchTools: [tool] }
        ],
        undefined,
        'standard',
        true
      );
      expect(deferred[1]).toMatchObject({
        type: 'tool_search_output',
        tools: [
          expect.objectContaining({
            strict,
            parameters: strict
              ? { type: 'object', properties: {}, required: [], additionalProperties: false }
              : original
          })
        ]
      });
      expect(schema).toEqual(original);
    }
  );

  it.each(['function_call', 'tool_search_call'] as const)(
    'keeps persisted %s search calls paired with the corresponding output type',
    (type) => {
      const messages: ModelRequest['messages'] = [
        { role: 'user', content: 'Find records.' },
        providerMessage(
          {
            type,
            id: 'persisted-search',
            call_id: 'search-call',
            ...(type === 'function_call'
              ? { name: 'tool_search', arguments: '{"query":"records"}' }
              : { execution: 'client', status: 'completed', arguments: { query: 'records' } })
          },
          'standard'
        ),
        {
          role: 'tool_call',
          content: '',
          callId: 'search-call',
          name: 'tool_search',
          arguments: { query: 'records' }
        },
        {
          role: 'tool',
          content: '{"tools":["mcp__records__read"]}',
          callId: 'search-call',
          toolSearchTools: clientTools()
        }
      ];
      const input = openAiInput(messages, undefined, 'standard', true);
      expect(input).toHaveLength(3);
      expect(input[1]).toMatchObject({ type, call_id: 'search-call' });
      expect(input[2]).toMatchObject({
        type: type === 'function_call' ? 'function_call_output' : 'tool_search_output',
        call_id: 'search-call',
        ...(type === 'function_call'
          ? { output: '{"tools":["mcp__records__read"]}' }
          : { tools: expect.any(Array) })
      });
      expect(
        openAiInput(
          messages.filter((message) => message.role !== 'provider'),
          undefined,
          'other-model',
          true
        )
      ).toMatchObject([
        { role: 'user' },
        { type: 'tool_search_call', call_id: 'search-call' },
        { type: 'tool_search_output', call_id: 'search-call' }
      ]);
    }
  );

  it('strips obsolete encoding without changing the standard SDK model configuration', () => {
    const model = {
      ...configuration('https://api.openai.com/v1'),
      apiKey: 'fake-key',
      responsesToolNamespace: 'mar'
    };
    const standard = parseModelCatalog({ version: 1, models: [model] });
    const parsed = parseModelCatalog({
      version: 1,
      models: [{ ...model, responsesEncoding: 'LITE' }]
    });
    expect(parsed).toEqual(standard);
    expect(parsed.models[0]).not.toHaveProperty('responsesEncoding');
    expect(parsed.models[0]).toMatchObject({
      protocol: 'OPENAI_RESPONSES',
      responsesToolNamespace: 'mar'
    });
  });
  it('encodes client tools under mar while keeping hosted web_search top-level over HTTP', async () => {
    const fixture = await startHttpResponsesServer(completedEvents('http-response'));
    httpFixtures.push(fixture);
    const adapter = registerAdapter(
      new OpenAiResponsesAdapter(
        configuration(fixture.baseUrl, {
          responsesTransport: { transport: 'HTTP', httpVersion: '1.1' },
          responsesToolNamespace: 'mar',
          hostedWebSearch: true,
          responsesPreviousResponseId: false
        })
      )
    );

    await collect(adapter.start(toolRequest(), new AbortController().signal));

    expect(fixture.requests).toHaveLength(1);
    const body = fixture.requests[0]!;
    expect(body).toMatchObject({
      model: 'test-model',
      stream: true,
      parallel_tool_calls: true,
      include: ['reasoning.encrypted_content', 'web_search_call.action.sources']
    });
    const tools = body.tools as Record<string, unknown>[];
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({
      type: 'namespace',
      name: 'mar',
      description: 'Client-side agent tools.'
    });
    expect(tools[0]?.tools).toEqual([
      expect.objectContaining({
        type: 'function',
        name: 'read',
        strict: true
      }),
      {
        type: 'custom',
        name: 'apply_patch',
        description: 'Apply a patch.'
      }
    ]);
    expect(tools[1]).toEqual({ type: 'web_search' });
    expect(JSON.stringify(tools[0])).not.toContain('"type":"web_search"');
  });

  it.each([false, true])(
    'replays native Tool Search definitions with Code Mode Only=%s',
    async (only) => {
      const searchCall = {
        type: 'tool_search_call',
        id: 'search-item',
        call_id: 'search-call',
        status: 'completed',
        execution: 'client',
        arguments: { query: 'records', limit: 1 }
      };
      const fixture = await startHttpResponsesServer(
        completedEvents('search-response', [searchCall])
      );
      httpFixtures.push(fixture);
      const adapter = registerAdapter(
        new OpenAiResponsesAdapter(
          configuration(fixture.baseUrl, {
            responsesTransport: { transport: 'HTTP', httpVersion: '1.1' },
            responsesToolNamespace: 'mar',
            responsesPreviousResponseId: false
          })
        )
      );
      const toolSearch = {
        name: 'tool_search',
        description: 'Search deferred tools.',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
          additionalProperties: false
        },
        nativeType: 'tool_search' as const
      };
      const events = await collect(
        adapter.start(toolRequest([toolSearch, ...clientTools()]), new AbortController().signal)
      );
      expect(events).toContainEqual({
        type: 'client_tool.call',
        callId: 'search-call',
        name: 'tool_search',
        arguments: { query: 'records', limit: 1 }
      });
      expect(fixture.requests[0]!.tools).toEqual([
        expect.objectContaining({ type: 'tool_search', execution: 'client' }),
        expect.objectContaining({ type: 'namespace', name: 'mar' })
      ]);

      await collect(
        adapter.start(
          {
            ...toolRequest([toolSearch, ...clientTools()]),
            messages: [
              { role: 'user', content: 'Find records.' },
              providerMessage(searchCall, 'standard'),
              projectCodeModeSearchResult(
                {
                  role: 'tool',
                  callId: 'search-call',
                  content: '{"tools":["mcp__records__read"]}',
                  toolSearchTools: [
                    {
                      name: 'mcp__records__read',
                      description: 'Read a record.',
                      ...(only ? { inputMode: 'freeform' as const } : {}),
                      inputSchema: {
                        type: 'object',
                        properties: { id: { type: 'string' } },
                        required: ['id'],
                        additionalProperties: false
                      }
                    }
                  ]
                },
                only
              )
            ]
          },
          new AbortController().signal
        )
      );
      expect(fixture.requests[1]!.input).toContainEqual({
        type: 'tool_search_output',
        call_id: 'search-call',
        status: 'completed',
        execution: 'client',
        tools: [
          expect.objectContaining({
            type: 'function',
            name: 'mcp__records__read',
            description: only
              ? 'Call only as tools.mcp__records__read inside code_exec, never as a direct model tool.\nInside code_exec, pass a JavaScript value matching inputSchema.\nRead a record.'
              : 'Read a record.',
            strict: true
          })
        ]
      });

      await collect(
        adapter.start(
          {
            ...toolRequest([toolSearch, ...clientTools()]),
            messages: [
              { role: 'user', content: 'Find records.' },
              providerMessage(searchCall, 'standard'),
              {
                role: 'tool',
                callId: 'search-call',
                content: '{"tools":[]}',
                toolSearchTools: []
              }
            ]
          },
          new AbortController().signal
        )
      );
      expect(fixture.requests[2]!.input).toContainEqual({
        type: 'tool_search_output',
        call_id: 'search-call',
        status: 'completed',
        execution: 'client',
        tools: []
      });
    }
  );

  it('reconciles function and freeform tool results in a WebSocket continuation', async () => {
    const functionCall = {
      type: 'function_call',
      id: 'function-item',
      call_id: 'function-call',
      name: 'read',
      arguments: '{"path":"README.md"}'
    };
    const freeformCall = {
      type: 'custom_tool_call',
      id: 'freeform-item',
      call_id: 'freeform-call',
      name: 'apply_patch',
      input: '*** Begin Patch\n*** Add File: marker.txt\n+created\n*** End Patch'
    };
    const fixture = await startResponsesWebSocketServer([], {
      responsesByRequest: [
        completedEvents('response-1', [functionCall, freeformCall]),
        completedEvents('response-2', [messageItem('response-2', 'Done')])
      ]
    });
    webSocketFixtures.push(fixture);
    const tools = clientTools();
    const adapter = registerAdapter(
      new OpenAiResponsesAdapter(
        configuration(fixture.baseUrl, {
          responsesToolNamespace: 'mar'
        })
      )
    );
    const turn = adapter.createTurnSession();

    try {
      await collect(turn.start(toolRequest(tools), new AbortController().signal));
      // The runtime commits native output and all tool calls before executing the tools.
      turn.commitContinuationInput(5);
      await collect(
        turn.start(
          {
            ...toolRequest(tools),
            messages: [
              { role: 'user', content: 'Inspect and patch.' },
              providerMessage(functionCall, 'standard'),
              providerMessage(freeformCall, 'standard'),
              {
                role: 'tool_call',
                callId: 'function-call',
                name: 'read',
                arguments: { path: 'README.md' }
              },
              {
                role: 'tool_call',
                callId: 'freeform-call',
                name: 'apply_patch',
                arguments: freeformCall.input,
                inputMode: 'freeform'
              },
              {
                role: 'tool',
                callId: 'function-call',
                name: 'read',
                content: 'README contents'
              },
              {
                role: 'tool',
                callId: 'freeform-call',
                name: 'apply_patch',
                content: 'Patch applied.',
                inputMode: 'freeform'
              },
              { role: 'user', content: 'What changed?' }
            ]
          },
          new AbortController().signal
        )
      );

      expect(fixture.requests).toHaveLength(2);
      expect(fixture.requests[0]).not.toHaveProperty('previous_response_id');
      expect(fixture.requests[1]).toMatchObject({ previous_response_id: 'response-1' });
      expect(fixture.requests[1]?.input).toEqual([
        {
          type: 'function_call_output',
          call_id: 'function-call',
          output: 'README contents'
        },
        {
          type: 'custom_tool_call_output',
          call_id: 'freeform-call',
          output: 'Patch applied.'
        },
        { role: 'user', content: 'What changed?' }
      ]);
      expect(fixture.connections()).toBe(1);
    } finally {
      await turn.close();
    }
  });

  it('replays full history when the client tool catalog changes', async () => {
    const functionCall = {
      type: 'function_call',
      id: 'function-item',
      call_id: 'function-call',
      name: 'read',
      arguments: '{"path":"README.md"}'
    };
    const fixture = await startResponsesWebSocketServer([], {
      responsesByRequest: [
        completedEvents('response-1', [functionCall]),
        completedEvents('response-2', [messageItem('response-2', 'Changed tools')])
      ]
    });
    webSocketFixtures.push(fixture);
    const adapter = registerAdapter(
      new OpenAiResponsesAdapter(configuration(fixture.baseUrl, { responsesToolNamespace: 'mar' }))
    );
    const turn = adapter.createTurnSession();

    try {
      await collect(turn.start(toolRequest([clientTools()[0]!]), new AbortController().signal));
      await collect(
        turn.start(
          {
            ...toolRequest([clientTools()[0]!, clientTools()[1]!]),
            messages: [
              { role: 'user', content: 'Inspect.' },
              providerMessage(functionCall, 'standard'),
              { role: 'user', content: 'Now use the changed catalog.' }
            ]
          },
          new AbortController().signal
        )
      );

      expect(fixture.requests).toHaveLength(2);
      expect(fixture.requests[1]).not.toHaveProperty('previous_response_id');
      expect(fixture.requests[1]?.input).toEqual([
        { role: 'developer', content: [{ type: 'input_text', text: 'Preserve task state.' }] },
        { role: 'user', content: 'Inspect.' },
        functionCall,
        { role: 'user', content: 'Now use the changed catalog.' }
      ]);
      expect(fixture.requests[1]?.tools).toEqual([
        {
          type: 'namespace',
          name: 'mar',
          description: 'Client-side agent tools.',
          tools: [
            expect.objectContaining({ type: 'function', name: 'read' }),
            {
              type: 'custom',
              name: 'apply_patch',
              description: 'Apply a patch.'
            }
          ]
        }
      ]);
    } finally {
      await turn.close();
    }
  });

  it('replays full history after a WebSocket reconnect', async () => {
    const message = messageItem('response-1', 'First answer');
    const fixture = await startResponsesWebSocketServer([], {
      closeAfterRequestIndexes: [0],
      responsesByRequest: [
        completedEvents('response-1', [message]),
        completedEvents('response-2', [messageItem('response-2', 'Recovered')])
      ]
    });
    webSocketFixtures.push(fixture);
    const adapter = registerAdapter(
      new OpenAiResponsesAdapter(configuration(fixture.baseUrl, { responsesToolNamespace: 'mar' }))
    );
    const turn = adapter.createTurnSession();

    try {
      await collect(
        turn.start(
          {
            ...toolRequest(),
            messages: [{ role: 'user', content: 'First question.' }]
          },
          new AbortController().signal
        )
      );
      await vi.waitFor(() => expect(fixture.closedConnections()).toBe(1));
      await collect(
        turn.start(
          {
            ...toolRequest(),
            messages: [
              { role: 'user', content: 'First question.' },
              providerMessage(message, 'standard'),
              { role: 'user', content: 'Continue after reconnect.' }
            ]
          },
          new AbortController().signal
        )
      );

      expect(fixture.connections()).toBe(2);
      expect(fixture.requests).toHaveLength(2);
      expect(fixture.requests[1]).not.toHaveProperty('previous_response_id');
      expect(fixture.requests[1]?.input).toEqual([
        { role: 'developer', content: [{ type: 'input_text', text: 'Preserve task state.' }] },
        { role: 'user', content: 'First question.' },
        message,
        { role: 'user', content: 'Continue after reconnect.' }
      ]);
    } finally {
      await turn.close();
    }
  });
});

function configuration(
  baseUrl: string,
  overrides: Partial<AgentModelConfiguration> = {}
): AgentModelConfiguration {
  return {
    id: 'standard',
    name: 'Standard Responses',
    protocol: 'OPENAI_RESPONSES',
    baseUrl,
    apiKey: new SecretValue('test-key'),
    modelId: 'test-model',
    contextWindowTokens: 200_000,
    maxOutputTokens: 4_096,
    inputCapabilities: ['TEXT'],
    outputCapabilities: ['TEXT'],
    reasoningEfforts: ['high'],
    defaultReasoningEffort: 'high',
    hostedWebSearch: false,
    responsesTransport: { transport: 'WEBSOCKET' },
    responsesPreviousResponseId: true,
    enabled: true,
    ...overrides
  };
}

function clientTools() {
  return [
    {
      name: 'read',
      description: 'Read a known file.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false
      }
    },
    {
      name: 'apply_patch',
      description: 'Apply a patch.',
      inputSchema: { type: 'string' },
      inputMode: 'freeform' as const
    }
  ];
}

function toolRequest(tools: ModelRequest['tools'] = clientTools()): ModelRequest {
  return {
    system: 'Preserve task state.',
    messages: [{ role: 'user', content: 'Inspect and patch.' }],
    tools,
    allowTools: true,
    toolChoice: 'auto',
    reasoningEffort: 'high'
  };
}

function providerMessage(
  item: Record<string, unknown>,
  providerModelId: string
): {
  role: 'provider';
  provider: 'OPENAI_RESPONSES';
  providerModelId: string;
  content: string;
  item: Record<string, unknown>;
} {
  return {
    role: 'provider',
    provider: 'OPENAI_RESPONSES',
    providerModelId,
    content: '',
    item
  };
}

function messageItem(responseId: string, text: string): Record<string, unknown> {
  return {
    type: 'message',
    id: `${responseId}-message`,
    role: 'assistant',
    phase: 'final_answer',
    status: 'completed',
    content: [{ type: 'output_text', text }]
  };
}

function completedEvents(
  responseId: string,
  outputItems: readonly Record<string, unknown>[] = []
): unknown[] {
  return [
    { type: 'response.created', response: { id: responseId } },
    ...outputItems.map((item) => ({ type: 'response.output_item.done', item })),
    {
      type: 'response.completed',
      response: {
        id: responseId,
        output: outputItems,
        usage: {
          input_tokens: 20,
          output_tokens: 5,
          input_tokens_details: { cached_tokens: 0 }
        }
      }
    }
  ];
}

function registerAdapter(adapter: OpenAiResponsesAdapter): OpenAiResponsesAdapter {
  adapters.push(adapter);
  return adapter;
}

async function collect(source: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of source) events.push(event);
  return events;
}

async function startHttpResponsesServer(events: readonly unknown[]): Promise<HttpFixture> {
  const requests: Record<string, unknown>[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      requests.push(JSON.parse(body) as Record<string, unknown>);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('HTTP fixture unavailable');
  return { server, baseUrl: `http://127.0.0.1:${address.port}`, requests };
}

async function closeServer(server: { close(callback: (error?: Error) => void): void }) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
