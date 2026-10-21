import { createRequire } from 'node:module';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  LocalAgentHost,
  parseModelCatalog,
  type MarAgentEvent,
  type MarAgentModelConfiguration
} from '../../../mar-agent/src/index.js';
import { AnthropicMessagesAdapter } from '../../../mar-agent/src/agent-core/model/anthropic-messages.js';
import { OpenAiResponsesAdapter } from '../../../mar-agent/src/agent-core/model/openai-responses.js';
import type {
  ModelAdapter,
  ModelRequest,
  ModelTurnSession
} from '../../../mar-agent/src/agent-core/model/contracts.js';
import { createMarAgentWithAdapter } from '../../../mar-agent/src/agent-core/sdk/agent.js';
import type { ResolvedMcpServer } from '../../src/mcp/model.js';
import { MarAgentMcpClientPool } from '../../src/runner/mar-agent/mcp-client-pool.js';

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

describe.runIf(process.env['MAR_AGENT_REAL_E2E'] === '1')(
  'real MAR built-in and Playwright MCP discovery',
  () => {
    it.each([
      { id: 'gpt-5.6-luna', protocol: 'OPENAI_RESPONSES' },
      { id: 'coding', protocol: 'ANTHROPIC_MESSAGES' }
    ] as const)(
      'keeps built-ins direct and discovers the Playwright catalog with $id',
      async ({ id, protocol }) => {
        const modelPath = join(import.meta.dirname, '../../../mar-agent/.e2e/models.local.json');
        const models = parseModelCatalog(JSON.parse(await readFile(modelPath, 'utf8'))).models;
        const configured = models.find(
          (value) => value.id === id && value.protocol === protocol && value.enabled
        );
        expect(configured, `Missing enabled ${id} real-model configuration`).toBeDefined();
        expect(existsSync('/usr/bin/google-chrome')).toBe(true);
        const model = {
          ...configured!,
          codeMode: false,
          hostedWebSearch: false,
          sessionTitleGeneration: false
        };
        const root = await mkdtemp(join(tmpdir(), 'mar-node-tool-search-real-'));
        roots.push(root);
        const home = join(root, 'home');
        const workspace = join(root, 'workspace');
        await Promise.all([mkdir(home), mkdir(workspace)]);
        const builtin = await builtinFixture(root);
        const page = createHttpServer((_request, response) => {
          response
            .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
            .end('<title>MAR Playwright MCP Fixture</title><h1>PLAYWRIGHT_FIXTURE</h1>');
        });
        page.listen(0, '127.0.0.1');
        await once(page, 'listening');
        const address = page.address();
        if (address === null || typeof address === 'string')
          throw new Error('Playwright fixture listener unavailable.');
        const pageUrl = `http://127.0.0.1:${address.port}/`;
        const require = createRequire(import.meta.url);
        const playwrightCli = join(dirname(require.resolve('@playwright/mcp')), 'cli.js');
        const servers: ResolvedMcpServer[] = [
          ...builtin.servers,
          {
            name: 'playwright',
            origin: 'USER',
            transport: 'STDIO',
            command: process.execPath,
            args: [
              playwrightCli,
              '--headless',
              '--isolated',
              '--browser',
              'chrome',
              '--executable-path',
              '/usr/bin/google-chrome',
              '--no-sandbox',
              '--no-webmcp',
              '--snapshot-mode',
              'none'
            ]
          }
        ];
        let pool: MarAgentMcpClientPool | undefined;
        let agent: Awaited<ReturnType<typeof createMarAgentWithAdapter>> | undefined;
        try {
          pool = await MarAgentMcpClientPool.connect(servers, workspace);
          const catalog = pool.catalog();
          const playwrightTools = catalog.tools.filter(
            (tool) =>
              tool.serverId === catalog.servers.find((server) => server.name === 'playwright')?.id
          );
          expect(playwrightTools.length).toBeGreaterThanOrEqual(20);
          expect(playwrightTools.every((tool) => tool.exposure === 'deferred')).toBe(true);
          expect(
            catalog.tools
              .filter((tool) => tool.serverId !== playwrightTools[0]?.serverId)
              .every((tool) => tool.exposure === 'direct' && tool.lifetime === 'execution')
          ).toBe(true);
          const requests: ModelRequest[] = [];
          const toolCalls: string[] = [];
          const host = new LocalAgentHost({
            homeDirectory: home,
            workspace,
            mcpCatalog: () => pool!.catalog(),
            callMcp: async (call, signal, context) => {
              toolCalls.push(call.name);
              return pool!.call(call.name, call.arguments, signal, context?.expectedTool);
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
          const session = await agent.createSession({
            workspace,
            title: 'MAR built-in and Playwright MCP'
          });
          const run = async (prompt: string, target: MarAgentEvent[]) => {
            const execution = session.run({ prompt });
            for await (const event of execution) target.push(event);
            const result = await execution.result();
            expect(result.status).toBe('completed');
          };
          await run(
            [
              'This is an isolated real-model test.',
              'Call mcp__mar_goal__get_goal with {} exactly once.',
              'Call mcp__mar_schedule__get_scheduled_task with {} exactly once.',
              'Do not call mcp__mar_notification__send_email_notification.',
              'Use tool_search with the exact query "mcp__playwright__browser_navigate".',
              `On the next model response, call that discovered tool with {"url":${JSON.stringify(pageUrl)}} exactly once.`,
              'Do not use any other tools. Then answer PLAYWRIGHT_OK.'
            ].join(' '),
            events
          );
          expect(requests[0]!.tools.map((tool) => tool.name)).toEqual(
            expect.arrayContaining([
              'mcp__mar_goal__get_goal',
              'mcp__mar_goal__update_goal',
              'mcp__mar_schedule__get_scheduled_task',
              'mcp__mar_notification__send_email_notification',
              'tool_search'
            ])
          );
          expect(requests[0]!.tools.map((tool) => tool.name)).not.toContain(
            'mcp__playwright__browser_navigate'
          );
          expect(
            requests.some((request) =>
              requestCarriesTool(request, 'mcp__playwright__browser_navigate')
            )
          ).toBe(true);
          expect(toolCalls).toEqual(
            expect.arrayContaining([
              'mcp__mar_goal__get_goal',
              'mcp__mar_schedule__get_scheduled_task',
              'mcp__playwright__browser_navigate'
            ])
          );
          expect(toolCalls).not.toContain('mcp__mar_notification__send_email_notification');
          expect(
            events.some(
              (event) => event.type === 'tool.completed' && event.toolName === 'tool_search'
            )
          ).toBe(true);
          expect(builtin.calls).toEqual(expect.arrayContaining(['get_goal', 'get_scheduled_task']));

          const cacheRequestIndex = requests.length;
          const cacheEvents: MarAgentEvent[] = [];
          await run('Do not call any tools. Answer CACHE_OK.', cacheEvents);
          const firstToolNames = requests[0]!.tools.map((tool) => tool.name);
          const cacheToolNames = requests[cacheRequestIndex]!.tools.map((tool) => tool.name);
          expect(cacheToolNames.slice(0, firstToolNames.length)).toEqual(firstToolNames);
          expect(
            requestCarriesTool(requests[cacheRequestIndex]!, 'mcp__playwright__browser_navigate')
          ).toBe(true);
          const cacheUsage = cacheEvents.findLast((event) => event.type === 'usage.updated');
          expect(cacheUsage).toBeDefined();
          const contextTokens =
            cacheUsage?.type === 'usage.updated'
              ? (cacheUsage.contextInputTokens ?? cacheUsage.inputTokens ?? 0)
              : 0;
          const cacheReadTokens =
            cacheUsage?.type === 'usage.updated' ? (cacheUsage.cacheReadTokens ?? 0) : 0;
          console.info(
            JSON.stringify({
              test: 'mar-builtins-playwright-tool-search-cache',
              modelId: id,
              contextTokens,
              cacheReadTokens,
              cacheReadRatio: cacheReadTokens / Math.max(contextTokens, 1)
            })
          );
          expect(cacheReadTokens).toBeGreaterThan(0);

          const compact = session.compact({
            prompt:
              'Preserve only that the MAR built-in and Playwright verification completed. Do not preserve tool schemas.'
          });
          for await (const event of compact) events.push(event);
          expect((await compact.result()).status).toBe('completed');
          const postGcRequestIndex = requests.length;
          const postGcEvents: MarAgentEvent[] = [];
          await run('Do not call any tools. Answer GC_OK.', postGcEvents);
          const postGcRequest = requests[postGcRequestIndex]!;
          expect(requestCarriesTool(postGcRequest, 'mcp__playwright__browser_navigate')).toBe(
            false
          );
          expect(postGcRequest.tools.map((tool) => tool.name)).toEqual(
            expect.arrayContaining([
              'mcp__mar_goal__get_goal',
              'mcp__mar_schedule__get_scheduled_task',
              'mcp__mar_notification__send_email_notification'
            ])
          );
        } finally {
          await agent?.dispose();
          await pool?.close();
          page.closeAllConnections();
          await new Promise<void>((resolve) => page.close(() => resolve()));
          await builtin.close();
        }
      },
      300_000
    );
  }
);

async function builtinFixture(root: string): Promise<{
  readonly servers: readonly ResolvedMcpServer[];
  readonly calls: string[];
  close(): Promise<void>;
}> {
  const endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\mar-tool-search-real-${process.pid}-${Date.now()}`
      : join(root, 'builtins.sock');
  const calls: string[] = [];
  const sockets = new Set<Socket>();
  const server = createNetServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.setEncoding('utf8');
    let body = '';
    socket.on('data', (chunk) => {
      body += chunk;
      const newline = body.indexOf('\n');
      if (newline < 0) return;
      const request = JSON.parse(body.slice(0, newline)) as {
        readonly token?: string;
        readonly tool?: string;
      };
      if (request.token !== 'fixture-token' || request.tool === undefined) {
        socket.end(`${JSON.stringify({ error: 'FIXTURE_CAPABILITY_INVALID' })}\n`);
        return;
      }
      calls.push(request.tool);
      const result =
        request.tool === 'get_goal'
          ? { objective: 'Verify MAR built-in MCP', status: 'active' }
          : request.tool === 'get_scheduled_task'
            ? null
            : request.tool === 'send_email_notification'
              ? { accepted: true }
              : undefined;
      socket.end(
        `${JSON.stringify(result === undefined ? { error: 'FIXTURE_TOOL_INVALID' } : { result })}\n`
      );
    });
  });
  server.listen(endpoint);
  await once(server, 'listening');
  const tsx = import.meta.resolve('tsx');
  const stdio = (name: string, file: string, environment: Record<string, string>) =>
    ({
      name,
      origin: 'BUILTIN',
      lifecycle: 'EXECUTION',
      transport: 'STDIO',
      command: process.execPath,
      args: ['--import', tsx, file],
      environment
    }) satisfies ResolvedMcpServer;
  return {
    calls,
    servers: [
      stdio(
        'mar_goal',
        fileURLToPath(new URL('../../src/service/goal-mcp-stdio.ts', import.meta.url)),
        {
          MAR_GOAL_MCP_ENDPOINT: endpoint,
          MAR_GOAL_MCP_TOKEN: 'fixture-token'
        }
      ),
      stdio(
        'mar_schedule',
        fileURLToPath(new URL('../../src/service/schedule-mcp-stdio.ts', import.meta.url)),
        {
          MAR_SCHEDULE_MCP_ENDPOINT: endpoint,
          MAR_SCHEDULE_MCP_TOKEN: 'fixture-token'
        }
      ),
      stdio(
        'mar_notification',
        fileURLToPath(new URL('../../src/service/notification-mcp-stdio.ts', import.meta.url)),
        {
          MAR_NOTIFICATION_MCP_ENDPOINT: endpoint,
          MAR_NOTIFICATION_MCP_TOKEN: 'fixture-token'
        }
      )
    ],
    async close() {
      for (const socket of sockets) socket.destroy();
      await closeNetServer(server);
      if (process.platform !== 'win32') await unlink(endpoint).catch(() => undefined);
    }
  };
}

async function closeNetServer(server: NetServer): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error)))
  );
}
