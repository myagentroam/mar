import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalAgentHost } from '../../../mar-agent/src/index.js';
import type { LocalProcessSpawnRequest } from '../../../mar-agent/src/index.js';
import { directLocalProcessExecutor } from '../../../mar-agent/src/agent-core/host/local-process-executor.js';
import { describe, expect, it, vi } from 'vitest';
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
    const goalBridge = new GoalMcpBridge(goals, () => undefined);
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
        active: new Set(),
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
            apiKey: 'model-secret',
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
    const server = new GoalMcpBridge(goals, () => undefined);
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
