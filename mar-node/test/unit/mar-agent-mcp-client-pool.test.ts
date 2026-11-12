import { executionActivity } from './support/execution-activity.js';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalAgentHost } from '../../../mar-agent/src/host.js';
import type { LocalProcessSpawnRequest } from '../../../mar-agent/src/host.js';
import { directLocalProcessExecutor } from '../../../mar-agent/src/host/local-process-executor.js';
import {
  SecretValue,
  type AgentEvent,
  type AgentModelConfiguration
} from '../../../mar-agent/src/index.js';
import { createAgentWithAdapter as createMarAgent } from '../../../mar-agent/src/sdk/agent.js';
import type {
  ModelAdapter,
  ModelEvent,
  ModelRequest
} from '../../../mar-agent/src/model/contracts.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MarAgentMcpClientCache,
  MarAgentMcpClientPool
} from '../../src/runner/mar-agent/mcp-client-pool.js';
import type { ResolvedMcpServer } from '../../src/mcp/model.js';
import { MarAgentManagedRunController } from '../../src/runner/mar-agent/managed-run-controller.js';
import { MarAgentRunner } from '../../src/runner/mar-agent-runner.js';
import { GoalMcpBridge } from '../../src/service/goal-mcp-bridge.js';
import { GoalRuntime } from '../../src/service/goal-runtime.js';

const server = (environment: Readonly<Record<string, string>> = {}) => ({
  name: 'test server',
  transport: 'STDIO' as const,
  command: process.execPath,
  args: [fileURLToPath(new URL('../support/mar-agent-mcp-server.mjs', import.meta.url))],
  environment
});

function mcpResultModel(codeMode: boolean): AgentModelConfiguration {
  return {
    id: `mcp-result-${codeMode ? 'code-mode' : 'direct'}`,
    name: 'MCP result fixture',
    protocol: 'ANTHROPIC_MESSAGES',
    baseUrl: 'https://example.test',
    apiKey: new SecretValue('fixture-only'),
    modelId: 'mcp-result-fixture',
    contextWindowTokens: 32_000,
    maxOutputTokens: 1_024,
    inputCapabilities: ['TEXT'],
    outputCapabilities: ['TEXT'],
    reasoningEfforts: [],
    hostedWebSearch: false,
    titleGeneration: false,
    codeMode,
    enabled: true
  };
}

function mcpResultHost(home: string, pool: MarAgentMcpClientPool): LocalAgentHost {
  return new LocalAgentHost({
    homeDirectory: home,
    workspace: home,
    mcpCatalog: () => pool.catalog(),
    callMcp: (call, signal, context) =>
      pool.call(call.name, call.arguments, signal, context?.expectedTool)
  });
}

describe('MCP cache acquisition', () => {
  const mockConnections = () => {
    const pools: MarAgentMcpClientPool[] = [];
    const connect = vi.spyOn(MarAgentMcpClientPool, 'connect').mockImplementation(async () => {
      const pool = new MarAgentMcpClientPool();
      vi.spyOn(pool, 'close').mockResolvedValue(undefined);
      pools.push(pool);
      return pool;
    });
    return { connect, pools };
  };

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('shares one cold pool until all leases release and idle expiry', async () => {
    vi.useFakeTimers();
    const { connect, pools } = mockConnections();
    const cache = new MarAgentMcpClientCache({ idleTtlMs: 50 });
    try {
      const [first, second] = await Promise.all([
        cache.acquire([server()], process.cwd(), {
          authorizationScope: 'actor-a',
          owner: { sessionId: 'first-session', executionId: 'first-run' }
        }),
        cache.acquire([server()], process.cwd(), {
          authorizationScope: 'actor-a',
          owner: { sessionId: 'second-session', executionId: 'second-run' }
        })
      ]);
      expect(connect).toHaveBeenCalledTimes(1);
      expect(first.pool).toBe(second.pool);
      await first.release();
      await first.release();
      await vi.advanceTimersByTimeAsync(50);
      expect(first.pool.close).not.toHaveBeenCalled();
      await second.release();
      await vi.advanceTimersByTimeAsync(49);
      expect(first.pool.close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(first.pool.close).toHaveBeenCalledTimes(1);
      await cache.close();
      expect(pools.every((pool) => vi.mocked(pool.close).mock.calls.length === 1)).toBe(true);
    } finally {
      await cache.close();
    }
  });

  it('closes a shared cold pool once while leases are still active', async () => {
    const { connect, pools } = mockConnections();
    const cache = new MarAgentMcpClientCache({ maxEntries: 1 });
    try {
      const [first, second] = await Promise.all([
        cache.acquire([server()], process.cwd()),
        cache.acquire([server()], process.cwd())
      ]);
      expect(connect).toHaveBeenCalledTimes(1);
      expect(first.pool).toBe(second.pool);
      await cache.close();
      await first.release();
      await second.release();
      await cache.close();
      expect(pools).toHaveLength(1);
      expect(first.pool.close).toHaveBeenCalledTimes(1);
      await expect(cache.acquire([server()], process.cwd())).rejects.toThrow(
        'MAR_AGENT_MCP_CACHE_CLOSED'
      );
    } finally {
      await cache.close();
    }
  });

  it.each([false, true])(
    'joins the same key created while idle eviction waits (close rejects: %s)',
    async (rejectClose) => {
      const { connect } = mockConnections();
      const cache = new MarAgentMcpClientCache({ maxEntries: 1 });
      const closing = Promise.withResolvers<void>();
      try {
        const idle = await cache.acquire([server({ TOKEN: 'old' })], process.cwd());
        vi.mocked(idle.pool.close).mockReturnValue(closing.promise);
        await idle.release();
        const waiting = cache.acquire([server({ TOKEN: 'new' })], process.cwd());
        const second = await cache.acquire([server({ TOKEN: 'new' })], process.cwd());
        if (rejectClose) closing.reject(new Error('fixture close failure'));
        else closing.resolve();
        const first = await waiting;
        expect(connect).toHaveBeenCalledTimes(2);
        expect(first.pool).toBe(second.pool);
        expect(idle.pool.close).toHaveBeenCalledTimes(1);
        await first.release();
        expect(second.pool.close).not.toHaveBeenCalled();
        await second.release();
        await cache.close();
        expect(second.pool.close).toHaveBeenCalledTimes(1);
      } finally {
        closing.resolve();
        await cache.close();
      }
    }
  );

  it('keeps active entries and uses single-use pools when capacity is exhausted', async () => {
    const { connect } = mockConnections();
    const cache = new MarAgentMcpClientCache({ maxEntries: 1 });
    try {
      const active = await cache.acquire([server({ TOKEN: 'active' })], process.cwd());
      const [first, second] = await Promise.all([
        cache.acquire([server({ TOKEN: 'overflow' })], process.cwd()),
        cache.acquire([server({ TOKEN: 'overflow' })], process.cwd())
      ]);
      expect(connect).toHaveBeenCalledTimes(3);
      expect(first.pool).not.toBe(second.pool);
      await first.release();
      await first.release();
      await second.release();
      expect(first.pool.close).toHaveBeenCalledTimes(1);
      expect(second.pool.close).toHaveBeenCalledTimes(1);
      expect(active.pool.close).not.toHaveBeenCalled();
      await active.release();
      await cache.close();
      expect(active.pool.close).toHaveBeenCalledTimes(1);
    } finally {
      await cache.close();
    }
  });

  it('isolates concurrent cwd, resolved configuration, caller policy and authorization scopes', async () => {
    const { connect, pools } = mockConnections();
    const cache = new MarAgentMcpClientCache();
    const cwd = process.cwd();
    try {
      const leases = await Promise.all([
        cache.acquire([server({ TOKEN: 'one' })], cwd, { authorizationScope: 'actor-a' }),
        cache.acquire([server({ TOKEN: 'one' })], cwd, { authorizationScope: 'actor-a' }),
        cache.acquire([server({ TOKEN: 'two' })], cwd, { authorizationScope: 'actor-a' }),
        cache.acquire([server({ TOKEN: 'one' })], join(cwd, 'other'), {
          authorizationScope: 'actor-a'
        }),
        cache.acquire([server({ TOKEN: 'one' })], cwd, { authorizationScope: 'actor-b' }),
        cache.acquire(
          [{ ...server({ TOKEN: 'one' }), allowedToolCallers: { echo: ['direct'] } }],
          cwd,
          { authorizationScope: 'actor-a' }
        )
      ]);
      expect(connect).toHaveBeenCalledTimes(5);
      expect(leases[0]!.pool).toBe(leases[1]!.pool);
      expect(new Set(leases.slice(1).map((lease) => lease.pool)).size).toBe(5);
      await Promise.all(leases.map((lease) => lease.release()));
      await cache.close();
      for (const pool of pools) expect(pool.close).toHaveBeenCalledTimes(1);
    } finally {
      await cache.close();
    }
  });

  it('does not cache non-reusable pools or allow reusable sandbox processes', async () => {
    const { connect } = mockConnections();
    const cache = new MarAgentMcpClientCache();
    try {
      await expect(
        cache.acquire([server()], process.cwd(), { processExecutor: directLocalProcessExecutor })
      ).rejects.toThrow('MAR_AGENT_MCP_SANDBOX_REUSE_INVALID');
      expect(connect).not.toHaveBeenCalled();
      const [first, second] = await Promise.all([
        cache.acquire([server()], process.cwd(), { reusable: false }),
        cache.acquire([server()], process.cwd(), { reusable: false })
      ]);
      expect(first.pool).not.toBe(second.pool);
      await first.release();
      await first.release();
      expect(first.pool.close).toHaveBeenCalledTimes(1);
      expect(second.pool.close).not.toHaveBeenCalled();
      await second.release();
      expect(second.pool.close).toHaveBeenCalledTimes(1);
    } finally {
      await cache.close();
    }
  });

  it('shares a failed connection and permits a fresh acquire after rejection', async () => {
    const { connect } = mockConnections();
    const failure = new Error('fixture connection failure');
    connect.mockRejectedValueOnce(failure);
    const cache = new MarAgentMcpClientCache();
    try {
      const results = await Promise.allSettled([
        cache.acquire([server()], process.cwd()),
        cache.acquire([server()], process.cwd())
      ]);
      expect(results).toEqual([
        { status: 'rejected', reason: failure },
        { status: 'rejected', reason: failure }
      ]);
      expect(connect).toHaveBeenCalledTimes(1);
      const retry = await cache.acquire([server()], process.cwd());
      expect(connect).toHaveBeenCalledTimes(2);
      await retry.release();
      await cache.close();
      expect(retry.pool.close).toHaveBeenCalledTimes(1);
    } finally {
      await cache.close();
    }
  });
});

describe('MAR Agent MCP client pool', () => {
  it('normalizes MCP source dictionary order while preserving values and argument order', () => {
    const runner = new MarAgentRunner();
    const installation = (reverse: boolean) => ({
      id: 'fixture',
      serverName: 'fixture',
      enabled: true,
      runtime: {
        transport: 'STDIO',
        command: process.execPath,
        args: ['first', 'second'],
        environment: {}
      },
      configuration: {
        environment: reverse
          ? { B: { secretName: 'b' }, A: { secretName: 'a' } }
          : { A: { secretName: 'a' }, B: { secretName: 'b' } }
      }
    });
    const resolve = (raw: unknown, b = 'fixture-b') =>
      runner.mcpConfiguration([raw], {
        a: 'fixture-a',
        b,
        MAR_USERNAME: 'fixture'
      }) as readonly ResolvedMcpServer[];
    const first = resolve(installation(false));
    const reordered = resolve(installation(true));
    expect(reordered).toEqual(first);
    expect(resolve(installation(false), 'changed-b')[0]!.environment).not.toEqual(
      first[0]!.environment
    );
    const reversedArgs = installation(false);
    reversedArgs.runtime.args.reverse();
    expect(resolve(reversedArgs)[0]!.sourceIdentity).not.toBe(first[0]!.sourceIdentity);
  });

  it('prepares Goal MCP as an execution-only server during unified resolution', async () => {
    const goals = new GoalRuntime(() => undefined);
    const goal = goals.start('goal-session', 'Goal Start');
    const goalBridge = new GoalMcpBridge(
      goals,
      () => undefined,
      (capability) => capability.sessionId
    );
    const executionServer = await goalBridge.prepare({
      executionId: 'goal-run',
      sessionId: goal.sessionId,
      goalId: goal.id,
      revision: goal.revision
    });
    try {
      const runner = new MarAgentRunner();
      const userInstallations: unknown[] = [];
      const expected = [
        expect.objectContaining({
          name: 'mar_goal',
          origin: 'BUILTIN',
          lifecycle: 'EXECUTION',
          transport: 'STDIO',
          command: process.execPath,
          allowedToolCallers: {
            get_goal: ['direct', 'programmatic'],
            update_goal: ['direct', 'programmatic']
          },
          environment: expect.objectContaining({ MAR_GOAL_MCP_TOKEN: expect.any(String) })
        })
      ];
      expect(runner.mcpConfiguration(userInstallations, {}, [executionServer])).toEqual(expected);

      const controller = new MarAgentManagedRunController(runner, {
        ...executionActivity(),
        adopt: vi.fn(),
        promote: vi.fn(),
        syncTitle: vi.fn(),
        emit: vi.fn(),
        emitItem: vi.fn(),
        run: vi.fn(),
        commandState: vi.fn(),
        setCommandState: vi.fn(),
        clearCommandState: vi.fn(),
        commandStates: vi.fn(() => []),
        webSearch: vi.fn()
      });
      const run = vi
        .spyOn(
          controller as unknown as {
            run(input: unknown): Promise<void>;
          },
          'run'
        )
        .mockResolvedValue();
      controller.start({
        payload: {
          runner: 'mar-agent',
          runId: 'goal-run',
          sessionId: 'goal-session',
          input: 'Goal Start',
          cwd: process.cwd(),
          model: 'coding',
          effort: '',
          access: 'full-access',
          collaborationMode: 'default',
          secretEnvironment: { USER_API_KEY: 'user-secret' },
          mcpInstallations: userInstallations,
          executionMcpServers: [executionServer],
          marAgentModel: {
            id: 'coding',
            name: 'Coding',
            protocol: 'ANTHROPIC_MESSAGES',
            baseUrl: 'https://example.test',
            credential: { type: 'INLINE_API_KEY', value: 'model-secret' },
            modelId: 'coding',
            contextWindowTokens: 200_000,
            maxOutputTokens: 4096,
            inputCapabilities: ['TEXT'],
            outputCapabilities: ['TEXT'],
            reasoningEfforts: [],
            hostedWebSearch: false,
            responsesPreviousResponseId: false,
            enabled: true
          }
        }
      } as never);
      expect(run).toHaveBeenCalledWith(expect.objectContaining({ mcpServers: expected }));
    } finally {
      await goalBridge.close();
    }
  });

  it('starts Goal stdio MCP in source mode and reads the current goal', async () => {
    const goals = new GoalRuntime(() => undefined);
    const goal = goals.start('goal-session', 'Complete source-mode verification');
    const server = new GoalMcpBridge(
      goals,
      () => undefined,
      (capability) => capability.sessionId
    );
    const descriptor = await server.prepare({
      executionId: 'goal-execution',
      sessionId: goal.sessionId,
      goalId: goal.id,
      revision: goal.revision
    });
    const configured = new MarAgentRunner().mcpConfiguration([], {}, [
      descriptor
    ]) as readonly ResolvedMcpServer[];
    let pool: MarAgentMcpClientPool | undefined;
    try {
      pool = await MarAgentMcpClientPool.connect(configured, process.cwd());
      expect(
        pool.catalog().tools.map(({ rawName, definition }) => [rawName, definition.allowedCallers])
      ).toEqual([
        ['get_goal', ['direct', 'programmatic']],
        ['update_goal', ['direct', 'programmatic']]
      ]);
      expect(pool.catalog().tools.map(({ definition }) => definition.name)).toEqual([
        'mcp__mar_goal__get_goal',
        'mcp__mar_goal__update_goal'
      ]);
      expect((await pool.call('mcp__mar_goal__get_goal', {})).content).toContain(
        'Complete source-mode verification'
      );
    } finally {
      await pool?.close();
      await server.close();
    }
  });

  it('discovers and calls namespaced stdio tools', async () => {
    const pool = await MarAgentMcpClientPool.connect([server()], process.cwd());
    try {
      expect(pool.definitions().map((tool) => tool.name)).toEqual(['mcp__test_server__echo']);
      expect(pool.definitions()[0]?.allowedCallers).toEqual(['direct', 'programmatic']);
      expect((await pool.call('mcp__test_server__echo', { value: 'ok' })).content).toContain('ok');
    } finally {
      await pool.close();
    }
  });

  it('projects MCP text, images and independent structured content without repeated blocks', async () => {
    const pool = await MarAgentMcpClientPool.connect(
      [server({ MAR_TEST_MCP_RESULT_CASES: '1' })],
      process.cwd()
    );
    const image = { mimeType: 'image/png', dataBase64: 'iVBORw0KGgo=' };
    const resource = { type: 'resource_link', uri: 'file:///sample.txt', name: 'sample' };
    try {
      const call = (value: string) => pool.call('mcp__test_server__echo', { value });
      expect(await call('text')).toEqual({ content: 'independent text' });
      expect(await call('image')).toEqual({ content: '[image]', images: [image] });
      expect(await call('mixed')).toEqual({
        content: 'independent text\n[image]\n[resource_link]',
        data: [resource],
        images: [image]
      });
      expect(await call('explicitSuccess')).toEqual({
        content: 'independent text\n[image]\n[resource_link]',
        data: { structuredContent: { answer: 42 }, content: [resource] },
        images: [image]
      });
      expect(await call('structured')).toEqual({
        content: 'independent text',
        data: { answer: 42 }
      });
      expect(await call('annotated')).toEqual({
        content: 'independent text\n[image]',
        images: [image],
        data: [
          {
            type: 'text',
            annotations: { audience: ['assistant'], priority: 0.5 },
            _meta: { source: 'text' }
          },
          {
            type: 'image',
            mimeType: 'image/png',
            annotations: { audience: ['user'] },
            _meta: { source: 'image' }
          }
        ]
      });
      expect(await call('structuredMixed')).toEqual({
        content: 'independent text\n[image]\n[resource_link]',
        data: { structuredContent: { answer: 42 }, content: [resource] },
        images: [image]
      });
      expect(await call('structuredJson')).toEqual({
        content: '{"answer":42}',
        data: { answer: 42 }
      });
      expect(await call('empty')).toEqual({ content: '' });
    } finally {
      await pool.close();
    }
  });

  it('composes MCP images and structured data through the real Code Exec worker', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-mcp-image-'));
    const host = new LocalAgentHost({ homeDirectory: home, workspace: home });
    let pool: MarAgentMcpClientPool | undefined;
    try {
      pool = await MarAgentMcpClientPool.connect(
        [server({ MAR_TEST_MCP_RESULT_CASES: '1' })],
        home
      );
      const binding = pool;
      const result = await host.executeTool(
        {
          name: 'code_exec',
          arguments: `
          const r = await tools.mcp__test_server__echo({ value: 'mixed' });
          observe.result(r);
          const structured = await tools.mcp__test_server__echo({ value: 'structuredJson' });
          observe.result(structured);
        `
        },
        {
          sessionId: 'mcp-image-session',
          executionId: 'mcp-image-execution',
          mode: 'run',
          signal: new AbortController().signal,
          codeMode: {
            tools: pool.definitions(),
            supportsImages: true,
            invoke: (call, signal) => binding.call(call.name, call.arguments, signal)
          }
        }
      );
      expect(result.images).toEqual([{ mimeType: 'image/png', dataBase64: 'iVBORw0KGgo=' }]);
      expect(result.content).not.toContain('iVBORw0KGgo=');
      expect(result.content.match(/independent text/gu)).toHaveLength(1);
      expect(result.observations?.every((value) => value.type === 'tool_result')).toBe(true);
      expect(JSON.parse(result.content).observations.at(-1).content).toBe('{"answer":42}');
      expect(result.content).toContain('resource_link');
      expect(result.truncated).toBe(false);
    } finally {
      await host.dispose();
      await pool?.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('preserves transport failures instead of classifying them as tool-result errors', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-mcp-transport-error-'));
    const pool = await MarAgentMcpClientPool.connect([server()], home);
    try {
      let rejection: unknown;
      try {
        await pool.call('mcp__test_server__echo', { value: 'disconnect' });
      } catch (error) {
        rejection = error;
      }
      expect(rejection).toBeInstanceOf(Error);
      expect(rejection).not.toMatchObject({ code: 'MAR_AGENT_MCP_TOOL_FAILED' });
    } finally {
      await pool.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('preserves MCP protocol exceptions separately from tool-result errors', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-mcp-protocol-error-'));
    const pool = await MarAgentMcpClientPool.connect(
      [server({ MAR_TEST_MCP_RESULT_CASES: '1' })],
      home
    );
    try {
      let rejection: unknown;
      try {
        await pool.call('mcp__test_server__echo', { value: 'protocolError' });
      } catch (error) {
        rejection = error;
      }
      expect(rejection).toBeInstanceOf(Error);
      expect(rejection).not.toMatchObject({ code: 'MAR_AGENT_MCP_TOOL_FAILED' });
      await expect(pool.call('mcp__test_server__echo', { value: 'text' })).resolves.toMatchObject({
        content: 'independent text'
      });
    } finally {
      await pool.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('propagates cancellation of an in-flight MCP call and releases the pool', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-mcp-cancel-'));
    const startedFile = join(home, 'started');
    const abortedFile = join(home, 'aborted');
    const pool = await MarAgentMcpClientPool.connect(
      [
        server({
          MAR_TEST_MCP_STARTED_FILE: startedFile,
          MAR_TEST_MCP_ABORTED_FILE: abortedFile
        })
      ],
      home
    );
    const controller = new AbortController();
    const call = pool.call('mcp__test_server__echo', { value: 'wait' }, controller.signal).then(
      () => ({ status: 'resolved' as const }),
      (error: unknown) => ({ status: 'rejected' as const, error })
    );
    try {
      await vi.waitFor(async () => expect(await readFile(startedFile, 'utf8')).toBe('started'), {
        interval: 10,
        timeout: 3_000
      });
      controller.abort();
      const result = await call;
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') {
        expect(result.error).toBeInstanceOf(Error);
        expect(result.error).not.toMatchObject({ code: 'MAR_AGENT_MCP_TOOL_FAILED' });
      }
      await vi.waitFor(async () => expect(await readFile(abortedFile, 'utf8')).toBe('aborted'), {
        interval: 10,
        timeout: 3_000
      });
    } finally {
      controller.abort();
      await pool.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('routes MCP isError results through direct tool failure with bounded model-visible diagnostics', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-mcp-is-error-direct-'));
    const pool = await MarAgentMcpClientPool.connect(
      [server({ MAR_TEST_MCP_RESULT_CASES: '1' })],
      home
    );
    const model = mcpResultModel(false);
    const requests: ModelRequest[] = [];
    const adapter: ModelAdapter = {
      configuration: model,
      async *start(request): AsyncIterable<ModelEvent> {
        requests.push(request);
        if (requests.length === 1) {
          yield {
            type: 'client_tool.call',
            callId: 'mcp-direct-discover',
            name: 'tool_search',
            arguments: { query: 'mcp__test_server__echo' }
          };
          yield { type: 'completed', reason: 'tool_use' };
          return;
        }
        if (requests.length === 2) {
          yield {
            type: 'client_tool.call',
            callId: 'mcp-direct-error',
            name: 'mcp__test_server__echo',
            arguments: { value: 'longError' }
          };
          yield { type: 'completed', reason: 'tool_use' };
          return;
        }
        yield {
          type: 'text.completed',
          itemId: 'answer',
          text: 'Recovered after the MCP tool error.'
        };
        yield { type: 'completed', reason: 'completed' };
      }
    };
    const host = mcpResultHost(home, pool);
    const agent = await createMarAgent(
      { mode: 'normal', host, models: [model], defaultModelId: model.id },
      () => adapter
    );
    try {
      const session = await agent.createSession({ workspace: home, title: 'MCP isError direct' });
      const run = session.run({ prompt: 'Call the MCP tool.' });
      const events: AgentEvent[] = [];
      for await (const event of run) events.push(event);

      await expect(run.result()).resolves.toMatchObject({ status: 'completed' });
      const failed = events.find(
        (event) => event.type === 'tool.failed' && event.callId === 'mcp-direct-error'
      );
      expect(failed).toMatchObject({
        type: 'tool.failed',
        toolName: 'mcp__test_server__echo',
        code: 'MAR_AGENT_MCP_TOOL_FAILED',
        message: expect.stringContaining('MCP fixture diagnostic')
      });
      expect(
        events.some(
          (event) => event.type === 'tool.completed' && event.callId === 'mcp-direct-error'
        )
      ).toBe(false);
      const failedMessage = failed?.type === 'tool.failed' ? (failed.message ?? '') : '';
      expect(failedMessage).toContain('MCP fixture diagnostic');
      expect([...failedMessage].length).toBeLessThanOrEqual(1_000);
      const modelToolResult = requests[2]?.messages.find(
        (message) => message.role === 'tool' && message.callId === 'mcp-direct-error'
      );
      expect(modelToolResult?.content).toContain(failedMessage);
    } finally {
      await agent.dispose();
      await pool.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('rejects nested MCP isError promises in Code Mode so guest code can catch and continue', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-mcp-is-error-code-mode-'));
    const pool = await MarAgentMcpClientPool.connect(
      [server({ MAR_TEST_MCP_RESULT_CASES: '1' })],
      home
    );
    const model = mcpResultModel(true);
    const requests: ModelRequest[] = [];
    const adapter: ModelAdapter = {
      configuration: model,
      async *start(request): AsyncIterable<ModelEvent> {
        requests.push(request);
        if (requests.length === 1) {
          yield {
            type: 'client_tool.call',
            callId: 'mcp-code-mode-discover',
            name: 'tool_search',
            arguments: { query: 'mcp__test_server__echo' }
          };
          yield { type: 'completed', reason: 'tool_use' };
          return;
        }
        if (requests.length === 2) {
          yield {
            type: 'client_tool.call',
            callId: 'mcp-code-mode-cell',
            name: 'code_exec',
            arguments: {
              code: `
                let failure;
                try {
                  await tools.mcp__test_server__echo({ value: 'error' });
                } catch (error) {
                  failure = { code: error.code, message: error.message };
                }
                const continued = await tools.mcp__test_server__echo({ value: 'text' });
                observe.text(JSON.stringify({ failure, continued: continued.content }));
              `
            }
          };
          yield { type: 'completed', reason: 'tool_use' };
          return;
        }
        yield { type: 'text.completed', itemId: 'answer', text: 'Cell recovered.' };
        yield { type: 'completed', reason: 'completed' };
      }
    };
    const host = mcpResultHost(home, pool);
    const agent = await createMarAgent(
      { mode: 'normal', host, models: [model], defaultModelId: model.id },
      () => adapter
    );
    try {
      const session = await agent.createSession({
        workspace: home,
        title: 'MCP isError Code Mode'
      });
      const run = session.run({ prompt: 'Catch the MCP tool error and continue.' });
      const events: AgentEvent[] = [];
      for await (const event of run) events.push(event);

      await expect(run.result()).resolves.toMatchObject({ status: 'completed' });
      const failed = events.find(
        (event) => event.type === 'tool.failed' && event.toolName === 'mcp__test_server__echo'
      );
      expect(failed).toMatchObject({
        type: 'tool.failed',
        parentCallId: 'mcp-code-mode-cell',
        code: 'MAR_AGENT_MCP_TOOL_FAILED',
        message: expect.stringContaining('MCP fixture diagnostic')
      });
      expect(
        events.some(
          (event) =>
            event.type === 'tool.completed' &&
            event.toolName === 'mcp__test_server__echo' &&
            event.parentCallId === 'mcp-code-mode-cell'
        )
      ).toBe(true);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'tool.completed',
          toolName: 'code_exec',
          callId: 'mcp-code-mode-cell'
        })
      );
      expect(events).not.toContainEqual(
        expect.objectContaining({
          type: 'tool.failed',
          toolName: 'code_exec',
          callId: 'mcp-code-mode-cell'
        })
      );
      expect(JSON.stringify(requests[2]?.messages)).toContain('MAR_AGENT_MCP_TOOL_FAILED');
      expect(JSON.stringify(requests[2]?.messages)).toContain('MCP fixture diagnostic');
      expect(JSON.stringify(requests[2]?.messages)).toContain('independent text');
    } finally {
      await agent.dispose();
      await pool.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('publishes trusted caller overrides and isolates policy changes in the cache', async () => {
    const cache = new MarAgentMcpClientCache({ idleTtlMs: 60_000 });
    const defaults = await cache.acquire([server()], process.cwd());
    const direct = await cache.acquire(
      [{ ...server(), allowedToolCallers: { echo: ['direct'] } }],
      process.cwd()
    );
    const programmatic = await cache.acquire(
      [
        {
          ...server(),
          allowedToolCallers: { echo: ['programmatic'] }
        }
      ],
      process.cwd()
    );
    try {
      expect(direct.pool).not.toBe(defaults.pool);
      expect(direct.pool.definitions()[0]?.allowedCallers).toEqual(['direct']);
      expect(programmatic.pool).not.toBe(direct.pool);
      expect(programmatic.pool.definitions()[0]?.allowedCallers).toEqual(['programmatic']);
      expect(programmatic.pool.catalog().revision).not.toBe(direct.pool.catalog().revision);
    } finally {
      await defaults.release();
      await direct.release();
      await programmatic.release();
      await cache.close();
    }
  });

  it('keeps undeclared built-in MCP callers direct-only', async () => {
    const pool = await MarAgentMcpClientPool.connect(
      [{ ...server(), origin: 'BUILTIN' }],
      process.cwd()
    );
    try {
      expect(pool.definitions()[0]?.allowedCallers).toEqual(['direct']);
    } finally {
      await pool.close();
    }
  });

  it('reuses the same cwd and resolved configuration while isolating environment changes', async () => {
    const cache = new MarAgentMcpClientCache({ idleTtlMs: 60_000 });
    const first = await cache.acquire([server({ TOKEN: 'one' })], process.cwd());
    const second = await cache.acquire([server({ TOKEN: 'one' })], process.cwd());
    const ordered = await cache.acquire([server({ A: 'one', B: 'two' })], process.cwd());
    const reordered = await cache.acquire([server({ B: 'two', A: 'one' })], process.cwd());
    const isolated = await cache.acquire([server({ TOKEN: 'two' })], process.cwd());
    try {
      expect(second.pool).toBe(first.pool);
      expect(isolated.pool).not.toBe(first.pool);
      expect(reordered.pool).toBe(ordered.pool);
    } finally {
      await first.release();
      await second.release();
      await isolated.release();
      await ordered.release();
      await reordered.release();
      await cache.close();
    }
  });

  it('routes hosted stdio MCP through the injected process executor without reusable pooling', async () => {
    const requests: LocalProcessSpawnRequest[] = [];
    const processExecutor = {
      async spawn(request: LocalProcessSpawnRequest) {
        requests.push(request);
        return directLocalProcessExecutor.spawn(request);
      }
    };
    const cache = new MarAgentMcpClientCache({ idleTtlMs: 60_000 });
    await expect(
      cache.acquire([server({ TOKEN: 'secret' })], process.cwd(), { processExecutor })
    ).rejects.toThrow('MAR_AGENT_MCP_SANDBOX_REUSE_INVALID');
    const lease = await cache.acquire([server({ TOKEN: 'secret' })], process.cwd(), {
      reusable: false,
      processExecutor,
      owner: { sessionId: 'hosted-session', executionId: 'hosted-mcp' }
    });
    try {
      expect(
        (await lease.pool.call('mcp__test_server__echo', { value: 'sandboxed' })).content
      ).toContain('sandboxed');
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        command: process.execPath,
        shell: false,
        environmentKeys: ['TOKEN'],
        owner: { sessionId: 'hosted-session', executionId: 'hosted-mcp' }
      });
    } finally {
      await lease.release();
      await cache.close();
    }
  });

  it('keeps execution-scoped temporary MCP out of the shared pool', async () => {
    const cache = new MarAgentMcpClientCache({ idleTtlMs: 60_000 });
    const first = await cache.acquire([server()], process.cwd(), { reusable: false });
    const second = await cache.acquire([server()], process.cwd(), { reusable: false });
    try {
      expect(second.pool).not.toBe(first.pool);
    } finally {
      await first.release();
      await second.release();
      await cache.close();
    }
  });
});
