import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalAgentHost, type McpToolCatalog } from '../../src/host.js';
import { SecretValue, type AgentModelConfiguration } from '../../src/index.js';
import { createAgentWithAdapter as createMarAgent } from '../../src/sdk/agent.js';
import { OpenAiResponsesAdapter } from '../../src/model/openai-responses.js';
import { JsonlSessionStore } from '../../src/session/store/index.js';
import {
  codeModeToolDefinition,
  projectCodeModeTools,
  projectCodeModeSearchResult
} from '../../src/tools/code-mode/index.js';
import type {
  ModelAttemptDiagnostic,
  ModelEvent,
  ModelMessage,
  ModelRequest
} from '../../src/model/contracts.js';
import {
  startResponsesWebSocketServer,
  type CloseableServer
} from './support/responses-transport-servers.js';

const roots: string[] = [];
const servers: CloseableServer[] = [];
const requestHashFields = [
  'requestInstructionsHash',
  'requestToolsHash',
  'requestPropertiesHash',
  'requestInputHash'
] as const;
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve()))
          )
      )
  );
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const configuration = (baseUrl: string): AgentModelConfiguration => ({
  id: 'prefix',
  name: 'Prefix',
  protocol: 'OPENAI_RESPONSES',
  baseUrl,
  apiKey: new SecretValue('fixture'),
  modelId: 'fixture',
  contextWindowTokens: 200000,
  maxOutputTokens: 4096,
  inputCapabilities: ['TEXT'],
  outputCapabilities: ['TEXT'],
  reasoningEfforts: [],
  hostedWebSearch: false,
  responsesTransport: { transport: 'WEBSOCKET' },
  responsesPreviousResponseId: true,
  titleGeneration: false,
  enabled: true
});
const item = (id: string) => ({
  type: 'message',
  id: `${id}-message`,
  role: 'assistant',
  status: 'completed',
  phase: 'final_answer',
  content: [{ type: 'output_text', text: 'Done.' }]
});
const completed = (id: string) => [
  { type: 'response.created', response: { id } },
  { type: 'response.output_item.done', item: item(id) },
  {
    type: 'response.completed',
    response: { id, usage: { input_tokens: 100, output_tokens: 1, input_tokens_details: {} } }
  }
];
async function consume(events: AsyncIterable<ModelEvent>) {
  for await (const event of events) {
    void event;
    /* Drain the isolated stream. */
  }
}
const messages = (): ModelMessage[] => [
  { role: 'user', content: 'first' },
  {
    role: 'provider',
    provider: 'OPENAI_RESPONSES',
    providerModelId: 'prefix',
    content: '',
    item: item('first')
  },
  { role: 'assistant', content: 'Done.' },
  { role: 'user', content: 'next' }
];

describe('Responses serialized prefix stability', () => {
  it('does not let mutable open-object schemas rewrite the previous request snapshot', async () => {
    const server = await startResponsesWebSocketServer([], {
      responsesByRequest: [completed('first'), completed('second')]
    });
    servers.push(server.server);
    const adapter = new OpenAiResponsesAdapter(configuration(server.baseUrl));
    const turn = adapter.createTurnSession();
    const schema = { type: 'object', additionalProperties: true, description: 'Before' };
    const diagnostics: ModelAttemptDiagnostic[] = [];
    const request: ModelRequest = {
      system: 'Stable.',
      messages: [{ role: 'user', content: 'first' }],
      tools: [{ name: 'lookup', description: 'Lookup.', inputSchema: schema }],
      onAttemptDiagnostic: (diagnostic) => {
        diagnostics.push(diagnostic);
      }
    };
    try {
      await consume(turn.start(request, new AbortController().signal));
      schema.description = 'After';
      await consume(turn.start({ ...request, messages: messages() }, new AbortController().signal));
      expect(server.requests[0]).toMatchObject({
        tools: [{ parameters: { description: 'Before' } }]
      });
      expect(server.requests[1]).toMatchObject({
        tools: [{ parameters: { description: 'After' } }]
      });
      expect(server.requests[1]).not.toHaveProperty('previous_response_id');
      const started = diagnostics.filter((diagnostic) => diagnostic.state === 'STARTED');
      expect(started).toHaveLength(2);
      for (const diagnostic of diagnostics)
        for (const field of requestHashFields) expect(diagnostic).not.toHaveProperty(field);
      expect(started[0]?.requestInputItems).toBe(2);
      expect(JSON.stringify(diagnostics)).not.toContain('Before');
      expect(JSON.stringify(diagnostics)).not.toContain('After');
    } finally {
      await turn.close();
      await adapter.close();
    }
  });

  it.each([true, false])(
    'stabilizes equivalent schema key order before final comparison (open: %s)',
    async (open) => {
      const server = await startResponsesWebSocketServer([], {
        responsesByRequest: [completed('first'), completed('second')]
      });
      servers.push(server.server);
      const adapter = new OpenAiResponsesAdapter(configuration(server.baseUrl));
      const turn = adapter.createTurnSession();
      const tool = {
        name: 'lookup',
        description: 'Lookup.',
        inputSchema: open
          ? { type: 'object', additionalProperties: true }
          : {
              type: 'object',
              properties: { value: { type: 'string' } },
              required: ['value'],
              additionalProperties: false
            }
      };
      try {
        await consume(
          turn.start(
            { system: 'Stable.', messages: [{ role: 'user', content: 'first' }], tools: [tool] },
            new AbortController().signal
          )
        );
        await consume(
          turn.start(
            {
              system: 'Stable.',
              messages: messages(),
              tools: [
                {
                  ...tool,
                  inputSchema: Object.fromEntries(Object.entries(tool.inputSchema).reverse())
                }
              ]
            },
            new AbortController().signal
          )
        );
        const first = server.requests[0] as Record<string, unknown>;
        const second = server.requests[1] as Record<string, unknown>;
        expect(first.tools).toEqual(second.tools);
        expect(JSON.stringify(first.tools)).toBe(JSON.stringify(second.tools));
        expect(second.previous_response_id).toBe('first');
      } finally {
        await turn.close();
        await adapter.close();
      }
    }
  );

  it('preserves native output order after an explicit history replacement', async () => {
    const server = await startResponsesWebSocketServer([], {
      responsesByRequest: [completed('first'), completed('second')]
    });
    servers.push(server.server);
    const adapter = new OpenAiResponsesAdapter(configuration(server.baseUrl));
    const turn = adapter.createTurnSession();
    try {
      await consume(
        turn.start(
          { system: 'Stable.', messages: [{ role: 'user', content: 'first' }], tools: [] },
          new AbortController().signal
        )
      );
      const reordered = Object.fromEntries(Object.entries(item('first')).reverse());
      const next = messages().map((message) =>
        message.role === 'provider' ? { ...message, item: reordered } : message
      );
      turn.resetContinuation();
      await consume(
        turn.start({ system: 'Stable.', messages: next, tools: [] }, new AbortController().signal)
      );
      expect(server.requests[1]).not.toHaveProperty('previous_response_id');
      expect(JSON.stringify((server.requests[1] as { input: unknown[] }).input[2])).toBe(
        JSON.stringify(reordered)
      );
    } finally {
      await turn.close();
      await adapter.close();
    }
  });

  it('stabilizes programmatic directory order without changing source schemas or arrays', () => {
    const schema = {
      type: 'object',
      properties: {
        value: {
          anyOf: [
            { type: 'string', title: 'Z' },
            { type: 'integer', title: 'A' }
          ]
        }
      },
      required: ['value'],
      additionalProperties: false
    };
    const original = JSON.stringify(schema);
    const tool = (name: string, inputSchema = schema) => ({
      name,
      description: 'Stable.',
      inputSchema,
      allowedCallers: ['programmatic'] as const
    });
    const first = projectCodeModeTools([codeModeToolDefinition, tool('zeta'), tool('alpha')]);
    const rebuilt = {
      additionalProperties: false,
      required: ['value'],
      properties: {
        value: {
          anyOf: [
            { title: 'Z', type: 'string' },
            { title: 'A', type: 'integer' }
          ]
        }
      },
      type: 'object'
    };
    const next = projectCodeModeTools([
      codeModeToolDefinition,
      tool('alpha', rebuilt),
      tool('zeta', rebuilt)
    ]);
    expect(first[0]!.description).toBe(next[0]!.description);
    expect(first[0]!.description.indexOf('"alpha"')).toBeLessThan(
      first[0]!.description.indexOf('"zeta"')
    );
    expect(first[0]!.description.indexOf('"title":"Z"')).toBeLessThan(
      first[0]!.description.indexOf('"title":"A"')
    );
    expect(JSON.stringify(schema)).toBe(original);
  });

  it('stabilizes search-result schemas without reordering discovery results', () => {
    const tool = (name: string, reversed: boolean) => ({
      name,
      description: 'Stable.',
      inputSchema: reversed
        ? { additionalProperties: true, type: 'object' }
        : { type: 'object', additionalProperties: true }
    });
    for (const codeMode of [true, false]) {
      const project = (reversed: boolean) =>
        projectCodeModeSearchResult(
          {
            role: 'tool',
            content: '',
            toolSearchTools: ['zeta', 'alpha'].map((name) => tool(name, reversed))
          },
          codeMode
        );
      expect(JSON.stringify(project(false))).toBe(JSON.stringify(project(true)));
      expect(project(true).toolSearchTools!.map((definition) => definition.name)).toEqual([
        'zeta',
        'alpha'
      ]);
    }
  });

  it('replays changed native output after its owner resets continuation', async () => {
    const server = await startResponsesWebSocketServer([], {
      responsesByRequest: [completed('first'), completed('second')]
    });
    servers.push(server.server);
    const adapter = new OpenAiResponsesAdapter(configuration(server.baseUrl));
    const turn = adapter.createTurnSession();
    try {
      let output: Record<string, unknown> | undefined;
      for await (const event of turn.start(
        { system: 'Stable.', messages: [{ role: 'user', content: 'first' }], tools: [] },
        new AbortController().signal
      ))
        if (event.type === 'response.item') output = event.item;
      (output!.content as Array<{ text: string }>)[0]!.text = 'Changed';
      turn.resetContinuation();
      await consume(
        turn.start(
          {
            system: 'Stable.',
            messages: [
              { role: 'user', content: 'first' },
              {
                role: 'provider',
                provider: 'OPENAI_RESPONSES',
                providerModelId: 'prefix',
                content: '',
                item: output
              },
              { role: 'assistant', content: 'Changed' },
              { role: 'user', content: 'next' }
            ],
            tools: []
          },
          new AbortController().signal
        )
      );
      expect(server.requests[1]).not.toHaveProperty('previous_response_id');
    } finally {
      await turn.close();
      await adapter.close();
    }
  });

  it.each(['completed', 'cancelled', 'restart'] as const)(
    'keeps AGENTS, re-enumerated MCP schemas and existing input stable after %s',
    async (boundary) => {
      const root = await mkdtemp(join(tmpdir(), 'mar-wire-prefix-'));
      roots.push(root);
      const home = join(root, 'home');
      const workspace = join(root, 'workspace');
      await mkdir(workspace);
      await writeFile(join(workspace, 'AGENTS.md'), 'PREFIX_RULE_STABLE');
      const server = await startResponsesWebSocketServer([], {
        responsesByRequest: [
          completed('first'),
          boundary === 'cancelled' ? [] : completed('second'),
          completed('third')
        ]
      });
      servers.push(server.server);
      let reverseCatalog = false;
      const catalog = (): McpToolCatalog => ({
        revision: 'stable',
        servers: [{ id: 'fixture', name: 'Fixture' }],
        tools: (reverseCatalog ? ['beta', 'alpha'] : ['alpha', 'beta']).map((name) => ({
          serverId: 'fixture',
          rawName: name,
          sourceIdentity: name,
          definitionRevision: 'stable',
          lifetime: 'session',
          exposure: 'direct',
          definition: {
            name: `mcp__fixture__${name}`,
            description: 'Stable.',
            inputSchema: reverseCatalog
              ? {
                  additionalProperties: false,
                  required: ['value'],
                  properties: { value: { type: 'string' } },
                  type: 'object'
                }
              : {
                  type: 'object',
                  properties: { value: { type: 'string' } },
                  required: ['value'],
                  additionalProperties: false
                }
          }
        }))
      });
      const create = () =>
        createMarAgent({
          mode: 'normal',
          host: new LocalAgentHost({
            homeDirectory: home,
            workspace,
            mcpCatalog: catalog,
            callMcp: async () => ({ content: 'Unused.' })
          }),
          models: [configuration(server.baseUrl)]
        });
      let agent = await create();
      let sessionId = '';
      try {
        let session = await agent.createSession({ workspace, title: 'Prefix' });
        const id = session.id;
        sessionId = id;
        expect((await session.run({ prompt: 'first' }).result()).status).toBe('completed');
        reverseCatalog = true;
        const pending = session.run({ prompt: 'middle' });
        if (boundary === 'cancelled') {
          await vi.waitFor(() => expect(server.requests).toHaveLength(2));
          pending.cancel();
        }
        expect((await pending.result()).status).toBe(
          boundary === 'cancelled' ? 'cancelled' : 'completed'
        );
        if (boundary === 'restart') {
          await agent.dispose();
          agent = await create();
          session = await agent.openSession(id);
        }
        expect((await session.run({ prompt: 'last' }).result()).status).toBe('completed');
        const first = server.requests[0] as {
          instructions: string;
          tools: unknown[];
          input: unknown[];
        };
        const last = server.requests[2] as {
          instructions: string;
          tools: unknown[];
          input: unknown[];
          previous_response_id?: string;
        };
        expect(last.instructions).toBe(first.instructions);
        expect(JSON.stringify(last.tools)).toBe(JSON.stringify(first.tools));
        expect(JSON.stringify(first.tools)).toContain('mcp__fixture__alpha');
        expect(JSON.stringify(first.input)).toContain('PREFIX_RULE_STABLE');
        if (boundary === 'completed') {
          expect(last.previous_response_id).toBe('second');
          expect(JSON.stringify(last.input)).not.toContain('PREFIX_RULE_STABLE');
          expect(server.connections()).toBe(1);
        } else {
          expect(last.previous_response_id).toBeUndefined();
          expect(JSON.stringify(last.input.slice(0, first.input.length))).toBe(
            JSON.stringify(first.input)
          );
          expect(server.connections()).toBe(2);
        }
      } finally {
        await agent.dispose();
      }
      const store = await JsonlSessionStore.open(home);
      try {
        const attempts = (await store.read(sessionId)).filter(
          (record) => record.type === 'model.attempt' && record.payload['state'] === 'STARTED'
        );
        expect(attempts).toHaveLength(3);
        for (const attempt of attempts) {
          for (const field of requestHashFields) expect(attempt.payload).not.toHaveProperty(field);
          expect(attempt.payload['requestInputItems']).toBeGreaterThan(0);
        }
        const persistedDiagnostics = JSON.stringify(attempts);
        expect(persistedDiagnostics).not.toContain('PREFIX_RULE_STABLE');
        expect(persistedDiagnostics).not.toContain('mcp__fixture__alpha');
        for (const field of ['instructions', 'tools', 'input', 'parameters', 'headers', 'apiKey'])
          expect(persistedDiagnostics).not.toContain(`"${field}":`);
      } finally {
        await store.close();
      }
    }
  );
});
