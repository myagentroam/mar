import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  LocalAgentHost,
  parseModelCatalog,
  type MarAgentEvent,
  type McpToolCatalog,
  type MarAgentModelConfiguration
} from '../../src/index.js';
import { AnthropicMessagesAdapter } from '../../src/agent-core/model/anthropic-messages.js';
import { OpenAiResponsesAdapter } from '../../src/agent-core/model/openai-responses.js';
import type {
  ModelAdapter,
  ModelRequest,
  ModelTurnSession
} from '../../src/agent-core/model/contracts.js';
import { createMarAgentWithAdapter } from '../../src/agent-core/sdk/agent.js';

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});
function capture(model: MarAgentModelConfiguration, requests: ModelRequest[]): ModelAdapter {
  if (model.protocol === 'ANTHROPIC_MESSAGES') {
    const delegate = new AnthropicMessagesAdapter(model);
    return {
      configuration: model,
      async *start(request, signal) {
        requests.push(request);
        yield* delegate.start(request, signal);
      }
    };
  }
  const delegate = new OpenAiResponsesAdapter(model);
  const turn = (value: ModelTurnSession): ModelTurnSession => ({
    async *start(request, signal) {
      requests.push(request);
      yield* value.start(request, signal);
    },
    resetContinuation: () => value.resetContinuation?.(),
    close: () => value.close()
  });
  return {
    configuration: model,
    async *start(request, signal) {
      requests.push(request);
      yield* delegate.start(request, signal);
    },
    createTurnSession: () => turn(delegate.createTurnSession()),
    close: () => delegate.close()
  };
}

function requestCarriesTool(request: ModelRequest, name: string): boolean {
  return (
    request.tools.some((tool) => tool.name === name) ||
    request.messages.some((message) => message.toolSearchTools?.some((tool) => tool.name === name))
  );
}

describe.runIf(process.env.MAR_AGENT_REAL_E2E === '1')('real MCP discovery', () => {
  it.each([
    { id: 'gpt-5.6-luna', protocol: 'OPENAI_RESPONSES' },
    { id: 'coding', protocol: 'ANTHROPIC_MESSAGES' }
  ] as const)(
    'discovers and reuses HTTP fixture tools with $id',
    async ({ id, protocol }) => {
      const models = parseModelCatalog(
        JSON.parse(
          await readFile(join(import.meta.dirname, '../../.e2e/models.local.json'), 'utf8')
        )
      ).models;
      const configured = models.find(
        (value) => value.id === id && value.protocol === protocol && value.enabled
      );
      expect(configured, `Missing enabled ${id} real-model configuration`).toBeDefined();
      const model = {
        ...configured!,
        codeMode: false,
        hostedWebSearch: false,
        sessionTitleGeneration: false
      };
      const root = await mkdtemp(join(tmpdir(), 'mar-tool-search-real-'));
      roots.push(root);
      const home = join(root, 'home');
      const workspace = join(root, 'workspace');
      await Promise.all([mkdir(home), mkdir(workspace)]);
      const calls: string[] = [];
      let lists = 0;
      const definitions = ['alpha', 'beta'].map((name) => ({
        name: `mcp__fixture__read_${name}`,
        description: `Read the ${name} inventory fixture. This is a harmless isolated test.`,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }
      }));
      const server = createServer(async (request, response) => {
        let body = '';
        for await (const chunk of request) body += chunk.toString();
        const message = JSON.parse(body);
        let result: unknown;
        if (message.method === 'tools/list') {
          lists++;
          result = { tools: definitions };
        } else if (message.method === 'tools/call') {
          calls.push(message.params.name);
          result = { content: [{ type: 'text', text: `FIXTURE_RESULT:${message.params.name}` }] };
        } else {
          response.writeHead(400).end();
          return;
        }
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (address === null || typeof address === 'string')
        throw new Error('Fixture listener unavailable.');
      const url = `http://127.0.0.1:${address.port}/mcp`;
      const rpc = async <T>(method: string, params?: unknown, signal?: AbortSignal): Promise<T> => {
        const response = await fetch(url, {
          method: 'POST',
          ...(signal === undefined ? {} : { signal }),
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
        });
        if (!response.ok) throw new Error('Fixture HTTP request failed.');
        return ((await response.json()) as { result: T }).result;
      };
      let agent: Awaited<ReturnType<typeof createMarAgentWithAdapter>> | undefined;
      try {
        const listed = await rpc<{ tools: typeof definitions }>('tools/list');
        const catalog: McpToolCatalog = {
          revision: 'fixture-v1',
          servers: [
            { id: 'fixture', name: 'Fixture', instructions: 'Read alpha and beta inventories.' }
          ],
          tools: listed.tools.map((definition: (typeof definitions)[number]) => ({
            definition,
            rawName: definition.name,
            serverId: 'fixture',
            sourceIdentity: 'fixture-installation',
            definitionRevision: 'v1',
            exposure: 'deferred',
            lifetime: 'session'
          }))
        };
        const requests: ModelRequest[] = [];
        const host = new LocalAgentHost({
          homeDirectory: home,
          workspace,
          mcpCatalog: () => catalog,
          callMcp: async (call, signal) => {
            const result = await rpc<{ content: [{ text: string }] }>(
              'tools/call',
              { name: call.name, arguments: call.arguments },
              signal
            );
            return { content: result.content[0].text };
          }
        });
        agent = await createMarAgentWithAdapter({
          mode: 'normal',
          host,
          models: [model],
          defaultModelId: model.id,
          adapterFactory: () => capture(model, requests)
        });
        const events: MarAgentEvent[] = [];
        const session = await agent.createSession({ workspace, title: 'MCP fixture discovery' });
        const run = async (prompt: string) => {
          const handle = session.run({ prompt });
          for await (const event of handle) events.push(event);
          expect((await handle.result()).status).toBe('completed');
        };
        await run(
          'This is an isolated test. Use tool_search with the exact query "mcp__fixture__read_alpha" to discover its schema. Do not call the inventory tool yet. Do not use any other tools. Then answer "discovered".'
        );
        expect(requests[0]!.tools.map((tool) => tool.name)).not.toContain(definitions[0]!.name);
        expect(requests.some((request) => requestCarriesTool(request, definitions[0]!.name))).toBe(
          true
        );
        expect(calls).toEqual([]);
        const resumedAt = requests.length;
        await run(
          'Now directly call mcp__fixture__read_alpha with {} once; it is already discovered. Do not search again or use other tools. Return the fixture result.'
        );
        expect(requestCarriesTool(requests[resumedAt]!, definitions[0]!.name)).toBe(true);
        expect(calls).toEqual([definitions[0]!.name]);
        const searchAt = requests.length;
        await run(
          'Use tool_search with query "beta inventory" and limit 1, then directly call the selected beta inventory tool with {} once. Do not use other tools. Return the fixture result.'
        );
        expect(requestCarriesTool(requests[searchAt]!, definitions[0]!.name)).toBe(true);
        expect(calls).toEqual([definitions[0]!.name, definitions[1]!.name]);
        expect(lists).toBe(1);
        const searches = events.filter(
          (event) => event.type === 'tool.completed' && event.toolName === 'tool_search'
        );
        expect(searches).toHaveLength(2);
      } finally {
        await agent?.dispose();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        );
      }
    },
    180_000
  );
});
